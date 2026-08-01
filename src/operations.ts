import { type Client, query, withTransaction } from './db.js';
import { recordEvent } from './funnel.js';
import { blockAt, ONBOARDING_CANDIDATES, ONBOARDING_MAX_CENTS } from './goldbach.js';

/**
 * Domain error carrying the HTTP status the server layer should surface. Lets
 * operations.ts stay free of HTTP machinery while still distinguishing the
 * expected 402 / 409 / 404 / 400 cases from genuine 5xx failures.
 */
export class OpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'OpError';
  }
}

const BAD_INPUT = 400;
const RESERVE_INSUFFICIENT_BUDGET = 402;
const CONFLICT = 409;

/** Caps on the free-form contribution fields (public + hydrated into prompts). */
/**
 * How far past its reservation a single submit may still be booked. A task that
 * ran a little long is a genuine donation; one reporting orders of magnitude more
 * than it reserved is a malfunction, and booking it would empty a volunteer's
 * budget on one bad number.
 */
const ABSURD_COST_MULTIPLE = 10;
const MAX_SUMMARY_CHARS = 2000;
const MAX_STATE_BYTES = 64 * 1024;
/** Cap on a salvaged-proposal artifact hydrated into a checkout payload. */
const SALVAGED_ARTIFACT_HYDRATE_MAX_BYTES = 16 * 1024;

/** SQL expression for the current accounting period (first day of this month). */
const CURRENT_PERIOD = `date_trunc('month', now())::date`;

interface DevBudgetRow {
  dev_id: string;
  period: string;
  budget_cents: number;
  reserved_cents: number;
  spent_cents: number;
}

interface TaskRow {
  id: string;
  target_id: string;
  title: string;
  spec: unknown;
  est_cost_cents: number;
  max_cost_cents: number;
  model: string;
  /** Reasoning tier ('low' | 'medium' | 'high'); the runner maps it to a model. */
  effort?: string;
  sensitivity: string;
  status: string;
  assigned_dev_id: string | null;
  lock_expires_at: string | null;
  actual_cost_cents: number | null;
  result: unknown;
}

/**
 * Lock a dev's budget row for a given period FOR UPDATE. This is the
 * serialization point: concurrent operations by the same dev block here so two
 * checkouts can't both pass the budget check on stale reads. Returns null if no
 * budget row exists for that period (we never auto-create one).
 *
 * `period` defaults to the current month. submit/release/expire pass the task's
 * original `reserved_period` so a lock that straddles a month boundary frees the
 * reservation from the period it was made in, not from "now".
 */
async function lockDevBudget(
  client: Client,
  devId: string,
  period?: string | null,
): Promise<DevBudgetRow | null> {
  const { rows } = await client.query<DevBudgetRow>(
    `SELECT dev_id, period, budget_cents, reserved_cents, spent_cents
       FROM dev_budgets
      WHERE dev_id = $1 AND period = COALESCE($2::date, ${CURRENT_PERIOD})
      FOR UPDATE`,
    [devId, period ?? null],
  );
  return rows[0] ?? null;
}

/**
 * The accounting period a task's reservation was made in (set at checkout).
 * NULL for never-checked-out tasks or rows predating the column — callers treat
 * NULL as "the current period".
 */
async function reservedPeriodOf(client: Client, taskId: string): Promise<string | null> {
  const { rows } = await client.query<{ reserved_period: string | null }>(
    `SELECT reserved_period FROM tasks WHERE id = $1`,
    [taskId],
  );
  return rows[0]?.reserved_period ?? null;
}

// ---------------------------------------------------------------------------
// onboarding — a newcomer's first, real piece of work
// ---------------------------------------------------------------------------

/**
 * The conjecture new contributors cut their teeth on. Goldbach is the right
 * target for a first task on every axis that matters:
 *   - a range sweep needs zero prior context, which is exactly what a newcomer has;
 *   - it has a deterministic built-in checker, so the result auto-verifies and no
 *     human ever has to look at it (200 signups in a week cost zero review minutes);
 *   - distinct ranges mean two newcomers never collide or duplicate each other;
 *   - the overwhelmingly likely outcome — nothing found — is a real contribution,
 *     not a failure, so a first run cannot "go wrong" in a discouraging way.
 */
export const ONBOARDING_SLUG = 'goldbach';

/**
 * The onboarding task's hard cap. Defined in goldbach.ts (which the CLI bundle
 * can import — it has no `pg` dependency) and re-exported here, so the guided
 * flow's "do you have enough left to mint?" check and the mint's own guard are
 * the same number.
 */
export { ONBOARDING_MAX_CENTS };

const ONBOARDING_EST_CENTS = 3;

/** Where the sweep cursor starts if the target has never been swept. */
const ONBOARDING_CURSOR_START = 4;

export interface OnboardingTask {
  task_id: string;
  title: string;
  /** The task's current status — 'open' to run, or further along on a resumed call. */
  status: string;
  target_slug: string;
  target_name: string;
  range_start: number;
  range_end: number;
  /** Even numbers this sweep rules out. */
  candidates: number;
  max_cost_cents: number;
  /** True when this returned the dev's existing task instead of minting a new one. */
  existing: boolean;
}

interface OnboardingRow {
  task_id: string;
  title: string;
  status: string;
  max_cost_cents: number;
  spec: { range_start?: number; range_end?: number } | null;
  target_slug: string | null;
  target_name: string;
}

function projectOnboarding(row: OnboardingRow, existing: boolean): OnboardingTask {
  const start = row.spec?.range_start ?? 0;
  const end = row.spec?.range_end ?? 0;
  return {
    task_id: row.task_id,
    title: row.title,
    status: row.status,
    target_slug: row.target_slug ?? ONBOARDING_SLUG,
    target_name: row.target_name,
    range_start: start,
    range_end: end,
    candidates: Math.max(0, Math.floor((end - start) / 2)),
    max_cost_cents: row.max_cost_cents,
    existing,
  };
}

const ONBOARDING_SELECT = `
  SELECT t.id AS task_id, t.title, t.status::text AS status, t.max_cost_cents, t.spec,
         tg.slug AS target_slug, tg.name AS target_name
    FROM tasks t JOIN targets tg ON tg.id = t.target_id
   WHERE t.onboarding_dev_id = $1`;

