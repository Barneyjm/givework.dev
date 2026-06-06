import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../src/db.js';
import { checkoutTask, OpError } from '../src/operations.js';
import {
  createDev,
  createNonprofit,
  createTask,
  getBudgetRow,
  getTaskRow,
  resetDb,
  setBudget,
} from './helpers.js';

afterAll(closePool);

/**
 * Settle a checkout into one of three buckets so concurrency outcomes can be
 * asserted without caring about which racer won.
 */
async function attempt(dev: string, task: string) {
  try {
    await checkoutTask(dev, task);
    return { ok: true as const };
  } catch (err) {
    if (err instanceof OpError) return { ok: false as const, status: err.status };
    throw err;
  }
}

describe('double-checkout race (criterion 4)', () => {
  beforeEach(resetDb);

  it('two concurrent checkouts of the same task -> exactly one 200, one 409', async () => {
    const dev1 = await createDev('alice');
    const dev2 = await createDev('bob');
    await setBudget(dev1, 2000);
    await setBudget(dev2, 2000);
    const np = await createNonprofit();
    const task = await createTask(np, { max: 500 });

    // Fire both genuinely concurrently — each checkoutTask opens its own txn.
    const [a, b] = await Promise.all([attempt(dev1, task), attempt(dev2, task)]);

    const oks = [a, b].filter((r) => r.ok);
    const conflicts = [a, b].filter((r) => !r.ok && r.status === 409);
    expect(oks).toHaveLength(1);
    expect(conflicts).toHaveLength(1);

    // Task locked exactly once; only the winner holds a reservation.
    const t = await getTaskRow(task);
    expect(t.status).toBe('locked');
    const winnerReserved =
      (await getBudgetRow(dev1)).reserved_cents + (await getBudgetRow(dev2)).reserved_cents;
    expect(winnerReserved).toBe(500); // exactly one reservation total
  });
});

describe('same-dev concurrent spend (criterion 5)', () => {
  beforeEach(resetDb);

  it('one dev, $5 budget, two $5 tasks, concurrent checkouts -> one 200, one 402', async () => {
    const dev = await createDev('alice');
    await setBudget(dev, 500); // $5
    const np = await createNonprofit();
    const t1 = await createTask(np, { max: 500 });
    const t2 = await createTask(np, { max: 500 });

    // Without FOR UPDATE on dev_budgets both would read available=500 and pass.
    const [a, b] = await Promise.all([attempt(dev, t1), attempt(dev, t2)]);

    const oks = [a, b].filter((r) => r.ok);
    const overBudget = [a, b].filter((r) => !r.ok && r.status === 402);
    expect(oks).toHaveLength(1);
    expect(overBudget).toHaveLength(1);

    // Exactly one task locked, reserved exactly once.
    const statuses = [(await getTaskRow(t1)).status, (await getTaskRow(t2)).status].sort();
    expect(statuses).toEqual(['locked', 'open']);
    expect((await getBudgetRow(dev)).reserved_cents).toBe(500);
  });
});
