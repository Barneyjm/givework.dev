import { extractCodeContribution, publishCodeContribution } from './code-contrib.js';
import type { ExecTask, Executor } from './executor.js';
import { Outbox } from './outbox.js';

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
    /** Inline artifact — hydrated only for a salvaged invalid decomposition. */
    artifact?: unknown;
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
  /**
   * Set when a decomposition proposal failed validation and the control plane
   * salvaged it as a progress contribution (full proposal + these errors
   * preserved for the next agent) instead of discarding the work.
   */
  salvaged_decomposition?: { validation_errors: string[] };
}
export interface SubmitArgs {
  task_id: string;
  result: unknown;
  actual_cost_cents: number;
  raw_usage: unknown;
  /**
   * Continuation fields (optional). Omitted -> the control plane defaults to a
   * terminal 'candidate_solution' submit, i.e. the original one-shot behaviour.
   * 'decomposition' proposes a split of an oversized task; the control plane
   * logs it and mints a peer-review task (see operations.submitResult).
   */
  outcome?: 'progress' | 'dead_end' | 'candidate_solution' | 'decomposition';
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
    /** HTTP status when the transport knows it — distinguishes a definitive 4xx from a retryable 5xx. */
    public status?: number,
  ) {
    super(message);
  }
}

/**
 * Whether a failed submit is a DEFINITIVE server rejection (retrying the same
 * payload can never succeed: validation 4xx, or a conflict because the task is
 * no longer locked to us) versus a transient failure (network error, timeout,
 * 5xx) where the payload stays spooled and is replayed. When the transport
 * carries no HTTP status (MCP / in-process), platform error codes are
 * definitive and only the transport/internal shapes are retryable — erring
 * toward "retryable" is safe either way, because a definitive error on replay
 * lands the entry in dead/ instead of deleting it.
 */
export function isDefinitiveReject(err: unknown): boolean {
  if (!(err instanceof ToolError)) return false; // network / timeout / abort
  if (typeof err.status === 'number') return err.status >= 400 && err.status < 500;
  return !/^(http_5\d\d|internal_error|tool_error)$/.test(err.code);
}

/** How long one submit attempt may hang before the spool-and-replay path takes over. */
export const SUBMIT_TIMEOUT_MS = 60_000;

/** Hostnames that count as a local control plane for the stub-executor guard. */
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Guard for the runner's wiring step: a STUB executor pointed at a REMOTE
 * control plane submits fabricated results as if they were real donated work.
 * Production incident: a stub run against api.givework.dev submitted 7
 * fabricated results and booked 1028¢ of fake spend, repaired by hand.
 *
 * Returns the refusal message when the combination is unsafe, or null when it
 * is fine: a real executor (EXECUTOR=claude), a local control plane
 * (localhost / 127.0.0.1 / [::1]), or the deliberate escape hatch
 * (GIVEWORK_ALLOW_STUB_REMOTE=1). An unparseable base URL counts as remote —
 * when in doubt, refuse. Called BEFORE any network traffic; tests that inject
 * executors into runLoop directly never pass through it.
 */