/** Human-readable thousands separators, locale-independent. */
function groupDigits(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** The task spec handed to the volunteer's agent. Platform-authored; no user input. */
function onboardingSpec(start: number, end: number, candidates: number) {
  return {
    deliverable: 'math_attack',
    angle: 'range sweep',
    range_start: start,
    range_end: end,
    prompt:
      `Goldbach's conjecture states that every even integer greater than 2 is the sum of ` +
      `two primes. It is open: nobody has proved it, and nobody has found a counterexample.\n\n` +
      `Your assigned range is [${start}, ${end}) — the ${groupDigits(candidates)} even numbers in it. ` +
      `Nobody else on Givework has this range; it was allocated to you alone.\n\n` +
      `For every even n in that range, decide whether n can be written as p + q with p and q ` +
      `prime. If you can execute code, do the sweep properly with a sieve and report the ` +
      `statistics below; if you cannot execute code, reason it out and report what you can ` +
      `stand behind.\n\n` +
      `Report ONLY these findings. The expected, correct outcome is an empty ` +
      `counterexamples list — every even number in the range decomposes. That is not a ` +
      `failure and it is not "no result": it is ${groupDigits(candidates)} candidates ruled ` +
      `out, and it is recorded permanently as your contribution. Do not invent a ` +
      `counterexample, and do not apologise for not finding one.\n\n` +
      `Only claim a counterexample if you have an even n for which you exhaustively checked ` +
      `every prime p <= n/2 and found n - p composite in every case. The control plane ` +
      `re-runs this entire range itself and compares against what you report, so a guess ` +
      `will be caught and the work discarded.`,
    output_schema: {
      range_start: 'integer — echo back the assigned range start',
      range_end: 'integer — echo back the assigned range end',
      counterexamples: 'array of integers — even n with no two-prime sum; almost certainly []',
      max_min_prime:
        'integer, OPTIONAL — the largest "smallest prime summand" needed anywhere in the ' +
        'range. Include this ONLY if you actually computed it by running code; omit it ' +
        'entirely otherwise. A wrong value fails verification.',
      summary: 'string — one or two sentences on what you swept and what you found',
    },
    acceptance:
      `range_start and range_end must equal the assigned range. counterexamples must list ` +
      `only genuine counterexamples (verified by re-running the sweep in the control plane). ` +
      `An empty list on the full range is a pass.`,
    suggested_timeout_ms: 300_000,
  };
}

/**
 * Mint (or return) this dev's onboarding task: one real attack task on a live
 * open problem, with a range nobody else has been given.
 *
 * Three properties this has to hold, and how:
 *
 *  - *Per-dev, not pooled.* The task carries `onboarding_dev_id`. A pooled task
 *    would be claimed once and then be missing for every other newcomer, so these
 *    are hidden from the shared pool (listOpenTasks / listAvailableTasks) and
 *    checkoutTask refuses them to anyone else.
 *
 *  - *Distinct ranges.* The range comes from a cursor on the target row, taken
 *    under `SELECT … FOR UPDATE`. Concurrent mints serialize on that row lock, so
 *    each one reads a cursor that already includes every block handed out before
 *    it. Blocks therefore tile the number line with no overlap and no gaps.
 *    Lock order is dev_budgets → targets, matching submitResult, so this cannot
 *    deadlock against the rest of the system.
 *
 *  - *Idempotent.* Asking twice returns the same task. Enforced twice over: a
 *    re-read after taking the budget lock (which, under READ COMMITTED, sees any
 *    concurrent mint that just committed) and a UNIQUE index on onboarding_dev_id
 *    as the database-level backstop.
 *
 * The budget guard is NOT special-cased. A dev with no budget, or with less than
 * the task reserves, is refused here with a message that says what to do — and
 * checkoutTask would refuse it again anyway, which is the authoritative gate.
 */
export async function mintOnboardingTask(devId: string): Promise<OnboardingTask> {
  const minted = await withTransaction(async (client) => {
    // Fast path: already have one? Answered before the budget lock so a resumed
    // run works even in a later period, where the dev has no budget row yet.
    const pre = await client.query<OnboardingRow>(ONBOARDING_SELECT, [devId]);
    if (pre.rows[0]) return { row: pre.rows[0], existing: true };

    // Lock the dev's budget row — the same serialization point every other
    // state change uses, and the pre-check that lets us refuse with a good
    // message instead of minting a task they cannot afford to run.
    const budget = await lockDevBudget(client, devId);
    if (!budget) {
      throw new OpError(
        RESERVE_INSUFFICIENT_BUDGET,
        'no_budget',
        'No budget set for this month. Choose how much of your own Claude credit to donate first, e.g.  givework budget set 500',
      );
    }
    const available = budget.budget_cents - budget.reserved_cents - budget.spent_cents;
    if (available < ONBOARDING_MAX_CENTS) {
      throw new OpError(
        RESERVE_INSUFFICIENT_BUDGET,
        'insufficient_budget',
        `This task reserves ${ONBOARDING_MAX_CENTS} cents and you have ${available} available. Raise your cap, e.g.  givework budget set 500`,
      );
    }

    // Re-check under the lock: a concurrent mint for this dev blocked on the
    // budget row above, so this read now sees its committed task.
    const again = await client.query<OnboardingRow>(ONBOARDING_SELECT, [devId]);
    if (again.rows[0]) return { row: again.rows[0], existing: true };

    // Allocate a range by advancing the target's cursor under a row lock.
    const tgt = await client.query<{ id: string; name: string; slug: string; cursor: number }>(
      `SELECT id, name, slug, COALESCE(sweep_cursor, $2::bigint) AS cursor
         FROM targets
        WHERE slug = $1
        FOR UPDATE`,
      [ONBOARDING_SLUG, ONBOARDING_CURSOR_START],
    );
    const target = tgt.rows[0];
    if (!target) {
      throw new OpError(
        CONFLICT,
        'onboarding_unavailable',
        `The onboarding conjecture ("${ONBOARDING_SLUG}") is not seeded on this control plane`,
      );
    }
    const range = blockAt(Number(target.cursor), ONBOARDING_CANDIDATES);
    await client.query(`UPDATE targets SET sweep_cursor = $2 WHERE id = $1`, [
      target.id,
      range.end,
    ]);

    const title = `Goldbach sweep ${groupDigits(range.start)}–${groupDigits(range.end)}`;
    const inserted = await client.query<{ task_id: string }>(
      `INSERT INTO tasks
         (target_id, title, spec, est_cost_cents, max_cost_cents, effort, kind, verify_via,
          sensitivity, onboarding_dev_id)
       VALUES ($1, $2, $3, $4, $5, 'low'::task_effort, 'computational'::task_kind,
               'auto_rerun'::verification_method, 'public', $6)
       RETURNING id AS task_id`,
      [
        target.id,
        title,
        JSON.stringify(onboardingSpec(range.start, range.end, range.candidates)),
        ONBOARDING_EST_CENTS,
        ONBOARDING_MAX_CENTS,
        devId,
      ],
    );
    // Funnel: on this connection, under a savepoint (see recordEvent) — no second
    // connect, and an analytics failure cannot lose the dev their minted task.
    await recordEvent(
      devId,
      'onboarding_minted',
      { task_id: inserted.rows[0].task_id, range: [range.start, range.end] },
      client,
    );
    return {
      row: {
        task_id: inserted.rows[0].task_id,
        title,
        status: 'open',
        max_cost_cents: ONBOARDING_MAX_CENTS,
        spec: { range_start: range.start, range_end: range.end },
        target_slug: target.slug,
        target_name: target.name,
      } satisfies OnboardingRow,
      existing: false,
    };
  }).catch(async (err: any) => {
    // Belt and braces: the UNIQUE index on onboarding_dev_id is the last word on
    // "one task per dev". If it ever fires, hand back the task that won.
    if (err?.code !== '23505') throw err;
    const { rows } = await query<OnboardingRow>(ONBOARDING_SELECT, [devId]);
    if (!rows[0]) throw err;
    return { row: rows[0], existing: true };
  });

  return projectOnboarding(minted.row, minted.existing);
}

// ---------------------------------------------------------------------------
// checkout
// ---------------------------------------------------------------------------

/** A recent chunk of work on a task, surfaced to the next agent that picks it up. */
export interface ContributionSummary {
  id: number;
  outcome: string;
  summary: string;
  artifact_uri: string | null;
  /**
   * Inline artifact, hydrated by checkoutTask ONLY when the next agent needs
   * the full thing: a salvaged invalid decomposition (`validation_errors`), a
   * peer review's rejection (`review_rejected`), or a failed Lean proof-check
   * build (`compiler_output` — the exact errors a corrected .lean source must
   * fix). Other contributions' artifacts stay out of the checkout payload:
   * they default to the whole executor result and would bloat every prompt.
   */
  artifact?: unknown;
  cost_cents: number;
  created_at: string;
}

export interface CheckoutResult {
  task_id: string;
  spec: unknown;
  title: string;
  model: string;
  max_cost_cents: number;
  lock_expires_at: string;
  /**
   * The target's compacted working set — the board state an incoming agent reads
   * first (current frontier, live sub-goals, known dead ends, suggested next
   * step). Kept small deliberately; the full history is in `contributions`.
   */
  target_state: unknown;
  /** The most recent contributions to this task, newest first — what's been tried. */
  prior_contributions: ContributionSummary[];
  /** The target's public slug (null for unslugged targets) — display/analytics context. */
  target_slug: string | null;
  /** The task's kind ('computational' | 'exploration' | ...) — display/analytics context. */
  task_kind: string;
}

/** How many recent contributions to hydrate into a checkout's context. */
const PRIOR_CONTRIBUTIONS_LIMIT = 5;

/**
 * Lazy lease expiry — belt and braces beside the cron sweep. A lock whose
 * lock_expires_at has passed is reclaimable by design, but the claim queries
 * guard on status='open', so until expire() runs the task is invisible and its
 * reservation blocks the volunteer's budget. The cron trigger runs expire()
 * every 5 minutes; this makes the pool-facing reads self-healing too, so a
 * lapsed lock never gates on the next cron tick. Best-effort: a failure here
 * must never fail the read/checkout it piggybacks on.
 */
async function reclaimLapsedLocks(): Promise<void> {
  try {
    const { rows } = await query(
      `SELECT 1 FROM tasks WHERE status = 'locked' AND lock_expires_at < now() LIMIT 1`,
    );
    if (rows.length > 0) await expire();
  } catch (err) {
    console.error('lazy lease-expiry sweep failed (continuing):', err);
  }
}

/**
 * Atomically reserve budget and lock an open task to a dev for 10 minutes.
 * Order matters: lock the budget row first (serialization point), then claim
 * the task, then mutate budget, then write the ledger row.
 *
 * A task sitting under a LAPSED lock (status='locked' but lock_expires_at has
 * passed) is reclaimable by design: the attempt below detects it inside its
 * own transaction (no extra query on the happy path — the donation path's
 * one-connection budget is load-bearing, see funnel.test), then runs the
 * expiry sweep and retries once. Without this, a stranded task answers
 * task_not_open until the next cron tick even though its lease is over.
 */
export async function checkoutTask(devId: string, taskId: string): Promise<CheckoutResult> {
  try {
    return await attemptCheckout(devId, taskId);
  } catch (err) {
    if (err instanceof OpError && err.code === LAPSED_LOCK_RETRY) {
      await expire().catch((sweepErr) => {
        console.error('lease-expiry sweep during checkout failed (continuing):', sweepErr);
      });
      try {
        return await attemptCheckout(devId, taskId);
      } catch (retryErr) {
        // Still lapsed-locked (the sweep failed or lost a race): surface the
        // public shape, never the internal retry sentinel.
        if (retryErr instanceof OpError && retryErr.code === LAPSED_LOCK_RETRY) {
          throw new OpError(CONFLICT, 'task_not_open', 'Task already claimed or not open');
        }
        throw retryErr;
      }
    }
    throw err;
  }
}

/** Internal sentinel: the task's lock has lapsed — sweep and retry the checkout. */
const LAPSED_LOCK_RETRY = 'task_lock_lapsed_retry';

async function attemptCheckout(devId: string, taskId: string): Promise<CheckoutResult> {
  const result = await withTransaction(async (client) => {
    // 1. Lock the dev's current-period budget row.
    const budget = await lockDevBudget(client, devId);
    if (!budget) {
      // No budget configured for this period — do not auto-create.
      throw new OpError(
        RESERVE_INSUFFICIENT_BUDGET,
        'no_budget',
        'No budget configured for the current period',
      );
    }

    // Need the task's cost (budget gate), sensitivity (trust gate) and owner
    // (onboarding gate) up front.
    const taskRes = await client.query<
      TaskRow & { onboarding_dev_id: string | null; lock_lapsed: boolean }
    >(
      `SELECT id, max_cost_cents, status, sensitivity, onboarding_dev_id,
              (status = 'locked' AND lock_expires_at < now()) AS lock_lapsed
         FROM tasks WHERE id = $1`,
      [taskId],
    );
    const task = taskRes.rows[0];
    if (!task) {
      throw new OpError(404, 'task_not_found', 'Unknown task');
    }
    // Onboarding tasks belong to one dev. They're already hidden from the shared
    // pool, but this is the authoritative gate: a newcomer's first task must
    // still be waiting for them however someone else learned its id.
    if (task.onboarding_dev_id && task.onboarding_dev_id !== devId) {
      throw new OpError(
        403,
        'not_your_task',
        "This is another contributor's onboarding task and is reserved for them",
      );
    }
    // Report an already-claimed task as such, rather than letting the budget gate
    // below mask it as a misleading 402. The claim UPDATE still guards on
    // status='open', so this is just clearer up-front error reporting.
    if (task.status !== 'open') {
      if (task.lock_lapsed) {
        // Reclaimable, not gone: bubble the internal sentinel so checkoutTask
        // sweeps the lapsed lock and retries this claim once.
        throw new OpError(CONFLICT, LAPSED_LOCK_RETRY, 'Task lock has lapsed; sweep and retry');
      }
      throw new OpError(CONFLICT, 'task_not_open', 'Task already claimed or not open');
    }

    // Trust gate: non-public work must never reach an unverified (self-serve,
    // unvetted) dev. This is the authoritative enforcement point — listOpenTasks
    // also hides these, but checkout is what actually protects the payload. Read
    // verified from the DB (not the token) so an admin's verification takes effect
    // immediately, without waiting for the dev's 90-day token to roll over.
    if (task.sensitivity !== 'public') {
      const dev = await client.query<{ verified: boolean }>(
        `SELECT verified FROM devs WHERE id = $1`,
        [devId],
      );
      if (!dev.rows[0]?.verified) {
        throw new OpError(
          403,
          'not_verified',
          'This task requires a verified developer; ask an admin to verify your account',
        );
      }
    }

    // 2. Budget gate.
    const available = budget.budget_cents - budget.reserved_cents - budget.spent_cents;
    if (available < task.max_cost_cents) {
      throw new OpError(
        RESERVE_INSUFFICIENT_BUDGET,
        'insufficient_budget',
        `Available ${available} < required ${task.max_cost_cents}`,
      );
    }

    // 3. Claim the task. Guard on status='open' so a concurrent winner causes
    //    0 rows affected -> 409.
    const claim = await client.query<TaskRow & { kind: string }>(
      `UPDATE tasks
          SET status = 'locked',
              assigned_dev_id = $2,
              lock_expires_at = now() + interval '10 minutes',
              reserved_period = ${CURRENT_PERIOD}
        WHERE id = $1 AND status = 'open'
        RETURNING id, target_id, title, spec, model, effort::text AS effort, max_cost_cents,
                  lock_expires_at, kind::text AS kind`,
      [taskId, devId],
    );
    if (claim.rowCount === 0) {
      throw new OpError(CONFLICT, 'task_not_open', 'Task already claimed or not open');
    }
    const claimed = claim.rows[0];

    // 4. Reserve the hard cap.
    await client.query(
      `UPDATE dev_budgets
          SET reserved_cents = reserved_cents + $2
        WHERE dev_id = $1 AND period = ${CURRENT_PERIOD}`,
      [devId, task.max_cost_cents],
    );

    // 5. Ledger: +max_cost reserved.
    await client.query(
      `INSERT INTO ledger (task_id, dev_id, target_id, event_type, delta_cents)
       VALUES ($1, $2, $3, 'checkout', $4)`,
      [taskId, devId, claimed.target_id, task.max_cost_cents],
    );

    // 6. Hydrate the incoming agent's context: the target's compacted working
    //    set plus the most recent chunks tried on this task (progress and dead
    //    ends), so a bounded budget continues the work instead of restarting it.
    const stateRes = await client.query<{ state: unknown; slug: string | null }>(
      `SELECT state, slug FROM targets WHERE id = $1`,
      [claimed.target_id],
    );
    //    A salvaged invalid decomposition additionally hydrates its inline
    //    artifact (the full proposal + validation_errors) so the next agent can
    //    resubmit it corrected; a peer review's rejection hydrates its
    //    review_rejected artifact (the reviewer's reasons) so the next agent
    //    addresses the verdict instead of resubmitting the same proposal into
    //    another burned review round; and a failed Lean proof-check build
    //    hydrates its compiler_output artifact (the exact compile errors) so
    //    the corrected .lean source is written against them, not re-guessed.
    //    Other artifacts stay out of the payload (they default to the whole
    //    executor result), and a pathologically large one is skipped rather
    //    than shipped.
    const prior = await client.query<ContributionSummary>(
      `SELECT id, outcome, summary, artifact_uri, cost_cents, created_at,
              CASE WHEN (artifact ? 'validation_errors' OR artifact ? 'review_rejected'
                         OR artifact ? 'compiler_output')
                    AND octet_length(artifact::text) <= ${SALVAGED_ARTIFACT_HYDRATE_MAX_BYTES}
                   THEN artifact END AS artifact
         FROM contributions
        WHERE task_id = $1
        ORDER BY id DESC
        LIMIT $2`,
      [taskId, PRIOR_CONTRIBUTIONS_LIMIT],
    );

    // 7. Funnel: on THIS connection, inside this transaction, under a savepoint.
    //    Analytics must not cost a second database connect on the donation path
    //    (on Workers every query() opens its own client), and the savepoint means
    //    a failed insert rolls back to here rather than failing the checkout.
    //    Every checkout is logged; "first checkout" is derived by counting per dev.
    await recordEvent(
      devId,
      'checkout',
      { task_id: claimed.id, max_cost_cents: claimed.max_cost_cents },
      client,
    );

    return {
      task_id: claimed.id,
      spec: claimed.spec,
      title: claimed.title,
      model: claimed.model,
      effort: claimed.effort,
      max_cost_cents: claimed.max_cost_cents,
      lock_expires_at: claimed.lock_expires_at as string,
      target_state: stateRes.rows[0]?.state ?? {},
      prior_contributions: prior.rows,
      target_slug: stateRes.rows[0]?.slug ?? null,
      task_kind: claimed.kind,
    };
  });
  return result;
}

// ---------------------------------------------------------------------------
// submit
// ---------------------------------------------------------------------------

export type ContributionOutcome = 'progress' | 'dead_end' | 'candidate_solution' | 'decomposition';
const CONTRIBUTION_OUTCOMES: readonly ContributionOutcome[] = [
  'progress',
  'dead_end',
  'candidate_solution',
  'decomposition',
];

// ---------------------------------------------------------------------------
// recursive decomposition — a task too big for its budget splits itself,
// gated by a peer volunteer's agent (never an admin button)
// ---------------------------------------------------------------------------

/**
 * Fan-out caps, differentiated by what a subtask costs to work:
 *  - a MODEL subtask spends a claiming volunteer's real Claude credit per
 *    attempt, so a proposal may mint at most 12 of them;
 *  - a sandbox CHUNK subtask is CPU only — it carries `code` pinning an
 *    already-merged program (the work-unit shape: repo + 40-hex sha +
 *    entrypoint), every chunk in the proposal pins the SAME program, and the
 *    donation is podman time, not tokens — so the sweep shape may fan wider,
 *    up to 64. Each class is counted against its own cap.
 */
export const MAX_DECOMPOSITION_SUBTASKS = 12;
export const MAX_DECOMPOSITION_CHUNKS = 64;
/** Each subtask's cap may be at most this multiple of the parent task's cap. */
export const DECOMPOSITION_CAP_MULTIPLE = 2;
/** The auto-minted review task: small, deliberately — it's a judgment call, not a computation. */
export const REVIEW_TASK_MAX_CENTS = 15;
const REVIEW_TASK_EST_CENTS = 5;

const SUBTASK_TITLE_CHARS = 200;
const SUBTASK_PROMPT_CHARS = 4000;
const DECOMPOSITION_REASON_CHARS = 2000;

const TASK_KINDS = [
  'computational',
  'counterexample_search',
  'formalization',
  'lemma',
  'exploration',
];
const TASK_EFFORTS = ['low', 'medium', 'high'];
const VERIFY_METHODS = ['auto_rerun', 'proof_checker', 'replication', 'human_review'];

/** The pinned-program marker that makes a subtask a sandbox CHUNK, not a model call. */
export interface ChunkCode {
  /** owner/name of the allowlisted contrib repo. */
  repo: string;
  /** Full 40-hex commit SHA — content-addressed, never a branch or tag. */
  sha: string;
  /** Repo-relative path of the script to run. */
  entrypoint: string;
  /** The slice this chunk covers, handed to the program on stdin. */
  input?: unknown;
}

export interface ProposedSubtask {
  title: string;
  prompt: string;
  kind: string;
  effort: string;
  verify_via: string;
  est_cost_cents: number;
  max_cost_cents: number;
  /** Present iff this subtask is a sandbox chunk (see ChunkCode / the 64 cap). */
  code?: ChunkCode;
}

export interface DecompositionProposal {
  reason: string;
  subtasks: ProposedSubtask[];
}

/** Validate one subtask's `code` marker into the exact work-unit shape, or throw. */
function normalizeChunkCode(raw: unknown, i: number, bad: (msg: string) => never): ChunkCode {
  const c = raw as Record<string, unknown> | null | undefined;
  const repo = typeof c?.repo === 'string' ? c.repo.trim() : '';
  const sha = typeof c?.sha === 'string' ? c.sha.trim().toLowerCase() : '';
  const entrypoint = typeof c?.entrypoint === 'string' ? c.entrypoint.trim() : '';
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    bad(`subtask ${i}: code.repo must be an owner/name repo`);
  }
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    bad(`subtask ${i}: code.sha must be a full 40-hex commit SHA (a pinned, merged program)`);
  }
  if (!entrypoint || entrypoint.length > 300 || entrypoint.startsWith('/')) {
    bad(`subtask ${i}: code.entrypoint must be a repo-relative path`);
  }
  if (entrypoint.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) {
    bad(`subtask ${i}: code.entrypoint must not contain empty/dot segments`);
  }
  return {
    repo,
    sha,
    entrypoint,
    ...(c && 'input' in c ? { input: c.input } : {}),
  };
}

/**
 * What checking an agent-submitted decomposition proposal found.
 *
 * `parseable` draws the salvage line, crisply: TRUE when `subtasks` is a
 * non-empty array of objects — there IS a proposal a next agent could correct
 * and resubmit, even if it broke a rule (cap breach, fan-out over the limit,
 * malformed chunk code, missing fields). FALSE when there are no parseable
 * subtasks at all (missing/empty/non-array `subtasks`, or entries that aren't
 * objects) — nothing worth preserving, and the submit hard-rejects as before.
 */
export interface DecompositionValidation {
  /** The fully-normalized proposal — set iff `errors` is empty. */
  proposal: DecompositionProposal | null;
  /**
   * Every rule the proposal broke (one per failing subtask, plus any fan-out /
   * same-program violations). Empty iff `proposal` is set.
   */
  errors: string[];
  /** See above: false means hard-reject, true + errors means salvageable. */
  parseable: boolean;
}

/**
 * Validate + normalize an agent-submitted decomposition proposal, collecting
 * every violation instead of stopping at the first — the errors are preserved
 * for the NEXT agent when an invalid-but-parseable proposal is salvaged as a
 * progress contribution (see submitResult). Strict where money and volume are
 * concerned (integer cents, per-subtask cap <= 2x the parent's, and the
 * differentiated fan-out caps: <= 12 model subtasks, <= 64 sandbox chunks —
 * each class against its own cap); lenient on the hint fields (an unknown
 * kind/effort/verify_via falls back to a safe default rather than losing an
 * otherwise sound plan).
 *
 * The chunk marker is crisp: a subtask is a CHUNK iff it carries `code` in the
 * work-unit shape ({repo, 40-hex sha, entrypoint, input?}) — i.e. it names an
 * ALREADY-pinned program the sandbox can run without any model call — and all
 * chunks in one proposal must pin the SAME repo+sha+entrypoint (one program,
 * many slices; only `input` varies). A malformed `code` is an error, never
 * silently reclassified as a model subtask. If the program doesn't exist yet
 * (two-phase pattern, phase 1 pending), the proposal can't mint chunks yet —
 * it proposes the code-writing task now and a later decomposition fans out
 * the chunks once the SHA exists.
 */
