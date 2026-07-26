import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, pool } from '../src/db.js';
import { ONBOARDING_CANDIDATES } from '../src/goldbach.js';
import {
  checkoutTask,
  listAvailableTasks,
  listOpenTasks,
  mintOnboardingTask,
  ONBOARDING_MAX_CENTS,
  OpError,
} from '../src/operations.js';
import { app } from '../src/server.js';
import { submitAndVerify } from '../src/verify.js';
import {
  createDev,
  createOnboardingTarget,
  createTarget,
  createTask,
  getBudgetRow,
  getTaskRow,
  mintAdminToken,
  mintDevToken,
  resetDb,
  setBudget,
} from './helpers.js';

afterAll(closePool);

// Onboarding: a newcomer's first task is REAL work on a live open problem, with
// a range allocated to them alone. These tests pin the three properties the
// design depends on — per-dev ownership, disjoint ranges under concurrency, and
// idempotent minting — plus the budget guard, which is not special-cased.

describe('mintOnboardingTask', () => {
  beforeEach(async () => {
    await resetDb();
    await createOnboardingTarget(4);
  });

  it('mints a real, auto-verifying task on the live conjecture', async () => {
    const dev = await createDev('newcomer');
    await setBudget(dev, 500);

    const t = await mintOnboardingTask(dev);
    expect(t.existing).toBe(false);
    expect(t.target_slug).toBe('goldbach');
    expect(t.range_start).toBe(4);
    expect(t.candidates).toBe(ONBOARDING_CANDIDATES);
    expect(t.range_end).toBe(4 + ONBOARDING_CANDIDATES * 2);
    expect(t.max_cost_cents).toBe(ONBOARDING_MAX_CENTS);

    const row = await getTaskRow(t.task_id);
    // auto_rerun + a target with a checker is what keeps this out of any human
    // review queue: 200 signups in a week must cost zero review minutes.
    expect(row.verify_via).toBe('auto_rerun');
    expect(row.kind).toBe('computational');
    expect(row.sensitivity).toBe('public');
    expect(row.onboarding_dev_id).toBe(dev);
    // Routed through the model path, not a sandboxed code work unit — running it
    // is what proves the volunteer's own Claude CLI credential works.
    expect(row.spec.code).toBeUndefined();
    expect(typeof row.spec.prompt).toBe('string');
  });

  it('is idempotent — asking twice before completing returns the same task', async () => {
    const dev = await createDev('twice');
    await setBudget(dev, 500);

    const first = await mintOnboardingTask(dev);
    const second = await mintOnboardingTask(dev);
    expect(second.task_id).toBe(first.task_id);
    expect(second.existing).toBe(true);
    expect(second.range_start).toBe(first.range_start);

    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM tasks`);
    expect(rows[0].n).toBe(1);
  });

  it('is idempotent even when both calls race', async () => {
    const dev = await createDev('racer');
    await setBudget(dev, 500);

    const results = await Promise.all([
      mintOnboardingTask(dev),
      mintOnboardingTask(dev),
      mintOnboardingTask(dev),
    ]);
    const ids = new Set(results.map((r) => r.task_id));
    expect(ids.size).toBe(1);

    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM tasks`);
    expect(rows[0].n).toBe(1);
  });

  it('gives concurrent newcomers disjoint, contiguous ranges', async () => {
    const devs = await Promise.all(
      ['a', 'b', 'c', 'd', 'e', 'f'].map((h) => createDev(`concurrent-${h}`)),
    );
    await Promise.all(devs.map((d) => setBudget(d, 500)));

    const tasks = await Promise.all(devs.map((d) => mintOnboardingTask(d)));

    // Every range is distinct...
    const starts = tasks.map((t) => t.range_start).sort((x, y) => x - y);
    expect(new Set(starts).size).toBe(devs.length);
    // ...and they tile the line: each starts exactly where the previous ended.
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i]).toBe(starts[i - 1] + ONBOARDING_CANDIDATES * 2);
    }
    // No pair overlaps.
    for (const t of tasks) {
      const others = tasks.filter((o) => o.task_id !== t.task_id);
      for (const o of others) {
        expect(t.range_start >= o.range_end || t.range_end <= o.range_start).toBe(true);
      }
    }
    // The cursor ended up exactly one block past the last allocation.
    const { rows } = await pool.query(`SELECT sweep_cursor FROM targets WHERE slug = 'goldbach'`);
    expect(Number(rows[0].sweep_cursor)).toBe(
      starts[starts.length - 1] + ONBOARDING_CANDIDATES * 2,
    );
  });

  it('refuses cleanly when no budget is set, without minting anything', async () => {
    const dev = await createDev('no-budget');
    await expect(mintOnboardingTask(dev)).rejects.toMatchObject({
      status: 402,
      code: 'no_budget',
    });
    await expect(mintOnboardingTask(dev)).rejects.toThrow(/givework budget set/);

    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM tasks`);
    expect(rows[0].n).toBe(0);
  });

  it('refuses cleanly when the budget is too small, and says what to do', async () => {
    const dev = await createDev('too-small');
    await setBudget(dev, ONBOARDING_MAX_CENTS - 1);

    const err = await mintOnboardingTask(dev).catch((e) => e);
    expect(err).toBeInstanceOf(OpError);
    expect(err.status).toBe(402);
    expect(err.code).toBe('insufficient_budget');
    expect(err.message).toMatch(/givework budget set/);

    // Raising the cap unblocks it — the guard is a gate, not a dead end.
    await setBudget(dev, 500);
    const t = await mintOnboardingTask(dev);
    expect(t.existing).toBe(false);
  });

  it('refuses when the onboarding conjecture is not seeded', async () => {
    await pool.query(`DELETE FROM targets WHERE slug = 'goldbach'`);
    const dev = await createDev('unseeded');
    await setBudget(dev, 500);
    await expect(mintOnboardingTask(dev)).rejects.toMatchObject({
      code: 'onboarding_unavailable',
    });
  });

  it('does not consume a range when the budget guard refuses', async () => {
    const poor = await createDev('poor');
    await setBudget(poor, 1);
    await mintOnboardingTask(poor).catch(() => {});

    const rich = await createDev('rich');
    await setBudget(rich, 500);
    const t = await mintOnboardingTask(rich);
    expect(t.range_start).toBe(4); // the first block, untouched by the refusal
  });
});

describe('onboarding tasks are not pooled', () => {
  beforeEach(async () => {
    await resetDb();
    await createOnboardingTarget(4);
  });

  it("hides another dev's onboarding task from the claimable pool", async () => {
    const mine = await createDev('mine');
    const other = await createDev('other');
    await setBudget(mine, 500);
    await setBudget(other, 500);
    const t = await mintOnboardingTask(mine);

    // The owner sees it...
    const forOwner = await listOpenTasks({ devId: mine });
    expect(forOwner.map((r) => r.id)).toContain(t.task_id);
    // ...nobody else does...
    const forOther = await listOpenTasks({ devId: other });
    expect(forOther.map((r) => r.id)).not.toContain(t.task_id);
    // ...and an unattributed listing hides all of them.
    const anonymous = await listOpenTasks({});
    expect(anonymous.map((r) => r.id)).not.toContain(t.task_id);
  });

  it('keeps onboarding tasks off the public work board', async () => {
    const dev = await createDev('boarded');
    await setBudget(dev, 500);
    const t = await mintOnboardingTask(dev);
    const available = await listAvailableTasks();
    expect(available.map((r) => r.id)).not.toContain(t.task_id);
  });

  it("refuses another dev's checkout of an onboarding task", async () => {
    const mine = await createDev('owner');
    const thief = await createDev('thief');
    await setBudget(mine, 500);
    await setBudget(thief, 500);
    const t = await mintOnboardingTask(mine);

    await expect(checkoutTask(thief, t.task_id)).rejects.toMatchObject({
      status: 403,
      code: 'not_your_task',
    });
    // Still waiting for its owner.
    expect((await getTaskRow(t.task_id)).status).toBe('open');
    await expect(checkoutTask(mine, t.task_id)).resolves.toMatchObject({ task_id: t.task_id });
  });

  it('leaves ordinary pooled tasks visible as before', async () => {
    const target = await createTarget();
    const pooled = await createTask(target, { max: 100 });
    const dev = await createDev('ordinary');
    await setBudget(dev, 500);
    await mintOnboardingTask(dev);
    const rows = await listOpenTasks({ devId: dev });
    expect(rows.map((r) => r.id)).toContain(pooled);
  });
});

describe('onboarding end to end', () => {
  beforeEach(async () => {
    await resetDb();
    await createOnboardingTarget(4);
  });

  it('books the spend, auto-verifies a clean sweep, and records the contribution', async () => {
    const dev = await createDev('finisher');
    await setBudget(dev, 500);
    const t = await mintOnboardingTask(dev);
    await checkoutTask(dev, t.task_id);

    const submitted = await submitAndVerify(
      dev,
      t.task_id,
      { range_start: t.range_start, range_end: t.range_end, counterexamples: [] },
      2,
      { model: 'test' },
      { summary: 'Swept the assigned range; every even number decomposes.' },
    );

    // A clean sweep is a PASS, not a rejection: territory ruled out is the work.
    expect(submitted.verification?.verdict).toBe('passed');
    expect(submitted.status).toBe('accepted');
    // …and it does NOT claim to have settled the conjecture.
    expect(submitted.verification?.target_status).toBeNull();
    const { rows: tgt } = await pool.query(`SELECT status FROM targets WHERE slug = 'goldbach'`);
    expect(tgt[0].status).toBe('open');

    // Ordinary accounting: no special-casing for onboarding work.
    const budget = await getBudgetRow(dev);
    expect(budget.reserved_cents).toBe(0);
    expect(budget.spent_cents).toBe(2);
    const { rows: contrib } = await pool.query(
      `SELECT cost_cents, dev_id FROM contributions WHERE task_id = $1`,
      [t.task_id],
    );
    expect(contrib).toHaveLength(1);
    expect(contrib[0].cost_cents).toBe(2);
    expect(contrib[0].dev_id).toBe(dev);
  });

  it('verifies an honestly computed statistic and rejects a fabricated one', async () => {
    const honest = await createDev('honest');
    await setBudget(honest, 500);
    const a = await mintOnboardingTask(honest);
    await checkoutTask(honest, a.task_id);
    const good = await submitAndVerify(
      honest,
      a.task_id,
      // 293 at n=63274 is the true record for the first block [4, 80004).
      {
        range_start: a.range_start,
        range_end: a.range_end,
        counterexamples: [],
        max_min_prime: 293,
      },
      2,
      null,
    );
    expect(good.verification?.verdict).toBe('passed');

    const liar = await createDev('liar');
    await setBudget(liar, 500);
    const b = await mintOnboardingTask(liar);
    await checkoutTask(liar, b.task_id);
    const bad = await submitAndVerify(
      liar,
      b.task_id,
      { range_start: b.range_start, range_end: b.range_end, counterexamples: [], max_min_prime: 7 },
      2,
      null,
    );
    expect(bad.verification?.verdict).toBe('failed');
    expect((await getTaskRow(b.task_id)).status).toBe('open'); // back for another go
  });

  it('rejects a made-up counterexample without disproving the conjecture', async () => {
    const dev = await createDev('fabricator');
    await setBudget(dev, 500);
    const t = await mintOnboardingTask(dev);
    await checkoutTask(dev, t.task_id);

    const r = await submitAndVerify(
      dev,
      t.task_id,
      { range_start: t.range_start, range_end: t.range_end, counterexamples: [1000] },
      2,
      null,
    );
    expect(r.verification?.verdict).toBe('failed');
    const { rows } = await pool.query(`SELECT status FROM targets WHERE slug = 'goldbach'`);
    expect(rows[0].status).toBe('open');
  });

  it('refuses credit for sweeping a range other than the assigned one', async () => {
    // The second dev is assigned the SECOND block. Reporting the (much easier,
    // already-swept) first block must not be verified as their contribution.
    const first = await createDev('first');
    const second = await createDev('second');
    await setBudget(first, 500);
    await setBudget(second, 500);
    const a = await mintOnboardingTask(first);
    const b = await mintOnboardingTask(second);
    expect(b.range_start).toBe(a.range_end);

    await checkoutTask(second, b.task_id);
    const r = await submitAndVerify(
      second,
      b.task_id,
      { range_start: a.range_start, range_end: a.range_end, counterexamples: [] },
      2,
      null,
    );
    expect(r.verification?.verdict).toBe('failed');
  });

  it('verifies the assigned range even when the agent forgets to echo it', async () => {
    const dev = await createDev('forgetful');
    await setBudget(dev, 500);
    const t = await mintOnboardingTask(dev);
    await checkoutTask(dev, t.task_id);
    const r = await submitAndVerify(dev, t.task_id, { counterexamples: [] }, 2, null);
    expect(r.verification?.verdict).toBe('passed');
  });

  it('holds a range it cannot check inline as inconclusive, not as a rejection', async () => {
    // A task that assigned no range of its own, so the claim itself sets the
    // bounds — and these are far wider than we are willing to sweep inline.
    // Unverifiable is not the same as false: hold it for a human, don't reject.
    const { rows } = await pool.query(`SELECT id FROM targets WHERE slug = 'goldbach'`);
    const adhoc = await createTask(rows[0].id, {
      max: 100,
      kind: 'computational',
      verify_via: 'auto_rerun',
    });
    const dev = await createDev('unverifiable');
    await setBudget(dev, 500);
    await checkoutTask(dev, adhoc);

    const r = await submitAndVerify(
      dev,
      adhoc,
      { range_start: 4, range_end: 4_000_000_000 },
      2,
      null,
    );
    expect(r.verification?.verdict).toBe('inconclusive');
    expect((await getTaskRow(adhoc)).status).toBe('submitted');
  });
});

describe('POST /devs/onboarding', () => {
  function req(path: string, init?: RequestInit) {
    return app.fetch(new Request(`http://test${path}`, init));
  }

  beforeEach(async () => {
    await resetDb();
    await createOnboardingTarget(4);
  });

  it('mints for the token holder and ignores the body', async () => {
    const alice = await createDev('alice-http');
    const bob = await createDev('bob-http');
    await setBudget(alice, 500);
    await setBudget(bob, 500);

    const post = async (tok: string) =>
      req('/devs/onboarding', {
        method: 'POST',
        headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
        // Identity comes from the JWT: this body is a lie and must be ignored.
        body: JSON.stringify({ dev_id: bob }),
      });

    const res = await post(await mintDevToken(alice));
    expect(res.status).toBe(200);
    const minted = (await res.json()) as any;
    expect((await getTaskRow(minted.task_id)).onboarding_dev_id).toBe(alice);

    // Bob's own call gets his own task, on the next block of the number line.
    const bobRes = await post(await mintDevToken(bob));
    const bobTask = (await bobRes.json()) as any;
    expect(bobTask.task_id).not.toBe(minted.task_id);
    expect(bobTask.range_start).toBe(minted.range_end);
  });

  it('requires a dev token', async () => {
    expect((await req('/devs/onboarding', { method: 'POST' })).status).toBe(401);
    const asAdmin = await req('/devs/onboarding', {
      method: 'POST',
      headers: { authorization: `Bearer ${await mintAdminToken()}` },
    });
    expect(asAdmin.status).toBe(403);
  });

  it('surfaces the budget refusal as a 402 with a usable message', async () => {
    const dev = await createDev('broke-http');
    const res = await req('/devs/onboarding', {
      method: 'POST',
      headers: { authorization: `Bearer ${await mintDevToken(dev)}` },
    });
    expect(res.status).toBe(402);
    const body = (await res.json()) as any;
    expect(body.error).toBe('no_budget');
    expect(body.message).toMatch(/givework budget set/);
  });
});