export function stubExecutorRemoteRefusal(
  baseUrl: string,
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (env.EXECUTOR === 'claude') return null;
  if (env.GIVEWORK_ALLOW_STUB_REMOTE === '1') return null;
  let hostname = '';
  try {
    hostname = new URL(baseUrl).hostname;
  } catch {
    // unparseable -> treat as remote
  }
  if (LOCAL_HOSTNAMES.has(hostname)) return null;
  return (
    `Refusing to start: the stub executor against a remote control plane (${baseUrl}) ` +
    'would submit fabricated results and book fake spend. Set EXECUTOR=claude to donate ' +
    'real capacity, or point at a local server; override deliberately with ' +
    'GIVEWORK_ALLOW_STUB_REMOTE=1.'
  );
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
    /** Only tasks for the conjecture with this public slug (`run --target`). */
    target?: string;
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
      // Without a timeout, a dead intermediary can hang a submit forever — the
      // finished work idling in memory the whole time. The abort surfaces as a
      // non-ToolError, i.e. transient: the spooled payload is kept and replayed.
      signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
    });
    const text = await res.text();
    // A crashed server or an intermediary (e.g. a 502 HTML page) returns
    // non-JSON; don't let JSON.parse throw a raw SyntaxError and kill the runner.
    let payload: any = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        throw new ToolError(`http_${res.status}`, text.slice(0, 300), res.status);
      }
    }
    // The REST API returns { error, message } with a 4xx for OpErrors; mirror
    // that into ToolError(code, message, status) so the loop sees the same
    // codes as over MCP, plus the status the retry policy keys on.
    if (!res.ok) {
      throw new ToolError(
        payload?.error ?? `http_${res.status}`,
        payload?.message ?? text,
        res.status,
      );
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
  listOpenTasks(args: {
    max_cost_cents?: number;
    limit?: number;
    sensitivity?: string;
    target?: string;
  }) {
    const qs = new URLSearchParams();
    if (args.max_cost_cents != null) qs.set('max_cost_cents', String(args.max_cost_cents));
    if (args.limit != null) qs.set('limit', String(args.limit));
    if (args.sensitivity) qs.set('sensitivity', args.sensitivity);
    if (args.target) qs.set('target', args.target);
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
  /**
   * Only claim tasks for the conjecture with this public slug. Opt-in: the
   * default is general chipping away — the loop takes whatever the pool offers,
   * which is how less-famous problems get attention. Narrows selection only;
   * checkout still enforces the budget gate exactly as before.
   */
  targetSlug?: string;
  /**
   * Claim exactly this one task (`run --task <id>`) and stop after the attempt.
   * If it's gone — someone else took it, or it's finished — report that cleanly
   * and stop; there is nothing to retry when the task was the whole point.
   */
  taskId?: string;
  /**
   * Called when a task was checked out but execution failed locally, so the
   * task is being released instead of submitted.
   *
   * This is the one failure the control plane cannot diagnose for itself: it
   * sees a checkout followed by a release and cannot tell "volunteer changed
   * their mind" from "`claude -p` is not installed". The CLI uses this to
   * report a content-free reason (see src/cli/telemetry.ts); `src/runner.ts`
   * and the tests leave it unset. Kept as a callback rather than an import so
   * the shared loop stays free of CLI config and filesystem access.
   */
  onExecutionFailure?: (info: { code: string; consecutiveFailures: number }) => void;
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
 * Replay every spooled submit still sitting in the outbox — work that finished
 * (tokens burned) but whose submit never got a 2xx. Success deletes the entry;
 * a definitive server rejection moves it to dead/ WITH the response attached
 * (never a silent delete — the most common shape is a 409 not_locked after the
 * lease lapsed, and the volunteer deserves to see what was lost and why);
 * anything transient keeps the entry for the next pass. Never throws: a broken
 * spool must not take the live loop down with it.
 */
async function replayOutbox(backend: Backend, outbox: Outbox): Promise<void> {
  for (const entry of outbox.list()) {
    const short = entry.args.task_id.slice(0, 8);
    try {
      const r = await backend.submit(entry.args);
      outbox.delete(entry);
      console.log(
        `  ⇧ replayed a spooled submit for ${short} — work recorded (spent ${r.spent_applied}¢)`,
      );
    } catch (err) {
      const msg = (err as Error).message;
      if (isDefinitiveReject(err)) {
        const code = err instanceof ToolError ? err.code : 'rejected';
        const dest = outbox.moveToDead(entry, { code, message: msg });
        console.error(
          `  ! the server rejected the spooled submit for ${short} (${code}: ${msg})` +
            (dest ? ` — the payload is preserved at ${dest}` : ''),
        );
      } else {
        console.error(
          `  ! could not replay the spooled submit for ${short} (${msg}) — still saved; will retry`,
        );
      }
    }
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
  // Salvaged timeouts are counted SEPARATELY from hard failures. A timeout is
  // not a config/credential problem — those fail in seconds, not at the end of
  // the window — and its salvage submit demonstrably worked, so it must not
  // trip the abort above. But each one burns the volunteer's full timeout
  // window at real token cost, so a run of them means the window is mis-sized
  // for this pool: stop after three in a row and say why, rather than silently
  // burning a fourth.
  let consecutiveTimeouts = 0;
  const MAX_CONSECUTIVE_TIMEOUTS = 3;
  // Crash salvages get the same treatment as timeout salvages: they are real,
  // booked contributions (never counted as config failures), but an unbroken
  // run of them means the CLI itself is dying mid-run at real token cost.
  let consecutiveCrashes = 0;
  const MAX_CONSECUTIVE_CRASHES = 3;
  // The disk spool for finished-but-unsubmitted work — see src/outbox.ts.
  const outbox = new Outbox();

  try {
    while (done < opts.maxTasks) {
      // Replay anything spooled from an earlier failure (this run or a previous
      // one) BEFORE claiming new work: landing a held submit also settles its
      // reservation, unblocking the budget the next checkout needs.
      await replayOutbox(backend, outbox);
      // --task is a single attempt by definition: once it has been done, or has
      // failed and been released, looping again could only re-claim the same id.
      if (opts.taskId && (done > 0 || failed.has(opts.taskId))) break;
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

      let pick: { id: string } | undefined;
      if (opts.taskId) {
        // A specific task was named — skip the pool entirely and go claim it.
        // Checkout is the authority on whether it's still open and affordable.
        pick = { id: opts.taskId };
      } else {
        const open = await backend.listOpenTasks({
          max_cost_cents: budget.available_cents,
          limit: 5,
          target: opts.targetSlug,
        });
        const pool = opts.targetSlug ? `open tasks for ${opts.targetSlug}` : 'open tasks';

        if (open.length === 0) {
          if (opts.watch) {
            console.log(`No affordable ${pool}. Waiting ${opts.intervalMs / 1000}s…`);
            await new Promise((r) => setTimeout(r, opts.intervalMs));
            continue;
          }
          console.log(`No affordable ${pool}. Done.`);
          break;
        }

        // Take the oldest affordable task we haven't already failed on this run.
        pick = open.find((t) => !failed.has(t.id));
        if (!pick) {
          console.log('No new affordable tasks to attempt. Done.');
          break;
        }
      }
      let checkout: CheckoutResult;
      try {
        checkout = await backend.checkout(pick.id);
      } catch (err) {
        if (
          err instanceof ToolError &&
          (err.code === 'task_not_open' || (opts.taskId && err.code === 'task_not_found'))
        ) {
          if (opts.taskId) {
            // The named task is gone — claimed by someone else, finished, or
            // never existed. Retrying can't change that, so say so and stop.
            console.log(
              `Task ${opts.taskId} is not open (${err.code === 'task_not_found' ? 'unknown task id' : 'someone else claimed it, or it is already done'}). Nothing claimed.`,
            );
            break;
          }
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
      // The whole checkout payload goes to the executor — including
      // `target_state` and `prior_contributions`, the accumulated frontier that
      // makes hard tasks resumable. The LLM executor injects them into the
      // model prompt as the continuation section; dropping them here would mean
      // every attempt restarts from the static spec.
      const execTask: ExecTask = checkout;
      let exec: Awaited<ReturnType<typeof executor.execute>>;
      try {
        exec = await withLease(backend, checkout.task_id, () => executor.execute(execTask));
      } catch (err) {
        console.error(
          `  ✗ execution failed for ${checkout.task_id.slice(0, 8)}: ${(err as Error).message} — releasing`,
        );
        await backend.release(checkout.task_id).catch(() => {});
        failed.add(checkout.task_id);
        consecutiveFailures++;
        opts.onExecutionFailure?.({
          code: err instanceof ToolError ? err.code : 'execution_error',
          consecutiveFailures,
        });
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
      // and the server persists that inline copy durably: on a decomposition
      // submit it lands in the contribution's artifact (and travels into the
      // minted review task's spec — see reviewTaskSpec in operations.ts); on a
      // terminal submit the whole result lands on the task row. Either way the
      // submit below never loses work, GitHub up or down.
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

      // Spool the exact submit payload to disk BEFORE the network attempt: from
      // here on the work (and the real spend behind it) survives any failure —
      // network, 5xx, timeout, process death — as a file that replays on the
      // next iteration or the next `givework run`.
      const submitArgs: SubmitArgs = {
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
      };
      const spooled = outbox.save(submitArgs);
      let submit: SubmitResult;
      try {
        submit = await backend.submit(submitArgs);
      } catch (err) {
        const short = checkout.task_id.slice(0, 8);
        const msg = (err as Error).message;
        if (isDefinitiveReject(err)) {
          // The server definitively rejected the payload — retrying the same
          // bytes can never succeed, so don't: archive the payload to dead/
          // (with the response) instead of deleting it, and free the claim.
          //
          // CONTRACT: a hard-rejected submit rolls back atomically on the
          // server — the task is still locked to us and our reservation still
          // held. The RUNNER owns freeing both, so the reservation never sits
          // stranded until lease expiry: attempt a release on every rejected
          // submit. If the rejection was `not_locked` (the lease already
          // expired) the release fails the same way, which is fine — there is
          // nothing held.
          console.error(
            `  ! submit rejected for ${short} (${msg}) — work not recorded; releasing the task`,
          );
          if (spooled) {
            const code = err instanceof ToolError ? err.code : 'rejected';
            const dest = outbox.moveToDead(spooled, { code, message: msg });
            if (dest) console.error(`    the rejected payload is preserved at ${dest}`);
          }
          await backend.release(checkout.task_id).catch(() => {});
          failed.add(checkout.task_id);
          continue;
        }
        // Transient failure (network, timeout, 5xx): the work is spooled and
        // the task stays claimed to us, so the replay at the top of the next
        // iteration (or the next runner start) can land it. Do NOT release —
        // releasing would let another runner re-claim and re-spend on work
        // that is already done and saved.
        console.error(
          `  ! submit failed for ${short} (${msg}) — your work is SAVED` +
            (spooled ? ` at ${spooled.path}` : '') +
            ' and will be resubmitted automatically; holding the task meanwhile',
        );
        if (!spooled) {
          console.error(
            '    (spooling to disk ALSO failed — if this runner exits before a retry lands, this result is lost)',
          );
        }
        failed.add(checkout.task_id);
        continue;
      }
      if (spooled) outbox.delete(spooled);
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
      // Tell the volunteer the truth at submit time: an accepted-and-verified
      // result and a claim that is merely awaiting review are different things,
      // and printing the same "submitted" for both leaves them wondering
      // whether their agent actually found something.
      const short = checkout.task_id.slice(0, 8);
      if (exec.timed_out) {
        // Not a clean completion and not a loss either: the partial work is
        // logged as a progress contribution and the task is back in the pool
        // with the salvaged state, so the next agent continues rather than
        // restarts. Don't re-claim it ourselves this run, and don't let an
        // unbroken run of timeouts keep burning full windows.
        console.log(
          `⏱ ${short} timed out — salvaged partial work as a progress contribution (spent ~${submit.spent_applied}¢, estimated); task returned to the pool with state for the next agent`,
        );
        failed.add(checkout.task_id);
        consecutiveTimeouts++;
        done++;
        if (consecutiveTimeouts >= MAX_CONSECUTIVE_TIMEOUTS) {
          console.error(
            `Stopping after ${consecutiveTimeouts} consecutive timeouts. Each one burns your full window — raise EXECUTOR_TIMEOUT_MS, or work smaller (lower-effort) tasks.`,
          );
          break;
        }
        continue;
      }
      consecutiveTimeouts = 0;
      if (exec.crashed) {
        // The CLI died mid-run (or returned an error/empty result) but real
        // tokens were burned and something was recoverable: it is on the
        // record as a flagged progress contribution, honestly costed, and the
        // task is back in the pool with the salvaged state. Not a config
        // failure (those leave nothing recoverable and release instead) — but
        // an unbroken run of these means the CLI itself is sick, and each one
        // burns real credit, so stop after three in a row and say why.
        console.log(
          `⚠ ${short} crashed mid-run — salvaged the partial work as a progress contribution ` +
            `(spent ~${submit.spent_applied}¢); task returned to the pool with what was recovered`,
        );
        failed.add(checkout.task_id);
        consecutiveCrashes++;
        done++;
        if (consecutiveCrashes >= MAX_CONSECUTIVE_CRASHES) {
          console.error(
            `Stopping after ${consecutiveCrashes} consecutive crashed runs — the CLI is dying mid-run ` +
              `at real token cost. Check \`claude\` auth, memory, and network before running again.`,
          );
          break;
        }
        continue;
      }
      consecutiveCrashes = 0;
      if (submit.salvaged_decomposition) {
        // The proposal broke a validation rule, but the server salvaged it: the
        // full proposal + errors are on the record as a progress contribution
        // and the task is back in the pool, so the NEXT agent (which sees both
        // in its continuation context) can resubmit it corrected. Truthful
        // messaging: no review task exists, nothing will publish from this.
        // Don't re-claim it ourselves this run — the same executor would most
        // likely reproduce the same invalid proposal.
        console.log(
          `⑂ ${short}: decomposition proposal failed validation (${submit.salvaged_decomposition.validation_errors.join('; ')}) — ` +
            `preserved as a progress contribution for the next agent; spent ${submit.spent_applied}¢, task returned to the pool`,
        );
        failed.add(checkout.task_id);
        done++;
        continue;
      }
      if (exec.outcome === 'decomposition') {
        // The deliverable was a plan, not an answer — and that's success, not
        // a fallback (grinding to timeout is the failure mode). Nothing is
        // published yet: a peer's agent must approve the split first.
        console.log(
          `⑂ submitted a decomposition proposal for ${short} — spent ${submit.spent_applied}¢. ` +
            `A review task was created; the subtasks publish only if another volunteer's agent approves the split.`,
        );
        done++;
        continue;
      }
      if (submit.status === 'accepted') {
        const flipped = submit.verification?.target_status;
        console.log(
          `✔ ${submit.verification ? 'verified & accepted' : 'accepted'} ${short} — spent ${submit.spent_applied}¢` +
            (flipped ? ` — target is now ${flipped}!` : ''),
        );
      } else if (submit.status === 'submitted') {
        console.log(
          `✔ submitted ${short} — awaiting verification (not yet a confirmed result) — spent ${submit.spent_applied}¢`,
        );
      } else {
        console.log(`✔ submitted ${short} — spent ${submit.spent_applied}¢`);
      }
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