export function validateDecomposition(
  raw: unknown,
  parentMaxCents: number,
): DecompositionValidation {
  const r = raw as { reason?: unknown; subtasks?: unknown } | null | undefined;
  const list = r?.subtasks;
  if (!Array.isArray(list) || list.length === 0) {
    return {
      proposal: null,
      parseable: false,
      errors: ['decomposition.subtasks must be a non-empty array'],
    };
  }
  const nonObject = list.findIndex((s) => s == null || typeof s !== 'object' || Array.isArray(s));
  if (nonObject !== -1) {
    return {
      proposal: null,
      parseable: false,
      errors: [`subtask ${nonObject}: must be an object`],
    };
  }

  const errors: string[] = [];
  const bad = (msg: string): never => {
    throw new OpError(BAD_INPUT, 'bad_decomposition', msg);
  };
  const capCeiling = parentMaxCents * DECOMPOSITION_CAP_MULTIPLE;
  // Per-subtask: the first broken rule is recorded and validation moves on to
  // the next subtask, so one bad slice doesn't hide the others' problems.
  const subtasks: ProposedSubtask[] = [];
  (list as any[]).forEach((s, i) => {
    try {
      const title =
        typeof s?.title === 'string' ? s.title.trim().slice(0, SUBTASK_TITLE_CHARS) : '';
      const prompt =
        typeof s?.prompt === 'string' ? s.prompt.trim().slice(0, SUBTASK_PROMPT_CHARS) : '';
      if (!title) bad(`subtask ${i}: title is required`);
      if (!prompt) bad(`subtask ${i}: prompt is required`);
      const max = s?.max_cost_cents;
      if (!Number.isInteger(max) || max <= 0) {
        bad(`subtask ${i}: max_cost_cents must be a positive integer (money is integer cents)`);
      }
      if (max > capCeiling) {
        bad(
          `subtask ${i}: max_cost_cents ${max} exceeds ${DECOMPOSITION_CAP_MULTIPLE}x the parent task's cap (${capCeiling})`,
        );
      }
      const est = s?.est_cost_cents === undefined ? max : s.est_cost_cents;
      if (!Number.isInteger(est) || est <= 0 || est > max) {
        bad(`subtask ${i}: est_cost_cents must be a positive integer <= max_cost_cents`);
      }
      const code = s?.code != null ? normalizeChunkCode(s.code, i, bad) : undefined;
      subtasks.push({
        title,
        prompt,
        // A pinned-program chunk is computational/cheap by nature; valid hints still win.
        kind: TASK_KINDS.includes(s?.kind)
          ? (s.kind as string)
          : code
            ? 'computational'
            : 'exploration',
        effort: TASK_EFFORTS.includes(s?.effort) ? (s.effort as string) : code ? 'low' : 'medium',
        verify_via: VERIFY_METHODS.includes(s?.verify_via)
          ? (s.verify_via as string)
          : 'human_review',
        est_cost_cents: est as number,
        max_cost_cents: max as number,
        ...(code ? { code } : {}),
      });
    } catch (err) {
      if (err instanceof OpError && err.code === 'bad_decomposition') {
        errors.push(err.message);
      } else {
        throw err;
      }
    }
  });

  // Differentiated fan-out: each class counted against its own cap. Counted
  // over the subtasks that normalized cleanly — when some already failed, the
  // per-subtask errors above dominate anyway.
  const chunks = subtasks.filter((s) => s.code);
  const modelCount = subtasks.length - chunks.length;
  if (modelCount > MAX_DECOMPOSITION_SUBTASKS) {
    errors.push(
      `a proposal may have at most ${MAX_DECOMPOSITION_SUBTASKS} model-executed subtasks ` +
        `(got ${modelCount}; only pinned-code sandbox chunks may fan wider)`,
    );
  }
  if (chunks.length > MAX_DECOMPOSITION_CHUNKS) {
    errors.push(`a proposal may have at most ${MAX_DECOMPOSITION_CHUNKS} sandbox chunk subtasks`);
  }
  // One program, many slices: every chunk must pin the same repo+sha+entrypoint.
  if (chunks.length > 0) {
    const first = chunks[0].code as ChunkCode;
    const differs = chunks.some(
      (c) =>
        c.code!.repo !== first.repo ||
        c.code!.sha !== first.sha ||
        c.code!.entrypoint !== first.entrypoint,
    );
    if (differs) {
      errors.push('all chunk subtasks in a proposal must pin the same repo+sha+entrypoint');
    }
  }

  if (errors.length > 0) {
    return { proposal: null, parseable: true, errors };
  }
  const reason = typeof r?.reason === 'string' ? r.reason.slice(0, DECOMPOSITION_REASON_CHARS) : '';
  return { proposal: { reason, subtasks }, parseable: true, errors: [] };
}

/**
 * Strict form of validateDecomposition: the normalized proposal, or throw
 * OpError('bad_decomposition') on the first violation. Used where an invalid
 * proposal has no salvage path (the publish step's defense-in-depth re-check).
 */
export function normalizeDecomposition(
  raw: unknown,
  parentMaxCents: number,
): DecompositionProposal {
  const v = validateDecomposition(raw, parentMaxCents);
  if (!v.proposal) {
    throw new OpError(BAD_INPUT, 'bad_decomposition', v.errors[0]);
  }
  return v.proposal;
}

/**
 * Bound a salvaged raw proposal before storing it on the contribution row: an
 * invalid proposal never went through normalization's per-field caps, so a
 * pathological payload is clipped — with an explicit marker, never silently —
 * rather than bloating the contributions table and every later checkout that
 * hydrates it.
 */
function boundedProposal(proposed: unknown): unknown {
  let json: string;
  try {
    json = JSON.stringify(proposed) ?? 'null';
  } catch {
    return { truncated: true, note: 'proposal was not JSON-serializable' };
  }
  if (Buffer.byteLength(json) <= MAX_STATE_BYTES) return proposed;
  return {
    truncated: true,
    note: `proposal JSON exceeded ${MAX_STATE_BYTES} bytes; prefix preserved`,
    prefix: json.slice(0, MAX_STATE_BYTES),
  };
}

/** Reserved keys in a state_update — routed, never stored in the blob. */
const STATE_FACTS_KEY = 'facts';
const STATE_RETRACT_KEY = '$retract';

export interface ParsedStateUpdate {
  /** The merged working set to store on targets.state. */
  state: Record<string, unknown>;
  /** Claims to append to target_facts. */
  facts: string[];
  /** Working-set keys the agent explicitly dropped. */
  retracted: string[];
}

/**
 * Merge a state_update into the existing working set instead of replacing it.
 *
 * The old behaviour was `UPDATE targets SET state = $2` — last writer wins over
 * the whole blob. That forced every agent to reconstruct the entire working set
 * from scratch just to add one key, so any submit could silently destroy what
 * earlier work had established, and any key an agent did not recognise got
 * copied forward forever because dropping it looked exactly like vandalism.
 *
 * Now:
 *   - unknown keys are merged per key, so adding one thing cannot drop another;
 *   - `facts: [...]` is routed to the append-only target_facts table, out of
 *     reach of both the blob cap and the next writer;
 *   - `$retract: ["key", ...]` is the ONLY way to remove a working-set key, so
 *     dropping stale scaffolding is a deliberate, attributable act rather than
 *     a side effect of omission. This is what lets an agent clean up after a
 *     dead end without an admin editing the field by hand.
 *
 * A non-object update (scalar, array, null) replaces wholesale, as before —
 * targets seeded with a bare cursor keep working untouched.
 */
export function mergeStateUpdate(existing: unknown, update: unknown): ParsedStateUpdate {
  const isPlain = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === 'object' && !Array.isArray(v);
  if (!isPlain(update)) {
    return { state: update as Record<string, unknown>, facts: [], retracted: [] };
  }

  // Facts may be given as plain strings or as {claim} objects — an agent
  // writing structured output shouldn't have to guess which we take.
  const rawFacts = update[STATE_FACTS_KEY];
  const facts: string[] = [];
  if (Array.isArray(rawFacts)) {
    for (const f of rawFacts) {
      const claim = typeof f === 'string' ? f : isPlain(f) ? String(f.claim ?? '') : '';
      const trimmed = claim.trim();
      if (trimmed) facts.push(trimmed);
    }
  }

  const rawRetract = update[STATE_RETRACT_KEY];
  const retracted = Array.isArray(rawRetract)
    ? rawRetract.filter((k): k is string => typeof k === 'string' && k.length > 0)
    : [];

  // A truncation marker is a tombstone the platform wrote, not a working set an
  // agent built, so the next real update REPLACES it rather than merging into
  // it. Merging would pin `truncated`/`note`/`tail` in place permanently — a
  // fresh species of exactly the sticky debris this function exists to end.
  const isTombstone = isPlain(existing) && existing.truncated === true && 'tail' in existing;
  const base = isPlain(existing) && !isTombstone ? { ...existing } : {};
  for (const [k, v] of Object.entries(update)) {
    if (k === STATE_FACTS_KEY || k === STATE_RETRACT_KEY) continue;
    base[k] = v;
  }
  for (const k of retracted) delete base[k];
  // Never let a retired reserved key survive in the stored blob.
  delete base[STATE_FACTS_KEY];
  delete base[STATE_RETRACT_KEY];
  return { state: base, facts, retracted };
}

/**
 * Bound a state_update to MAX_STATE_BYTES by truncating instead of rejecting.
 * By the time a submit carries an oversized state the volunteer's tokens are
 * already burned, so failing the whole submit over a size cap would discard
 * real work AND leave the real spend unbooked (the old behaviour). Keep the
 * TAIL of the serialized state — new material (e.g. a salvage merged in beside
 * accumulated state) lands at the end of the object, so the newest content is
 * what survives — under an explicit marker, never silently.
 */
function boundedStateUpdate(proposed: unknown): { state: unknown; truncated: boolean } {
  let json: string;
  try {
    json = JSON.stringify(proposed) ?? 'null';
  } catch {
    return {
      state: { truncated: true, note: 'state_update was not JSON-serializable' },
      truncated: true,
    };
  }
  if (Buffer.byteLength(json) <= MAX_STATE_BYTES) return { state: proposed, truncated: false };
  // Slice bytes, not chars, so a multibyte-heavy state can't sneak past the cap;
  // the wrapper below adds ~200 bytes, so keep comfortable head-room.
  const buf = Buffer.from(json, 'utf8');
  const tail = buf.subarray(buf.length - (MAX_STATE_BYTES - 512)).toString('utf8');
  return {
    state: {
      truncated: true,
      note:
        `state_update JSON exceeded ${MAX_STATE_BYTES} bytes; the tail (newest content) ` +
        `was preserved and the rest dropped`,
      tail,
    },
    truncated: true,
  };
}

/** Per-file cap on code embedded into a review task's prompt. */
const REVIEW_CODE_FILE_EMBED_BYTES = 16 * 1024;
/** Total embedded-code cap per review spec — the spec rides every checkout of the review task. */
const REVIEW_CODE_TOTAL_EMBED_BYTES = 48 * 1024;

/** The loose shape of a `code_contribution` riding a submitted result. */
interface SubmittedCode {
  title: string;
  description?: string;
  files: { path: string; content: string }[];
}

/**
 * Pull the code_contribution off a submitted result, LENIENTLY: the strict
 * extractor in src/code-contrib.ts is the PUBLISH gate (it decides what may
 * become a PR); this one only decides what the reviewer and successors get to
 * SEE, and a shape the publisher rejected is exactly the kind of thing a
 * reviewer should still see. Files without both a string path and string
 * content are dropped; no files at all means no code shipped.
 */
function extractSubmittedCode(result: unknown): SubmittedCode | null {
  const cc = (result as { code_contribution?: unknown } | null | undefined)?.code_contribution;
  if (!cc || typeof cc !== 'object') return null;
  const c = cc as { title?: unknown; description?: unknown; files?: unknown };
  const files = Array.isArray(c.files)
    ? c.files.filter(
        (f): f is { path: string; content: string } =>
          f != null &&
          typeof f === 'object' &&
          typeof (f as { path?: unknown }).path === 'string' &&
          typeof (f as { content?: unknown }).content === 'string',
      )
    : [];
  if (files.length === 0) return null;
  return {
    title:
      typeof c.title === 'string' && c.title.trim().length > 0
        ? c.title.trim().slice(0, 120)
        : '(untitled code contribution)',
    ...(typeof c.description === 'string' ? { description: c.description.slice(0, 4000) } : {}),
    files,
  };
}

/**
 * Render the code that shipped WITH a decomposition proposal as a section of
 * the review task's prompt — title, every file's path and true byte size, and
 * file contents under a per-file cap and a total cap (truncation is explicit,
 * never silent). Production incident this closes: a proposer shipped its
 * simulation code as a code_contribution, the runner published the PR and set
 * artifact_uri on the CONTRIBUTION — but the minted review spec carried only
 * the decomposition JSON, so the reviewer rejected the proposal because "the
 * actual proposal contains no code_contribution key — the simulation code is
 * absent". The code must travel to the one agent whose whole job is judging it.
 */
function codeListingSection(code: SubmittedCode, codeArtifactUri: string | null): string {
  const parts: string[] = [
    `THE PROPOSAL SHIPS CODE — the same submit that carried this decomposition also delivered ` +
      `a code contribution` +
      (codeArtifactUri
        ? `; code published at: ${codeArtifactUri}`
        : ` (its pull-request publish did not complete, so the inline copy below is authoritative)`) +
      `. Judge the decomposition INCLUDING this code — never reject the proposal as "missing" ` +
      `code that is listed here.\n` +
      `Code contribution: "${code.title}"` +
      (code.description ? ` — ${code.description}` : '') +
      `\nFiles (${code.files.length}):`,
  ];
  let budget = REVIEW_CODE_TOTAL_EMBED_BYTES;
  for (const f of code.files) {
    const size = Buffer.byteLength(f.content, 'utf8');
    if (budget <= 0) {
      parts.push(
        `--- ${f.path} (${size} bytes) — content omitted: the ${REVIEW_CODE_TOTAL_EMBED_BYTES}-byte ` +
          `total embed cap is spent; the full file is in the contribution's code_contribution artifact ---`,
      );
      continue;
    }
    const cap = Math.min(REVIEW_CODE_FILE_EMBED_BYTES, budget);
    let content = f.content;
    let note = '';
    if (size > cap) {
      content = Buffer.from(f.content, 'utf8').subarray(0, cap).toString('utf8');
      note = `\n[file truncated — showing the first ${cap} of ${size} bytes]`;
    }
    budget -= Math.min(size, cap);
    parts.push(`--- ${f.path} (${size} bytes) ---\n${content}${note}`);
  }
  return parts.join('\n');
}

/**
 * The spec of the auto-minted peer-review task. spec.review_of is the proposal
 * contribution's id — it is both the pointer the publish step follows and the
 * marker that makes this task itself non-decomposable (no recursion bombs:
 * submitResult rejects a 'decomposition' outcome on any task carrying
 * review_of).
 *
 * When the proposing submit ALSO shipped code (a code_contribution in the
 * result, PR-published or not), the spec carries it to the reviewer:
 * `code_published_at` (the sibling contribution's artifact_uri) plus a full
 * listing embedded in the prompt — see codeListingSection for the incident.
 */
function reviewTaskSpec(
  contributionId: number,
  parentTitle: string,
  proposal: DecompositionProposal,
  depth: number,
  reviewedMaxCostCents: number,
  code: SubmittedCode | null = null,
  codeArtifactUri: string | null = null,
) {
  const chunkCount = proposal.subtasks.filter((s) => s.code).length;
  const codeSection = code ? codeListingSection(code, codeArtifactUri) : null;
  return {
    review_of: contributionId,
    // The REVIEWED task's cap, baked in at mint time so the executor can state
    // the caps that actually govern the proposal (2x THIS number per subtask)
    // without touching the database — the execution plane is pg-free. Without
    // it, executors computed limits from the review task's own tiny cap and
    // reviewers rejected perfectly legal subtask prices as violations.
    reviewed_max_cost_cents: reviewedMaxCostCents,
    deliverable: 'decomposition_review',
    // The sibling contribution's published code, surfaced structurally so the
    // pg-free executor can tell the reviewer code accompanies the proposal
    // without re-parsing the prompt.
    ...(codeArtifactUri ? { code_published_at: codeArtifactUri } : {}),
    ...(code
      ? {
          code_files: code.files.map((f) => ({
            path: f.path,
            bytes: Buffer.byteLength(f.content, 'utf8'),
          })),
        }
      : {}),
    prompt:
      `Another volunteer's agent judged the task "${parentTitle}" too big for its budget and ` +
      `proposed splitting it into ${proposal.subtasks.length} subtask(s)` +
      (chunkCount > 0 ? ` (${chunkCount} of them pinned-code sandbox chunks)` : '') +
      `. This is a depth-${depth} proposal` +
      (depth > 1
        ? ` — the parent task was itself published by an earlier approved decomposition, so scrutinize whether splitting AGAIN genuinely helps or is just fragmenting the work`
        : '') +
      `. Its stated reason: ` +
      `${proposal.reason || '(none given)'}\n\nThe full proposal:\n` +
      `${JSON.stringify(proposal, null, 2)}\n\n` +
      (codeSection ? `${codeSection}\n\n` : '') +
      `The reviewed task is capped at ${reviewedMaxCostCents}¢; validation allows each proposed ` +
      `subtask's max_cost_cents to be at most ${DECOMPOSITION_CAP_MULTIPLE * reviewedMaxCostCents}¢ ` +
      `(${DECOMPOSITION_CAP_MULTIPLE}x that cap). Judge the proposal's pricing against these ` +
      `numbers — never against this review task's own budget.\n\n` +
      `Evaluate whether this split is (a) sensible — each subtask is well-posed and independently ` +
      `workable; (b) economical — the cost caps are proportionate to the work, not inflated; and ` +
      `(c) faithful — completing the subtasks genuinely advances the parent problem rather than ` +
      `something adjacent. Approving publishes these subtasks as real, claimable tasks; rejecting ` +
      `leaves the proposal on the record without publishing anything. Be strict: a vague or padded ` +
      `plan should be rejected with reasons the proposer can act on.`,
    output_schema: {
      approve: 'boolean — true publishes the proposed subtasks; anything else publishes nothing',
      reasons: 'string — the concrete grounds for your verdict',
    },
    acceptance:
      'approve must be an explicit boolean and reasons must reference the actual proposal.',
  };
}

