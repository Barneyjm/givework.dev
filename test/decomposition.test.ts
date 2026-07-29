import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db.js';
import {
  checkoutTask,
  MAX_DECOMPOSITION_CHUNKS,
  MAX_DECOMPOSITION_SUBTASKS,
  normalizeDecomposition,
  REVIEW_TASK_MAX_CENTS,
  rejectTask,
  submitResult,
} from '../src/operations.js';
import { submitAndVerify } from '../src/verify.js';
import {
  createDev,
  createTarget,
  createTask,
  getBudgetRow,
  getTaskRow,
  resetDb,
  setBudget,
  setVerified,
} from './helpers.js';

// Recursive decomposition: a task too big for its budget submits a structured
// split as its deliverable. The proposal is INERT — it mints exactly one small
// peer-review task, and only an approving review (any volunteer's agent, never
// an admin button) publishes the subtasks, exactly once. Money never moves at
// publish: open tasks cost nothing until checkoutTask charges the CLAIMING
// volunteer behind the unchanged budget gate.

const subtask = (i: number, max = 100) => ({
  title: `slice ${i}`,
  prompt: `sweep slice ${i} of the range`,
  kind: 'computational',
  effort: 'low',
  est_cost_cents: Math.min(5, max),
  max_cost_cents: max,
});

const proposalOf = (n: number, max = 100) => ({
  reason: 'the full sweep is ~50x this task budget',
  subtasks: Array.from({ length: n }, (_, i) => subtask(i, max)),
});

const PINNED = {
  repo: 'Barneyjm/givework-contrib',
  sha: 'a'.repeat(40),
  entrypoint: 'sweeps/goldbach.py',
};

/** A sandbox chunk subtask: pinned program + per-slice input. CPU, not tokens. */
const chunk = (i: number, code: Record<string, unknown> = PINNED) => ({
  title: `chunk ${i}`,
  prompt: `run the pinned sweep over slice ${i}`,
  max_cost_cents: 5,
  code: { ...code, input: { slice: i } },
});

const chunkProposalOf = (n: number) => ({
  reason: 'fan the pinned program over slices',
  subtasks: Array.from({ length: n }, (_, i) => chunk(i)),
});

async function tasksFrom(contributionId: number) {
  const { rows } = await pool.query(
    `SELECT * FROM tasks WHERE decomposed_from = $1 ORDER BY created_at, title`,
    [contributionId],
  );
  return rows;
}

async function reviewTaskFor(contributionId: number) {
  const { rows } = await pool.query(`SELECT * FROM tasks WHERE (spec->>'review_of')::bigint = $1`, [
    contributionId,
  ]);
  return rows;
}

/** Submit a decomposition on a fresh parent task; returns ids for the gate tests. */
async function proposeDecomposition(opts: { subtasks?: number; subMax?: number } = {}) {
  const proposer = await createDev('proposer');
  const target = await createTarget('Erdos problem');
  const parent = await createTask(target, { est: 50, max: 200, title: 'Sweep the whole range' });
  await setBudget(proposer, 1000);
  await checkoutTask(proposer, parent);
  const res = await submitResult(
    proposer,
    parent,
    { decomposition: proposalOf(opts.subtasks ?? 3, opts.subMax ?? 100) },
    40,
    { tokens: 1 },
    { outcome: 'decomposition', summary: 'too big — proposing a split' },
  );
  return { proposer, target, parent, res };
}

