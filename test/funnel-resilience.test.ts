import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db.js';
import {
  checkoutTask,
  getBudget,
  mintOnboardingTask,
  setOwnBudget,
  submitResult,
} from '../src/operations.js';
import {
  createDev,
  createOnboardingTarget,
  createTarget,
  createTask,
  getTaskRow,
  resetDb,
} from './helpers.js';

// The load-bearing property of the funnel: an event that cannot be recorded must
// never break the action it describes. A missing analytics row is a reporting
// gap; a failed checkout is a lost donation.
//
// This is proved by breaking the real thing rather than by mocking the swallow
// we are trying to test: the funnel_events table is renamed out from under the
// running code, so every single event write fails with a genuine Postgres error
// on the real code path. If any money operation is coupled to analytics, it
// fails here. (Test files run serially — see vitest.config.ts — so no other
// test sees the table missing, and it is always renamed back.)

describe('a funnel write that fails never breaks the action', () => {
  beforeAll(async () => {
    await resetDb();
    await createOnboardingTarget(4);
    await pool.query(`ALTER TABLE funnel_events RENAME TO funnel_events_hidden`);
  });

  afterAll(async () => {
    await pool.query(`ALTER TABLE funnel_events_hidden RENAME TO funnel_events`);
  });

  it('confirms the funnel really is broken for this file', async () => {
    await expect(pool.query(`SELECT 1 FROM funnel_events`)).rejects.toThrow();
  });

  it('still sets a budget', async () => {
    const dev = await createDev('budget-anyway');
    const b = await setOwnBudget(dev, 500);
    expect(b.budget_cents).toBe(500);
  });

  it('still mints an onboarding task', async () => {
    const dev = await createDev('mint-anyway');
    await setOwnBudget(dev, 500);
    const t = await mintOnboardingTask(dev);
    expect(t.task_id).toBeTruthy();
    expect(t.candidates).toBeGreaterThan(0);
  });

  it('still checks out, submits, books the spend, and writes the ledger', async () => {
    const dev = await createDev('submit-anyway');
    await setOwnBudget(dev, 500);
    const target = await createTarget();
    const task = await createTask(target, { max: 100 });

    await checkoutTask(dev, task);
    expect((await getBudget(dev))?.reserved_cents).toBe(100);
    expect((await getTaskRow(task)).status).toBe('locked');

    const r = await submitResult(dev, task, { ok: true }, 42, null);
    expect(r.spent_applied).toBe(42);
    const budget = await getBudget(dev);
    expect(budget?.spent_cents).toBe(42);
    expect(budget?.reserved_cents).toBe(0);

    // The ledger — the record that actually matters — is complete.
    const { rows } = await pool.query(
      `SELECT event_type FROM ledger WHERE dev_id = $1 ORDER BY id`,
      [dev],
    );
    expect(rows.map((x) => x.event_type)).toEqual(['checkout', 'submit']);
  });
});
