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
 * Lock the dev's current-period budget row FOR UPDATE. This is the
 * serialization point: concurrent operations by the same dev block here so two
 * checkouts can't both pass the budget check on stale reads. Returns null if no
 * budget row exists for the current period (we never auto-create one).
 */
async function lockDevBudget(
  client: Client,
  devId: string,
): Promise<DevBudgetRow | null> {
  const { rows } = await client.query<DevBudgetRow>(
    `SELECT dev_id, period, budget_cents, reserved_cents, spent_cents
       FROM dev_budgets
      WHERE dev_id = $1 AND period = ${CURRENT_PERIOD}
      FOR UPDATE`,
    [devId],
  );
  return rows[0] ?? null;
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

    // Need the task's cost before we can evaluate the budget gate.
    const taskRes = await client.query<TaskRow>(
      `SELECT id, max_cost_cents, status FROM tasks WHERE id = $1`,
      [taskId],
    );
    const task = taskRes.rows[0];
    if (!task) {
      throw new OpError(404, 'task_not_found', 'Unknown task');
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
              lock_expires_at = now() + interval '10 minutes'
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
  return withTransaction(async (client) => {
    // 1. Lock the dev's budget row.
    const budget = await lockDevBudget(client, devId);
    if (!budget) {
      // The reservation was made against a budget row; its absence means the
      // task isn't legitimately locked to this dev in this period.
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

    // 3. Release the reservation, apply the spend.
    await client.query(
      `UPDATE dev_budgets
          SET reserved_cents = reserved_cents - $2,
              spent_cents = spent_cents + $3
        WHERE dev_id = $1 AND period = ${CURRENT_PERIOD}`,
      [devId, reserved, spendApplied],
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
    const budget = await lockDevBudget(client, devId);
    if (!budget) {
      throw new OpError(CONFLICT, 'not_locked', 'Task not locked to you');
    }

    const upd = await client.query<{ max_cost_cents: number; nonprofit_id: string }>(
      `UPDATE tasks
          SET status = 'open', assigned_dev_id = NULL, lock_expires_at = NULL
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
        WHERE dev_id = $1 AND period = ${CURRENT_PERIOD}`,
      [devId, reserved],
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
 * transaction. STAGE 2: a reservation is freed from the *current* period; if a
 * lock straddles a month boundary (checked out in one month, expires in the
 * next) the reservation should be released from the period it was made in. Stage
 * 1 assumes lock and expiry fall in the same month.
 */
export async function expire(): Promise<ExpireResult> {
  return withTransaction(async (client) => {
    // Capture which tasks to expire (and their dev + cost) BEFORE clearing the
    // assignment — an UPDATE ... RETURNING would hand back the post-update
    // (NULL) assigned_dev_id, so we can't free the reservation from it. Lock the
    // rows FOR UPDATE so a concurrent checkout/submit can't race us.
    const toExpire = await client.query<{
      id: string;
      assigned_dev_id: string;
      nonprofit_id: string;
      max_cost_cents: number;
    }>(
      `SELECT id, assigned_dev_id, nonprofit_id, max_cost_cents
         FROM tasks
        WHERE status = 'locked' AND lock_expires_at < now()
        FOR UPDATE`,
    );

    if (toExpire.rowCount === 0) {
      return { expired_count: 0, task_ids: [] };
    }

    const ids = toExpire.rows.map((r) => r.id);
    const expired = await client.query<{ id: string }>(
      `UPDATE tasks
          SET status = 'open', assigned_dev_id = NULL, lock_expires_at = NULL
        WHERE id = ANY($1::uuid[])
        RETURNING id`,
      [ids],
    );

    // Free each reservation from the current period's budget row and write one
    // expire ledger row (-max_cost_cents) per task.
    // STAGE 2: handle cross-month locks (see note above) — free from the period
    // the reservation was made in, not necessarily the current one.
    for (const r of toExpire.rows) {
      await client.query(
        `UPDATE dev_budgets
            SET reserved_cents = reserved_cents - $2
          WHERE dev_id = $1 AND period = ${CURRENT_PERIOD}`,
        [r.assigned_dev_id, r.max_cost_cents],
      );
      await client.query(
        `INSERT INTO ledger (task_id, dev_id, nonprofit_id, event_type, delta_cents)
         VALUES ($1, $2, $3, 'expire', $4)`,
        [r.id, r.assigned_dev_id, r.nonprofit_id, -r.max_cost_cents],
      );
    }

    return {
      expired_count: expired.rowCount ?? 0,
      task_ids: ids,
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

export interface OpenTaskFilter {
  maxCostCents?: number;
  sensitivity?: string;
  limit?: number;
}

export async function listOpenTasks(filter: OpenTaskFilter = {}): Promise<TaskRow[]> {
  const conditions: string[] = [`status = 'open'`];
  const params: unknown[] = [];

  if (filter.maxCostCents !== undefined) {
    params.push(filter.maxCostCents);
    conditions.push(`max_cost_cents <= $${params.length}`);
  }
  if (filter.sensitivity !== undefined) {
    params.push(filter.sensitivity);
    conditions.push(`sensitivity = $${params.length}`);
  }

  params.push(filter.limit ?? 10);
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
