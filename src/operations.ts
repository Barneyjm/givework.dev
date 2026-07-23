import { type Client, query, withTransaction } from './db.js';

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
// checkout
// ---------------------------------------------------------------------------

/** A recent chunk of work on a task, surfaced to the next agent that picks it up. */
export interface ContributionSummary {
  id: number;
  outcome: string;
  summary: string;
  artifact_uri: string | null;
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
}

/** How many recent contributions to hydrate into a checkout's context. */
const PRIOR_CONTRIBUTIONS_LIMIT = 5;

/**
 * Atomically reserve budget and lock an open task to a dev for 10 minutes.
 * Order matters: lock the budget row first (serialization point), then claim
 * the task, then mutate budget, then write the ledger row.
 */
export async function checkoutTask(devId: string, taskId: string): Promise<CheckoutResult> {
  return withTransaction(async (client) => {
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

    // Need the task's cost (budget gate) and sensitivity (trust gate) up front.
    const taskRes = await client.query<TaskRow>(
      `SELECT id, max_cost_cents, status, sensitivity FROM tasks WHERE id = $1`,
      [taskId],
    );
    const task = taskRes.rows[0];
    if (!task) {
      throw new OpError(404, 'task_not_found', 'Unknown task');
    }
    // Report an already-claimed task as such, rather than letting the budget gate
    // below mask it as a misleading 402. The claim UPDATE still guards on
    // status='open', so this is just clearer up-front error reporting.
    if (task.status !== 'open') {
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
    const claim = await client.query<TaskRow>(
      `UPDATE tasks
          SET status = 'locked',
              assigned_dev_id = $2,
              lock_expires_at = now() + interval '10 minutes',
              reserved_period = ${CURRENT_PERIOD}
        WHERE id = $1 AND status = 'open'
        RETURNING id, target_id, title, spec, model, max_cost_cents, lock_expires_at`,
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
    const stateRes = await client.query<{ state: unknown }>(
      `SELECT state FROM targets WHERE id = $1`,
      [claimed.target_id],
    );
    const prior = await client.query<ContributionSummary>(
      `SELECT id, outcome, summary, artifact_uri, cost_cents, created_at
         FROM contributions
        WHERE task_id = $1
        ORDER BY id DESC
        LIMIT $2`,
      [taskId, PRIOR_CONTRIBUTIONS_LIMIT],
    );

    return {
      task_id: claimed.id,
      spec: claimed.spec,
      title: claimed.title,
      model: claimed.model,
      max_cost_cents: claimed.max_cost_cents,
      lock_expires_at: claimed.lock_expires_at as string,
      target_state: stateRes.rows[0]?.state ?? {},
      prior_contributions: prior.rows,
    };
  });
}

// ---------------------------------------------------------------------------
// submit
// ---------------------------------------------------------------------------

export type ContributionOutcome = 'progress' | 'dead_end' | 'candidate_solution';
const CONTRIBUTION_OUTCOMES: readonly ContributionOutcome[] = [
  'progress',
  'dead_end',
  'candidate_solution',
];

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
}

/**
 * Record one chunk of work on a locked task: append a `contributions` row, book
 * the spend, and either finish the task (a candidate solution -> 'submitted') or
 * return it to the pool for the next agent (progress / dead end -> 'open'). In
 * every case the reservation made at checkout (max_cost_cents) is released and
 * the actual spend applied — the budget mechanics are identical to the original
 * one-shot submit; only the resulting task status and the appended log differ.
 *
 * Overage handling (unchanged): actual_cost_cents should be <= max_cost_cents.
 * If it exceeds the reservation, naively applying it could push reserved + spent
 * over budget and fail the CHECK. We clamp the spend to max_cost_cents and flag
 * the overage in raw_usage — a capped tracked total beats a violated invariant.
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
  const terminal = outcome === 'candidate_solution';

  return withTransaction(async (client) => {
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
    //    artifact lives on the contributions row, not the task).
    const upd = terminal
      ? await client.query<{ max_cost_cents: number; target_id: string }>(
          `UPDATE tasks
              SET status = 'submitted',
                  actual_cost_cents = $3,
                  result = $4,
                  submitted_at = now()
            WHERE id = $1 AND assigned_dev_id = $2 AND status = 'locked'
            RETURNING max_cost_cents, target_id`,
          [taskId, devId, actualCostCents, result],
        )
      : await client.query<{ max_cost_cents: number; target_id: string }>(
          `UPDATE tasks
              SET status = 'open',
                  assigned_dev_id = NULL,
                  lock_expires_at = NULL,
                  reserved_period = NULL
            WHERE id = $1 AND assigned_dev_id = $2 AND status = 'locked'
            RETURNING max_cost_cents, target_id`,
          [taskId, devId],
        );
    if (upd.rowCount === 0) {
      throw new OpError(CONFLICT, 'not_locked', 'Task not locked to you or already moved on');
    }
    const reserved = upd.rows[0].max_cost_cents;
    const targetId = upd.rows[0].target_id;

    // Clamp the spend so reserved + spent can never exceed budget.
    let spendApplied = actualCostCents;
    let overageClamped = false;
    if (actualCostCents > reserved) {
      spendApplied = reserved;
      overageClamped = true;
    }

    // 3. Release the reservation, apply the spend — in the reservation's period.
    await client.query(
      `UPDATE dev_budgets
          SET reserved_cents = reserved_cents - $2,
              spent_cents = spent_cents + $3
        WHERE dev_id = $1 AND period = COALESCE($4::date, ${CURRENT_PERIOD})`,
      [devId, reserved, spendApplied, period],
    );

    // 4. Ledger: net delta of this event is (spend applied) - (reservation released).
    const usagePayload = overageClamped
      ? {
          ...(rawUsage && typeof rawUsage === 'object' ? rawUsage : { rawUsage }),
          overage: true,
          reported_cost_cents: actualCostCents,
          clamped_to_cents: reserved,
        }
      : rawUsage;

    await client.query(
      `INSERT INTO ledger (task_id, dev_id, target_id, event_type, delta_cents, raw_usage)
       VALUES ($1, $2, $3, 'submit', $4, $5)`,
      [taskId, devId, targetId, spendApplied - reserved, JSON.stringify(usagePayload ?? null)],
    );

    // 5. Append the contribution — the durable, append-only record of this chunk
    //    (progress or dead end alike). cost_cents is the booked spend.
    const contrib = await client.query<{ id: number }>(
      `INSERT INTO contributions
         (task_id, target_id, dev_id, outcome, summary, artifact_uri, artifact, cost_cents, raw_usage)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        taskId,
        targetId,
        devId,
        outcome,
        opts.summary ?? '',
        opts.artifactUri ?? null,
        opts.artifact != null ? JSON.stringify(opts.artifact) : null,
        spendApplied,
        JSON.stringify(usagePayload ?? null),
      ],
    );

    // 6. Refresh the target's compacted working set, if the agent supplied one.
    if (opts.stateUpdate !== undefined) {
      await client.query(`UPDATE targets SET state = $2 WHERE id = $1`, [
        targetId,
        JSON.stringify(opts.stateUpdate),
      ]);
    }

    return {
      task_id: taskId,
      status: terminal ? 'submitted' : 'open',
      outcome,
      contribution_id: contrib.rows[0].id,
      reserved_released: reserved,
      spent_applied: spendApplied,
      overage_clamped: overageClamped,
    };
  });
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
// release
// ---------------------------------------------------------------------------

export interface ReleaseResult {
  task_id: string;
  status: 'open';
  reserved_released: number;
}

/** Voluntarily abandon a locked task, returning it to the pool and freeing the reservation. */
export async function releaseTask(devId: string, taskId: string): Promise<ReleaseResult> {
  return withTransaction(async (client) => {
    const period = await reservedPeriodOf(client, taskId);
    const budget = await lockDevBudget(client, devId, period);
    if (!budget) {
      throw new OpError(CONFLICT, 'not_locked', 'Task not locked to you');
    }

    const upd = await client.query<{ max_cost_cents: number; target_id: string }>(
      `UPDATE tasks
          SET status = 'open', assigned_dev_id = NULL, lock_expires_at = NULL, reserved_period = NULL
        WHERE id = $1 AND assigned_dev_id = $2 AND status = 'locked'
        RETURNING max_cost_cents, target_id`,
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

    return { task_id: taskId, status: 'open', reserved_released: reserved };
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
    const upd = await client.query<{ dev_id: string; target_id: string }>(
      `UPDATE tasks
          SET status = 'open', assigned_dev_id = NULL, lock_expires_at = NULL
        WHERE id = $1 AND status = 'submitted'
        RETURNING assigned_dev_id AS dev_id, target_id`,
      [taskId],
    );
    if (upd.rowCount === 0) {
      throw new OpError(CONFLICT, 'not_submitted', 'Task is not in submitted state');
    }
    await client.query(
      `INSERT INTO ledger (task_id, dev_id, target_id, event_type, delta_cents)
       VALUES ($1, $2, $3, 'reject', 0)`,
      [taskId, upd.rows[0].dev_id, upd.rows[0].target_id],
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
  try {
    await query(
      `INSERT INTO dev_budgets (dev_id, period, budget_cents)
       VALUES ($1, ${CURRENT_PERIOD}, $2)
       ON CONFLICT (dev_id, period) DO UPDATE SET budget_cents = EXCLUDED.budget_cents`,
      [devId, budgetCents],
    );
  } catch (err: any) {
    if (err?.code === '23514') {
      // CHECK (reserved_cents + spent_cents <= budget_cents)
      throw new OpError(
        CONFLICT,
        'budget_below_committed',
        'New budget is below what you have already reserved or spent this period',
      );
    }
    throw err;
  }
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

export interface TargetProgress {
  slug: string;
  name: string;
  kind: string;
  status: string;
  statement_plain: string | null;
  statement_formal: string | null;
  source_ref: string | null;
  state: unknown; // compacted working set (current frontier, next steps)
  created_at: string;
  metrics: TargetProgressMetrics;
  recent_contributions: { outcome: string; summary: string; created_at: string }[];
}

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
    state: unknown;
    created_at: string | Date;
  }>(
    `SELECT id, slug, name, kind::text AS kind, status::text AS status,
            statement_plain, statement_formal, source_ref, state, created_at
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
  const recent = await query<{ outcome: string; summary: string; created_at: string | Date }>(
    `SELECT outcome::text AS outcome, summary, created_at
       FROM contributions
      WHERE target_id = $1
      ORDER BY id DESC
      LIMIT 10`,
    [t.id],
  );
  const mr = m.rows[0];
  return {
    slug: t.slug,
    name: t.name,
    kind: t.kind,
    status: t.status,
    statement_plain: t.statement_plain,
    statement_formal: t.statement_formal,
    source_ref: t.source_ref,
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
    recent_contributions: recent.rows.map((r) => ({
      outcome: r.outcome,
      summary: r.summary,
      created_at: new Date(r.created_at).toISOString(),
    })),
  };
}
