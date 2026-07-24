import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, pool } from '../src/db.js';
import { checkoutTask, heartbeatTask } from '../src/operations.js';
import { createDev, createTarget, createTask, resetDb, setBudget } from './helpers.js';

afterAll(closePool);
beforeEach(resetDb);

async function lockExpiry(taskId: string): Promise<number> {
  const { rows } = await pool.query(`SELECT lock_expires_at FROM tasks WHERE id = $1`, [taskId]);
  return new Date(rows[0].lock_expires_at).getTime();
}

describe('heartbeatTask', () => {
  it('renews the lease on a task the dev holds', async () => {
    const target = await createTarget('HB Org');
    const task = await createTask(target, { max: 100 });
    const dev = await createDev('hb-dev');
    await setBudget(dev, 1000);
    await checkoutTask(dev, task);

    const before = await lockExpiry(task);
    // Backdate the lease so the renewal is observable without sleeping.
    await pool.query(
      `UPDATE tasks SET lock_expires_at = now() + interval '1 minute' WHERE id = $1`,
      [task],
    );
    const hb = await heartbeatTask(dev, task);
    const after = await lockExpiry(task);
    expect(after).toBeGreaterThan(before - 60_000); // back to a full lease
    expect(new Date(hb.lock_expires_at).getTime()).toBe(after);
  });

  it('409s for a dev that does not hold the lock', async () => {
    const target = await createTarget('HB Org 2');
    const task = await createTask(target, { max: 100 });
    const holder = await createDev('hb-holder');
    const intruder = await createDev('hb-intruder');
    await setBudget(holder, 1000);
    await setBudget(intruder, 1000);
    await checkoutTask(holder, task);

    await expect(heartbeatTask(intruder, task)).rejects.toMatchObject({
      code: 'not_locked_by_you',
    });
  });

  it('409s for a task that is not locked at all', async () => {
    const target = await createTarget('HB Org 3');
    const task = await createTask(target, { max: 100 });
    const dev = await createDev('hb-open');
    await expect(heartbeatTask(dev, task)).rejects.toMatchObject({ code: 'not_locked_by_you' });
  });
});
