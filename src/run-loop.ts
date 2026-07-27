import { extractCodeContribution, publishCodeContribution } from './code-contrib.js';
import type { ExecTask, Executor } from './executor.js';

// The transport-agnostic runner core: the Backend abstraction, the production
// HTTP transport, and the poll→checkout→execute→submit loop. Deliberately free of
// any server-only import (no pg/hono, no MCP SDK, no @anthropic-ai/sdk) so both
// src/runner.ts (which adds a local MCP backend) and the bundled CLI can reuse it.

export interface OpenTask {
  id: string;
  title: string;
  max_cost_cents: number;
  model: string;
}
export interface CheckoutResult {
  task_id: string;
  spec: any;
  title: string;
  model: string;
  effort?: 'low' | 'medium' | 'high';
  max_cost_cents: number;
  /** The target's compacted working set (present on newer control planes). */
  target_state?: unknown;
  /** Recent chunks tried on this task, newest first (present on newer control planes). */
  prior_contributions?: Array<{
    id: number;
    outcome: string;
    summary: string;
    artifact_uri: string | null;
    cost_cents: number;
    created_at: string;
  }>;
}
export interface Budget {
  budget_cents: number;
  reserved_cents: number;
  spent_cents: number;
  available_cents: number;
}
export interface SubmitResult {
  spent_applied: number;
  /** Post-verification task state: 'open' means verification rejected the work. */
  status?: 'submitted' | 'open' | 'accepted';
  verification?: { verdict: string; target_status: string | null } | null;
}
export interface SubmitArgs {
  task_id: string;
  result: unknown;
  actual_cost_cents: number;
  raw_usage: unknown;
  /**
   * Continuation fields (optional). Omitted -> the control plane defaults to a
   * terminal 'candidate_solution' submit, i.e. the original one-shot behaviour.
   */
  outcome?: 'progress' | 'dead_end' | 'candidate_solution';
  summary?: string;
  artifact_uri?: string;
  artifact?: unknown;
  state_update?: unknown;
}
export interface ApiVersion {
  service: string;
  commit: string;
  ref: string;
  deployed_at: string | null;
}

/** A tool/op error surfaced by the platform (e.g. task_not_open, insufficient_budget, no_budget). */
export class ToolError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

// The runner drives a Backend that exposes the five dev operations. Both
// transports normalize platform errors to ToolError(code), so the loop's
// race/budget handling is identical regardless of transport.
export interface Backend {
  readonly kind: string;
  /** Control-plane build info, if the transport exposes it (HTTP only). */
  version?(): Promise<ApiVersion>;
  getBudget(): Promise<Budget>;
  listOpenTasks(args: {
    max_cost_cents?: number;
    limit?: number;
    sensitivity?: string;
  }): Promise<OpenTask[]>;
  checkout(taskId: string): Promise<CheckoutResult>;
  submit(args: SubmitArgs): Promise<SubmitResult>;
  /** Renew the checkout lease — pinged periodically during long executions. */
  heartbeat(taskId: string): Promise<void>;
  release(taskId: string): Promise<void>;
  close(): Promise<void>;
}

/** Production transport: the platform's REST API, authenticated with a dev token. */
export class HttpBackend implements Backend {
  readonly kind = 'http';
  private readonly baseUrl: string;
  constructor(
    baseUrl: string,
    private readonly token: string,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    // A crashed server or an intermediary (e.g. a 502 HTML page) returns
    // non-JSON; don't let JSON.parse throw a raw SyntaxError and kill the runner.
    let payload: any = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        throw new ToolError(`http_${res.status}`, text.slice(0, 300));
      }
    }
    // The REST API returns { error, message } with a 4xx for OpErrors; mirror
    // that into ToolError(code) so the loop sees the same codes as over MCP.
    if (!res.ok) {
      throw new ToolError(payload?.error ?? `http_${res.status}`, payload?.message ?? text);
    }
    // A 2xx with an empty body parses to null; hand callers {} so property access
    // doesn't throw.
    return (payload ?? {}) as T;
  }

  version() {
    return this.req<ApiVersion>('GET', '/version');
  }
  getBudget() {
    return this.req<Budget>('GET', '/budget');
  }
  listOpenTasks(args: { max_cost_cents?: number; limit?: number; sensitivity?: string }) {
    const qs = new URLSearchParams();
    if (args.max_cost_cents != null) qs.set('max_cost_cents', String(args.max_cost_cents));
    if (args.limit != null) qs.set('limit', String(args.limit));
    if (args.sensitivity) qs.set('sensitivity', args.sensitivity);
    const q = qs.toString();
    return this.req<OpenTask[]>('GET', `/tasks/open${q ? `?${q}` : ''}`);
  }
  checkout(taskId: string) {
    return this.req<CheckoutResult>('POST', '/checkout', { task_id: taskId });
  }
  submit(args: SubmitArgs) {
    return this.req<SubmitResult>('POST', '/submit', args);
  }
  async heartbeat(taskId: string) {
    await this.req('POST', '/heartbeat', { task_id: taskId });
  }
  async release(taskId: string) {
    await this.req('POST', '/release', { task_id: taskId });
  }
  async close() {}
}

