// Ensure a signing secret exists before anything in src/auth touches it.
process.env.JWT_SECRET ??= 'test-secret-do-not-use-in-prod';

import { pool } from '../src/db.js';
import { signDevToken, signAdminToken } from '../src/auth.js';

export const mintDevToken = (devId: string) => signDevToken(devId);
export const mintAdminToken = () => signAdminToken();

// resetDb TRUNCATEs every table. The suite must NEVER run against a real
// database — point it at a local/CI Postgres. Refuse anything that isn't
// obviously a test DB unless explicitly overridden (TEST_DB_ALLOW_REMOTE=1).
const url = process.env.DATABASE_URL ?? '';
const looksLocal = /@(localhost|127\.0\.0\.1|postgres)[:/]/.test(url);
if (url && !looksLocal && process.env.TEST_DB_ALLOW_REMOTE !== '1') {
  throw new Error(
    `Refusing to run destructive tests against a non-local database (${url.replace(/:[^:@]*@/, ':***@')}). ` +
      `Tests TRUNCATE every table. Use a local/CI Postgres, or set TEST_DB_ALLOW_REMOTE=1 to override.`,
  );
}

/** Wipe all data between tests. Order respects FK references. */
export async function resetDb(): Promise<void> {
  await pool.query(
    `TRUNCATE ledger, tasks, intake_attachments, intake_requests,
              dev_budgets, nonprofit_budgets, nonprofit_identifiers, nonprofits, devs
              RESTART IDENTITY CASCADE`,
  );
}

export async function createDev(handle: string): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO devs (github_handle) VALUES ($1) RETURNING id`,
    [handle],
  );
  return rows[0].id;
}

/** Mark a dev as verified (trusted with non-public work). */
export async function setVerified(devId: string, verified = true): Promise<void> {
  await pool.query(`UPDATE devs SET verified = $2 WHERE id = $1`, [devId, verified]);
}

export async function createNonprofit(name = 'Test NP'): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO nonprofits (name, contact_email) VALUES ($1, $2) RETURNING id`,
    [name, 'np@test.com'],
  );
  return rows[0].id;
}

/** A verified (allowlisted) nonprofit with a specific contact address. */
export async function createVerifiedNonprofit(
  contactEmail: string,
  name = 'Verified NP',
): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO nonprofits (name, contact_email, verified) VALUES ($1, $2, true) RETURNING id`,
    [name, contactEmail],
  );
  return rows[0].id;
}

/** Set the dev's current-period budget (in cents). */
export async function setBudget(devId: string, budgetCents: number): Promise<void> {
  await pool.query(
    `INSERT INTO dev_budgets (dev_id, period, budget_cents)
     VALUES ($1, date_trunc('month', now())::date, $2)
     ON CONFLICT (dev_id, period) DO UPDATE SET budget_cents = EXCLUDED.budget_cents`,
    [devId, budgetCents],
  );
}

export async function createTask(
  nonprofitId: string,
  opts: { est?: number; max: number; sensitivity?: string; title?: string } = { max: 500 },
): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO tasks (nonprofit_id, title, spec, est_cost_cents, max_cost_cents, model, sensitivity)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::data_sensitivity,'public'))
     RETURNING id`,
    [
      nonprofitId,
      opts.title ?? 'Test task',
      JSON.stringify({ prompt: 'do the thing' }),
      opts.est ?? Math.min(opts.max, 100),
      opts.max,
      'claude-opus-4-8',
      opts.sensitivity ?? null,
    ],
  );
  return rows[0].id;
}

/** Set a dev_budgets row for an arbitrary period (e.g. last month) — for cross-month tests. */
export async function setBudgetForPeriod(
  devId: string,
  period: string,
  budgetCents: number,
  reservedCents = 0,
): Promise<void> {
  await pool.query(
    `INSERT INTO dev_budgets (dev_id, period, budget_cents, reserved_cents)
     VALUES ($1, $2::date, $3, $4)
     ON CONFLICT (dev_id, period)
     DO UPDATE SET budget_cents = EXCLUDED.budget_cents, reserved_cents = EXCLUDED.reserved_cents`,
    [devId, period, budgetCents, reservedCents],
  );
}

/** Force a task into a locked state assigned to a dev, reserved against a given period. */
export async function forceLocked(
  taskId: string,
  devId: string,
  period: string,
  lockExpiresSql = `now() + interval '10 minutes'`,
): Promise<void> {
  await pool.query(
    `UPDATE tasks
        SET status='locked', assigned_dev_id=$2, reserved_period=$3::date,
            lock_expires_at=${lockExpiresSql}
      WHERE id=$1`,
    [taskId, devId, period],
  );
}

export async function getBudgetRowFor(devId: string, period: string) {
  const { rows } = await pool.query(
    `SELECT budget_cents, reserved_cents, spent_cents FROM dev_budgets
     WHERE dev_id=$1 AND period=$2::date`,
    [devId, period],
  );
  return rows[0];
}

export async function getBudgetRow(devId: string) {
  const { rows } = await pool.query(
    `SELECT budget_cents, reserved_cents, spent_cents FROM dev_budgets
     WHERE dev_id=$1 AND period=date_trunc('month', now())::date`,
    [devId],
  );
  return rows[0];
}

export async function getTaskRow(taskId: string) {
  const { rows } = await pool.query(`SELECT * FROM tasks WHERE id=$1`, [taskId]);
  return rows[0];
}

export async function getLedger(devId: string) {
  const { rows } = await pool.query(
    `SELECT event_type, delta_cents, raw_usage FROM ledger WHERE dev_id=$1 ORDER BY id ASC`,
    [devId],
  );
  return rows;
}

/** Force a locked task's lock into the past so /expire will collect it. */
export async function expireLockNow(taskId: string): Promise<void> {
  await pool.query(
    `UPDATE tasks SET lock_expires_at = now() - interval '1 second' WHERE id=$1`,
    [taskId],
  );
}
