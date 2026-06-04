import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import {
  checkoutTask,
  submitResult,
  releaseTask,
  expire,
  getBudget,
  OpError,
} from '../src/operations.js';
import { closePool } from '../src/db.js';
import {
  resetDb,
  createDev,
  createNonprofit,
  setBudget,
  createTask,
  getBudgetRow,
  getTaskRow,
  getLedger,
  expireLockNow,
} from './helpers.js';

let dev: string;
let np: string;

beforeEach(async () => {
  await resetDb();
  dev = await createDev('alice');
  np = await createNonprofit();
});

afterAll(closePool);

describe('happy path (criterion 1)', () => {
  it('checkout reserves, submit moves to spend, ledger is correct', async () => {
    await setBudget(dev, 2000); // $20
    const task = await createTask(np, { max: 500 }); // $5 max

    const co = await checkoutTask(dev, task);
    expect(co.max_cost_cents).toBe(500);
    expect(co.lock_expires_at).toBeTruthy();

    let b = await getBudget(dev);
    expect(b).toEqual({
      budget_cents: 2000,
      reserved_cents: 500,
      spent_cents: 0,
      available_cents: 1500,
    });

    const sub = await submitResult(dev, task, { ok: true }, 380, { tokens: 1000 });
    expect(sub.overage_clamped).toBe(false);

    b = await getBudget(dev);
    expect(b).toEqual({
      budget_cents: 2000,
      reserved_cents: 0,
      spent_cents: 380,
      available_cents: 1620,
    });

    const t = await getTaskRow(task);
    expect(t.status).toBe('submitted');
    expect(t.actual_cost_cents).toBe(380);

    const ledger = await getLedger(dev);
    expect(ledger.map((l) => [l.event_type, l.delta_cents])).toEqual([
      ['checkout', 500],
      ['submit', -120], // 380 spent - 500 reserved
    ]);
  });

  it('rejects a non-positive-integer actual_cost_cents and leaves the reservation intact', async () => {
    await setBudget(dev, 2000);
    const task = await createTask(np, { max: 500 });
    await checkoutTask(dev, task);

    // A negative cost would refund the dev's own spend; NaN/floats skew the math.
    for (const bad of [-100, 1.5, NaN]) {
      await expect(submitResult(dev, task, { ok: true }, bad, null)).rejects.toMatchObject({
        status: 400,
        code: 'bad_input',
      });
    }

    // Still locked/reserved, nothing spent, no submit ledger row written.
    const b = await getBudget(dev);
    expect(b).toMatchObject({ reserved_cents: 500, spent_cents: 0 });
    expect((await getTaskRow(task)).status).toBe('locked');
    expect((await getLedger(dev)).map((l) => l.event_type)).toEqual(['checkout']);
  });
});

describe('budget gate (criterion 2)', () => {
  it('insufficient budget -> 402, no mutation, no ledger', async () => {
    await setBudget(dev, 400); // $4
    const task = await createTask(np, { max: 500 }); // $5 max

    await expect(checkoutTask(dev, task)).rejects.toMatchObject({ status: 402 });

    const b = await getBudgetRow(dev);
    expect(b.reserved_cents).toBe(0);
    const t = await getTaskRow(task);
    expect(t.status).toBe('open');
    expect(await getLedger(dev)).toHaveLength(0);
  });
});

describe('no budget row (criterion 3)', () => {
  it('checkout for dev with no current-period budget -> 402', async () => {
    const task = await createTask(np, { max: 500 });
    await expect(checkoutTask(dev, task)).rejects.toMatchObject({
      status: 402,
      code: 'no_budget',
    });
    expect((await getTaskRow(task)).status).toBe('open');
  });
});

describe('expiry (criterion 6)', () => {
  it('expired lock returns task to pool and frees reservation', async () => {
    await setBudget(dev, 2000);
    const task = await createTask(np, { max: 500 });
    await checkoutTask(dev, task);
    await expireLockNow(task);

    const res = await expire();
    expect(res.expired_count).toBe(1);
    expect(res.task_ids).toContain(task);

    const t = await getTaskRow(task);
    expect(t.status).toBe('open');
    expect(t.assigned_dev_id).toBeNull();
    expect(t.lock_expires_at).toBeNull();

    expect((await getBudgetRow(dev)).reserved_cents).toBe(0);

    const ledger = await getLedger(dev);
    expect(ledger.at(-1)).toMatchObject({ event_type: 'expire', delta_cents: -500 });
  });

  it('does not expire a still-valid lock', async () => {
    await setBudget(dev, 2000);
    const task = await createTask(np, { max: 500 });
    await checkoutTask(dev, task);
    const res = await expire();
    expect(res.expired_count).toBe(0);
    expect((await getTaskRow(task)).status).toBe('locked');
  });
});

describe('release (criterion 7)', () => {
  it('release returns task to pool and frees reservation', async () => {
    await setBudget(dev, 2000);
    const task = await createTask(np, { max: 500 });
    await checkoutTask(dev, task);

    const r = await releaseTask(dev, task);
    expect(r.reserved_released).toBe(500);

    const t = await getTaskRow(task);
    expect(t.status).toBe('open');
    expect((await getBudgetRow(dev)).reserved_cents).toBe(0);
    expect((await getLedger(dev)).at(-1)).toMatchObject({
      event_type: 'release',
      delta_cents: -500,
    });
  });
});

describe('submit on unlocked task (criterion 8)', () => {
  it('submitting a task not locked to you -> 409, no mutation', async () => {
    await setBudget(dev, 2000);
    const other = await createDev('bob');
    await setBudget(other, 2000);
    const task = await createTask(np, { max: 500 });
    await checkoutTask(dev, task); // locked to alice

    await expect(submitResult(other, task, {}, 100, {})).rejects.toMatchObject({
      status: 409,
    });

    // alice's reservation untouched, task still locked
    expect((await getBudgetRow(dev)).reserved_cents).toBe(500);
    expect((await getTaskRow(task)).status).toBe('locked');
  });

  it('submitting an open (never-locked) task -> 409', async () => {
    await setBudget(dev, 2000);
    const task = await createTask(np, { max: 500 });
    await expect(submitResult(dev, task, {}, 100, {})).rejects.toBeInstanceOf(OpError);
  });
});

describe('actual exceeds reservation (criterion 9)', () => {
  it('spend is clamped to max_cost, CHECK never violated, overage flagged', async () => {
    await setBudget(dev, 600);
    const task = await createTask(np, { max: 500 });
    await checkoutTask(dev, task);

    // Runner reports 700 but only 500 was reserved.
    const sub = await submitResult(dev, task, {}, 700, { tokens: 99999 });
    expect(sub.overage_clamped).toBe(true);
    expect(sub.spent_applied).toBe(500);

    const b = await getBudgetRow(dev);
    expect(b.reserved_cents).toBe(0);
    expect(b.spent_cents).toBe(500); // clamped, not 700
    expect(b.reserved_cents + b.spent_cents).toBeLessThanOrEqual(b.budget_cents);

    const submitRow = (await getLedger(dev)).find((l) => l.event_type === 'submit');
    expect(submitRow.delta_cents).toBe(0); // 500 spent - 500 reserved
    expect(submitRow.raw_usage).toMatchObject({
      overage: true,
      reported_cost_cents: 700,
      clamped_to_cents: 500,
    });
  });
});

describe('unknown ids (404)', () => {
  it('checkout of unknown task -> 404', async () => {
    await setBudget(dev, 2000);
    await expect(
      checkoutTask(dev, '00000000-0000-0000-0000-000000000000'),
    ).rejects.toMatchObject({ status: 404 });
  });
});
