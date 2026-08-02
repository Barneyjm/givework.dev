import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, pool } from '../src/db.js';
import {
  checkoutTask,
  listAvailableTasks,
  listOpenTasks,
  OpError,
  submitResult,
} from '../src/operations.js';
import { createDev, createTask, resetDb, setBudget, setVerified } from './helpers.js';

// Two bugs found by running real work through the 0.5.0 runner against
// firstproof-c4:
//
//   1. A task whose decomposition proposal was still unreviewed stayed
//      claimable, so it could be re-proposed without limit. That target
//      collected EIGHT proposals of the same split — the agent's own summaries
//      counting them off as "third pass", "fourth pass", "fifth pass" — each
//      burning a volunteer's credit and minting another review task for a
//      second volunteer to clear.
//   2. An agent that omitted `summary` wrote an empty string to the public
//      feed. Eight of that target's contributions render as blank rows,
//      including a real analytical result.

afterAll(closePool);
beforeEach(resetDb);

/** A public, slugged conjecture — listAvailableTasks only surfaces those. */
async function conjecture(slug: string): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO targets (name, slug, kind, status) VALUES ($1, $1, 'conjecture', 'open')
     RETURNING id`,
    [slug],
  );
  return rows[0].id;
}

async function summaryOf(taskId: string): Promise<string> {
  const { rows } = await pool.query(
    `SELECT summary FROM contributions WHERE task_id = $1 ORDER BY id DESC LIMIT 1`,
    [taskId],
  );
  return rows[0].summary;
}

const PROPOSAL = {
  decomposition: {
    subtasks: [
      { title: 'Half one', prompt: 'do the first half', max_cost_cents: 100 },
      { title: 'Half two', prompt: 'do the second half', max_cost_cents: 100 },
    ],
  },
};

async function proposer(handle = 'proposer') {
  const dev = await createDev(handle);
  await setBudget(dev, 100_000);
  await setVerified(dev);
  return dev;
}

describe('a task awaiting decomposition review is not claimable', () => {
  it('refuses a second proposal on the same task, naming the reason', async () => {
    const target = await conjecture('loop');
    const dev = await proposer();
    const task = await createTask(target, { max: 200 });

    await checkoutTask(dev, task);
    const first = await submitResult(dev, task, PROPOSAL, 20, null, {
      outcome: 'decomposition',
      summary: 'splitting it',
    });
    expect(first.review_task_id).toBeDefined();
    // The parent returns to the pool by design — the proposal is inert until
    // reviewed and the work still needs doing…
    expect(first.status).toBe('open');

    // …but it must not be claimable, or the next runner just proposes again.
    await expect(checkoutTask(dev, task)).rejects.toThrow(OpError);
    await expect(checkoutTask(dev, task)).rejects.toThrow(/awaiting peer review/);
  });

  it('hides it from both pool listings, so no runner even tries', async () => {
    const target = await conjecture('hidden');
    const dev = await proposer();
    const task = await createTask(target, { max: 200 });

    expect((await listOpenTasks()).map((t) => t.id)).toContain(task);
    expect((await listAvailableTasks()).map((t) => t.id)).toContain(task);

    await checkoutTask(dev, task);
    await submitResult(dev, task, PROPOSAL, 20, null, { outcome: 'decomposition', summary: 's' });

    expect((await listOpenTasks()).map((t) => t.id)).not.toContain(task);
    expect((await listAvailableTasks()).map((t) => t.id)).not.toContain(task);
  });

  it('becomes claimable again once the review rejects the split', async () => {
    const target = await conjecture('reopen');
    const dev = await proposer();
    const reviewer = await proposer('reviewer');
    const task = await createTask(target, { max: 200 });

    await checkoutTask(dev, task);
    const res = await submitResult(dev, task, PROPOSAL, 20, null, {
      outcome: 'decomposition',
      summary: 's',
    });
    await expect(checkoutTask(dev, task)).rejects.toThrow(/awaiting peer review/);

    // The reviewer rules against the split; the next agent gets their reasons
    // and should be able to propose a better one.
    await checkoutTask(reviewer, res.review_task_id!);
    await submitResult(
      reviewer,
      res.review_task_id!,
      { approve: false, reasons: 'caps padded' },
      5,
      null,
    );

    await expect(checkoutTask(dev, task)).resolves.toBeDefined();
  });

  it('does not block an unrelated task on the same target', async () => {
    const target = await conjecture('sibling');
    const dev = await proposer();
    const proposed = await createTask(target, { max: 200 });
    const other = await createTask(target, { max: 200 });

    await checkoutTask(dev, proposed);
    await submitResult(dev, proposed, PROPOSAL, 20, null, {
      outcome: 'decomposition',
      summary: 's',
    });

    expect((await listOpenTasks()).map((t) => t.id)).toContain(other);
    await expect(checkoutTask(dev, other)).resolves.toBeDefined();
  });
});

describe('a contribution never lands on the feed with a blank summary', () => {
  it('synthesizes from the task title and headline scalars when the agent omits one', async () => {
    const target = await conjecture('blank');
    const dev = await createDev('quiet');
    await setBudget(dev, 100_000);
    const task = await createTask(target, { max: 200, title: 'Analytical δn table' });

    await checkoutTask(dev, task);
    // No `summary` — exactly what the real δn run did.
    await submitResult(dev, task, { delta_n: -25, vacuous: true }, 13, null, {
      outcome: 'candidate_solution',
    });

    const line = await summaryOf(task);
    expect(line).not.toBe('');
    expect(line).toContain('Analytical δn table');
    expect(line).toContain('delta_n: -25');
  });

  it('still says something when the result carries no headline scalars at all', async () => {
    const target = await conjecture('bare');
    const dev = await createDev('bare-dev');
    await setBudget(dev, 100_000);
    const task = await createTask(target, { max: 200, title: 'A task with a name' });
    await checkoutTask(dev, task);
    await submitResult(dev, task, { rows: [[1, 2]] }, 5, null, { outcome: 'progress' });
    expect(await summaryOf(task)).toBe('A task with a name');
  });

  it('leaves a supplied summary exactly as given', async () => {
    const target = await conjecture('given');
    const dev = await createDev('talker');
    await setBudget(dev, 100_000);
    const task = await createTask(target, { max: 200, title: 'Some task' });
    await checkoutTask(dev, task);
    await submitResult(dev, task, { x: 1 }, 5, null, {
      outcome: 'progress',
      summary: 'my own words',
    });
    expect(await summaryOf(task)).toBe('my own words');
  });
});