/** The crisp approve contract: publish iff the review's result carries `approve: true` (strict boolean). */
function reviewApproves(result: unknown): boolean {
  return (result as { approve?: unknown } | null | undefined)?.approve === true;
}

/**
 * Record a peer review's REJECTION where the proposer's next agent will
 * actually see it. Checkout hydration is task-scoped, but the reviewer's
 * reasons land on the REVIEW task's own contribution — so without this, the
 * proposing task's next agent never learns the proposal was rejected or why,
 * and can loop forever resubmitting the same split, each round minting a fresh
 * review task and burning both agents' spend.
 *
 * So a non-approving terminal review appends a zero-cost 'progress'
 * contribution to the PARENT task (the one whose decomposition was reviewed),
 * carrying a `review_rejected` artifact with the reviewer's reasons — the same
 * artifact-hydration channel a salvaged invalid proposal rides (checkoutTask
 * whitelists it into the next agent's continuation context). Attributed to the
 * reviewer, at cost 0: the reviewer's real spend is already booked on the
 * review task, and booking it again here would double-count the donation.
 * A dangling/mistyped review_of records nothing — same leniency as the
 * approve path.
 */
async function recordReviewRejection(
  client: Client,
  reviewerDevId: string,
  contributionId: number,
  reviewResult: unknown,
  reviewTaskId: string,
): Promise<void> {
  const { rows } = await client.query<{ task_id: string; target_id: string }>(
    `SELECT task_id, target_id FROM contributions
      WHERE id = $1 AND outcome = 'decomposition'`,
    [contributionId],
  );
  const prop = rows[0];
  if (!prop) return;
  const r = reviewResult as { reasons?: unknown } | null | undefined;
  const hasReasons = typeof r?.reasons === 'string' && r.reasons.trim().length > 0;
  // Prefer the reviewer's structured reasons; fall back to the whole (bounded)
  // review result so a free-form verdict still reaches the next agent.
  const reasons = hasReasons
    ? (r.reasons as string).trim().slice(0, MAX_SUMMARY_CHARS)
    : boundedProposal(reviewResult);
  const summary = (
    hasReasons
      ? `Peer review REJECTED the proposed decomposition: ${(r.reasons as string).trim()}`
      : 'Peer review REJECTED the proposed decomposition (no reasons given).'
  ).slice(0, MAX_SUMMARY_CHARS);
  await client.query(
    `INSERT INTO contributions
       (task_id, target_id, dev_id, outcome, summary, artifact, cost_cents, raw_usage)
     VALUES ($1, $2, $3, 'progress', $4, $5, 0, $6)`,
    [
      prop.task_id,
      prop.target_id,
      reviewerDevId,
      summary,
      JSON.stringify({
        review_rejected: true,
        reasons,
        reviewed_contribution: contributionId,
      }),
      JSON.stringify({ review_task_id: reviewTaskId }),
    ],
  );
}

/**
 * Publish an approved decomposition's subtasks — exactly once. Runs inside the
 * review submit's transaction.
 *
 * SPEND SAFETY — why agents may mint tasks at all: publishing a task moves NO
 * money. An open task costs nothing until some volunteer's runner checks it
 * out, and checkoutTask charges the CLAIMING volunteer's own budget behind its
 * row-level gate (reserved + spent + max_cost <= budget), which this feature
 * leaves byte-identical. Agent-minted tasks are therefore a noise risk, not a
 * theft risk — and the noise is bounded by the proposal caps (<= 12 subtasks,
 * each <= 2x the parent's cap) plus the peer-review gate that had to approve
 * this call.
 *
 * Exactly-once: the proposal contribution row is locked FOR UPDATE (the mutex),
 * then any task already pointing back via decomposed_from means a previous
 * approve won the race or a replay is in flight — return [] and publish
 * nothing. A second review, a resubmitted review, or a concurrent duplicate
 * all take this path.
 */
async function publishApprovedDecomposition(
  client: Client,
  contributionId: number,
): Promise<string[]> {
  const { rows } = await client.query<{
    id: number;
    task_id: string;
    artifact: { decomposition?: unknown } | null;
    outcome: string;
  }>(
    `SELECT id, task_id, artifact, outcome::text AS outcome
       FROM contributions WHERE id = $1
       FOR UPDATE`,
    [contributionId],
  );
  const prop = rows[0];
  // Only a real decomposition contribution can publish; a dangling or
  // mistyped review_of publishes nothing (and the review is still logged).
  if (prop?.outcome !== 'decomposition') return [];

  const dup = await client.query(`SELECT 1 FROM tasks WHERE decomposed_from = $1 LIMIT 1`, [
    contributionId,
  ]);
  if ((dup.rowCount ?? 0) > 0) return []; // already published — idempotent no-op

  const parent = await client.query<{
    target_id: string;
    max_cost_cents: number;
    sensitivity: string;
    decomposition_depth: number;
  }>(
    `SELECT target_id, max_cost_cents, sensitivity::text AS sensitivity, decomposition_depth
       FROM tasks WHERE id = $1`,
    [prop.task_id],
  );
  if (!parent.rows[0]) return [];

  // Re-normalize from the stored artifact: defense in depth — the caps hold at
  // publish time even if the stored proposal were somehow malformed. An invalid
  // stored proposal publishes nothing rather than failing the reviewer's submit.
  let proposal: DecompositionProposal;
  try {
    proposal = normalizeDecomposition(prop.artifact?.decomposition, parent.rows[0].max_cost_cents);
  } catch (err) {
    console.error(`decomposition ${contributionId} failed re-validation at publish:`, err);
    return [];
  }

  // Depth bookkeeping: children carry the parent's depth + 1, so decomposition
  // towers are visible in the data. No hard depth cap — per-level peer review
  // is the damper — but each level's review prompt states the depth.
  const childDepth = parent.rows[0].decomposition_depth + 1;
  const created: string[] = [];
  for (const st of proposal.subtasks) {
    const ins = await client.query<{ id: string }>(
      `INSERT INTO tasks
         (target_id, title, spec, est_cost_cents, max_cost_cents, effort, kind, verify_via,
          sensitivity, decomposed_from, decomposition_depth)
       VALUES ($1, $2, $3, $4, $5, $6::task_effort, $7::task_kind, $8::verification_method,
               $9::data_sensitivity, $10, $11)
       RETURNING id`,
      [
        parent.rows[0].target_id,
        st.title,
        JSON.stringify({
          prompt: st.prompt,
          decomposed_from: contributionId,
          // A chunk subtask carries the pinned program — DispatchingExecutor
          // routes spec.code to the podman work-unit sandbox, never a model.
          ...(st.code ? { code: st.code } : {}),
        }),
        st.est_cost_cents,
        st.max_cost_cents,
        st.effort,
        st.kind,
        st.verify_via,
        parent.rows[0].sensitivity, // subtasks inherit the parent's sensitivity
        contributionId,
        childDepth,
      ],
    );
    created.push(ins.rows[0].id);
  }
  return created;
}

export interface ContributeOptions {
  /**
   * What this chunk represents. 'progress' and 'dead_end' return the task to the
   * pool so the next agent continues from the accumulated state; 'candidate_solution'
   * (the default) finishes the task into 'submitted' for verification/review — the
   * original one-shot behaviour.
   */
  outcome?: ContributionOutcome;
  /** The agent's handoff note for whoever picks the task up next. */
  summary?: string;
  /** Pointer to a large artifact (code, Lean file) in blob storage. */
  artifactUri?: string;
  /** Small inline artifact (a lemma, an extended range). */
  artifact?: unknown;
  /** Replacement compacted working set for the target (the cheap-path compaction). */
  stateUpdate?: unknown;
}

export interface SubmitResult {
  task_id: string;
  /** 'submitted' for a candidate solution (terminal); 'open' when returned to the pool. */
  status: 'submitted' | 'open';
  outcome: ContributionOutcome;
  contribution_id: number;
  reserved_released: number;
  spent_applied: number;
  overage_clamped: boolean;
  /** Set on a 'decomposition' submit: the auto-minted peer-review task. */
  review_task_id?: string;
  /**
   * Set when a submitted decomposition proposal failed validation but was
   * SALVAGED as a 'progress' contribution instead of being discarded: the
   * volunteer's tokens were genuinely spent producing it, so the full proposal
   * plus these errors is preserved for the next agent to correct and resubmit.
   * When set, `outcome` is 'progress' (what was actually booked) and no review
   * task was minted.
   */
  salvaged_decomposition?: { validation_errors: string[] };
  /**
   * Set on a terminal submit of a review task: the subtask ids an approving
   * review published. [] means nothing was published — the review rejected the
   * proposal, or a previous approve already published it (exactly-once).
   */
  published_task_ids?: string[];
  /**
   * Set when the claimed actual_cost_cents exceeded the absurdity ceiling
   * (ABSURD_COST_MULTIPLE x the reservation) and was CLAMPED to it rather than
   * rejected: rejecting would roll the whole submit back and leave a very large
   * real spend unrecorded. The raw claimed figure is preserved in the
   * ledger/contribution raw_usage (`claimed_cost_cents`) for admin review.
   */
  cost_clamped?: boolean;
  /**
   * Set when an oversized state_update was truncated to fit MAX_STATE_BYTES
   * instead of failing the submit (see boundedStateUpdate).
   */
  state_truncated?: boolean;
  /** The target's public slug (null for unslugged targets) — display/analytics context. */
  target_slug: string | null;
  /** The task's kind ('computational' | 'exploration' | ...) — display/analytics context. */
  task_kind: string;
}

/**
 * Record one chunk of work on a locked task: append a `contributions` row, book
 * the spend, and either finish the task (a candidate solution -> 'submitted') or
 * return it to the pool for the next agent (progress / dead end -> 'open'). In
 * every case the reservation made at checkout (max_cost_cents) is released and
 * the actual spend applied — the budget mechanics are identical to the original
 * one-shot submit; only the resulting task status and the appended log differ.
 *
 * Overage: actual_cost_cents may come in above the reservation. That money is
 * already gone from the volunteer's own subscription by the time we hear about
 * it, so we book what they actually spent rather than what we wished they had —
 * clamping never refunded a cent, it only understated the donation. The spend is
 * still flagged as an overage so a systematically bad estimate is visible.
 *
 * Spending beyond budget is prevented where it can still be prevented: checkout
 * refuses to hand out a task unless reserved + spent + max_cost <= budget. An
 * overage therefore only ever pushes `available` negative by the overshoot, and
 * the next checkout is refused until the volunteer raises the cap or the month
 * rolls over.
 */
