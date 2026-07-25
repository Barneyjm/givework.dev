import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../src/db.js';
import { checkoutTask, submitResult } from '../src/operations.js';
import { app } from '../src/server.js';
import { createDev, createTask, mintAdminToken, resetDb, setBudget } from './helpers.js';

// The public per-conjecture progress page: admins seed conjectures with a slug,
// and anyone can read their progress at /conjectures/:slug (no auth, no PII).

afterAll(closePool);

let adminTok: string;
beforeEach(async () => {
  await resetDb();
  adminTok = await mintAdminToken();
});

const bearer = (t: string) => ({
  authorization: `Bearer ${t}`,
  'content-type': 'application/json',
});
const req = (path: string, init?: RequestInit) =>
  app.fetch(new Request(`http://test${path}`, init));
const createTargetVia = (fields: Record<string, unknown>) =>
  req('/admin/targets', {
    method: 'POST',
    headers: bearer(adminTok),
    body: JSON.stringify(fields),
  });

describe('conjecture progress page', () => {
  it('seeds a conjecture with a slug and serves its public progress', async () => {
    const create = await createTargetVia({
      name: 'Collatz conjecture',
      slug: 'Collatz', // mixed case -> slugified
      kind: 'conjecture',
      statement_plain: 'Every positive integer reaches 1 under the 3n+1 map.',
      source_ref: 'OEIS A006577',
    });
    expect(create.status).toBe(200);
    const conj: any = await create.json();
    expect(conj.slug).toBe('collatz');
    expect(conj.kind).toBe('conjecture');

    // Do a little work: one task, one progress contribution that updates state.
    const task = await createTask(conj.id, { max: 500 });
    const dev = await createDev('worker');
    await setBudget(dev, 2000);
    await checkoutTask(dev, task);
    await submitResult(dev, task, { checked: true }, 300, null, {
      outcome: 'progress',
      summary: 'verified n up to 10^6, no counterexample',
      stateUpdate: { verified_up_to: 1000000 },
    });

    const res = await req('/conjectures/collatz');
    expect(res.status).toBe(200);
    const p: any = await res.json();
    expect(p.name).toBe('Collatz conjecture');
    expect(p.statement_plain).toContain('3n+1');
    expect(p.source_ref).toBe('OEIS A006577');
    expect(p.state).toEqual({ verified_up_to: 1000000 });
    expect(p.metrics.tasks_total).toBe(1);
    expect(p.metrics.tasks_open).toBe(1); // returned to the pool after the progress contribution
    expect(p.metrics.contributions).toBe(1);
    expect(p.metrics.contributors).toBe(1);
    expect(p.metrics.compute_cents).toBe(300);
    expect(p.metrics.last_activity_at).not.toBeNull();
    expect(p.recent_contributions[0]).toMatchObject({
      outcome: 'progress',
      summary: 'verified n up to 10^6, no counterexample',
    });
  });

  it('404s for an unknown slug', async () => {
    const res = await req('/conjectures/does-not-exist');
    expect(res.status).toBe(404);
  });

  it('does not expose org_request targets on the public page', async () => {
    const create = await createTargetVia({
      name: 'Private Org Work',
      slug: 'private-org',
      kind: 'org_request',
      contact_email: 'ops@org.example',
    });
    expect(create.status).toBe(200);
    const res = await req('/conjectures/private-org');
    expect(res.status).toBe(404); // org work is never public, even by slug
  });

  it('rejects a duplicate slug with a 409', async () => {
    expect((await createTargetVia({ name: 'A', slug: 'dup' })).status).toBe(200);
    expect((await createTargetVia({ name: 'B', slug: 'dup' })).status).toBe(409);
  });

  it('requires an admin token to seed a conjecture', async () => {
    const res = await req('/admin/targets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'X', slug: 'x' }),
    });
    expect(res.status).toBe(401);
  });
});

