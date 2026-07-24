import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../src/db.js';
import { checkoutTask, submitResult } from '../src/operations.js';
import { app } from '../src/server.js';
import { createDev, createTask, mintAdminToken, resetDb, setBudget } from './helpers.js';

// Phase 7 public surface: open problem submission (no allowlist/DMARC vetting)
// and the public leaderboard.

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

describe('POST /submissions (public)', () => {
  it('accepts an open-problem submission from anyone and returns a public-safe payload', async () => {
    const res = await req('/submissions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        from_email: 'mathematician@university.edu',
        subject: 'A conjecture about perfect numbers',
        body: 'Are there infinitely many even perfect numbers? Please investigate computationally.',
      }),
    });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.submission_id).toBeTruthy();
    expect(body.status).toBe('received');
    // Public-safe: no proposed tasks, costs, or models leaked.
    expect(body.proposed).toBeUndefined();
    expect(JSON.stringify(body)).not.toMatch(/cost|model|sensitivity/i);

    // The submitter can follow it via the existing public status page.
    const status = await req(body.status_url);
    expect(status.status).toBe(200);
    expect(((await status.json()) as any).stage).toBe('received');
  });

  it('rejects a bad email or too-short body', async () => {
    const badEmail = await req('/submissions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from_email: 'not-an-email', body: 'a'.repeat(50) }),
    });
    expect(badEmail.status).toBe(400);

    const shortBody = await req('/submissions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from_email: 'x@y.org', body: 'too short' }),
    });
    expect(shortBody.status).toBe(400);
  });
});

describe('GET /leaderboard (public)', () => {
  it('lists curated conjectures with progress and top contributors', async () => {
    // Seed a curated conjecture via the admin API.
    const create = await req('/admin/targets', {
      method: 'POST',
      headers: bearer(adminTok),
      body: JSON.stringify({ name: 'Collatz', slug: 'collatz', kind: 'conjecture' }),
    });
    const conj: any = await create.json();

    // A provisional (no-slug) target must NOT appear — only curated ones.
    await req('/admin/targets', {
      method: 'POST',
      headers: bearer(adminTok),
      body: JSON.stringify({ name: 'Unreviewed idea', kind: 'conjecture' }), // no slug
    });

    // One contribution of donated compute toward the curated conjecture.
    const task = await createTask(conj.id, { max: 500 });
    const dev = await createDev('ada');
    await setBudget(dev, 2000);
    await checkoutTask(dev, task);
    await submitResult(dev, task, { step: 1 }, 250, null, {
      outcome: 'progress',
      summary: 'did a bit',
    });

    const res = await req('/leaderboard');
    expect(res.status).toBe(200);
    const lb: any = await res.json();

    expect(lb.totals.conjectures).toBe(1); // the slugged one only
    expect(lb.totals.open).toBe(1);
    expect(lb.totals.compute_cents).toBe(250);
    expect(lb.conjectures).toHaveLength(1);
    expect(lb.conjectures[0]).toMatchObject({
      slug: 'collatz',
      contributions: 1,
      contributors: 1,
      compute_cents: 250,
    });
    expect(lb.contributors[0]).toMatchObject({ github_handle: 'ada', donated_cents: 250 });
  });

  it('is unauthenticated and empty on a fresh system', async () => {
    const res = await req('/leaderboard');
    expect(res.status).toBe(200);
    const lb: any = await res.json();
    expect(lb.conjectures).toEqual([]);
    expect(lb.totals.conjectures).toBe(0);
  });
});
