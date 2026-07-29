import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, pool } from '../src/db.js';
import { listOpenTasks } from '../src/operations.js';
import { app } from '../src/server.js';
import { createDev, createTarget, createTask, mintDevToken, resetDb } from './helpers.js';

// "Let volunteers choose which conjecture their agent works on": the open-task
// listing accepts a public target slug and returns only that conjecture's pool.
// The filter narrows SELECTION only — checkout and its budget gate are untouched
// — and it is strictly opt-in: no slug means the whole pool, the default posture.
//
// Design decision pinned here: an unknown slug is an EMPTY LIST, not a 404. This
// is a filter on a listing that the run loop polls repeatedly; "that conjecture
// has nothing open" and "that conjecture just got resolved and delisted" must
// both read as an empty pool, not as an error that kills a --watch loop. The
// fail-fast UX for a typo lives in the CLI, which resolves the slug against the
// public /conjectures/:slug (a real resource, which does 404) before looping.

afterAll(closePool);

/** A curated (slugged) conjecture — the only kind addressable by --target. */
async function createConjecture(name: string, slug: string): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO targets (name, kind, slug, statement_plain)
     VALUES ($1, 'conjecture', $2, 'statement') RETURNING id`,
    [name, slug],
  );
  return rows[0].id;
}

let twinPrimes: string;
let collatz: string;
let twinTask: string;
let collatzTask: string;

beforeEach(async () => {
  await resetDb();
  twinPrimes = await createConjecture('Twin primes', 'twin-primes');
  collatz = await createConjecture('Collatz', 'collatz');
  // The Collatz task is older AND cheaper — without the filter it would win
  // the oldest-first ordering, which is exactly what the filter must override.
  collatzTask = await createTask(collatz, { max: 10, title: 'Collatz sweep' });
  twinTask = await createTask(twinPrimes, { max: 50, title: 'Twin prime gap hunt' });
});

describe('listOpenTasks({ targetSlug })', () => {
  it('returns only the named conjecture’s open tasks', async () => {
    const rows = await listOpenTasks({ targetSlug: 'twin-primes' });
    expect(rows.map((r) => r.id)).toEqual([twinTask]);
  });

  it('returns the whole pool when no slug is given — the default posture', async () => {
    const rows = await listOpenTasks({});
    expect(rows.map((r) => r.id).sort()).toEqual([collatzTask, twinTask].sort());
  });

  it('treats an unknown slug as an empty pool, not an error', async () => {
    await expect(listOpenTasks({ targetSlug: 'no-such-conjecture' })).resolves.toEqual([]);
  });

  it('cannot address a non-slugged target at all', async () => {
    // org_request-style targets have no slug; their tasks stay reachable only
    // through the general pool, never through --target.
    const org = await createTarget('Unslugged org');
    await createTask(org, { max: 5, title: 'Org task' });
    for (const slug of ['Unslugged org', 'unslugged-org', '']) {
      expect(await listOpenTasks({ targetSlug: slug })).toEqual([]);
    }
  });

  it('composes with the affordability filter instead of replacing it', async () => {
    const pricey = await createTask(twinPrimes, { max: 900, title: 'Expensive attack' });
    const rows = await listOpenTasks({ targetSlug: 'twin-primes', maxCostCents: 100 });
    expect(rows.map((r) => r.id)).toEqual([twinTask]);
    expect(rows.map((r) => r.id)).not.toContain(pricey);
  });
});

describe('GET /tasks/open?target=<slug>', () => {
  const req = (path: string, token: string) =>
    app.fetch(new Request(`http://test${path}`, { headers: { authorization: `Bearer ${token}` } }));

  it('filters the claimable feed by slug for the runner', async () => {
    const dev = await createDev('picky');
    const token = await mintDevToken(dev);
    const res = await req('/tasks/open?target=twin-primes', token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any[];
    expect(body.map((t) => t.id)).toEqual([twinTask]);
  });

  it('answers an unknown slug with 200 and an empty list', async () => {
    const dev = await createDev('typo');
    const token = await mintDevToken(dev);
    const res = await req('/tasks/open?target=riemann-hypothesys', token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});