export async function submitResult(
  devId: string,
  taskId: string,
  result: unknown,
  actualCostCents: number,
  rawUsage: unknown,
  opts: ContributeOptions = {},
): Promise<SubmitResult> {
  // actual_cost_cents comes straight from the dev's /submit body. Reject
  // negatives, NaN, and non-integers up front: a negative value would refund
  // the dev's own spend (corrupting the ledger and letting them overspend the
  // pool), and NaN/floats would error or skew the budget arithmetic.
  if (!Number.isInteger(actualCostCents) || actualCostCents < 0) {
    throw new OpError(BAD_INPUT, 'bad_input', 'actual_cost_cents must be a non-negative integer');
  }
  const outcome = opts.outcome ?? 'candidate_solution';
  if (!CONTRIBUTION_OUTCOMES.includes(outcome)) {
    throw new OpError(
      BAD_INPUT,
      'bad_input',
      `outcome must be one of ${CONTRIBUTION_OUTCOMES.join(', ')}`,
    );
  }
  // A candidate solution finishes the task; progress/dead-end keep it alive.
  // A decomposition is also non-terminal: the proposal is INERT (it mints a
  // review task, never subtasks), and the parent returns to the pool so work
  // can continue even while the review is pending.
  const terminal = outcome === 'candidate_solution';

  // Server-side bounds on the free-form fields. summary and target state are
  // published on the public page and hydrated verbatim into the next agent's
  // prompt context, so an unbounded value is both a storage-bloat and a
  // content-injection vector. Truncate the note; reject an oversized state.
  const summary = typeof opts.summary === 'string' ? opts.summary.slice(0, MAX_SUMMARY_CHARS) : '';
  // An oversized state is truncated, never rejected: by submit time the spend
  // is real, and failing the submit would lose both the work and the booking.
  // NOT bounded here any more: the update is merged into the existing working
  // set inside the transaction (which needs the current row), so the size cap
  // has to apply to the merged result, not to the fragment on its own.
  const stateUpdate = opts.stateUpdate;
  // A non-terminal contribution returns the task to the pool, so `result` has
  // nowhere to live on the task row. Preserve it as the contribution's inline
  // artifact (unless the agent already supplied one) rather than dropping the
  // computed work on the floor.
  const artifact =
    opts.artifact !== undefined ? opts.artifact : terminal ? undefined : (result ?? undefined);

  const settled = await withTransaction<SubmitResult>(async (client) => {
    // The reservation was made in the task's reserved_period (which may be a
    // prior month if the lock straddled a boundary). Read it first — a plain
    // read is safe: the guarded UPDATE below rejects (409) before any budget
    // mutation if the task isn't actually locked to us, so a stale period only
    // ever causes a no-op budget lock.
    const period = await reservedPeriodOf(client, taskId);

    // 1. Lock the dev's budget row for that period (budget-first order, matching
    //    checkout, to avoid deadlocks).
    const budget = await lockDevBudget(client, devId, period);
    if (!budget) {
      throw new OpError(CONFLICT, 'not_locked', 'Task not locked to you');
    }

    // 2. Settle the task, guarded on lock+assignment. Terminal writes the final
    //    result; a continuing contribution returns the task to the pool (its
    //    artifact lives on the contributions row, not the task). RETURNING also
    //    carries the columns the decomposition/review hooks below need.
    type SettledRow = {
      max_cost_cents: number;
      target_id: string;
      title: string;
      spec: Record<string, unknown> | null;
      sensitivity: string;
      decomposition_depth: number;
      kind: string;
      target_slug: string | null;
    };
    // target_slug rides the settle's own RETURNING (a scalar subselect) so the
    // analytics context costs no extra query on the submit path.
    const RETURNING = `max_cost_cents, target_id, title, spec, sensitivity::text AS sensitivity,
                       decomposition_depth, kind::text AS kind,
                       (SELECT slug FROM targets WHERE targets.id = tasks.target_id) AS target_slug`;
    const upd = terminal
      ? await client.query<SettledRow>(
          // actual_cost_cents mirrors the BOOKED spend, which is clamped at the
          // absurdity ceiling below — LEAST keeps the task row consistent with
          // the ledger without needing the reservation read first.
          `UPDATE tasks
              SET status = 'submitted',
                  actual_cost_cents = LEAST($3::bigint, max_cost_cents * ${ABSURD_COST_MULTIPLE}),
                  result = $4,
                  submitted_at = now()
            WHERE id = $1 AND assigned_dev_id = $2 AND status = 'locked'
            RETURNING ${RETURNING}`,
          [taskId, devId, actualCostCents, result],
        )
      : await client.query<SettledRow>(
          `UPDATE tasks
              SET status = 'open',
                  assigned_dev_id = NULL,
                  lock_expires_at = NULL,
                  reserved_period = NULL
            WHERE id = $1 AND assigned_dev_id = $2 AND status = 'locked'
            RETURNING ${RETURNING}`,
          [taskId, devId],
        );
    if (upd.rowCount === 0) {
      throw new OpError(CONFLICT, 'not_locked', 'Task not locked to you or already moved on');
    }
    const reserved = upd.rows[0].max_cost_cents;
    const targetId = upd.rows[0].target_id;
    const taskSpec = upd.rows[0].spec;

    // A decomposition proposal is validated BEFORE any money moves — but the
    // volunteer's tokens are ALREADY burned by the time we hear about it, so a
    // near-miss proposal (parseable subtasks that broke a rule: cap breach,
    // fan-out over the limit, malformed chunk shape) is SALVAGED, not vaporized:
    // it books as a 'progress' contribution carrying the full proposal + the
    // structured error list, the reservation is released, and the task returns
    // to the pool exactly like any other progress outcome — so the next agent
    // sees the proposal and the exact errors in its continuation context and
    // can resubmit it corrected. Only a proposal with no parseable subtasks at
    // all still hard-rejects (rollback; nothing booked; task still locked —
    // the runner releases it, see run-loop's submit-rejection path). Review
    // tasks themselves are never decomposable (spec.review_of marks them), so
    // a proposal can't spawn a review of a review ad infinitum — that's a
    // policy violation, not a near-miss, and stays a hard reject too.
    let proposal: DecompositionProposal | null = null;
    let salvage: { proposed: unknown; errors: string[] } | null = null;
    let bookedOutcome: ContributionOutcome = outcome;
    if (outcome === 'decomposition') {
      const rawProposal = (result as { decomposition?: unknown } | null | undefined)?.decomposition;
      if (taskSpec?.review_of != null) {
        // Decomposing a review task is a policy violation (no recursion bombs),
        // but the tokens that produced the proposal are already burned — so it
        // is SALVAGED like any other near-miss: booked as progress with the
        // violation on the record, never a rollback that discards real spend.
        // The review task returns to the pool unreviewed; no review-of-a-review
        // is ever minted.
        salvage = {
          proposed: rawProposal,
          errors: ['a decomposition-review task cannot itself be decomposed'],
        };
        bookedOutcome = 'progress';
      } else {
        const checked = validateDecomposition(rawProposal, reserved);
        if (checked.proposal) {
          proposal = checked.proposal;
        } else if (!checked.parseable) {
          throw new OpError(BAD_INPUT, 'bad_decomposition', checked.errors[0]);
        } else {
          salvage = { proposed: rawProposal, errors: checked.errors };
          bookedOutcome = 'progress';
        }
      }
    }

    // A modest overshoot is a real donation and gets booked. A wildly impossible
    // number is a bug or a hostile client — but rejecting it here would roll the
    // WHOLE submit back, discarding the completed work and leaving what may be
    // the largest real spend in the system unrecorded anywhere. So it is CLAMPED
    // to the absurdity ceiling instead: the contribution books at the ceiling,
    // the raw claimed figure rides along flagged (`cost_clamped` +
    // `claimed_cost_cents` in raw_usage) so an admin can review, and only
    // non-numeric/negative garbage still hard-rejects (validated up front,
    // before any budget mutation).
    const absurdCeiling = reserved * ABSURD_COST_MULTIPLE;
    const costClamped = actualCostCents > absurdCeiling;
    // Book what was actually spent (clamped at the ceiling). Over the
    // reservation is still flagged as an overage so a consistently wrong
    // estimate surfaces instead of hiding.
    const spendApplied = costClamped ? absurdCeiling : actualCostCents;
    const overageClamped = spendApplied > reserved;

    // 3. Release the reservation, apply the spend — in the reservation's period.
    await client.query(
      `UPDATE dev_budgets
          SET reserved_cents = reserved_cents - $2,
              spent_cents = spent_cents + $3
        WHERE dev_id = $1 AND period = COALESCE($4::date, ${CURRENT_PERIOD})`,
      [devId, reserved, spendApplied, period],
    );

    // 4. Ledger: net delta of this event is (spend applied) - (reservation released).
    const usagePayload =
      overageClamped || costClamped
        ? {
            ...(rawUsage && typeof rawUsage === 'object' ? rawUsage : { rawUsage }),
            overage: true,
            reported_cost_cents: actualCostCents,
            reserved_cents: reserved,
            ...(costClamped
              ? {
                  // The claimed figure was implausible (> ABSURD_COST_MULTIPLE x
                  // the reservation) and was clamped, not rejected — preserved
                  // here verbatim so an admin can audit the malfunction.
                  cost_clamped: true,
                  claimed_cost_cents: actualCostCents,
                  clamped_to_cents: spendApplied,
                }
              : {}),
          }
        : rawUsage;

    await client.query(
      `INSERT INTO ledger (task_id, dev_id, target_id, event_type, delta_cents, raw_usage)
       VALUES ($1, $2, $3, 'submit', $4, $5)`,
      [taskId, devId, targetId, spendApplied - reserved, JSON.stringify(usagePayload ?? null)],
    );

    // 5. Append the contribution — the durable, append-only record of this chunk
    //    (progress or dead end alike). cost_cents is the booked spend. For a
    //    valid decomposition, the artifact is the NORMALIZED proposal — the
    //    exact thing the review gates and the publish step later re-reads. For
    //    a salvaged invalid one, the artifact preserves the FULL proposal as
    //    submitted plus the structured error list — the channel checkoutTask
    //    hydrates into the next agent's continuation context.
    //
    //    Code that shipped WITH a decomposition rides along: without this, the
    //    proposal path replaced the whole result with {decomposition} and the
    //    code_contribution survived NOWHERE server-side — so when the runner's
    //    PR publish failed ("code inline only"), the inline copy evaporated,
    //    and even when it succeeded the reviewer/successors had no copy to
    //    read. Bounded like any salvaged proposal (explicitly, never silently).
    const submittedCode = outcome === 'decomposition' ? extractSubmittedCode(result) : null;
    const contributionArtifact = proposal
      ? {
          decomposition: proposal,
          ...(submittedCode ? { code_contribution: boundedProposal(submittedCode) } : {}),
        }
      : salvage
        ? {
            proposed_decomposition: boundedProposal(salvage.proposed),
            validation_errors: salvage.errors,
            ...(submittedCode ? { code_contribution: boundedProposal(submittedCode) } : {}),
          }
        : artifact;
    const bookedSummary = salvage
      ? `Proposed a decomposition that failed validation: ${salvage.errors.join('; ')}`.slice(
          0,
          MAX_SUMMARY_CHARS,
        )
      : summary;
    const contrib = await client.query<{ id: number }>(
      `INSERT INTO contributions
         (task_id, target_id, dev_id, outcome, summary, artifact_uri, artifact, cost_cents, raw_usage)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        taskId,
        targetId,
        devId,
        bookedOutcome,
        bookedSummary,
        opts.artifactUri ?? null,
        contributionArtifact != null ? JSON.stringify(contributionArtifact) : null,
        spendApplied,
        JSON.stringify(usagePayload ?? null),
      ],
    );

    // 5a. A decomposition mints its peer-review gate: ONE small task on the
    //     same target whose deliverable is an approve/reject with reasons. The
    //     proposal itself stays inert until that review approves it. "Someone
    //     else's agent verifies this is a good idea" — any volunteer's runner
    //     can pick it up; there is deliberately no admin button in this path.
    let reviewTaskId: string | undefined;
    if (proposal) {
      const review = await client.query<{ id: string }>(
        `INSERT INTO tasks
           (target_id, title, spec, est_cost_cents, max_cost_cents, effort, kind, verify_via,
            sensitivity)
         VALUES ($1, $2, $3, $4, $5, 'medium'::task_effort, 'exploration'::task_kind,
                 'human_review'::verification_method, $6::data_sensitivity)
         RETURNING id`,
        [
          targetId,
          `Review a proposed decomposition of: ${upd.rows[0].title}`.slice(0, 200),
          JSON.stringify(
            reviewTaskSpec(
              contrib.rows[0].id,
              upd.rows[0].title,
              proposal,
              // The depth the published subtasks WOULD have — flagged to the
              // reviewer so towers get extra scrutiny at the judgment point.
              upd.rows[0].decomposition_depth + 1,
              // The proposing (reviewed) task's own cap — the number the 2x
              // per-subtask ceiling is computed from, baked into the review
              // spec so the pg-free executor can state it.
              upd.rows[0].max_cost_cents,
              // Code that shipped with the proposal travels TO THE REVIEWER:
              // the listing embeds in the prompt, and the sibling
              // contribution's artifact_uri (the runner's published PR, when
              // the publish succeeded) is labeled in it.
              submittedCode,
              opts.artifactUri ?? null,
            ),
          ),
          REVIEW_TASK_EST_CENTS,
          REVIEW_TASK_MAX_CENTS,
          upd.rows[0].sensitivity, // the review sees the proposal, so it inherits its sensitivity
        ],
      );
      reviewTaskId = review.rows[0].id;
    }

    // 5b. A terminal submit of a review task settles the proposal's fate.
    //     approve: true publishes the subtasks (exactly once — see
    //     publishApprovedDecomposition); anything else publishes nothing, and
    //     the proposal simply stays on the record as the honest contribution it
    //     was. Same transaction as the review contribution itself, so a crash
    //     can't record an approval without its publish (or vice versa).
    let publishedTaskIds: string[] | undefined;
    if (terminal && Number.isInteger(taskSpec?.review_of)) {
      const reviewedId = taskSpec?.review_of as number;
      if (reviewApproves(result)) {
        publishedTaskIds = await publishApprovedDecomposition(client, reviewedId);
      } else {
        // The verdict must reach the PROPOSING task's next agent, not just the
        // review task's log — see recordReviewRejection.
        publishedTaskIds = [];
        await recordReviewRejection(client, devId, reviewedId, result, taskId);
      }
    }

    // 6. Refresh the target's compacted working set, if the agent supplied one
    //    (bounded above — an oversized update was truncated, not rejected).
    //    Merged per key, not replaced: see mergeStateUpdate. The targets row is
    //    locked FOR UPDATE first so two submits landing on the same conjecture
    //    can't read-modify-write over each other — without it, merging would
    //    reintroduce the very lost-update it exists to prevent.
    let stateTruncated = false;
    if (stateUpdate !== undefined && targetId) {
      const cur = await client.query<{ state: unknown }>(
        `SELECT state FROM targets WHERE id = $1 FOR UPDATE`,
        [targetId],
      );
      const parsed = mergeStateUpdate(cur.rows[0]?.state, stateUpdate);
      const bounded = boundedStateUpdate(parsed.state);
      stateTruncated = bounded.truncated;
      await client.query(`UPDATE targets SET state = $2 WHERE id = $1`, [
        targetId,
        JSON.stringify(bounded.state),
      ]);
      // Facts are append-only and deduped by claim, so a replayed submit adds
      // nothing and two agents establishing the same thing collapse to one row.
      for (const claim of parsed.facts) {
        await client.query(
          `INSERT INTO target_facts (target_id, claim, established_by)
           VALUES ($1, $2, $3)
           ON CONFLICT (target_id, md5(claim)) DO NOTHING`,
          [targetId, claim, contrib.rows[0].id],
        );
      }
    }

    // 7. Funnel: on THIS connection, under a savepoint — see checkoutTask. The
    //    contribution and its booked spend are real whether or not analytics
    //    records them, and analytics must not add a connect to the submit path.
    //    Every submit is logged, so a repeat contributor is distinguishable from
    //    a one-and-done without any extra bookkeeping.
    await recordEvent(
      devId,
      'submit',
      { task_id: taskId, outcome: bookedOutcome, spent_cents: spendApplied },
      client,
    );

    return {
      task_id: taskId,
      status: terminal ? ('submitted' as const) : ('open' as const),
      outcome: bookedOutcome,
      contribution_id: contrib.rows[0].id,
      reserved_released: reserved,
      spent_applied: spendApplied,
      overage_clamped: overageClamped,
      ...(salvage ? { salvaged_decomposition: { validation_errors: salvage.errors } } : {}),
      ...(reviewTaskId !== undefined ? { review_task_id: reviewTaskId } : {}),
      ...(publishedTaskIds !== undefined ? { published_task_ids: publishedTaskIds } : {}),
      ...(costClamped ? { cost_clamped: true } : {}),
      ...(stateTruncated ? { state_truncated: true } : {}),
      target_slug: upd.rows[0].target_slug,
      task_kind: upd.rows[0].kind,
    };
  });
  return settled;
}

/** A task's contributions, newest first — the accumulated log of what's been tried. */
export async function getTaskContributions(
  taskId: string,
  limit = 20,
): Promise<ContributionSummary[]> {
  const { rows } = await query<ContributionSummary>(
    `SELECT id, outcome, summary, artifact_uri, cost_cents, created_at
       FROM contributions
      WHERE task_id = $1
      ORDER BY id DESC
      LIMIT $2`,
    [taskId, limit],
  );
  return rows;
}

// ---------------------------------------------------------------------------
// heartbeat
// ---------------------------------------------------------------------------

/**
 * Renew the checkout lease on a task the dev currently holds. Long-running
 * work units (CPU jobs that may take hours) ping this while executing so the
 * 10-minute lock doesn't expire under them; a crashed runner's silence lets
 * expire() reclaim the task as before. No budget interaction — the
 * reservation was made at checkout and is settled at submit/release.
 */
export async function heartbeatTask(
  devId: string,
  taskId: string,
): Promise<{ task_id: string; lock_expires_at: string }> {
  const { rows } = await query<{ lock_expires_at: string | Date }>(
    `UPDATE tasks
        SET lock_expires_at = now() + interval '10 minutes'
      WHERE id = $1 AND assigned_dev_id = $2 AND status = 'locked'
      RETURNING lock_expires_at`,
    [taskId, devId],
  );
  if (!rows[0]) {
    throw new OpError(CONFLICT, 'not_locked_by_you', 'Task is not locked to you');
  }
  return { task_id: taskId, lock_expires_at: new Date(rows[0].lock_expires_at).toISOString() };
}

// ---------------------------------------------------------------------------
// release
// ---------------------------------------------------------------------------

export interface ReleaseResult {
  task_id: string;
  status: 'open';
  reserved_released: number;
  /** The target's public slug (null for unslugged targets) — display/analytics context. */
  target_slug: string | null;
  /** The task's kind ('computational' | 'exploration' | ...) — display/analytics context. */
  task_kind: string;
}

/** Voluntarily abandon a locked task, returning it to the pool and freeing the reservation. */
export async function releaseTask(devId: string, taskId: string): Promise<ReleaseResult> {
  return withTransaction(async (client) => {
    const period = await reservedPeriodOf(client, taskId);
    const budget = await lockDevBudget(client, devId, period);
    if (!budget) {
      throw new OpError(CONFLICT, 'not_locked', 'Task not locked to you');
    }

    const upd = await client.query<{
      max_cost_cents: number;
      target_id: string;
      kind: string;
      target_slug: string | null;
    }>(
      `UPDATE tasks
          SET status = 'open', assigned_dev_id = NULL, lock_expires_at = NULL, reserved_period = NULL
        WHERE id = $1 AND assigned_dev_id = $2 AND status = 'locked'
        RETURNING max_cost_cents, target_id, kind::text AS kind,
                  (SELECT slug FROM targets WHERE targets.id = tasks.target_id) AS target_slug`,
      [taskId, devId],
    );
    if (upd.rowCount === 0) {
      throw new OpError(CONFLICT, 'not_locked', 'Task not locked to you');
    }
    const reserved = upd.rows[0].max_cost_cents;

    await client.query(
      `UPDATE dev_budgets
          SET reserved_cents = reserved_cents - $2
        WHERE dev_id = $1 AND period = COALESCE($3::date, ${CURRENT_PERIOD})`,
      [devId, reserved, period],
    );

    await client.query(
      `INSERT INTO ledger (task_id, dev_id, target_id, event_type, delta_cents)
       VALUES ($1, $2, $3, 'release', $4)`,
      [taskId, devId, upd.rows[0].target_id, -reserved],
    );

    return {
      task_id: taskId,
      status: 'open',
      reserved_released: reserved,
      target_slug: upd.rows[0].target_slug,
      task_kind: upd.rows[0].kind,
    };
  });
}

// ---------------------------------------------------------------------------
// expire (background sweep)
// ---------------------------------------------------------------------------

export interface ExpireResult {
  expired_count: number;
  task_ids: string[];
}

/**
 * Return all expired locked tasks to the pool and free their reservations in one
 * transaction. Each reservation is freed from the period it was made in
 * (`reserved_period`), so a lock that straddles a month boundary — checked out
 * in one month, expired the next — refunds the right month's budget row.
 */
export async function expire(): Promise<ExpireResult> {
  return withTransaction(async (client) => {
    // Capture candidate expired tasks WITHOUT locking them. We must NOT take the
    // tasks lock before the dev_budgets lock: checkout/submit/release all lock
    // budget-first, so locking tasks-first here would invert the order and can
    // deadlock under concurrency (Gemini review). Values are captured now so the
    // post-update (NULLed) RETURNING below can't lose them.
    const candidates = await client.query<{
      id: string;
      assigned_dev_id: string;
      target_id: string;
      max_cost_cents: number;
      reserved_period: string | null;
    }>(
      `SELECT id, assigned_dev_id, target_id, max_cost_cents, reserved_period
         FROM tasks
        WHERE status = 'locked' AND lock_expires_at < now()`,
    );

    if (candidates.rowCount === 0) {
      return { expired_count: 0, task_ids: [] };
    }

    const ids = candidates.rows.map((r) => r.id);

    // Lock the affected dev_budgets rows FOR UPDATE first, in a deterministic
    // (dev_id, period) order — the budget-first order every other op uses, so
    // there is no lock-order inversion.
    await client.query(
      `SELECT db.dev_id, db.period
         FROM dev_budgets db
        WHERE (db.dev_id, db.period) IN (
                SELECT t.assigned_dev_id, COALESCE(t.reserved_period, ${CURRENT_PERIOD})::date
                  FROM tasks t
                 WHERE t.id = ANY($1::uuid[])
              )
        ORDER BY db.dev_id, db.period
          FOR UPDATE`,
      [ids],
    );

    // Flip the tasks to open under the budget locks, re-checking the expiry
    // condition. A task submitted/released since our unlocked read won't match
    // and is skipped — that op already settled its reservation.
    const expired = await client.query<{ id: string }>(
      `UPDATE tasks
          SET status = 'open', assigned_dev_id = NULL, lock_expires_at = NULL, reserved_period = NULL
        WHERE id = ANY($1::uuid[]) AND status = 'locked' AND lock_expires_at < now()
        RETURNING id`,
      [ids],
    );
    const expiredIds = new Set(expired.rows.map((r) => r.id));
    if (expiredIds.size === 0) {
      return { expired_count: 0, task_ids: [] };
    }

    // Free each freshly-expired reservation from its own reserved_period and
    // write one expire ledger row (-max_cost_cents) per task.
    for (const r of candidates.rows) {
      if (!expiredIds.has(r.id)) continue;
      await client.query(
        `UPDATE dev_budgets
            SET reserved_cents = reserved_cents - $2
          WHERE dev_id = $1 AND period = COALESCE($3::date, ${CURRENT_PERIOD})`,
        [r.assigned_dev_id, r.max_cost_cents, r.reserved_period],
      );
      await client.query(
        `INSERT INTO ledger (task_id, dev_id, target_id, event_type, delta_cents)
         VALUES ($1, $2, $3, 'expire', $4)`,
        [r.id, r.assigned_dev_id, r.target_id, -r.max_cost_cents],
      );
    }

    return {
      expired_count: expiredIds.size,
      task_ids: ids.filter((id) => expiredIds.has(id)),
    };
  });
}

// ---------------------------------------------------------------------------
// accept / reject (nonprofit-side review)
// ---------------------------------------------------------------------------

/** Accept a submitted task. Sets accepted_at, logs an accept ledger row (delta 0). */
export async function acceptTask(taskId: string): Promise<{ task_id: string; status: 'accepted' }> {
  return withTransaction(async (client) => {
    const upd = await client.query<{ dev_id: string; target_id: string }>(
      `UPDATE tasks
          SET status = 'accepted', accepted_at = now()
        WHERE id = $1 AND status = 'submitted'
        RETURNING assigned_dev_id AS dev_id, target_id`,
      [taskId],
    );
    if (upd.rowCount === 0) {
      throw new OpError(CONFLICT, 'not_submitted', 'Task is not in submitted state');
    }
    await client.query(
      `INSERT INTO ledger (task_id, dev_id, target_id, event_type, delta_cents)
       VALUES ($1, $2, $3, 'accept', 0)`,
      [taskId, upd.rows[0].dev_id, upd.rows[0].target_id],
    );
    return { task_id: taskId, status: 'accepted' };
  });
}

/**
 * Reject a submitted task: returns it to 'open'. STAGE 1 decision — does NOT
 * refund, since the dev already spent the cost; we log a reject ledger row with
 * delta 0. STAGE 2: decide whether rejection should ever refund (e.g. if the
 * output was unusable through no fault of compute, the nonprofit may not want to
 * have "spent" the dev's donation). For now spend is final at submit time.
 */
export async function rejectTask(taskId: string): Promise<{ task_id: string; status: 'open' }> {
  return withTransaction(async (client) => {
    // Read the assignee before the UPDATE nulls it — RETURNING evaluates the
    // NEW row, so returning assigned_dev_id from the UPDATE always yields NULL
    // and the reject ledger row would lose attribution.
    const prev = await client.query<{ dev_id: string | null; target_id: string }>(
      `SELECT assigned_dev_id AS dev_id, target_id
         FROM tasks
        WHERE id = $1 AND status = 'submitted'
        FOR UPDATE`,
      [taskId],
    );
    if (prev.rowCount === 0) {
      throw new OpError(CONFLICT, 'not_submitted', 'Task is not in submitted state');
    }
    await client.query(
      `UPDATE tasks
          SET status = 'open', assigned_dev_id = NULL, lock_expires_at = NULL
        WHERE id = $1`,
      [taskId],
    );
    await client.query(
      `INSERT INTO ledger (task_id, dev_id, target_id, event_type, delta_cents)
       VALUES ($1, $2, $3, 'reject', 0)`,
      [taskId, prev.rows[0].dev_id, prev.rows[0].target_id],
    );
    return { task_id: taskId, status: 'open' };
  });
}

// ---------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------

export interface BudgetView {
  budget_cents: number;
  reserved_cents: number;
  spent_cents: number;
  available_cents: number;
}

export async function getBudget(devId: string): Promise<BudgetView | null> {
  const { rows } = await query<DevBudgetRow>(
    `SELECT budget_cents, reserved_cents, spent_cents
       FROM dev_budgets
      WHERE dev_id = $1 AND period = ${CURRENT_PERIOD}`,
    [devId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    budget_cents: r.budget_cents,
    reserved_cents: r.reserved_cents,
    spent_cents: r.spent_cents,
    available_cents: r.budget_cents - r.reserved_cents - r.spent_cents,
  };
}

/** Whether a dev is verified (trusted with non-public work). Missing dev -> false. */
export async function isDevVerified(devId: string): Promise<boolean> {
  const { rows } = await query<{ verified: boolean }>(`SELECT verified FROM devs WHERE id = $1`, [
    devId,
  ]);
  return rows[0]?.verified ?? false;
}

export interface DevProfile {
  id: string;
  github_handle: string;
  verified: boolean;
  budget: BudgetView | null;
}

/** A dev's own profile + current-period budget, for GET /devs/me. */
export async function getDevProfile(devId: string): Promise<DevProfile | null> {
  const { rows } = await query<{ id: string; github_handle: string; verified: boolean }>(
    `SELECT id, github_handle, verified FROM devs WHERE id = $1`,
    [devId],
  );
  const dev = rows[0];
  if (!dev) return null;
  return { ...dev, budget: await getBudget(devId) };
}

/**
 * A dev sets their OWN current-period budget — the cap on how much of their own
 * donated Claude-CLI credit they'll spend this month. Safe to self-serve: it only
 * governs the dev's own credit, not a shared pool. Lowering it below what's
 * already reserved+spent would violate the dev_budgets CHECK; we surface that as a
 * clean 409 rather than letting the constraint error become a 500.
 */
export async function setOwnBudget(devId: string, budgetCents: number): Promise<BudgetView> {
  if (!Number.isInteger(budgetCents) || budgetCents < 0) {
    throw new OpError(BAD_INPUT, 'bad_input', 'budget_cents must be a non-negative integer');
  }
  // Refusing to set a cap below what is already committed used to fall out of the
  // dev_budgets CHECK, which we caught as a constraint violation. That CHECK is
  // gone (an overage may legitimately push spent past budget — see migration
  // 010), so the rule is enforced here instead: the UPDATE only applies when the
  // new cap still covers everything reserved or already spent, and an update that
  // matches nothing means it was refused.
  const { rows } = await query<{ budget_cents: number }>(
    `INSERT INTO dev_budgets (dev_id, period, budget_cents)
     VALUES ($1, ${CURRENT_PERIOD}, $2)
     ON CONFLICT (dev_id, period) DO UPDATE SET budget_cents = EXCLUDED.budget_cents
       WHERE dev_budgets.reserved_cents + dev_budgets.spent_cents <= EXCLUDED.budget_cents
     RETURNING budget_cents`,
    [devId, budgetCents],
  );
  if (rows.length === 0) {
    throw new OpError(
      CONFLICT,
      'budget_below_committed',
      'New budget is below what you have already reserved or spent this period',
    );
  }
  // Funnel: the second step of the signup funnel. Recorded on every set; "first
  // budget set" is the earliest such event for the dev.
  await recordEvent(devId, 'budget_set', { budget_cents: budgetCents });
  return (await getBudget(devId))!;
}

export interface OpenTaskFilter {
  maxCostCents?: number;
  sensitivity?: string;
  limit?: number;
  /**
   * Whether the requesting dev is verified. When false, the listing is forced to
   * sensitivity='public' regardless of any requested filter — an unverified dev
   * must not even see non-public work (and couldn't check it out anyway; see the
   * trust gate in checkoutTask). Omitted (undefined) means "no restriction",
   * preserving the unfiltered behaviour for internal callers.
   */
  devVerified?: boolean;
  /**
   * The dev doing the listing. Onboarding tasks belong to exactly one dev, so
   * the pool hides everyone else's — otherwise the first task a newcomer is
   * waiting for could be claimed out from under them. Passing the dev id lets
   * their OWN onboarding task still show up (so an abandoned one can be picked
   * back up by a plain `run`); omitting it hides every onboarding task.
   */
  devId?: string;
  /**
   * Only tasks attached to the target with this public slug (`run --target`).
   * Strictly opt-in — the default posture is the whole pool, and pool ordering
   * is how less-famous problems get attention. A slug that matches nothing
   * (unknown, or a target with no slug) yields an empty list, not an error:
   * this is a filter on a listing, the run loop polls it repeatedly, and a
   * conjecture that just got resolved must read as "nothing to claim", not as
   * a failure. Only curated targets have slugs, so nothing non-public becomes
   * addressable through this.
   */
  targetSlug?: string;
}

// ---------------------------------------------------------------------------
// dev self-serve history & aggregates
// ---------------------------------------------------------------------------

export interface LedgerEntry {
  id: number;
  task_id: string;
  task_title: string | null;
  target_id: string;
  target_name: string | null;
  event_type: string;
  delta_cents: number;
  created_at: string;
}

export interface LedgerPage {
  entries: LedgerEntry[];
  /** Cursor for the next (older) page — pass as `before`. Null when no more. */
  next_before: number | null;
}

/**
 * A dev's own ledger entries, newest first, with the task title and nonprofit
 * name joined in for a readable history. Keyset-paginated on the ledger id
 * (monotonic BIGSERIAL): pass the previous page's `next_before` to walk
 * backwards. Scoped to the caller's dev_id — never the path/body — so a token
 * can only ever read its own history. LEFT JOINs so an entry survives even if a
 * task/nonprofit row were ever removed.
 */
export async function getDevLedger(
  devId: string,
  opts: { limit?: number; before?: number } = {},
): Promise<LedgerPage> {
  let limit = opts.limit ?? 50;
  if (opts.limit !== undefined) {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new OpError(BAD_INPUT, 'bad_input', 'limit must be a positive integer');
    }
    if (limit > 100) limit = 100;
  }
  const params: unknown[] = [devId];
  let cursor = '';
  if (opts.before !== undefined) {
    if (!Number.isInteger(opts.before) || opts.before < 0) {
      throw new OpError(BAD_INPUT, 'bad_input', 'before must be a non-negative integer');
    }
    params.push(opts.before);
    cursor = `AND l.id < $${params.length}`;
  }
  // Fetch one extra row to learn whether an older page exists without a count(*).
  params.push(limit + 1);
  const { rows } = await query<LedgerEntry>(
    `SELECT l.id, l.task_id, t.title AS task_title,
            l.target_id, n.name AS target_name,
            l.event_type, l.delta_cents, l.created_at
       FROM ledger l
       LEFT JOIN tasks t ON t.id = l.task_id
       LEFT JOIN targets n ON n.id = l.target_id
      WHERE l.dev_id = $1 ${cursor}
      ORDER BY l.id DESC
      LIMIT $${params.length}`,
    params,
  );
  let next_before: number | null = null;
  if (rows.length > limit) {
    rows.pop(); // drop the look-ahead row
    next_before = rows[rows.length - 1].id;
  }
  return { entries: rows, next_before };
}

export interface DevStats {
  /**
   * All-time actual compute donated, in cents. Derived from `submit` events:
   * the spend booked at submit is (checkout reservation + the submit delta), and
   * the reservation is the task's max_cost_cents — so spend = delta + max_cost.
   * Reservations that were released/expired net to zero and live (still-locked)
   * reservations are excluded, so this is money actually given, not committed.
   */
  total_donated_cents: number;
  tasks_completed: number;
  tasks_accepted: number;
  targets_helped: number;
  first_contribution_at: string | null;
  last_contribution_at: string | null;
  by_month: { month: string; donated_cents: number; tasks: number }[];
}

/**
 * A dev's all-time contribution aggregates plus a per-month breakdown — the
 * "running tally" the runner can show. Scoped to the caller's dev_id. SUM over
 * BIGINT yields NUMERIC (returned as a string by node-postgres), so the money
 * sums are cast back to ::bigint to land as JS numbers via the OID-20 parser.
 *
 * LEFT JOIN tasks (like getDevLedger): the counts and dates depend only on
 * ledger columns, so a deleted task must not drop those rows — it only nulls
 * that task's max_cost_cents, omitting its donated contribution (SUM/COALESCE
 * skip the null) rather than corrupting the whole aggregate.
 */
export async function getDevStats(devId: string): Promise<DevStats> {
  const summaryP = query<{
    total_donated_cents: number;
    tasks_completed: number;
    tasks_accepted: number;
    targets_helped: number;
    first_contribution_at: string | null;
    last_contribution_at: string | null;
  }>(
    `SELECT
        COALESCE(SUM(l.delta_cents + t.max_cost_cents)
                 FILTER (WHERE l.event_type = 'submit'), 0)::bigint AS total_donated_cents,
        COUNT(DISTINCT l.task_id) FILTER (WHERE l.event_type = 'submit') AS tasks_completed,
        COUNT(DISTINCT l.task_id) FILTER (WHERE l.event_type = 'accept') AS tasks_accepted,
        COUNT(DISTINCT l.target_id)
          FILTER (WHERE l.event_type IN ('submit', 'accept')) AS targets_helped,
        MIN(l.created_at) FILTER (WHERE l.event_type = 'submit') AS first_contribution_at,
        MAX(l.created_at) FILTER (WHERE l.event_type = 'submit') AS last_contribution_at
       FROM ledger l LEFT JOIN tasks t ON t.id = l.task_id
      WHERE l.dev_id = $1`,
    [devId],
  );
  const monthsP = query<{ month: string; donated_cents: number; tasks: number }>(
    `SELECT to_char(date_trunc('month', l.created_at), 'YYYY-MM') AS month,
            COALESCE(SUM(l.delta_cents + t.max_cost_cents), 0)::bigint AS donated_cents,
            COUNT(DISTINCT l.task_id) AS tasks
       FROM ledger l LEFT JOIN tasks t ON t.id = l.task_id
      WHERE l.dev_id = $1 AND l.event_type = 'submit'
      GROUP BY 1
      ORDER BY 1 DESC`,
    [devId],
  );
  const [summary, months] = await Promise.all([summaryP, monthsP]);
  const s = summary.rows[0];
  return {
    total_donated_cents: s.total_donated_cents,
    tasks_completed: s.tasks_completed,
    tasks_accepted: s.tasks_accepted,
    targets_helped: s.targets_helped,
    first_contribution_at: s.first_contribution_at,
    last_contribution_at: s.last_contribution_at,
    by_month: months.rows,
  };
}

export async function listOpenTasks(filter: OpenTaskFilter = {}): Promise<TaskRow[]> {
  // A task under a lapsed lock belongs in this listing — reclaim before
  // reading so stranded work is visible to the next poll, not just to the
  // 5-minute cron sweep.
  await reclaimLapsedLocks();
  const conditions: string[] = [`status = 'open'`];
  const params: unknown[] = [];

  if (filter.maxCostCents !== undefined) {
    if (!Number.isInteger(filter.maxCostCents) || filter.maxCostCents < 0) {
      throw new OpError(BAD_INPUT, 'bad_input', 'max_cost_cents must be a non-negative integer');
    }
    params.push(filter.maxCostCents);
    conditions.push(`max_cost_cents <= $${params.length}`);
  }
  // An unverified dev is pinned to public tasks: ignore a broader requested
  // sensitivity rather than honour it.
  const effectiveSensitivity = filter.devVerified === false ? 'public' : filter.sensitivity;
  if (effectiveSensitivity !== undefined) {
    params.push(effectiveSensitivity);
    conditions.push(`sensitivity = $${params.length}`);
  }
  // Narrow to one conjecture by public slug. Selection only — the budget gate
  // in checkoutTask is untouched, and an unmatched slug is simply an empty pool.
  if (filter.targetSlug !== undefined) {
    params.push(filter.targetSlug);
    conditions.push(`target_id IN (SELECT id FROM targets WHERE slug = $${params.length})`);
  }
  // Another dev's onboarding task is never claimable, so never listed either.
  if (filter.devId !== undefined) {
    params.push(filter.devId);
    conditions.push(`(onboarding_dev_id IS NULL OR onboarding_dev_id = $${params.length}::uuid)`);
  } else {
    conditions.push(`onboarding_dev_id IS NULL`);
  }

  // Validate + clamp limit: an unchecked NaN/negative would be a SQL error (500).
  let limit = filter.limit ?? 10;
  if (filter.limit !== undefined) {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new OpError(BAD_INPUT, 'bad_input', 'limit must be a positive integer');
    }
    if (limit > 100) limit = 100;
  }
  params.push(limit);
  const limitParam = `$${params.length}`;

  const { rows } = await query<TaskRow>(
    `SELECT id, target_id, title, spec, est_cost_cents, max_cost_cents,
            model, sensitivity, status, created_at
       FROM tasks
      WHERE ${conditions.join(' AND ')}
      ORDER BY created_at ASC
      LIMIT ${limitParam}`,
    params,
  );
  return rows;
}

// ---------------------------------------------------------------------------
// public transparency
// ---------------------------------------------------------------------------

export interface TransparencyOrg {
  name: string;
  tasks_total: number;
  tasks_accepted: number;
}

export interface Transparency {
  totals: { orgs: number; tasks_total: number; tasks_accepted: number };
  orgs: TransparencyOrg[];
}

/**
 * Public "who we work with" rollup: opt-in (`listed`) nonprofits with their task
 * counts — total tasks that entered the pool and how many were accepted. No
 * contact info, EINs, or task content; just org name + counts. Drives the public
 * GET /transparency endpoint. count(...)::int lands as a JS number (int4 parser).
 */
export async function getPublicTransparency(): Promise<Transparency> {
  const { rows } = await query<TransparencyOrg>(
    `SELECT n.name,
            count(t.id)::int AS tasks_total,
            (count(t.id) FILTER (WHERE t.status = 'accepted'))::int AS tasks_accepted
       FROM targets n
       LEFT JOIN tasks t ON t.target_id = n.id
      WHERE n.listed = true
      GROUP BY n.id, n.name
      ORDER BY tasks_total DESC, n.name ASC`,
  );
  const totals = rows.reduce(
    (a, r) => ({
      orgs: a.orgs + 1,
      tasks_total: a.tasks_total + r.tasks_total,
      tasks_accepted: a.tasks_accepted + r.tasks_accepted,
    }),
    { orgs: 0, tasks_total: 0, tasks_accepted: 0 },
  );
  return { totals, orgs: rows };
}

// ---------------------------------------------------------------------------
// public per-target (conjecture) progress
// ---------------------------------------------------------------------------

export interface TargetProgressMetrics {
  tasks_total: number;
  tasks_open: number;
  tasks_resolved: number; // accepted
  contributions: number;
  contributors: number; // distinct devs
  compute_cents: number; // total donated toward this target
  last_activity_at: string | null;
}

/**
 * The honest per-contribution status every public surface shows:
 *   - 'awaiting_verification' — a candidate_solution nothing has confirmed yet.
 *     NOT a result; the site must read it as pending, never as a find.
 *   - 'verified'              — a verification passed (verified_via says how:
 *     auto_rerun machine check, human_review accept, …).
 *   - 'rejected'              — a verification failed; the claim did not hold.
 *   - 'logged'                — progress / dead_end handoff notes; there is no
 *     claim to verify, the note itself is the contribution.
 */
export type ContributionStatus = 'awaiting_verification' | 'verified' | 'rejected' | 'logged';

/** Derive the public status from a contribution's outcome + latest verdict. */
export function contributionStatus(outcome: string, verdict: string | null): ContributionStatus {
  if (outcome !== 'candidate_solution') return 'logged';
  if (verdict === 'passed') return 'verified';
  if (verdict === 'failed') return 'rejected';
  // null (never verified — including a pre-fix trust auto-accept), 'pending',
  // or 'inconclusive': nothing has confirmed the claim, so it is still pending.
  return 'awaiting_verification';
}

export interface TargetProgress {
  slug: string;
  name: string;
  kind: string;
  status: string;
  statement_plain: string | null;
  statement_formal: string | null;
  source_ref: string | null;
  significance: string | null; // why the problem matters, in plain words
  tags: string[]; // coarse subject tags (number-theory, graph-theory, …)
  state: unknown; // compacted working set (current frontier, next steps)
  created_at: string;
  metrics: TargetProgressMetrics;
  /** The newest page of the feed; page the rest via listTargetContributions. */
  recent_contributions: TargetContribution[];
  /**
   * What this conjecture has actually established, oldest first. Append-only
   * and out of `state`, so no later submit can overwrite it.
   */
  facts: TargetFact[];
  /**
   * What is left to do, DERIVED from the task graph on every read — never
   * stored, so it cannot go stale. This is what a hand-maintained "NEXT: …"
   * field in `state` was standing in for.
   */
  next_steps: TargetNextSteps;
}

export interface TargetFact {
  id: number;
  claim: string;
  /** The contribution that established it, or null for an admin-seeded fact. */
  established_by: number | null;
  created_at: string;
  /** Superseded rather than deleted; retracted facts stay on the record. */
  retracted_at: string | null;
  retracted_reason: string | null;
}

export interface TargetNextSteps {
  /** Open tasks a volunteer could claim right now. */
  claimable: { id: string; title: string; kind: string; max_cost_cents: number }[];
  /** Submitted, waiting on verification or review — work in flight, not lost. */
  awaiting_verification: number;
  /**
   * Tasks whose lock expired: claimed, never finished, back in the pool. A
   * large number here is the signal that something is systematically failing
   * (the C4 timeout pile), which no prose field would ever have surfaced.
   */
  expired: number;
  /** Nothing claimable and nothing in flight — the target needs decomposition. */
  stalled: boolean;
}

/** One row of a conjecture's public contribution feed. */
export interface TargetContribution {
  outcome: string;
  summary: string;
  /** Unambiguous state of this contribution — see ContributionStatus. */
  status: ContributionStatus;
  verdict: string | null;
  /** How the verdict was reached (auto_rerun, human_review, …), if verified. */
  verified_via: string | null;
  /** The contributor's GitHub handle (public, as on the leaderboard), or null. */
  contributor: string | null;
  /**
   * For a work-unit contribution, the exact code that produced it, pinned by
   * commit SHA — the provenance that makes a result reproducible and
   * tamper-evident. Null for LLM/other contributions.
   */
  code: { repo: string; sha: string; entrypoint: string } | null;
  created_at: string;
}

/** How many contributions ride along in the progress payload itself. */
const PROGRESS_FEED_PAGE = 10;
/** Paging bounds for GET /conjectures/:slug/contributions. */
const CONTRIB_PAGE_DEFAULT = 25;
const CONTRIB_PAGE_MAX = 100;

// Only inherently-public kinds are exposed by slug. org_request work (the future
// vetted-org path) is never served on the public progress page.
const PUBLIC_TARGET_KINDS = ['conjecture', 'research_question'];

/**
 * Public progress for one conjecture, keyed by its human-readable slug: the
 * statement, current status, the compacted working set, roll-up metrics, and a
 * feed of the most recent contributions (the handoff notes read as a progress
 * log). No PII — conjectures are public. Returns null for an unknown slug or a
 * non-public kind. Backs GET /conjectures/:slug.
 */
export async function getTargetProgress(slug: string): Promise<TargetProgress | null> {
  const { rows } = await query<{
    id: string;
    slug: string;
    name: string;
    kind: string;
    status: string;
    statement_plain: string | null;
    statement_formal: string | null;
    source_ref: string | null;
    significance: string | null;
    tags: string[];
    state: unknown;
    created_at: string | Date;
  }>(
    `SELECT id, slug, name, kind::text AS kind, status::text AS status,
            statement_plain, statement_formal, source_ref, significance, tags, state, created_at
       FROM targets
      WHERE slug = $1 AND kind::text = ANY($2::text[])`,
    [slug, PUBLIC_TARGET_KINDS],
  );
  const t = rows[0];
  if (!t) return null;

  const m = await query<{
    tasks_total: number;
    tasks_open: number;
    tasks_resolved: number;
    contributions: number;
    contributors: number;
    compute_cents: number;
    last_activity_at: string | Date | null;
  }>(
    `SELECT
        (SELECT count(*)::int FROM tasks WHERE target_id = $1) AS tasks_total,
        (SELECT count(*)::int FROM tasks WHERE target_id = $1 AND status = 'open') AS tasks_open,
        (SELECT count(*)::int FROM tasks WHERE target_id = $1 AND status = 'accepted') AS tasks_resolved,
        (SELECT count(*)::int FROM contributions WHERE target_id = $1) AS contributions,
        (SELECT count(DISTINCT dev_id)::int FROM contributions WHERE target_id = $1) AS contributors,
        (SELECT COALESCE(SUM(cost_cents), 0)::bigint FROM contributions WHERE target_id = $1) AS compute_cents,
        (SELECT max(created_at) FROM contributions WHERE target_id = $1) AS last_activity_at`,
    [t.id],
  );
  const recent = await contributionPage(t.id, PROGRESS_FEED_PAGE, 0);
  const [facts, nextSteps] = await Promise.all([listTargetFacts(t.id), deriveNextSteps(t.id)]);
  const mr = m.rows[0];
  return {
    slug: t.slug,
    name: t.name,
    kind: t.kind,
    status: t.status,
    statement_plain: t.statement_plain,
    statement_formal: t.statement_formal,
    source_ref: t.source_ref,
    significance: t.significance,
    tags: t.tags,
    state: t.state,
    created_at: new Date(t.created_at).toISOString(),
    metrics: {
      tasks_total: mr.tasks_total,
      tasks_open: mr.tasks_open,
      tasks_resolved: mr.tasks_resolved,
      contributions: mr.contributions,
      contributors: mr.contributors,
      compute_cents: mr.compute_cents,
      last_activity_at: mr.last_activity_at ? new Date(mr.last_activity_at).toISOString() : null,
    },
    recent_contributions: recent,
    facts,
    next_steps: nextSteps,
  };
}

/** A target's established facts, oldest first — retracted ones included, marked. */
async function listTargetFacts(targetId: string): Promise<TargetFact[]> {
  const { rows } = await query<{
    id: string;
    claim: string;
    established_by: string | null;
    created_at: string | Date;
    retracted_at: string | Date | null;
    retracted_reason: string | null;
  }>(
    `SELECT id, claim, established_by, created_at, retracted_at, retracted_reason
       FROM target_facts WHERE target_id = $1 ORDER BY id`,
    [targetId],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    claim: r.claim,
    established_by: r.established_by === null ? null : Number(r.established_by),
    created_at: new Date(r.created_at).toISOString(),
    retracted_at: r.retracted_at ? new Date(r.retracted_at).toISOString() : null,
    retracted_reason: r.retracted_reason,
  }));
}

/**
 * What is left to do, computed from the task graph rather than stored.
 *
 * The whole reason a target ever carried a hand-written "NEXT: propose a
 * decomposition of …" was that nothing derived it. A stored directive is stale
 * the moment the work it describes lands, and then someone has to go and edit
 * the field — forever, once per conjecture per turn of work. This cannot go
 * stale, because there is nothing to keep up to date.
 */
async function deriveNextSteps(targetId: string): Promise<TargetNextSteps> {
  const { rows } = await query<{
    id: string;
    title: string;
    kind: string;
    max_cost_cents: string;
    status: string;
  }>(
    `SELECT id, title, kind::text AS kind, max_cost_cents, status::text AS status
       FROM tasks
      WHERE target_id = $1 AND status IN ('open', 'submitted', 'locked', 'expired')
      ORDER BY max_cost_cents, created_at`,
    [targetId],
  );
  const claimable = rows
    .filter((r) => r.status === 'open')
    .map((r) => ({
      id: r.id,
      title: r.title,
      kind: r.kind,
      max_cost_cents: Number(r.max_cost_cents),
    }));
  const awaiting = rows.filter((r) => r.status === 'submitted').length;
  const inFlight = rows.filter((r) => r.status === 'locked').length;
  return {
    claimable,
    awaiting_verification: awaiting,
    expired: rows.filter((r) => r.status === 'expired').length,
    stalled: claimable.length === 0 && awaiting === 0 && inFlight === 0,
  };
}

/**
 * One page of a target's contribution feed, newest first. Backs both the first
 * page embedded in getTargetProgress and GET /conjectures/:slug/contributions,
 * so the paged rows are byte-identical to the embedded ones — a "load more" can
 * never render a contribution differently from the ten above it.
 */
async function contributionPage(
  targetId: string,
  limit: number,
  offset: number,
): Promise<TargetContribution[]> {
  // Each contribution carries its latest verification verdict (if any) so the
  // public feed can distinguish a machine-verified solution from a mere claim.
  const { rows } = await query<{
    outcome: string;
    summary: string;
    verdict: string | null;
    verified_via: string | null;
    contributor: string | null;
    code_repo: string | null;
    code_sha: string | null;
    code_entrypoint: string | null;
    created_at: string | Date;
  }>(
    // Pull only the three public provenance fields out of raw_usage — never the
    // blob itself, which carries token/usage detail for LLM contributions.
    `SELECT c.outcome::text AS outcome, c.summary, v.verdict, v.method AS verified_via,
            d.github_handle AS contributor, c.created_at,
            CASE WHEN c.raw_usage->>'workunit' = 'true'
                 THEN c.raw_usage->>'repo' END AS code_repo,
            CASE WHEN c.raw_usage->>'workunit' = 'true'
                 THEN c.raw_usage->>'sha' END AS code_sha,
            CASE WHEN c.raw_usage->>'workunit' = 'true'
                 THEN c.raw_usage->>'entrypoint' END AS code_entrypoint
       FROM contributions c
       LEFT JOIN devs d ON d.id = c.dev_id
       LEFT JOIN LATERAL (
         SELECT verdict, method::text AS method FROM verifications v
          WHERE v.contribution_id = c.id
          ORDER BY v.id DESC
          LIMIT 1
       ) v ON true
      WHERE c.target_id = $1
      ORDER BY c.id DESC
      LIMIT $2 OFFSET $3`,
    [targetId, limit, offset],
  );
  return rows.map((r) => ({
    outcome: r.outcome,
    summary: r.summary,
    status: contributionStatus(r.outcome, r.verdict),
    verdict: r.verdict,
    verified_via: r.verified_via,
    contributor: r.contributor,
    code:
      r.code_repo && r.code_sha && r.code_entrypoint
        ? { repo: r.code_repo, sha: r.code_sha, entrypoint: r.code_entrypoint }
        : null,
    created_at: new Date(r.created_at).toISOString(),
  }));
}

/**
 * A page of the public contribution feed for one conjecture, by slug. Same
 * ordering (newest first) and same row shape as the feed embedded in
 * getTargetProgress, so the page can append without re-fetching what it has.
 * `total` is the full count, so a caller knows when to stop asking. Returns
 * null for an unknown slug or a non-public kind — identical to
 * getTargetProgress, so an unknown conjecture 404s the same way on both.
 *
 * Ordering is by `c.id DESC`, not `created_at DESC`: ids are monotonic, so a
 * paged walk can't repeat or skip a row when two contributions share a
 * timestamp — the classic OFFSET-with-ties bug.
 */
export async function listTargetContributions(
  slug: string,
  // Strings as well as numbers: these come straight off the query string, and
  // clampInt is what turns `?limit=abc` / `?offset=-5` into something safe.
  opts: { limit?: number | string; offset?: number | string } = {},
): Promise<{ contributions: TargetContribution[]; total: number; has_more: boolean } | null> {
  const limit = clampInt(opts.limit, CONTRIB_PAGE_DEFAULT, 1, CONTRIB_PAGE_MAX);
  const offset = clampInt(opts.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM targets WHERE slug = $1 AND kind::text = ANY($2::text[])`,
    [slug, PUBLIC_TARGET_KINDS],
  );
  const t = rows[0];
  if (!t) return null;
  const { rows: cnt } = await query<{ total: number }>(
    'SELECT count(*)::int AS total FROM contributions WHERE target_id = $1',
    [t.id],
  );
  const total = cnt[0].total;
  const contributions = await contributionPage(t.id, limit, offset);
  return { contributions, total, has_more: offset + contributions.length < total };
}

/** One task in a conjecture's decomposition forest. */
export interface TaskTreeNode {
  id: string;
  title: string;
  kind: string;
  status: string;
  max_cost_cents: number;
  created_at: string;
  /** How many contributions have landed on this task. */
  contributions: number;
  /** The task this one was split out of, or null for a root ("impetus") task. */
  parent_id: string | null;
  /**
   * The decomposition proposal that produced this task — the *reason* it
   * exists. Null on roots. Publication only happens after a peer agent
   * approves the proposal, so a present `via` implies it was peer-approved.
   */
  via: {
    /** The proposal contribution. Siblings from one split share it, so the UI can caption the split once. */
    id: string;
    proposed_by: string | null;
    proposed_at: string;
  } | null;
}

/**
 * The decomposition forest for one conjecture: every task, plus the edge back
 * to the task it was split out of. Flat, with `parent_id` — the caller builds
 * the tree, which keeps the payload shallow and the recursion out of Postgres.
 *
 * The edge is deliberately two hops. `tasks.decomposed_from` points at the
 * *contribution* that proposed the split, and that contribution points at the
 * parent task, so the lineage carries who proposed the split as well as what
 * came of it.
 *
 * Auto-minted peer-review tasks are excluded: their `decomposed_from` is null,
 * so they would render as extra roots and read as impetus tasks that nobody
 * ever proposed. They are process around an edge, not structure in the tree —
 * `review_excluded` reports how many were dropped so the count is never a
 * silent truncation.
 */
export async function getTargetTaskTree(
  slug: string,
): Promise<{ nodes: TaskTreeNode[]; review_excluded: number } | null> {
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM targets WHERE slug = $1 AND kind::text = ANY($2::text[])`,
    [slug, PUBLIC_TARGET_KINDS],
  );
  const t = rows[0];
  if (!t) return null;
  const { rows: nodes } = await query<{
    id: string;
    title: string;
    kind: string;
    status: string;
    max_cost_cents: number;
    created_at: string | Date;
    contributions: number;
    parent_id: string | null;
    proposed_by: string | null;
    proposed_at: string | Date | null;
    via_id: string | null;
    is_review: boolean;
  }>(
    `SELECT t.id, t.title, t.kind::text AS kind, t.status::text AS status,
            t.max_cost_cents, t.created_at,
            (SELECT count(*)::int FROM contributions c WHERE c.task_id = t.id) AS contributions,
            p.task_id AS parent_id,
            d.github_handle AS proposed_by,
            p.created_at AS proposed_at,
            p.id::text AS via_id,
            (t.spec ? 'review_of') AS is_review
       FROM tasks t
       LEFT JOIN contributions p ON p.id = t.decomposed_from
       LEFT JOIN devs d ON d.id = p.dev_id
      WHERE t.target_id = $1
      -- title breaks the tie: subtasks from one split are inserted in a single
      -- transaction and therefore share created_at exactly, so without it the
      -- sibling order is unspecified and the tree can reshuffle between loads.
      -- (The proposer's own ordering isn't recoverable — nothing records it.)
      ORDER BY t.decomposition_depth, t.created_at, t.title`,
    [t.id],
  );
  const kept = nodes.filter((n) => !n.is_review);
  return {
    review_excluded: nodes.length - kept.length,
    nodes: kept.map((n) => ({
      id: n.id,
      title: n.title,
      kind: n.kind,
      status: n.status,
      max_cost_cents: Number(n.max_cost_cents),
      created_at: new Date(n.created_at).toISOString(),
      contributions: n.contributions,
      parent_id: n.parent_id,
      via:
        n.proposed_at && n.via_id
          ? {
              id: n.via_id,
              proposed_by: n.proposed_by,
              proposed_at: new Date(n.proposed_at).toISOString(),
            }
          : null,
    })),
  };
}

/** Coerce a caller-supplied paging number into range; anything unparseable → fallback. */
function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

// ---------------------------------------------------------------------------
// public leaderboard
// ---------------------------------------------------------------------------

export interface LeaderboardConjecture {
  slug: string;
  name: string;
  status: string;
  tags: string[];
  tasks_total: number;
  contributions: number;
  contributors: number;
  compute_cents: number;
}

export interface LeaderboardContributor {
  github_handle: string;
  tasks: number;
  donated_cents: number;
}

export interface Leaderboard {
  totals: {
    conjectures: number;
    open: number;
    settled: number;
    contributors: number;
    compute_cents: number;
  };
  conjectures: LeaderboardConjecture[];
  contributors: LeaderboardContributor[];
}

export interface AvailableTask {
  id: string;
  title: string;
  kind: string;
  verify_via: string;
  deliverable: string; // 'explainer_video' | 'math_attack'
  angle: string | null;
  max_cost_cents: number;
  conjecture_slug: string;
  conjecture_name: string;
  created_at: string;
}

/**
 * The public work board: open tasks anyone can browse before signing up — the
 * "here's what you could pick up" surface. Deliberately narrow: only tasks that
 * are `open`, `public` sensitivity, AND attached to a public slugged target, so
 * org_request work and anything non-public can never appear here however it was
 * created. Task titles/angles are public-safe by construction (open mathematics);
 * the full prompt stays behind checkout. Drives GET /tasks/available.
 */
export async function listAvailableTasks(
  opts: { slug?: string; deliverable?: string; limit?: number } = {},
): Promise<AvailableTask[]> {
  let limit = opts.limit ?? 60;
  if (!Number.isInteger(limit) || limit <= 0) limit = 60;
  if (limit > 200) limit = 200;

  const { rows } = await query<AvailableTask>(
    `SELECT k.id, k.title, k.kind::text AS kind, k.verify_via::text AS verify_via,
            COALESCE(k.spec->>'deliverable', 'math_attack') AS deliverable,
            k.spec->>'angle' AS angle,
            k.max_cost_cents, k.created_at,
            t.slug AS conjecture_slug, t.name AS conjecture_name
       FROM tasks k
       JOIN targets t ON t.id = k.target_id
      WHERE k.status = 'open'
        AND k.sensitivity = 'public'
        -- Onboarding tasks are minted per dev, so they are not "available" to
        -- browse: showing them would advertise work nobody else can claim.
        AND k.onboarding_dev_id IS NULL
        AND t.slug IS NOT NULL
        AND t.kind::text = ANY($1::text[])
        AND ($2::text IS NULL OR t.slug = $2)
        AND ($3::text IS NULL OR COALESCE(k.spec->>'deliverable', 'math_attack') = $3)
      ORDER BY k.created_at DESC
      LIMIT $4`,
    [PUBLIC_TARGET_KINDS, opts.slug ?? null, opts.deliverable ?? null, limit],
  );
  return rows.map((r) => ({ ...r, created_at: new Date(r.created_at).toISOString() }));
}

/**
 * The public "who's chipping at what" rollup: curated conjectures (a target is
 * curated once it has a slug) with their progress, and the top contributors by
 * donated compute. No PII, no task content — names, slugs, statuses, counts, and
 * donated cents only. Drives GET /leaderboard.
 */
export async function getLeaderboard(): Promise<Leaderboard> {
  const conjecturesP = query<LeaderboardConjecture>(
    `SELECT tg.slug, tg.name, tg.status::text AS status, tg.tags,
            (SELECT count(*)::int FROM tasks t WHERE t.target_id = tg.id) AS tasks_total,
            (SELECT count(*)::int FROM contributions c WHERE c.target_id = tg.id) AS contributions,
            (SELECT count(DISTINCT c.dev_id)::int FROM contributions c WHERE c.target_id = tg.id) AS contributors,
            (SELECT COALESCE(SUM(c.cost_cents), 0)::bigint FROM contributions c WHERE c.target_id = tg.id) AS compute_cents
       FROM targets tg
      WHERE tg.slug IS NOT NULL AND tg.kind::text = ANY($1::text[])
      ORDER BY compute_cents DESC, tg.name ASC`,
    [PUBLIC_TARGET_KINDS],
  );
  const contributorsP = query<LeaderboardContributor>(
    `SELECT d.github_handle,
            count(DISTINCT c.task_id)::int AS tasks,
            COALESCE(SUM(c.cost_cents), 0)::bigint AS donated_cents
       FROM contributions c
       JOIN devs d ON d.id = c.dev_id
       JOIN targets t ON t.id = c.target_id
      WHERE t.slug IS NOT NULL AND t.kind::text = ANY($1::text[])
      GROUP BY d.id, d.github_handle
      ORDER BY donated_cents DESC, tasks DESC
      LIMIT 20`,
    [PUBLIC_TARGET_KINDS],
  );
  const totalsP = query<{
    conjectures: number;
    open: number;
    settled: number;
    contributors: number;
    compute_cents: number;
  }>(
    `SELECT
        (SELECT count(*)::int FROM targets
          WHERE slug IS NOT NULL AND kind::text = ANY($1::text[])) AS conjectures,
        (SELECT count(*)::int FROM targets
          WHERE slug IS NOT NULL AND kind::text = ANY($1::text[]) AND status = 'open') AS open,
        (SELECT count(*)::int FROM targets
          WHERE slug IS NOT NULL AND kind::text = ANY($1::text[])
            AND status IN ('resolved', 'disproven')) AS settled,
        -- Scope the contribution rollups to the same public, slugged targets the
        -- cards show, so the totals never exceed the sum of the cards (and never
        -- leak aggregate activity on non-public org_request work).
        (SELECT count(DISTINCT c.dev_id)::int
           FROM contributions c JOIN targets t ON t.id = c.target_id
          WHERE t.slug IS NOT NULL AND t.kind::text = ANY($1::text[])) AS contributors,
        (SELECT COALESCE(SUM(c.cost_cents), 0)::bigint
           FROM contributions c JOIN targets t ON t.id = c.target_id
          WHERE t.slug IS NOT NULL AND t.kind::text = ANY($1::text[])) AS compute_cents`,
    [PUBLIC_TARGET_KINDS],
  );
  const [conjectures, contributors, totals] = await Promise.all([
    conjecturesP,
    contributorsP,
    totalsP,
  ]);
  return {
    totals: totals.rows[0],
    conjectures: conjectures.rows,
    contributors: contributors.rows,
  };
}

// ---------------------------------------------------------------------------
// contributor profile — a shareable page of one volunteer's public work
// ---------------------------------------------------------------------------

export interface ContributorProfile {
  github_handle: string;
  totals: {
    conjectures: number;
    contributions: number;
    compute_cents: number;
    first_at: string | null;
    last_at: string | null;
  };
  contributions: {
    conjecture_slug: string;
    conjecture_name: string;
    outcome: string;
    summary: string;
    /** Unambiguous state of this contribution — see ContributionStatus. */
    status: ContributionStatus;
    verdict: string | null;
    verified_via: string | null;
    cost_cents: number;
    created_at: string;
  }[];
}

/**
 * One volunteer's public contribution history — the shareable "here's my work"
 * page, keyed by GitHub handle (already public via the leaderboard). Only
 * contributions to public, slugged conjectures are shown; org_request work is
 * never surfaced. Returns null for an unknown handle. Backs GET
 * /contributors/:handle.
 */
export async function getContributorProfile(handle: string): Promise<ContributorProfile | null> {
  // GitHub handles are case-insensitive and people link them in any case, so
  // match case-insensitively and return the canonical stored casing.
  const dev = (
    await query<{ id: string; github_handle: string }>(
      `SELECT id, github_handle FROM devs WHERE lower(github_handle) = lower($1)`,
      [handle],
    )
  ).rows[0];
  if (!dev) return null;

  const totalsRow = (
    await query<{
      conjectures: number;
      contributions: number;
      compute_cents: number;
      first_at: string | Date | null;
      last_at: string | Date | null;
    }>(
      `SELECT count(DISTINCT c.target_id)::int AS conjectures,
              count(*)::int AS contributions,
              COALESCE(SUM(c.cost_cents), 0)::bigint AS compute_cents,
              min(c.created_at) AS first_at, max(c.created_at) AS last_at
         FROM contributions c
         JOIN targets tg ON tg.id = c.target_id
        WHERE c.dev_id = $1 AND tg.slug IS NOT NULL AND tg.kind::text = ANY($2::text[])`,
      [dev.id, PUBLIC_TARGET_KINDS],
    )
  ).rows[0];

  const rows = (
    await query<{
      conjecture_slug: string;
      conjecture_name: string;
      outcome: string;
      summary: string;
      verdict: string | null;
      verified_via: string | null;
      cost_cents: number;
      created_at: string | Date;
    }>(
      `SELECT tg.slug AS conjecture_slug, tg.name AS conjecture_name,
              c.outcome::text AS outcome, c.summary, c.cost_cents, c.created_at,
              v.verdict, v.method AS verified_via
         FROM contributions c
         JOIN targets tg ON tg.id = c.target_id
         LEFT JOIN LATERAL (
           SELECT verdict, method::text AS method FROM verifications v
            WHERE v.contribution_id = c.id ORDER BY v.id DESC LIMIT 1
         ) v ON true
        WHERE c.dev_id = $1 AND tg.slug IS NOT NULL AND tg.kind::text = ANY($2::text[])
        ORDER BY c.id DESC
        LIMIT 50`,
      [dev.id, PUBLIC_TARGET_KINDS],
    )
  ).rows;

  return {
    github_handle: dev.github_handle,
    totals: {
      conjectures: totalsRow?.conjectures ?? 0,
      contributions: totalsRow?.contributions ?? 0,
      compute_cents: totalsRow?.compute_cents ?? 0,
      first_at: totalsRow?.first_at ? new Date(totalsRow.first_at).toISOString() : null,
      last_at: totalsRow?.last_at ? new Date(totalsRow.last_at).toISOString() : null,
    },
    contributions: rows.map((r) => ({
      conjecture_slug: r.conjecture_slug,
      conjecture_name: r.conjecture_name,
      outcome: r.outcome,
      summary: r.summary,
      status: contributionStatus(r.outcome, r.verdict),
      verdict: r.verdict,
      verified_via: r.verified_via,
      cost_cents: r.cost_cents,
      created_at: new Date(r.created_at).toISOString(),
    })),
  };
}
