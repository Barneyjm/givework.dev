import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, pool } from '../src/db.js';
import { checkoutTask, expire, OpError, releaseTask, submitResult } from '../src/operations.js';
import {
  createDev,
  createNonprofit,
  createTask,
  expireLockNow,
  resetDb,
  setBudget,
} from './helpers.js';

afterAll(closePool);

/** Assert the budget invariant and ledger/budget agreement for every dev. */
async function assertInvariants(devIds: string[]) {
  const { rows: budgets } = await pool.query(
    `SELECT dev_id, budget_cents, reserved_cents, spent_cents FROM dev_budgets`,
  );
  for (const b of budgets) {
    // Invariant 1: reserved + spent <= budget, and neither goes negative.
    expect(b.reserved_cents).toBeGreaterThanOrEqual(0);
    expect(b.spent_cents).toBeGreaterThanOrEqual(0);
    expect(b.reserved_cents + b.spent_cents).toBeLessThanOrEqual(b.budget_cents);
  }

  // Invariant 2: per dev, the sum of ledger deltas equals reserved + spent.
  for (const devId of devIds) {
    const { rows: lrows } = await pool.query(
      `SELECT COALESCE(SUM(delta_cents),0)::bigint AS total FROM ledger WHERE dev_id=$1`,
      [devId],
    );
    const ledgerTotal = Number(lrows[0].total);
    const b = budgets.find((r) => r.dev_id === devId);
    const live = b ? b.reserved_cents + b.spent_cents : 0;
    expect(ledgerTotal).toBe(live);
  }
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

describe('invariant fuzz (criterion 10)', () => {
  beforeEach(resetDb);

  it('100 randomized operations keep ledger and budgets in agreement', async () => {
    const devIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const d = await createDev(`dev${i}`);
      await setBudget(d, 2000 + i * 500); // $20–$30
      devIds.push(d);
    }
    const np = await createNonprofit();

    const taskIds: string[] = [];
    for (let i = 0; i < 8; i++) {
      taskIds.push(await createTask(np, { max: 100 + Math.floor(Math.random() * 700) }));
    }

    const ops = ['checkout', 'submit', 'release', 'expire', 'force-expire'];

    for (let n = 0; n < 100; n++) {
      const op = pick(ops);
      const dev = pick(devIds);
      const task = pick(taskIds);
      try {
        switch (op) {
          case 'checkout':
            await checkoutTask(dev, task);
            break;
          case 'submit':
            // Random actual cost, sometimes over the cap to exercise clamping.
            await submitResult(dev, task, { n }, Math.floor(Math.random() * 900), { n });
            break;
          case 'release':
            await releaseTask(dev, task);
            break;
          case 'expire':
            await expire();
            break;
          case 'force-expire':
            await expireLockNow(task);
            await expire();
            break;
        }
      } catch (err) {
        // Expected domain conflicts (wrong state, over budget) are fine — the
        // point is that even rejected ops leave the books consistent.
        if (!(err instanceof OpError)) throw err;
      }

      await assertInvariants(devIds);
    }
  });
});