export interface RunLoopOptions {
  maxTasks: number;
  watch: boolean;
  intervalMs: number;
  stopOnError: boolean;
}

/**
 * How often the lease is renewed while work runs. `checkoutTask` sets
 * `lock_expires_at = now() + 10 minutes`, so anything that can outlive that has
 * to heartbeat or its submit hits the guarded UPDATE, matches 0 rows, and throws
 * `not_locked` — the volunteer's real Claude credit spent for nothing.
 */
export const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Run `fn` while holding the task's lease open. Every path that executes a
 * checked-out task must go through this — the run loop and `givework onboard`
 * alike — because the failure it prevents (a slow machine, a long CLI startup, a
 * retried call) is invisible until it costs someone their first contribution.
 *
 * Heartbeat failures are logged, not thrown: a dead lease just returns the task
 * to the pool, which is the designed behaviour, and killing the run in flight
 * would guarantee the loss it is trying to avoid.
 */
export async function withLease<T>(
  backend: Backend,
  taskId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lease = setInterval(() => {
    backend
      .heartbeat(taskId)
      .catch((err) => console.error(`  ! heartbeat failed: ${(err as Error).message}`));
  }, HEARTBEAT_INTERVAL_MS);
  try {
    return await fn();
  } finally {
    clearInterval(lease);
  }
}

/**
 * The volunteer's work loop: find an affordable open task, check it out, execute
 * it on the donated executor, submit the result, repeat — until the budget runs
 * out, the pool is empty, or maxTasks is reached. Returns the number of completed
 * tasks. Does not close the backend; the caller owns its lifecycle.
 */
