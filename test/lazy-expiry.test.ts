import { beforeEach, describe, expect, it } from 'vitest';
import { checkoutTask, expire, listOpenTasks } from '../src/operations.js';
import worker from '../src/worker.js';
import {
  createDev,
  createTarget,
  createTask,
  expireLockNow,
  getBudgetRow,
  getLedger,
  getTaskRow,
  resetDb,
  setBudget,
} from './helpers.js';

// F3 (compute-loss audit): expire() must run on its own. The cron trigger
// (wrangler.toml [triggers] → worker.scheduled) is the backstop; these tests
// cover the lazy, belt-and-braces layer — the pool listing and checkout treat
// a lapsed lock as reclaimable instead of waiting for the next sweep — plus
// the scheduled shim's wiring to the same expire().

describe('lazy lease expiry — a lapsed lock never strands a task or a reservation', () => {
  beforeEach(resetDb);

  async function strandedTask() {
    const stranded = await createDev('stranded-runner');
    const target = await createTarget();
    const task = await createTask(target, { max: 100 });
    await setBudget(stranded, 1000);
    await checkoutTask(stranded, task);
    await expireLockNow(task); // the runner died; its 10-minute lease has lapsed
    return { stranded, target, task };
  }

  it('listOpenTasks reclaims a lapsed lock: the task reappears and the reservation refunds', async () => {
    const { stranded, task } = await strandedTask();

    const open = await listOpenTasks({});
    expect(open.map((t) => t.id)).toContain(task);
    expect((await getTaskRow(task)).status).toBe('open');

    // The stranded dev's reservation was freed, with the expire ledger row.
    const b = await getBudgetRow(stranded);
    expect(Number(b.reserved_cents)).toBe(0);
    const events = (await getLedger(stranded)).map((l) => l.event_type);
    expect(events).toEqual(['checkout', 'expire']);
  });

  it('checkoutTask claims a lapsed-locked task directly (run --task on a stranded id)', async () => {
    const { stranded, task } = await strandedTask();

    const dev2 = await createDev('next-runner');
    await setBudget(dev2, 1000);
    // No listing first — the checkout itself detects the lapse, sweeps, retries.
    const co = await checkoutTask(dev2, task);
    expect(co.task_id).toBe(task);

    const row = await getTaskRow(task);
    expect(row.status).toBe('locked');
    expect(row.assigned_dev_id).toBe(dev2);

    // Both budgets are coherent: the stranded reservation refunded, the new one held.
    expect(Number((await getBudgetRow(stranded)).reserved_cents)).toBe(0);
    expect(Number((await getBudgetRow(dev2)).reserved_cents)).toBe(100);
  });

  it('a live (unexpired) lock is untouched: hidden from the pool and not claimable', async () => {
    const holder = await createDev('working-runner');
    const target = await createTarget();
    const task = await createTask(target, { max: 100 });
    await setBudget(holder, 1000);
    await checkoutTask(holder, task);

    expect((await listOpenTasks({})).map((t) => t.id)).not.toContain(task);

    const dev2 = await createDev('impatient');
    await setBudget(dev2, 1000);
    await expect(checkoutTask(dev2, task)).rejects.toMatchObject({ code: 'task_not_open' });
    // and the internal lapsed-retry sentinel never leaks as an error code
    await expect(checkoutTask(dev2, task)).rejects.not.toMatchObject({
      code: 'task_lock_lapsed_retry',
    });
    expect((await getTaskRow(task)).assigned_dev_id).toBe(holder);
  });

  it("the Worker's scheduled handler runs the same expire() sweep", async () => {
    const { stranded, task } = await strandedTask();

    // The cron shim is deliberately thin — invoke it as Cloudflare would.
    await (
      worker as { scheduled: (c: unknown, e: unknown, x: unknown) => Promise<void> }
    ).scheduled({}, {}, {});

    expect((await getTaskRow(task)).status).toBe('open');
    expect(Number((await getBudgetRow(stranded)).reserved_cents)).toBe(0);
  });

  it('expire() remains idempotent under the extra callers: a second sweep books nothing new', async () => {
    const { stranded } = await strandedTask();
    await expire();
    await expire();
    const events = (await getLedger(stranded)).map((l) => l.event_type);
    expect(events).toEqual(['checkout', 'expire']); // exactly one refund
  });
});
