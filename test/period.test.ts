import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, pool } from '../src/db.js';
import { expire, releaseTask, submitResult } from '../src/operations.js';
import {
  createDev,
  createNonprofit,
  createTask,
  forceLocked,
  getBudgetRow,
  getBudgetRowFor,
  resetDb,
  setBudget,
  setBudgetForPeriod,
} from './helpers.js';

afterAll(closePool);

// "Last month" and "this month" as first-of-month dates.
const LAST_MONTH = `(date_trunc('month', now()) - interval '1 month')::date`;

async function lastMonth(): Promise<string> {
  const { rows } = await pool.query(`SELECT ${LAST_MONTH} AS p`);
  return rows[0].p;
}

let dev: string;
let np: string;
let prev: string;

beforeEach(async () => {
  await resetDb();
  dev = await createDev('alice');
  np = await createNonprofit();
  prev = await lastMonth();
  // Reservation was made last month (500 held there); also a fresh current-month budget.
  await setBudgetForPeriod(dev, prev, 2000, 500);
  await setBudget(dev, 2000); // current period, nothing reserved
});

describe('cross-month reservation accounting', () => {
  it('expire frees the reservation from the period it was MADE in, not the current one', async () => {
    const task = await createTask(np, { max: 500 });
    // Locked last month, lock already expired (straddles the boundary).
    await forceLocked(task, dev, prev, `now() - interval '1 second'`);

    const res = await expire();
    expect(res.expired_count).toBe(1);

    // Last month's reservation is freed...
    expect((await getBudgetRowFor(dev, prev)).reserved_cents).toBe(0);
    // ...and the CURRENT month is untouched (no phantom negative reservation).
    expect((await getBudgetRow(dev)).reserved_cents).toBe(0);
  });

  it('release frees from the reservation period', async () => {
    const task = await createTask(np, { max: 500 });
    await forceLocked(task, dev, prev);

    await releaseTask(dev, task);

    expect((await getBudgetRowFor(dev, prev)).reserved_cents).toBe(0);
    expect((await getBudgetRow(dev)).reserved_cents).toBe(0);
  });

  it('submit moves spend into the reservation period', async () => {
    const task = await createTask(np, { max: 500 });
    await forceLocked(task, dev, prev);

    await submitResult(dev, task, { ok: true }, 300, {});

    const last = await getBudgetRowFor(dev, prev);
    expect(last.reserved_cents).toBe(0);
    expect(last.spent_cents).toBe(300);
    // Current month never saw this task.
    const now = await getBudgetRow(dev);
    expect(now.reserved_cents).toBe(0);
    expect(now.spent_cents).toBe(0);
  });
});