export async function runLoop(
  backend: Backend,
  executor: Executor,
  opts: RunLoopOptions,
): Promise<number> {
  let done = 0;
  // Tasks whose execution failed this run — don't re-check-out a task we just
  // released after a failure, or we'd hot-loop on it forever.
  const failed = new Set<string>();
  let consecutiveFailures = 0;
  // Consistent execution failure means a config/auth problem (bad or missing
  // credential), not a transient task issue — bail instead of firehosing.
  const MAX_CONSECUTIVE_FAILURES = 3;

  try {
    while (done < opts.maxTasks) {
      let budget: Budget;
      try {
        budget = await backend.getBudget();
      } catch (err) {
        if (err instanceof ToolError && err.code === 'no_budget') {
          console.log('No budget for the current period. Stopping.');
          break;
        }
        throw err;
      }
      if (budget.available_cents <= 0) {
        console.log(`Budget exhausted (available ${budget.available_cents}¢). Stopping.`);
        break;
      }

      const open = await backend.listOpenTasks({
        max_cost_cents: budget.available_cents,
        limit: 5,
      });

      if (open.length === 0) {
        if (opts.watch) {
          console.log(`No affordable open tasks. Waiting ${opts.intervalMs / 1000}s…`);
          await new Promise((r) => setTimeout(r, opts.intervalMs));
          continue;
        }
        console.log('No affordable open tasks. Done.');
        break;
      }

      // Take the oldest affordable task we haven't already failed on this run.
      const pick = open.find((t) => !failed.has(t.id));
      if (!pick) {
        console.log('No new affordable tasks to attempt. Done.');
        break;
      }
      let checkout: CheckoutResult;
      try {
        checkout = await backend.checkout(pick.id);
      } catch (err) {
        if (err instanceof ToolError && err.code === 'task_not_open') {
          // Lost the race — someone else grabbed it. Refresh and retry.
          console.log(`  ${pick.id.slice(0, 8)} taken by another runner, retrying…`);
          continue;
        }
        if (err instanceof ToolError && err.code === 'insufficient_budget') {
          console.log('  Not enough budget for the cheapest task. Stopping.');
          break;
        }
        throw err;
      }

      console.log(
        `▶ checked out ${checkout.task_id.slice(0, 8)} — "${checkout.title}" (cap ${checkout.max_cost_cents}¢)`,
      );

      // Run the work. If execution fails (e.g. the real Claude call errors), do
      // NOT submit — release the task so another volunteer can pick it up.
      // Submitting fabricated output would corrupt the ledger and the deliverable.
      // withLease renews the 10-minute lease every 5 minutes while execution
      // runs, so long CPU work units keep their claim; failures are non-fatal
      // (a dead lease just returns the task to the pool, as designed).
      let exec: Awaited<ReturnType<typeof executor.execute>>;
      try {
        exec = await withLease(backend, checkout.task_id, () =>
          executor.execute(checkout as ExecTask),
        );
      } catch (err) {
        console.error(
          `  ✗ execution failed for ${checkout.task_id.slice(0, 8)}: ${(err as Error).message} — releasing`,
        );
        await backend.release(checkout.task_id).catch(() => {});
        failed.add(checkout.task_id);
        consecutiveFailures++;
        if (opts.stopOnError || consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          console.error(
            `Aborting after ${consecutiveFailures} consecutive execution failure(s) — likely a config/credential problem, not a task issue.`,
          );
          break;
        }
        continue;
      }
      consecutiveFailures = 0;

      // Code contributions ride the volunteer's own git+gh identity to the
      // public contrib repo; the PR URL becomes the contribution's artifact.
      // Publish failure is non-fatal — the code is still inline in `result`,
      // so the submit below never loses work.
      let artifactUri = exec.artifact_uri;
      let summary = exec.summary;
      const code = extractCodeContribution(exec.result);
      if (code) {
        try {
          const pub = await publishCodeContribution(code, { taskId: checkout.task_id });
          artifactUri = pub.pr_url;
          summary = summary ?? `${code.title} — PR: ${pub.pr_url}`;
          console.log(`  ⇪ code contribution → ${pub.pr_url}`);
        } catch (err) {
          console.error(
            `  ! code PR failed (${(err as Error).message}) — submitting with code inline only`,
          );
        }
      }

      let submit: SubmitResult;
      try {
        submit = await backend.submit({
          task_id: checkout.task_id,
          result: exec.result,
          actual_cost_cents: exec.actual_cost_cents,
          raw_usage: exec.raw_usage,
          // Forwarded when the executor produces them; otherwise a terminal submit.
          outcome: exec.outcome,
          summary,
          artifact_uri: artifactUri,
          artifact: exec.artifact,
          state_update: exec.state_update,
        });
      } catch (err) {
        // A submit can legitimately fail — most often because the lease expired
        // during a long run and expire() reclaimed the task (ToolError
        // 'not_locked'/'task_not_open'). That's a lost unit of work, not a
        // runner-fatal condition: log it and move on rather than aborting.
        console.error(
          `  ! submit rejected for ${checkout.task_id.slice(0, 8)} (${(err as Error).message}) — work not recorded, continuing`,
        );
        failed.add(checkout.task_id);
        continue;
      }
      if (submit.verification?.verdict === 'failed') {
        // Verification rejected the claim and the task is back in the pool.
        // Don't pick it up again this run — we'd just re-spend on the same
        // wrong answer.
        console.log(
          `  ✗ verification failed for ${checkout.task_id.slice(0, 8)} — spent ${submit.spent_applied}¢, task returned to pool`,
        );
        failed.add(checkout.task_id);
        continue;
      }
      console.log(`✔ submitted ${checkout.task_id.slice(0, 8)} — spent ${submit.spent_applied}¢`);
      done++;
    }
  } finally {
    const b = await backend.getBudget().catch(() => null);
    if (b) {
      console.log(
        `\nDone. Completed ${done} task(s). Budget: spent ${b.spent_cents}¢, available ${b.available_cents}¢ of ${b.budget_cents}¢.`,
      );
    }
  }
  return done;
}
