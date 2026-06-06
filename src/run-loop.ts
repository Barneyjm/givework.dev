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
  max_cost_cents: number;
}
export interface Budget {
  budget_cents: number;
  reserved_cents: number;
  spent_cents: number;
  available_cents: number;
}
export interface SubmitResult {
  spent_applied: number;
}
export interface SubmitArgs {
  task_id: string;
  result: unknown;
  actual_cost_cents: number;
  raw_usage: unknown;
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
      let exec: Awaited<ReturnType<typeof executor.execute>>;
      try {
        exec = await executor.execute(checkout as ExecTask);
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

      const submit = await backend.submit({
        task_id: checkout.task_id,
        result: exec.result,
        actual_cost_cents: exec.actual_cost_cents,
        raw_usage: exec.raw_usage,
      });
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
