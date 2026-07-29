import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, pool } from '../src/db.js';
import { app } from '../src/server.js';
import {
  createDev,
  createTarget,
  createTask,
  getBudgetRow,
  getFunnelEvents,
  getLedger,
  getTaskRow,
  mintAdminToken,
  mintDevToken,
  resetDb,
  setBudget,
  setVerified,
} from './helpers.js';

afterAll(closePool);

const bearer = (t: string) => ({
  authorization: `Bearer ${t}`,
  'content-type': 'application/json',
});
function req(path: string, init?: RequestInit) {
  return app.fetch(new Request(`http://test${path}`, init));
}

let np: string;
beforeEach(async () => {
  await resetDb();
  // The nonprofit/org world, where accept was always a subjective judgment call.
  np = await createTarget('Test NP', 'org_request');
});

/** Drive a dev through checkout → submit on a public task via the HTTP routes. */
async function checkoutAndSubmit(
  token: string,
  taskId: string,
  body: Record<string, unknown> = {},
) {
  const co = await req('/checkout', {
    method: 'POST',
    headers: bearer(token),
    body: JSON.stringify({ task_id: taskId }),
  });
  expect(co.status).toBe(200);
  return req('/submit', {
    method: 'POST',
    headers: bearer(token),
    body: JSON.stringify({
      task_id: taskId,
      result: { ok: true },
      actual_cost_cents: 100,
      ...body,
    }),
  });
}

async function verificationRows(taskId: string) {
  const { rows } = await pool.query(`SELECT verdict FROM verifications WHERE task_id = $1`, [
    taskId,
  ]);
  return rows;
}

describe('auto-accept on submit (verified devs, org_request work)', () => {
  it("auto-accepts a verified dev's submission on org_request work", async () => {
    const dev = await createDev('verified-vol');
    await setVerified(dev);
    await setBudget(dev, 2000);
    const task = await createTask(np, { max: 200 }); // public

    const res = await checkoutAndSubmit(await mintDevToken(dev), task);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('accepted');
    // No manual review gate: the task went straight to accepted.
    expect((await getTaskRow(task)).status).toBe('accepted');
  });

  it("leaves an unverified dev's submission in 'submitted' for manual review", async () => {
    const dev = await createDev('new-vol'); // unverified
    await setBudget(dev, 2000);
    const task = await createTask(np, { max: 200 }); // public (unverified can claim)

    const res = await checkoutAndSubmit(await mintDevToken(dev), task);
    expect(res.status).toBe(200);
    expect((await getTaskRow(task)).status).toBe('submitted');
  });
});

describe('trust auto-accept is kind-gated (open mathematics)', () => {
  // The production hole: a verified dev's candidate_solution on a research
  // target was instantly accepted with no one — human or machine — ever
  // checking the mathematics. Trust in the volunteer must never stand in for
  // verification of the claim.
  for (const kind of ['conjecture', 'research_question']) {
    it(`verified dev + candidate_solution on a ${kind} stays 'submitted'`, async () => {
      const target = await createTarget(`Open ${kind}`, kind);
      const dev = await createDev(`trusted-${kind}`);
      await setVerified(dev);
      await setBudget(dev, 2000);
      const task = await createTask(target, { max: 200 }); // verify_via human_review

      const res = await checkoutAndSubmit(await mintDevToken(dev), task);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; verification: unknown };
      // The submit itself succeeded, but nothing accepted the claim.
      expect(body.status).toBe('submitted');
      expect(body.verification).toBeNull();
      expect((await getTaskRow(task)).status).toBe('submitted');
      expect(await verificationRows(task)).toHaveLength(0);

      // Funnel/ledger semantics unchanged: the spend is booked exactly as for
      // any finished submit (reserve released, actual cost spent) and there is
      // no 'accept' ledger row — the work simply awaits verification.
      const ledger = await getLedger(dev);
      expect(ledger.map((l: { event_type: string }) => l.event_type)).not.toContain('accept');
      expect(ledger.some((l: { event_type: string }) => l.event_type === 'submit')).toBe(true);
      const budget = await getBudgetRow(dev);
      expect(Number(budget.spent_cents)).toBe(100);
      expect(Number(budget.reserved_cents)).toBe(0);
      const funnel = await getFunnelEvents(dev);
      expect(funnel.some((f) => f.event === 'submit')).toBe(true);
    });
  }

  it('progress / dead_end contributions on research targets release as before', async () => {
    const target = await createTarget('Open conj', 'conjecture');
    const dev = await createDev('trusted-progress');
    await setVerified(dev);
    await setBudget(dev, 2000);
    const tok = await mintDevToken(dev);

    for (const outcome of ['progress', 'dead_end']) {
      const task = await createTask(target, { max: 200 });
      const res = await checkoutAndSubmit(tok, task, { outcome, summary: `a ${outcome} note` });
      expect(res.status).toBe(200);
      // Back in the pool for the next contributor — never held for review.
      expect((await getTaskRow(task)).status).toBe('open');
    }
  });

  it('the machine path still accepts and flips when the checker really confirms', async () => {
    // Regression: the kind-gate must not touch auto_rerun — a checker-confirmed
    // counterexample from a verified dev still accepts + disproves instantly.
    const target = await createTarget('Euler k5', 'conjecture');
    await pool.query(`UPDATE targets SET checker = 'euler_sum_of_powers' WHERE id = $1`, [target]);
    const dev = await createDev('trusted-machine');
    await setVerified(dev);
    await setBudget(dev, 2000);
    const task = await createTask(target, {
      max: 200,
      kind: 'counterexample_search',
      verify_via: 'auto_rerun',
    });

    const res = await checkoutAndSubmit(await mintDevToken(dev), task, {
      result: { bases: [27, 84, 110, 133], target: 144 },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      verification: { verdict: string; target_status: string | null };
    };
    expect(body.status).toBe('accepted');
    expect(body.verification).toEqual({ verdict: 'passed', target_status: 'disproven' });
    expect((await getTaskRow(task)).status).toBe('accepted');
    const tg = await pool.query(`SELECT status::text AS status FROM targets WHERE id = $1`, [
      target,
    ]);
    expect(tg.rows[0].status).toBe('disproven');
  });
});

describe('GET /admin/tasks (review queue)', () => {
  it('lists submitted tasks and rejects an unknown status', async () => {
    const adminTok = await mintAdminToken();
    const dev = await createDev('u');
    await setBudget(dev, 2000);
    const task = await createTask(np, { max: 200, title: 'Tag emails' });
    await checkoutAndSubmit(await mintDevToken(dev), task); // → submitted (unverified)

    const ok = await req('/admin/tasks?status=submitted', {
      headers: { authorization: `Bearer ${adminTok}` },
    });
    expect(ok.status).toBe(200);
    const rows = (await ok.json()) as any[];
    expect(rows.some((t) => t.id === task && t.title === 'Tag emails')).toBe(true);

    const bad = await req('/admin/tasks?status=nope', {
      headers: { authorization: `Bearer ${adminTok}` },
    });
    expect(bad.status).toBe(400);

    // Still admin-gated.
    expect((await req('/admin/tasks')).status).toBe(401);
  });
});
