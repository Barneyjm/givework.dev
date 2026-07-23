import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, pool } from '../src/db.js';
import { checkoutTask, submitResult } from '../src/operations.js';
import { app } from '../src/server.js';
import { runAutoVerification, submitAndVerify } from '../src/verify.js';
import { createDev, createTask, mintAdminToken, resetDb, setBudget } from './helpers.js';

// Phase 5: verification core. auto_rerun re-evaluates a counterexample witness
// with a built-in checker; a pass flips the target to 'disproven'. human_review
// stays the admin path (exercised in auto-accept / admin tests).

afterAll(closePool);
beforeEach(resetDb);

async function createConjecture(opts: {
  slug: string;
  checker?: string;
  status?: string;
}): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO targets (name, kind, slug, checker, contact_email)
     VALUES ($1, 'conjecture', $2, $3, NULL) RETURNING id`,
    [`Conj ${opts.slug}`, opts.slug, opts.checker ?? null],
  );
  return rows[0].id;
}
async function targetRow(id: string) {
  const { rows } = await pool.query(
    `SELECT status::text AS status, resolved_by FROM targets WHERE id = $1`,
    [id],
  );
  return rows[0];
}
async function verificationsFor(taskId: string) {
  const { rows } = await pool.query(
    `SELECT method::text AS method, verdict, verifier FROM verifications WHERE task_id = $1 ORDER BY id`,
    [taskId],
  );
  return rows;
}
async function taskStatus(taskId: string): Promise<string> {
  const { rows } = await pool.query(`SELECT status FROM tasks WHERE id = $1`, [taskId]);
  return rows[0].status;
}

/** Fund a dev, check out the task, and submit a candidate_solution with `result`. */
async function submitCandidate(taskId: string, result: unknown, cost = 100) {
  const dev = await createDev(`dev-${Math.floor(cost)}-${taskId.slice(0, 4)}`);
  await setBudget(dev, 5000);
  await checkoutTask(dev, taskId);
  await submitResult(dev, taskId, result, cost, null); // default outcome: candidate_solution
}

describe('auto_rerun verification', () => {
  it('a valid counterexample passes and disproves the conjecture', async () => {
    // Euler's sum-of-powers conjecture — disproven by 27^5+84^5+110^5+133^5 = 144^5.
    const target = await createConjecture({ slug: 'euler-k5', checker: 'euler_sum_of_powers' });
    const task = await createTask(target, {
      max: 500,
      kind: 'counterexample_search',
      verify_via: 'auto_rerun',
    });
    await submitCandidate(task, { bases: [27, 84, 110, 133], target: 144 });

    const v = await runAutoVerification(task);
    expect(v.handled).toBe(true);
    expect(v.verdict).toBe('passed');
    expect(v.target_status).toBe('disproven');

    expect(await taskStatus(task)).toBe('accepted'); // deliverable accepted
    const tg = await targetRow(target);
    expect(tg.status).toBe('disproven');
    expect(tg.resolved_by).not.toBeNull(); // credits the winning contribution
    const vs = await verificationsFor(task);
    expect(vs).toEqual([{ method: 'auto_rerun', verdict: 'passed', verifier: 'platform' }]);
  });

  it('a bogus counterexample fails and returns the task to the pool', async () => {
    const target = await createConjecture({ slug: 'euler-bad', checker: 'euler_sum_of_powers' });
    const task = await createTask(target, {
      max: 500,
      kind: 'counterexample_search',
      verify_via: 'auto_rerun',
    });
    await submitCandidate(task, { bases: [1, 2, 3, 4], target: 5 }); // 1+32+243+1024 != 3125

    const v = await runAutoVerification(task);
    expect(v.verdict).toBe('failed');
    expect(await taskStatus(task)).toBe('open'); // back to the pool
    expect((await targetRow(target)).status).toBe('open'); // conjecture untouched
    expect((await verificationsFor(task))[0]).toMatchObject({ verdict: 'failed' });
  });

  it('holds a candidate as pending when the target has no checker', async () => {
    const target = await createConjecture({ slug: 'no-checker' }); // checker null
    const task = await createTask(target, { max: 500, verify_via: 'auto_rerun' });
    await submitCandidate(task, { anything: true });

    const v = await runAutoVerification(task);
    expect(v.verdict).toBe('pending');
    expect(await taskStatus(task)).toBe('submitted'); // waits for a human
    expect((await verificationsFor(task))[0]).toMatchObject({ verdict: 'pending' });
  });

  it('does not disprove for a non-checkable Goldbach witness (checker rejects it)', async () => {
    const target = await createConjecture({ slug: 'goldbach', checker: 'goldbach' });
    const task = await createTask(target, { max: 500, verify_via: 'auto_rerun' });
    await submitCandidate(task, { n: 100 }); // 100 = 3 + 97, so NOT a counterexample

    const v = await runAutoVerification(task);
    expect(v.verdict).toBe('failed');
    expect((await targetRow(target)).status).toBe('open');
  });

  it('leaves human_review to the caller (not handled)', async () => {
    const target = await createConjecture({ slug: 'hr' });
    const task = await createTask(target, { max: 500, verify_via: 'human_review' });
    await submitCandidate(task, { note: 'a partial argument' });

    const v = await runAutoVerification(task);
    expect(v.handled).toBe(false);
    expect(await taskStatus(task)).toBe('submitted'); // untouched — waits for review
    expect(await verificationsFor(task)).toHaveLength(0);
  });
});

describe('submitAndVerify (the shared submit rail: HTTP /submit + MCP submit_result)', () => {
  it('a passing witness reports the post-verification state: accepted + disproven', async () => {
    const target = await createConjecture({ slug: 'euler-rail', checker: 'euler_sum_of_powers' });
    const task = await createTask(target, {
      max: 500,
      kind: 'counterexample_search',
      verify_via: 'auto_rerun',
    });
    const dev = await createDev('rail-pass');
    await setBudget(dev, 5000);
    await checkoutTask(dev, task);

    const res = await submitAndVerify(
      dev,
      task,
      { bases: [27, 84, 110, 133], target: 144 },
      100,
      null,
    );
    expect(res.status).toBe('accepted'); // not the stale 'submitted'
    expect(res.verification).toEqual({ verdict: 'passed', target_status: 'disproven' });
    expect(await taskStatus(task)).toBe('accepted');
    expect((await targetRow(target)).status).toBe('disproven');
  });

  it('a failing witness reports open, and the reject ledger row keeps dev attribution', async () => {
    const target = await createConjecture({ slug: 'euler-rail-2', checker: 'euler_sum_of_powers' });
    const task = await createTask(target, {
      max: 500,
      kind: 'counterexample_search',
      verify_via: 'auto_rerun',
    });
    const dev = await createDev('rail-fail');
    await setBudget(dev, 5000);
    await checkoutTask(dev, task);

    const res = await submitAndVerify(dev, task, { bases: [1, 2, 3, 4], target: 5 }, 100, null);
    expect(res.status).toBe('open'); // verification already returned it to the pool
    expect(res.verification).toMatchObject({ verdict: 'failed' });
    expect(await taskStatus(task)).toBe('open');

    // rejectTask must attribute the ledger row to the dev whose claim failed.
    const { rows } = await pool.query(
      `SELECT dev_id FROM ledger WHERE task_id = $1 AND event_type = 'reject'`,
      [task],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].dev_id).toBe(dev);
  });

  it('a progress contribution is not verified (no terminal claim to check)', async () => {
    const target = await createConjecture({ slug: 'euler-rail-3', checker: 'euler_sum_of_powers' });
    const task = await createTask(target, { max: 500, verify_via: 'auto_rerun' });
    const dev = await createDev('rail-progress');
    await setBudget(dev, 5000);
    await checkoutTask(dev, task);

    const res = await submitAndVerify(dev, task, null, 50, null, { outcome: 'progress' });
    expect(res.status).toBe('open'); // back in the pool by design, not by rejection
    expect(res.verification).toBeNull();
    expect(await verificationsFor(task)).toHaveLength(0);
  });
});

describe('admin local checker (POST /admin/tasks/:id/verify)', () => {
  const req = (path: string, init?: RequestInit) =>
    app.fetch(new Request(`http://test${path}`, init));
  const verify = (tok: string, taskId: string, payload: unknown) =>
    req(`/admin/tasks/${taskId}/verify`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

  async function submittedTask(opts: {
    slug: string;
    kind?: string;
    verify_via: string;
  }): Promise<{ target: string; task: string }> {
    const target = await createConjecture({ slug: opts.slug });
    const task = await createTask(target, {
      max: 500,
      kind: opts.kind,
      verify_via: opts.verify_via,
    });
    await submitCandidate(task, { proof: 'see attached' });
    return { target, task };
  }

  it('a passed proof_checker resolves the conjecture', async () => {
    const tok = await mintAdminToken();
    const { target, task } = await submittedTask({
      slug: 'pc',
      kind: 'formalization',
      verify_via: 'proof_checker',
    });

    const res = await verify(tok, task, { verdict: 'passed', detail: { lake: 'build ok' } });
    expect(res.status).toBe(200);
    expect(await taskStatus(task)).toBe('accepted');
    expect((await targetRow(target)).status).toBe('resolved');
    expect((await verificationsFor(task))[0]).toMatchObject({
      method: 'proof_checker',
      verdict: 'passed',
      verifier: 'admin',
    });
  });

  it('a passed counterexample_search disproves the conjecture', async () => {
    const tok = await mintAdminToken();
    const { target, task } = await submittedTask({
      slug: 'cx',
      kind: 'counterexample_search',
      verify_via: 'proof_checker',
    });
    await verify(tok, task, { verdict: 'passed' });
    expect((await targetRow(target)).status).toBe('disproven');
  });

  it('a passed replication accepts the range work but does NOT resolve the conjecture', async () => {
    const tok = await mintAdminToken();
    const { target, task } = await submittedTask({
      slug: 'rep',
      kind: 'computational',
      verify_via: 'replication',
    });
    await verify(tok, task, { verdict: 'passed' });
    expect(await taskStatus(task)).toBe('accepted');
    expect((await targetRow(target)).status).toBe('open'); // progress, not a solution
  });

  it('a failed verdict returns the task to the pool', async () => {
    const tok = await mintAdminToken();
    const { target, task } = await submittedTask({ slug: 'fail', verify_via: 'proof_checker' });
    await verify(tok, task, { verdict: 'failed', detail: { reason: 'does not compile' } });
    expect(await taskStatus(task)).toBe('open');
    expect((await targetRow(target)).status).toBe('open');
    expect((await verificationsFor(task))[0]).toMatchObject({ verdict: 'failed' });
  });

  it('an explicit resolve override settles a lemma the admin judges complete', async () => {
    const tok = await mintAdminToken();
    const { target, task } = await submittedTask({
      slug: 'lemma',
      kind: 'lemma',
      verify_via: 'human_review',
    });
    // A lemma would not flip on its own; the admin forces resolution.
    await verify(tok, task, { verdict: 'passed', resolve: 'resolved' });
    expect((await targetRow(target)).status).toBe('resolved');
  });

  it('validates the verdict and requires an admin token', async () => {
    const tok = await mintAdminToken();
    const { task } = await submittedTask({ slug: 'bad', verify_via: 'proof_checker' });
    expect((await verify(tok, task, { verdict: 'maybe' })).status).toBe(400);
    const noAuth = await req(`/admin/tasks/${task}/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ verdict: 'passed' }),
    });
    expect(noAuth.status).toBe(401);
  });
});