describe('decomposition proposals', () => {
  beforeEach(resetDb);

  it('submission mints ONE review task and stays inert (no subtasks, parent back in pool)', async () => {
    const { parent, res } = await proposeDecomposition();

    // Non-terminal: the parent returns to the pool; spend booked as usual.
    expect(res.status).toBe('open');
    expect(res.outcome).toBe('decomposition');
    expect(res.review_task_id).toBeDefined();
    expect((await getTaskRow(parent)).status).toBe('open');

    // Exactly one review task, on the same target, pointing at the contribution.
    const reviews = await reviewTaskFor(res.contribution_id);
    expect(reviews).toHaveLength(1);
    expect(reviews[0].id).toBe(res.review_task_id);
    expect(reviews[0].title).toBe('Review a proposed decomposition of: Sweep the whole range');
    expect(reviews[0].spec.review_of).toBe(res.contribution_id);
    expect(reviews[0].spec.prompt).toContain('sensible');
    expect(Number(reviews[0].max_cost_cents)).toBe(REVIEW_TASK_MAX_CENTS);
    expect(reviews[0].effort).toBe('medium');
    expect(reviews[0].status).toBe('open');

    // INERT: the proposal published nothing.
    expect(await tasksFrom(res.contribution_id)).toHaveLength(0);

    // The durable contribution carries the normalized proposal.
    const { rows } = await pool.query(`SELECT * FROM contributions WHERE id = $1`, [
      res.contribution_id,
    ]);
    expect(rows[0].outcome).toBe('decomposition');
    expect(rows[0].artifact.decomposition.subtasks).toHaveLength(3);
  });

  it('an approving review publishes the subtasks — with caps, provenance, and inherited target', async () => {
    const { target, res } = await proposeDecomposition();
    const reviewer = await createDev('reviewer');
    await setBudget(reviewer, 1000);

    await checkoutTask(reviewer, res.review_task_id!);
    const review = await submitResult(
      reviewer,
      res.review_task_id!,
      { approve: true, reasons: 'well-sliced, caps proportionate, faithful to the parent' },
      10,
      null,
    );

    expect(review.status).toBe('submitted');
    expect(review.published_task_ids).toHaveLength(3);

    const published = await tasksFrom(res.contribution_id);
    expect(published).toHaveLength(3);
    for (const t of published) {
      expect(t.target_id).toBe(target);
      expect(t.status).toBe('open');
      expect(Number(t.max_cost_cents)).toBe(100);
      expect(t.effort).toBe('low');
      expect(t.kind).toBe('computational');
      expect(t.spec.prompt).toContain('sweep slice');
      expect(t.spec.decomposed_from).toBe(res.contribution_id);
    }
  });

  it('a replayed approve publishes nothing more (exactly once)', async () => {
    const { res } = await proposeDecomposition();
    const reviewer = await createDev('reviewer');
    await setBudget(reviewer, 1000);

    await checkoutTask(reviewer, res.review_task_id!);
    const first = await submitResult(reviewer, res.review_task_id!, { approve: true }, 10, null);
    expect(first.published_task_ids).toHaveLength(3);

    // The natural replay path: the review task is rejected back to the pool
    // (admin verdict, expiry-style churn, …) and someone reviews it AGAIN.
    await rejectTask(res.review_task_id!);
    const again = await createDev('reviewer2');
    await setBudget(again, 1000);
    await checkoutTask(again, res.review_task_id!);
    const second = await submitResult(again, res.review_task_id!, { approve: true }, 10, null);

    expect(second.published_task_ids).toEqual([]); // no-op, loudly visible
    expect(await tasksFrom(res.contribution_id)).toHaveLength(3); // still exactly 3
  });

  it('a rejecting review publishes nothing; the proposal stays logged as an honest contribution', async () => {
    const { parent, res } = await proposeDecomposition();
    const reviewer = await createDev('reviewer');
    await setBudget(reviewer, 1000);

    await checkoutTask(reviewer, res.review_task_id!);
    const review = await submitResult(
      reviewer,
      res.review_task_id!,
      { approve: false, reasons: 'caps padded 10x beyond the stated work' },
      10,
      null,
    );

    expect(review.published_task_ids).toEqual([]);
    expect(await tasksFrom(res.contribution_id)).toHaveLength(0);
    // approve must be the explicit boolean true — truthy strings don't publish
    expect((await getTaskRow(parent)).status).toBe('open'); // parent simply remains open
    const { rows } = await pool.query(`SELECT outcome::text FROM contributions WHERE id = $1`, [
      res.contribution_id,
    ]);
    expect(rows[0].outcome).toBe('decomposition'); // still on the record
  });

  it('only approve === true publishes ("yes"/1/truthy are rejections)', async () => {
    const { res } = await proposeDecomposition();
    const reviewer = await createDev('reviewer');
    await setBudget(reviewer, 1000);
    await checkoutTask(reviewer, res.review_task_id!);
    const review = await submitResult(
      reviewer,
      res.review_task_id!,
      { approve: 'yes', reasons: 'sloppy output shape' },
      10,
      null,
    );
    expect(review.published_task_ids).toEqual([]);
    expect(await tasksFrom(res.contribution_id)).toHaveLength(0);
  });

  it('publish flows through submitAndVerify too — and PR-83 keeps the review itself un-trust-accepted', async () => {
    const { res } = await proposeDecomposition();
    const reviewer = await createDev('trusted-reviewer');
    await setVerified(reviewer); // even a verified dev's review is a claim on a conjecture target
    await setBudget(reviewer, 1000);

    await checkoutTask(reviewer, res.review_task_id!);
    const out = await submitAndVerify(reviewer, res.review_task_id!, { approve: true }, 10, null);

    // The gate worked (subtasks published at submit time, no admin involved)…
    expect(out.published_task_ids).toHaveLength(3);
    // …while the review task's own fate stays honest: awaiting verification,
    // not trust-accepted, because the target is open mathematics.
    expect(out.status).toBe('submitted');
  });

  it('a review task can never accept a decomposition outcome (no recursion bombs)', async () => {
    const { res } = await proposeDecomposition();
    const reviewer = await createDev('reviewer');
    await setBudget(reviewer, 1000);
    await checkoutTask(reviewer, res.review_task_id!);

    await expect(
      submitResult(reviewer, res.review_task_id!, { decomposition: proposalOf(2, 10) }, 5, null, {
        outcome: 'decomposition',
      }),
    ).rejects.toMatchObject({ code: 'review_not_decomposable' });

    // The whole submit rolled back: no contribution booked, no spend, still locked.
    expect((await getTaskRow(res.review_task_id!)).status).toBe('locked');
    const b = await getBudgetRow(reviewer);
    expect(Number(b.spent_cents)).toBe(0);
    expect(Number(b.reserved_cents)).toBe(REVIEW_TASK_MAX_CENTS);
  });

  it('rejects oversized / over-cap proposals at submit, before any money is booked', async () => {
    const dev = await createDev('dev');
    const target = await createTarget();
    const parent = await createTask(target, { est: 50, max: 200 });
    await setBudget(dev, 1000);
    await checkoutTask(dev, parent);

    // 13 subtasks > the hard ceiling of 12
    await expect(
      submitResult(
        dev,
        parent,
        { decomposition: proposalOf(MAX_DECOMPOSITION_SUBTASKS + 1) },
        40,
        null,
        { outcome: 'decomposition' },
      ),
    ).rejects.toMatchObject({ code: 'bad_decomposition' });

    // per-subtask cap over 2x the parent's 200¢
    await expect(
      submitResult(dev, parent, { decomposition: proposalOf(2, 401) }, 40, null, {
        outcome: 'decomposition',
      }),
    ).rejects.toMatchObject({ code: 'bad_decomposition' });

    // non-integer cents are never money
    await expect(
      submitResult(
        dev,
        parent,
        { decomposition: { subtasks: [{ ...subtask(0), max_cost_cents: 10.5 }] } },
        40,
        null,
        { outcome: 'decomposition' },
      ),
    ).rejects.toMatchObject({ code: 'bad_decomposition' });

    // missing proposal entirely
    await expect(
      submitResult(dev, parent, { output: 'no plan here' }, 40, null, {
        outcome: 'decomposition',
      }),
    ).rejects.toMatchObject({ code: 'bad_decomposition' });

    // Every rejection rolled back whole: nothing booked, no review task minted,
    // the task still locked to the dev (who can submit a valid outcome next).
    expect((await getTaskRow(parent)).status).toBe('locked');
    const b = await getBudgetRow(dev);
    expect(Number(b.spent_cents)).toBe(0);
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM contributions`);
    expect(rows[0].n).toBe(0);
  });

  it('normalizeDecomposition: strict on money and volume, lenient on hint fields', () => {
    const ok = normalizeDecomposition(
      {
        reason: 'r',
        subtasks: [
          { title: 't', prompt: 'p', max_cost_cents: 40, kind: 'nonsense', effort: 'ultra' },
        ],
      },
      100,
    );
    // unknown hints fall back to safe defaults rather than losing the plan
    expect(ok.subtasks[0]).toMatchObject({
      kind: 'exploration',
      effort: 'medium',
      verify_via: 'human_review',
      est_cost_cents: 40, // defaults to the cap when unstated
      max_cost_cents: 40,
    });
    // exactly 2x the parent cap is allowed; a cent more is not
    expect(() =>
      normalizeDecomposition({ subtasks: [{ ...subtask(0), max_cost_cents: 200 }] }, 100),
    ).not.toThrow();
    expect(() =>
      normalizeDecomposition({ subtasks: [{ ...subtask(0), max_cost_cents: 201 }] }, 100),
    ).toThrow(/exceeds/);
    expect(() => normalizeDecomposition({ subtasks: [] }, 100)).toThrow(/non-empty/);
  });

  it('differentiated fan-out: 12 model / 64 chunks, each class against its own cap', () => {
    // 12 model + 64 chunks in ONE proposal is legal — each class under its cap.
    const mixed = {
      subtasks: [
        ...proposalOf(MAX_DECOMPOSITION_SUBTASKS).subtasks,
        ...chunkProposalOf(MAX_DECOMPOSITION_CHUNKS).subtasks,
      ],
    };
    expect(normalizeDecomposition(mixed, 100).subtasks).toHaveLength(76);

    // 65 chunks: over the chunk cap even though model count is 0.
    expect(() =>
      normalizeDecomposition(chunkProposalOf(MAX_DECOMPOSITION_CHUNKS + 1), 100),
    ).toThrow(/at most 64 sandbox chunk/);
    // 13 model subtasks: over the model cap even with zero chunks.
    expect(() => normalizeDecomposition(proposalOf(MAX_DECOMPOSITION_SUBTASKS + 1), 100)).toThrow(
      /at most 12 model-executed/,
    );
    // 13 model + 3 chunks: chunks never buy headroom for model subtasks.
    expect(() =>
      normalizeDecomposition(
        {
          subtasks: [
            ...proposalOf(MAX_DECOMPOSITION_SUBTASKS + 1).subtasks,
            ...chunkProposalOf(3).subtasks,
          ],
        },
        100,
      ),
    ).toThrow(/at most 12 model-executed/);
  });

  it('the chunk marker is crisp: one pinned program, valid shape — or an error, never reclassified', () => {
    // chunks pinning DIFFERENT programs are rejected (one program, many slices)
    expect(() =>
      normalizeDecomposition(
        { subtasks: [chunk(0), chunk(1, { ...PINNED, sha: 'b'.repeat(40) })] },
        100,
      ),
    ).toThrow(/same repo\+sha\+entrypoint/);
    // a malformed sha is an error — NOT silently counted as a model subtask
    expect(() =>
      normalizeDecomposition({ subtasks: [chunk(0, { ...PINNED, sha: 'main' })] }, 100),
    ).toThrow(/40-hex commit SHA/);
    expect(() =>
      normalizeDecomposition(
        { subtasks: [chunk(0, { ...PINNED, entrypoint: '../../etc/passwd' })] },
        100,
      ),
    ).toThrow(/entrypoint/);
    // chunk defaults: computational / low effort (CPU work), hints still win
    const ok = normalizeDecomposition({ subtasks: [chunk(7)] }, 100);
    expect(ok.subtasks[0]).toMatchObject({ kind: 'computational', effort: 'low' });
    expect(ok.subtasks[0].code).toMatchObject({ ...PINNED, input: { slice: 7 } });
  });

  it('approved chunk subtasks publish with spec.code (the sandbox rail) and depth 1', async () => {
    const proposer = await createDev('proposer');
    const target = await createTarget('Euler-like sweep');
    const parent = await createTask(target, { est: 50, max: 200, title: 'Full search' });
    await setBudget(proposer, 1000);
    await checkoutTask(proposer, parent);
    const res = await submitResult(
      proposer,
      parent,
      { decomposition: chunkProposalOf(20) },
      40,
      null,
      { outcome: 'decomposition', summary: 'fanning the pinned sweep' },
    );
    // the review prompt tells the reviewer what it's looking at
    const review = (await reviewTaskFor(res.contribution_id))[0];
    expect(review.spec.prompt).toContain('20 of them pinned-code sandbox chunks');

    const reviewer = await createDev('reviewer');
    await setBudget(reviewer, 1000);
    await checkoutTask(reviewer, res.review_task_id!);
    const approved = await submitResult(reviewer, res.review_task_id!, { approve: true }, 10, null);
    expect(approved.published_task_ids).toHaveLength(20);

    const published = await tasksFrom(res.contribution_id);
    for (const t of published) {
      expect(t.spec.code).toMatchObject(PINNED); // routes to the podman sandbox, not a model
      expect(t.decomposition_depth).toBe(1);
      expect(t.kind).toBe('computational');
    }
    // distinct slices survived normalization
    expect(new Set(published.map((t) => t.spec.code.input.slice)).size).toBe(20);
  });

  it('published subtasks CAN themselves decompose — depth recorded, review prompt says depth-N', async () => {
    // depth 0 -> 1
    const { res } = await proposeDecomposition();
    const review1 = (await reviewTaskFor(res.contribution_id))[0];
    expect(review1.spec.prompt).toContain('This is a depth-1 proposal');
    expect(review1.spec.prompt).not.toContain('published by an earlier approved decomposition');

    const reviewer = await createDev('reviewer');
    await setBudget(reviewer, 1000);
    await checkoutTask(reviewer, res.review_task_id!);
    const approved = await submitResult(reviewer, res.review_task_id!, { approve: true }, 10, null);
    const child = approved.published_task_ids![0];
    expect((await getTaskRow(child)).decomposition_depth).toBe(1);

    // depth 1 -> 2: an ordinary published subtask is decomposable (only review
    // tasks are blocked).
    const splitter = await createDev('splitter');
    await setBudget(splitter, 1000);
    await checkoutTask(splitter, child);
    const res2 = await submitResult(
      splitter,
      child,
      { decomposition: proposalOf(2, 50) },
      20,
      null,
      {
        outcome: 'decomposition',
        summary: 'still too big',
      },
    );
    const review2 = (await reviewTaskFor(res2.contribution_id))[0];
    expect(review2.spec.prompt).toContain('This is a depth-2 proposal');
    expect(review2.spec.prompt).toContain('scrutinize whether splitting AGAIN');

    const reviewer2 = await createDev('reviewer2');
    await setBudget(reviewer2, 1000);
    await checkoutTask(reviewer2, res2.review_task_id!);
    const approved2 = await submitResult(
      reviewer2,
      res2.review_task_id!,
      { approve: true },
      10,
      null,
    );
    for (const id of approved2.published_task_ids!) {
      expect((await getTaskRow(id)).decomposition_depth).toBe(2);
    }
  });

  it('published subtasks are claimable through the byte-identical budget gate', async () => {
    const { res } = await proposeDecomposition();
    const reviewer = await createDev('reviewer');
    await setBudget(reviewer, 1000);
    await checkoutTask(reviewer, res.review_task_id!);
    const review = await submitResult(reviewer, res.review_task_id!, { approve: true }, 10, null);

    const claimer = await createDev('claimer');
    await setBudget(claimer, 50); // < the 100¢ subtask cap
    await expect(checkoutTask(claimer, review.published_task_ids![0])).rejects.toMatchObject({
      code: 'insufficient_budget',
    });
    await setBudget(claimer, 500);
    const co = await checkoutTask(claimer, review.published_task_ids![0]);
    expect(co.max_cost_cents).toBe(100);
  });
});