describe('contributor attribution + profile', () => {
  it('attributes contributions to the handle and serves a shareable profile', async () => {
    const create = await createTargetVia({
      name: 'Goldbach',
      slug: 'goldbach',
      kind: 'conjecture',
    });
    const targetId = ((await create.json()) as { id: string }).id;
    const task = await createTask(targetId, { max: 500 });
    const dev = await createDev('ada');
    await setBudget(dev, 2000);
    await checkoutTask(dev, task);
    await submitResult(dev, task, null, 120, null, {
      outcome: 'progress',
      summary: 'verified evens up to 1e6',
    });

    // the conjecture feed now carries the contributor handle
    const prog = (await (await req('/conjectures/goldbach')).json()) as {
      recent_contributions: { contributor: string | null }[];
    };
    expect(prog.recent_contributions[0].contributor).toBe('ada');

    // and the contributor has a public profile at /contributors/:handle
    const profile = (await (await req('/contributors/ada')).json()) as {
      github_handle: string;
      totals: { contributions: number; conjectures: number };
      contributions: { conjecture_slug: string }[];
    };
    expect(profile.github_handle).toBe('ada');
    expect(profile.totals.contributions).toBe(1);
    expect(profile.totals.conjectures).toBe(1);
    expect(profile.contributions[0].conjecture_slug).toBe('goldbach');

    // GitHub handles are case-insensitive: a differently-cased link resolves to
    // the same profile and echoes back the canonical stored casing.
    const ci = await req('/contributors/ADA');
    expect(ci.status).toBe(200);
    expect(((await ci.json()) as { github_handle: string }).github_handle).toBe('ada');

    // unknown handle -> 404
    expect((await req('/contributors/nobody')).status).toBe(404);
    // malformed handle -> 404
    expect((await req('/contributors/has spaces')).status).toBe(404);
  });
});

describe('work-unit provenance on the feed', () => {
  it('cites the exact pinned code that produced a contribution, and leaks nothing else', async () => {
    const create = await createTargetVia({
      name: 'Euler sum of powers',
      slug: 'euler-demo',
      kind: 'conjecture',
    });
    const targetId = ((await create.json()) as { id: string }).id;
    const task = await createTask(targetId, { max: 500 });
    const dev = await createDev('ada');
    await setBudget(dev, 2000);
    await checkoutTask(dev, task);
    await submitResult(
      dev,
      task,
      { found: false },
      0,
      {
        workunit: true,
        repo: 'Barneyjm/givework-contrib',
        sha: 'b22346012688b6c70057717549bd905f8083e119',
        entrypoint: 'euler-sum-of-powers/counterexample-search/euler_search.py',
        duration_ms: 910,
      },
      { outcome: 'progress', summary: 'searched a window' },
    );

    const prog = (await (await req('/conjectures/euler-demo')).json()) as {
      recent_contributions: Record<string, unknown>[];
    };
    const c = prog.recent_contributions[0];
    expect(c.code).toEqual({
      repo: 'Barneyjm/givework-contrib',
      sha: 'b22346012688b6c70057717549bd905f8083e119',
      entrypoint: 'euler-sum-of-powers/counterexample-search/euler_search.py',
    });
    // the raw usage blob itself (token counts etc.) is never exposed
    expect(c.raw_usage).toBeUndefined();
    expect(Object.keys(c).sort()).toEqual(
      ['code', 'contributor', 'created_at', 'outcome', 'summary', 'verdict', 'verified_via'].sort(),
    );
  });

  it('reports null code for a contribution that did not run pinned code', async () => {
    const create = await createTargetVia({ name: 'Plain', slug: 'plain', kind: 'conjecture' });
    const targetId = ((await create.json()) as { id: string }).id;
    const task = await createTask(targetId, { max: 500 });
    const dev = await createDev('bob');
    await setBudget(dev, 2000);
    await checkoutTask(dev, task);
    await submitResult(dev, task, null, 120, null, {
      outcome: 'progress',
      summary: 'thought about it',
    });
    const prog = (await (await req('/conjectures/plain')).json()) as {
      recent_contributions: { code: unknown }[];
    };
    expect(prog.recent_contributions[0].code).toBeNull();
  });
});
