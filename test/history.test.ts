import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, pool } from '../src/db.js';
import { acceptTask, checkoutTask, releaseTask, submitResult } from '../src/operations.js';
import { app } from '../src/server.js';
import {
  createDev,
  createNonprofit,
  createTask,
  mintDevToken,
  resetDb,
  setBudget,
} from './helpers.js';

afterAll(closePool);

// Drive the real Hono app in-process (no network), matching auth.test.ts.
function get(path: string, token: string) {
  return app.fetch(
    new Request(`http://test${path}`, { headers: { authorization: `Bearer ${token}` } }),
  );
}
/** GET and parse the JSON body in one step (response body typed as any). */
async function getJson(path: string, token: string): Promise<any> {
  return (await get(path, token)).json();
}

let alice: string;
let aliceTok: string;
let np: string;

beforeEach(async () => {
  await resetDb();
  np = await createNonprofit('Helpful Org');
  alice = await createDev('alice');
  aliceTok = await mintDevToken(alice);
  await setBudget(alice, 5000);
});

/** Run a full checkout → submit (→ optional accept) for one task. */
async function contribute(
  devId: string,
  taskId: string,
  actual: number,
  accept = false,
): Promise<void> {
  await checkoutTask(devId, taskId);
  await submitResult(devId, taskId, { ok: true }, actual, null);
  if (accept) await acceptTask(taskId);
}

describe('GET /devs/me/ledger', () => {
  it("returns the caller's entries newest-first with task + nonprofit joined", async () => {
    const task = await createTask(np, { max: 500, title: 'Summarize intake' });
    await contribute(alice, task, 380);

    const res = await get('/devs/me/ledger', aliceTok);
    expect(res.status).toBe(200);
    const body: any = await res.json();

    // checkout then submit, newest (submit) first.
    expect(body.entries.map((e: any) => e.event_type)).toEqual(['submit', 'checkout']);
    expect(body.entries[0]).toMatchObject({
      task_title: 'Summarize intake',
      nonprofit_name: 'Helpful Org',
      delta_cents: 380 - 500, // submit nets spend - reservation
    });
    expect(body.entries[1].delta_cents).toBe(500); // checkout reservation
    expect(body.next_before).toBeNull();
  });

  it('keyset-paginates via limit + before', async () => {
    for (let i = 0; i < 3; i++) {
      const t = await createTask(np, { max: 200, title: `task ${i}` });
      await contribute(alice, t, 100); // 2 ledger rows each → 6 total
    }

    const first = await getJson('/devs/me/ledger?limit=4', aliceTok);
    expect(first.entries).toHaveLength(4);
    expect(first.next_before).toBe(first.entries[3].id);

    const second = await getJson(`/devs/me/ledger?limit=4&before=${first.next_before}`, aliceTok);
    expect(second.entries).toHaveLength(2);
    expect(second.next_before).toBeNull();

    // Continuous, strictly-decreasing ids across the two pages — no overlap, no gap.
    const ids = [...first.entries, ...second.entries].map((e: any) => e.id);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
    expect(new Set(ids).size).toBe(6);
  });

  it("is scoped to the caller — never another dev's entries", async () => {
    const bob = await createDev('bob');
    const bobTok = await mintDevToken(bob);
    await setBudget(bob, 5000);
    const t = await createTask(np, { max: 300 });
    await contribute(alice, t, 200);

    const bobLedger = await getJson('/devs/me/ledger', bobTok);
    expect(bobLedger.entries).toEqual([]);
    expect(bobLedger.next_before).toBeNull();
  });

  it('rejects a bad limit (400)', async () => {
    const res = await get('/devs/me/ledger?limit=0', aliceTok);
    expect(res.status).toBe(400);
  });
});

describe('GET /devs/me/stats', () => {
  it('aggregates donated spend, task counts, and nonprofits helped', async () => {
    const t1 = await createTask(np, { max: 500 });
    const t2 = await createTask(np, { max: 500 });
    await contribute(alice, t1, 380, true); // accepted
    await contribute(alice, t2, 420); // submitted, not accepted
    // A released task spends nothing and must not count as donated.
    const t3 = await createTask(np, { max: 500 });
    await checkoutTask(alice, t3);
    await releaseTask(alice, t3);

    const s = await getJson('/devs/me/stats', aliceTok);
    expect(s.total_donated_cents).toBe(380 + 420);
    expect(s.tasks_completed).toBe(2);
    expect(s.tasks_accepted).toBe(1);
    expect(s.nonprofits_helped).toBe(1);
    expect(s.first_contribution_at).toBeTruthy();
    expect(s.last_contribution_at).toBeTruthy();
    expect(s.by_month).toHaveLength(1);
    expect(s.by_month[0]).toMatchObject({ donated_cents: 800, tasks: 2 });
    expect(s.by_month[0].month).toMatch(/^\d{4}-\d{2}$/);
  });

  it('an overage-clamped submit counts the capped spend, not the reported cost', async () => {
    const t = await createTask(np, { max: 500 });
    await checkoutTask(alice, t);
    await submitResult(alice, t, { ok: true }, 900, null); // clamps to 500

    const s = await getJson('/devs/me/stats', aliceTok);
    expect(s.total_donated_cents).toBe(500);
  });

  it('keeps ledger-only aggregates when a row has no matching task (LEFT JOIN)', async () => {
    // Simulate an orphaned ledger row (task gone / task_id nulled). With an
    // INNER JOIN this submit would vanish from every aggregate; the LEFT JOIN
    // must preserve the counts/dates and only omit its donated contribution.
    const t = await createTask(np, { max: 500 });
    await contribute(alice, t, 380);
    await pool.query(`UPDATE ledger SET task_id = NULL WHERE dev_id = $1`, [alice]);

    const s = await getJson('/devs/me/stats', aliceTok);
    expect(s.nonprofits_helped).toBe(1); // the submit row survives the join
    expect(s.first_contribution_at).toBeTruthy();
    expect(s.last_contribution_at).toBeTruthy();
    expect(s.total_donated_cents).toBe(0); // no task → no max_cost → omitted, not crashed
    expect(s.by_month[0]).toMatchObject({ donated_cents: 0 });
  });

  it('zeroes out for a dev with no history', async () => {
    const bob = await createDev('bob');
    const bobTok = await mintDevToken(bob);
    const s = await getJson('/devs/me/stats', bobTok);
    expect(s).toMatchObject({
      total_donated_cents: 0,
      tasks_completed: 0,
      tasks_accepted: 0,
      nonprofits_helped: 0,
      first_contribution_at: null,
      last_contribution_at: null,
      by_month: [],
    });
  });
});
