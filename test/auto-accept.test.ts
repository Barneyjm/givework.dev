import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../src/db.js';
import { app } from '../src/server.js';
import {
  createDev,
  createNonprofit,
  createTask,
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
  np = await createNonprofit();
});

/** Drive a dev through checkout → submit on a public task via the HTTP routes. */
async function checkoutAndSubmit(token: string, taskId: string) {
  const co = await req('/checkout', {
    method: 'POST',
    headers: bearer(token),
    body: JSON.stringify({ task_id: taskId }),
  });
  expect(co.status).toBe(200);
  return req('/submit', {
    method: 'POST',
    headers: bearer(token),
    body: JSON.stringify({ task_id: taskId, result: { ok: true }, actual_cost_cents: 100 }),
  });
}

describe('auto-accept on submit (verified devs)', () => {
  it("auto-accepts a verified dev's submission", async () => {
    const dev = await createDev('verified-vol');
    await setVerified(dev);
    await setBudget(dev, 2000);
    const task = await createTask(np, { max: 200 }); // public

    const res = await checkoutAndSubmit(await mintDevToken(dev), task);
    expect(res.status).toBe(200);
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
