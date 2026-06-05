import { withTransaction, query, type Client } from './db.js';

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
  nonprofit_id: string;
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

export interface CheckoutResult {
  task_id: string;
  spec: unknown;
  title: string;
  model: string;
  max_cost_cents: number;
  lock_expires_at: string;
}

/**
 * Atomically reserve budget and lock an open task to a dev for 10 minutes.
 * Order matters: lock the budget row first (serialization point), then claim
 * the task, then mutate budget, then write the ledger row.
 */
export async function checkoutTask(
  devId: string,
  taskId: string,
): Promise<CheckoutResult> {
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
    const available =
      budget.budget_cents - budget.reserved_cents - budget.spent_cents;
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
        RETURNING id, nonprofit_id, title, spec, model, max_cost_cents, lock_expires_at`,
      [taskId, devId],
    );
    if (claim.rowCount === 0) {
      throw new OpError(
        CONFLICT,
        'task_not_open',
        'Task already claimed or not open',
      );
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
      `INSERT INTO ledger (task_id, dev_id, nonprofit_id, event_type, delta_cents)
       VALUES ($1, $2, $3, 'checkout', $4)`,
      [taskId, devId, claimed.nonprofit_id, task.max_cost_cents],
    );

    return {
      task_id: claimed.id,
      spec: claimed.spec,
      title: claimed.title,
      model: claimed.model,
      max_cost_cents: claimed.max_cost_cents,
      lock_expires_at: claimed.lock_expires_at as string,
    };
  });
}

// ---------------------------------------------------------------------------
// submit
// ---------------------------------------------------------------------------

export interface SubmitResult {
  task_id: string;
  status: 'submitted';
  reserved_released: number;
  spent_applied: number;
  overage_clamped: boolean;
}

/**
 * Atomically record a result for a locked task and move the reservation to
 * spend. Releases exactly the amount reserved at checkout (the task's
 * max_cost_cents) and applies the actual spend.
 *
 * Overage handling: actual_cost_cents should normally be <= max_cost_cents (the
 * runner aborts before exceeding). But if actual > reserved, naively applying it
 * could push reserved + spent over budget and fail the CHECK constraint. We
 * never let that happen: we clamp the spend increment to max_cost_cents and flag
 * the overage in the ledger's raw_usage. The platform eats the difference in
 * Stage 1 rather than failing the transaction — a wrong receipt is worse than a
 * capped one, and the budget invariant is sacred.
 */
export async function submitResult(
  devId: string,
  taskId: string,
  result: unknown,
  actualCostCents: number,
  rawUsage: unknown,
): Promise<SubmitResult> {
  // actual_cost_cents comes straight from the dev's /submit body. Reject
  // negatives, NaN, and non-integers up front: a negative value would refund
  // the dev's own spend (corrupting the ledger and letting them overspend the
  // pool), and NaN/floats would error or skew the budget arithmetic.
  if (!Number.isInteger(actualCostCents) || actualCostCents < 0) {
    throw new OpError(BAD_INPUT, 'bad_input', 'actual_cost_cents must be a non-negative integer');
  }
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

    // 2. Move the task to submitted, guarded on lock+assignment.
    const upd = await client.query<{ max_cost_cents: number }>(
      `UPDATE tasks
          SET status = 'submitted',
              actual_cost_cents = $3,
              result = $4,
              submitted_at = now()
        WHERE id = $1 AND assigned_dev_id = $2 AND status = 'locked'
        RETURNING max_cost_cents`,
      [taskId, devId, actualCostCents, result],
    );
    if (upd.rowCount === 0) {
      throw new OpError(
        CONFLICT,
        'not_locked',
        'Task not locked to you or already moved on',
      );
    }
    const reserved = upd.rows[0].max_cost_cents;

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
      `INSERT INTO ledger (task_id, dev_id, nonprofit_id, event_type, delta_cents, raw_usage)
       SELECT $1, $2, t.nonprofit_id, 'submit', $3, $4
         FROM tasks t WHERE t.id = $1`,
      [taskId, devId, spendApplied - reserved, JSON.stringify(usagePayload ?? null)],
    );

    return {
      task_id: taskId,
      status: 'submitted',
      reserved_released: reserved,
      spent_applied: spendApplied,
      overage_clamped: overageClamped,
    };
  });
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
export async function releaseTask(
  devId: string,
  taskId: string,
): Promise<ReleaseResult> {
  return withTransaction(async (client) => {
    const period = await reservedPeriodOf(client, taskId);
    const budget = await lockDevBudget(client, devId, period);
    if (!budget) {
      throw new OpError(CONFLICT, 'not_locked', 'Task not locked to you');
    }

    const upd = await client.query<{ max_cost_cents: number; nonprofit_id: string }>(
      `UPDATE tasks
          SET status = 'open', assigned_dev_id = NULL, lock_expires_at = NULL, reserved_period = NULL
        WHERE id = $1 AND assigned_dev_id = $2 AND status = 'locked'
        RETURNING max_cost_cents, nonprofit_id`,
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
      `INSERT INTO ledger (task_id, dev_id, nonprofit_id, event_type, delta_cents)
       VALUES ($1, $2, $3, 'release', $4)`,
      [taskId, devId, upd.rows[0].nonprofit_id, -reserved],
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
      nonprofit_id: string;
      max_cost_cents: number;
      reserved_period: string | null;
    }>(
      `SELECT id, assigned_dev_id, nonprofit_id, max_cost_cents, reserved_period
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
        `INSERT INTO ledger (task_id, dev_id, nonprofit_id, event_type, delta_cents)
         VALUES ($1, $2, $3, 'expire', $4)`,
        [r.id, r.assigned_dev_id, r.nonprofit_id, -r.max_cost_cents],
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
    const upd = await client.query<{ dev_id: string; nonprofit_id: string }>(
      `UPDATE tasks
          SET status = 'accepted', accepted_at = now()
        WHERE id = $1 AND status = 'submitted'
        RETURNING assigned_dev_id AS dev_id, nonprofit_id`,
      [taskId],
    );
    if (upd.rowCount === 0) {
      throw new OpError(CONFLICT, 'not_submitted', 'Task is not in submitted state');
    }
    await client.query(
      `INSERT INTO ledger (task_id, dev_id, nonprofit_id, event_type, delta_cents)
       VALUES ($1, $2, $3, 'accept', 0)`,
      [taskId, upd.rows[0].dev_id, upd.rows[0].nonprofit_id],
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
    const upd = await client.query<{ dev_id: string; nonprofit_id: string }>(
      `UPDATE tasks
          SET status = 'open', assigned_dev_id = NULL, lock_expires_at = NULL
        WHERE id = $1 AND status = 'submitted'
        RETURNING assigned_dev_id AS dev_id, nonprofit_id`,
      [taskId],
    );
    if (upd.rowCount === 0) {
      throw new OpError(CONFLICT, 'not_submitted', 'Task is not in submitted state');
    }
    await client.query(
      `INSERT INTO ledger (task_id, dev_id, nonprofit_id, event_type, delta_cents)
       VALUES ($1, $2, $3, 'reject', 0)`,
      [taskId, upd.rows[0].dev_id, upd.rows[0].nonprofit_id],
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
  const { rows } = await query<{ verified: boolean }>(
    `SELECT verified FROM devs WHERE id = $1`,
    [devId],
  );
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
export async function setOwnBudget(
  devId: string,
  budgetCents: number,
): Promise<BudgetView> {
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
  nonprofit_id: string;
  nonprofit_name: string | null;
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
            l.nonprofit_id, n.name AS nonprofit_name,
            l.event_type, l.delta_cents, l.created_at
       FROM ledger l
       LEFT JOIN tasks t ON t.id = l.task_id
       LEFT JOIN nonprofits n ON n.id = l.nonprofit_id
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
  nonprofits_helped: number;
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
    nonprofits_helped: number;
    first_contribution_at: string | null;
    last_contribution_at: string | null;
  }>(
    `SELECT
        COALESCE(SUM(l.delta_cents + t.max_cost_cents)
                 FILTER (WHERE l.event_type = 'submit'), 0)::bigint AS total_donated_cents,
        COUNT(DISTINCT l.task_id) FILTER (WHERE l.event_type = 'submit') AS tasks_completed,
        COUNT(DISTINCT l.task_id) FILTER (WHERE l.event_type = 'accept') AS tasks_accepted,
        COUNT(DISTINCT l.nonprofit_id)
          FILTER (WHERE l.event_type IN ('submit', 'accept')) AS nonprofits_helped,
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
    nonprofits_helped: s.nonprofits_helped,
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
  const effectiveSensitivity =
    filter.devVerified === false ? 'public' : filter.sensitivity;
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
    `SELECT id, nonprofit_id, title, spec, est_cost_cents, max_cost_cents,
            model, sensitivity, status, created_at
       FROM tasks
      WHERE ${conditions.join(' AND ')}
      ORDER BY created_at ASC
      LIMIT ${limitParam}`,
    params,
  );
  return rows;
}
