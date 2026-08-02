import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db.js';
import { checkoutTask, getTaskContributions, submitResult } from '../src/operations.js';
import {
  createDev,
  createTarget,
  createTask,
  getBudgetRow,
  getLedger,
  resetDb,
  setBudget,
} from './helpers.js';

// Phase 3: resumable, accumulating tasks. A progress/dead-end contribution books
// spend and returns the task to the pool with an updated compacted state; only a
// candidate_solution finishes it (the original one-shot behaviour).

async function contributionRows(taskId: string) {
  const { rows } = await pool.query(
    `SELECT * FROM contributions WHERE task_id = $1 ORDER BY id ASC`,
    [taskId],
  );
  return rows;
}
async function taskStatus(taskId: string): Promise<string> {
  const { rows } = await pool.query(`SELECT status FROM tasks WHERE id = $1`, [taskId]);
  return rows[0].status;
}
async function targetState(targetId: string): Promise<unknown> {
  const { rows } = await pool.query(`SELECT state FROM targets WHERE id = $1`, [targetId]);
  return rows[0].state;
}

describe('contributions / resumable tasks', () => {
  beforeEach(resetDb);

  it('a progress contribution books spend, returns the task to the pool, and logs the chunk', async () => {
    const dev = await createDev('dev1');
    const target = await createTarget();
    const task = await createTask(target, { est: 100, max: 500 });
    await setBudget(dev, 2000);

    const co = await checkoutTask(dev, task);
    expect(co.target_state).toEqual({}); // fresh target has no working set yet
    expect(co.prior_contributions).toEqual([]);
    expect((await getBudgetRow(dev)).reserved_cents).toBe(500);

    const res = await submitResult(
      dev,
      task,
      { partial: 1 },
      300,
      { tokens: 10 },
      {
        outcome: 'progress',
        summary: 'proved base case; case n=2 still open',
        stateUpdate: { frontier: 'base case done', next: 'case n=2' },
      },
    );

    expect(res.status).toBe('open');
    expect(res.outcome).toBe('progress');
    expect(res.contribution_id).toBeGreaterThan(0);
    expect(res.reserved_released).toBe(500);
    expect(res.spent_applied).toBe(300);

    // Task is back in the pool; reservation freed, spend booked.
    expect(await taskStatus(task)).toBe('open');
    const b = await getBudgetRow(dev);
    expect(b.reserved_cents).toBe(0);
    expect(b.spent_cents).toBe(300);

    // The chunk is durably logged, and the target's state was refreshed.
    const rows = await contributionRows(task);
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('progress');
    expect(rows[0].summary).toBe('proved base case; case n=2 still open');
    expect(Number(rows[0].cost_cents)).toBe(300);
    expect(await targetState(target)).toEqual({ frontier: 'base case done', next: 'case n=2' });

    // Ledger records the reservation and the booked spend (delta = spend - reserved).
    const led = await getLedger(dev);
    expect(led.map((l) => l.event_type)).toEqual(['checkout', 'submit']);
    expect(Number(led[0].delta_cents)).toBe(500);
    expect(Number(led[1].delta_cents)).toBe(300 - 500);
  });

  it('accumulates across checkouts and hydrates the next agent with state + prior chunks', async () => {
    const dev = await createDev('dev1');
    const target = await createTarget();
    const task = await createTask(target, { est: 100, max: 500 });
    await setBudget(dev, 5000);

    await checkoutTask(dev, task);
    await submitResult(dev, task, { step: 1 }, 200, null, {
      outcome: 'progress',
      summary: 'did A',
      stateUpdate: { frontier: 'A' },
    });

    // Second agent picks up the same task: it sees the compacted state and the
    // prior chunk rather than starting from scratch.
    const co2 = await checkoutTask(dev, task);
    expect(co2.target_state).toEqual({ frontier: 'A' });
    expect(co2.prior_contributions).toHaveLength(1);
    expect(co2.prior_contributions[0].summary).toBe('did A');
    expect(co2.prior_contributions[0].outcome).toBe('progress');

    await submitResult(dev, task, { step: 2 }, 250, null, {
      outcome: 'progress',
      summary: 'did B',
      stateUpdate: { frontier: 'B' },
    });

    expect(await contributionRows(task)).toHaveLength(2);
    expect(await targetState(target)).toEqual({ frontier: 'B' });
    const b = await getBudgetRow(dev);
    expect(b.reserved_cents).toBe(0);
    expect(b.spent_cents).toBe(450);

    // getTaskContributions returns newest-first.
    const log = await getTaskContributions(task);
    expect(log.map((c) => c.summary)).toEqual(['did B', 'did A']);
  });

  it('records a dead end and returns the task to the pool', async () => {
    const dev = await createDev('dev1');
    const target = await createTarget();
    const task = await createTask(target, { est: 100, max: 500 });
    await setBudget(dev, 2000);

    await checkoutTask(dev, task);
    const res = await submitResult(dev, task, null, 150, null, {
      outcome: 'dead_end',
      summary: 'generating-function approach collapses at step 3',
    });

    expect(res.status).toBe('open');
    expect(res.outcome).toBe('dead_end');
    expect(await taskStatus(task)).toBe('open');
    const rows = await contributionRows(task);
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('dead_end');
  });

  it('defaults to a terminal candidate_solution submit (unchanged one-shot behaviour)', async () => {
    const dev = await createDev('dev1');
    const target = await createTarget();
    const task = await createTask(target, { est: 100, max: 500 });
    await setBudget(dev, 2000);

    await checkoutTask(dev, task);
    const res = await submitResult(dev, task, { answer: 42 }, 400, null);

    expect(res.status).toBe('submitted');
    expect(res.outcome).toBe('candidate_solution');
    expect(await taskStatus(task)).toBe('submitted');

    // Still logged as a contribution, and the final result lives on the task.
    const rows = await contributionRows(task);
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('candidate_solution');
    const { rows: t } = await pool.query(`SELECT result FROM tasks WHERE id = $1`, [task]);
    expect(t[0].result).toEqual({ answer: 42 });
  });

  it('rejects an unknown outcome', async () => {
    const dev = await createDev('dev1');
    const target = await createTarget();
    const task = await createTask(target, { est: 100, max: 500 });
    await setBudget(dev, 2000);
    await checkoutTask(dev, task);
    await expect(
      // @ts-expect-error deliberately invalid outcome
      submitResult(dev, task, null, 100, null, { outcome: 'solved' }),
    ).rejects.toMatchObject({ code: 'bad_input' });
  });

  it('books the real cost of an overrunning contribution, and credits it in full', async () => {
    const dev = await createDev('dev1');
    const target = await createTarget();
    const task = await createTask(target, { est: 100, max: 500 });
    await setBudget(dev, 2000);

    await checkoutTask(dev, task);
    const res = await submitResult(dev, task, null, 900, null, {
      outcome: 'progress',
      summary: 'overran the cap',
    });

    expect(res.overage_clamped).toBe(true); // flagged, so a bad estimate surfaces
    expect(res.spent_applied).toBe(900); // …and booked as spent
    const b = await getBudgetRow(dev);
    expect(b.reserved_cents).toBe(0);
    expect(b.spent_cents).toBe(900);
    // the contribution — which drives the public "compute donated" totals — must
    // credit the volunteer for what they actually gave, not the reservation
    const rows = await contributionRows(task);
    expect(Number(rows[0].cost_cents)).toBe(900);
  });

  it('preserves result on a non-terminal submit (as the inline artifact)', async () => {
    const dev = await createDev('dev-keep');
    const target = await createTarget();
    const task = await createTask(target, { max: 500 });
    await setBudget(dev, 2000);
    await checkoutTask(dev, task);

    // progress submit with computed data in `result` and no explicit artifact —
    // the data must not be dropped when the task returns to the pool.
    await submitResult(dev, task, { verified_range: '1e9..2e9', hits: [] }, 100, null, {
      outcome: 'progress',
      summary: 'swept a block',
    });
    const rows = await contributionRows(task);
    expect(rows[0].artifact).toEqual({ verified_range: '1e9..2e9', hits: [] });
  });

  it('truncates an oversized summary and an oversized state_update — the submit always books', async () => {
    const dev = await createDev('dev-limits');
    const target = await createTarget();
    const task = await createTask(target, { max: 500 });
    await setBudget(dev, 2000);
    await checkoutTask(dev, task);

    // An oversized state_update arrives AFTER the tokens are burned, so
    // rejecting the submit would lose both the work and the booking. The
    // oversized KEY is dropped by name and the submit succeeds.
    const sub = await submitResult(dev, task, null, 50, null, {
      outcome: 'progress',
      summary: 'y'.repeat(5000),
      stateUpdate: { blob: 'x'.repeat(70_000), newest: 'the frontier moved to 1e9' },
    });
    expect(sub.state_truncated).toBe(true);
    expect(sub.spent_applied).toBe(50); // booked, not rolled back

    // Whole keys go, largest first, and what remains is still a real working
    // set: the small readable key survives as a VALUE the next agent can read,
    // rather than being buried inside a raw byte slice of JSON.
    const { rows: t } = await pool.query(`SELECT state FROM targets WHERE id = $1`, [target]);
    expect(t[0].state.newest).toBe('the frontier moved to 1e9');
    expect(t[0].state._dropped).toEqual(['blob']); // named, never silent
    expect(t[0].state.blob).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(t[0].state))).toBeLessThanOrEqual(64 * 1024);

    // A very long summary truncates rather than storing whole (as before).
    const rows = await contributionRows(task);
    expect((rows[0].summary as string).length).toBe(2000);

    // A right-sized state_update still lands verbatim, untouched.
    const task2 = await createTask(target, { max: 500 });
    await checkoutTask(dev, task2);
    const sub2 = await submitResult(dev, task2, null, 10, null, {
      outcome: 'progress',
      stateUpdate: { frontier: 'small and tidy' },
    });
    expect(sub2.state_truncated).toBeUndefined();
    const { rows: t2 } = await pool.query(`SELECT state FROM targets WHERE id = $1`, [target]);
    // Merged, so the surviving key from the earlier write is still there — and
    // `_dropped` is gone, because it describes the value stored now and this
    // write dropped nothing.
    expect(t2[0].state).toEqual({
      newest: 'the frontier moved to 1e9',
      frontier: 'small and tidy',
    });
  });
});
