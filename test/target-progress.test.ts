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
