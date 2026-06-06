import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../src/db.js';
import { app } from '../src/server.js';
import {
  createDev,
  createNonprofit,
  createTask,
  getBudgetRow,
  mintAdminToken,
  mintDevToken,
  resetDb,
  setBudget,
} from './helpers.js';

afterAll(closePool);

// Drive the real Hono app in-process. No network — app.fetch(Request) -> Response.
function req(path: string, init?: RequestInit) {
  return app.fetch(new Request(`http://test${path}`, init));
}
const bearer = (t: string) => ({
  authorization: `Bearer ${t}`,
  'content-type': 'application/json',
});

let alice: string;
let aliceTok: string;
let task: string;

beforeEach(async () => {
  await resetDb();
  const np = await createNonprofit();
  alice = await createDev('alice');
  aliceTok = await mintDevToken(alice);
  await setBudget(alice, 2000);
  task = await createTask(np, { max: 500 });
});

describe('authentication', () => {
  it('rejects requests with no token (401)', async () => {
    const res = await req('/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task_id: task }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects a garbage / unsigned token (401)', async () => {
    const res = await req('/budget', { headers: bearer('not.a.jwt') });
    expect(res.status).toBe(401);
  });

  it('accepts a valid dev token (200) and checks out', async () => {
    const res = await req('/checkout', {
      method: 'POST',
      headers: bearer(aliceTok),
      body: JSON.stringify({ task_id: task }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.task_id).toBe(task);
    expect((await getBudgetRow(alice)).reserved_cents).toBe(500);
  });
});

describe('impersonation is closed', () => {
  it('dev_id in the body is ignored — a token only acts as its own dev', async () => {
    const bob = await createDev('bob');
    await setBudget(bob, 2000);

    // Alice's token, but the body tries to spend as Bob.
    const res = await req('/checkout', {
      method: 'POST',
      headers: bearer(aliceTok),
      body: JSON.stringify({ task_id: task, dev_id: bob }),
    });
    expect(res.status).toBe(200);

    // The reservation landed on Alice (the token), not Bob (the body).
    expect((await getBudgetRow(alice)).reserved_cents).toBe(500);
    expect((await getBudgetRow(bob)).reserved_cents).toBe(0);
  });

  it("budget reads return the caller's own budget", async () => {
    const res = await req('/budget', { headers: bearer(aliceTok) });
    const b = (await res.json()) as any;
    expect(b.budget_cents).toBe(2000);
  });
});

describe('admin authorization', () => {
  it('a dev token cannot hit /admin/* (403)', async () => {
    const res = await req('/admin/devs', {
      method: 'POST',
      headers: bearer(aliceTok),
      body: JSON.stringify({ github_handle: 'mallory' }),
    });
    expect(res.status).toBe(403);
  });

  it('no token on /admin/expire is 401', async () => {
    const res = await req('/admin/expire', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('an admin token can create a dev and gets back a usable token', async () => {
    const adminTok = await mintAdminToken();
    const res = await req('/admin/devs', {
      method: 'POST',
      headers: bearer(adminTok),
      body: JSON.stringify({ github_handle: 'carol' }),
    });
    expect(res.status).toBe(200);
    const dev = (await res.json()) as any;
    expect(dev.id).toBeTruthy();
    expect(dev.token).toBeTruthy();

    // The returned token authenticates as that new dev.
    const who = await req('/tasks/open', { headers: bearer(dev.token) });
    expect(who.status).toBe(200);
  });
});
