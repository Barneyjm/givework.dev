import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../src/db.js';
import { checkoutTask, submitResult } from '../src/operations.js';
import { app } from '../src/server.js';
import { recordHumanReview, submitAndVerify } from '../src/verify.js';
import {
  createDev,
  createTask,
  mintAdminToken,
  resetDb,
  setBudget,
  setVerified,
} from './helpers.js';

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
      status: 'logged', // a handoff note, not a claim awaiting verification
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

describe('paging the contribution feed', () => {
  // The progress payload carries only the newest 10. A conjecture with 39
  // contributions (firstproof-c4's real shape) must be able to show the rest.
  async function seedContributions(n: number) {
    const create = await createTargetVia({ name: 'Paged', slug: 'paged', kind: 'conjecture' });
    const conj: any = await create.json();
    const dev = await createDev('pager');
    await setBudget(dev, 100_000);
    for (let i = 0; i < n; i++) {
      const task = await createTask(conj.id, { max: 500 });
      await checkoutTask(dev, task);
      await submitResult(dev, task, { i }, 1, null, {
        outcome: 'progress',
        summary: `contribution ${i}`,
      });
    }
    return conj;
  }

  it('embeds the newest 10 and pages the remainder, newest first, without gaps or repeats', async () => {
    await seedContributions(23);

    const p: any = await (await req('/conjectures/paged')).json();
    expect(p.recent_contributions).toHaveLength(10);
    expect(p.metrics.contributions).toBe(23);
    expect(p.recent_contributions[0].summary).toBe('contribution 22'); // newest first

    const seen: string[] = p.recent_contributions.map((r: any) => r.summary);
    let offset = 10;
    for (;;) {
      const page: any = await (
        await req(`/conjectures/paged/contributions?limit=10&offset=${offset}`)
      ).json();
      expect(page.total).toBe(23);
      seen.push(...page.contributions.map((r: any) => r.summary));
      if (!page.has_more) break;
      offset += page.contributions.length;
    }
    // Every contribution exactly once, in strict newest-first order.
    expect(seen).toHaveLength(23);
    expect(new Set(seen).size).toBe(23);
    expect(seen).toEqual(Array.from({ length: 23 }, (_, i) => `contribution ${22 - i}`));
  });

  it('serves a paged row identically to the embedded one', async () => {
    await seedContributions(11);
    const p: any = await (await req('/conjectures/paged')).json();
    const page: any = await (
      await req('/conjectures/paged/contributions?limit=10&offset=0')
    ).json();
    // Same shape and same values — "load more" must not render differently.
    expect(page.contributions.slice(0, 10)).toEqual(p.recent_contributions);
  });

  it('clamps junk paging input instead of erroring or dumping the table', async () => {
    await seedContributions(3);
    const bad: any = await (
      await req('/conjectures/paged/contributions?limit=abc&offset=-5')
    ).json();
    expect(bad.contributions).toHaveLength(3); // default page, offset floored to 0
    expect(bad.has_more).toBe(false);

    const huge: any = await (await req('/conjectures/paged/contributions?limit=99999')).json();
    expect(huge.contributions).toHaveLength(3); // capped, and only 3 exist

    const past: any = await (await req('/conjectures/paged/contributions?offset=999')).json();
    expect(past.contributions).toEqual([]);
    expect(past.total).toBe(3);
    expect(past.has_more).toBe(false);
  });

  it('404s for an unknown slug, like the progress payload it extends', async () => {
    const res = await req('/conjectures/no-such-thing/contributions');
    expect(res.status).toBe(404);
  });

  it('does not page a non-public target kind', async () => {
    const create = await createTargetVia({ name: 'Org', slug: 'org-x', kind: 'org_request' });
    expect(create.status).toBe(200);
    const res = await req('/conjectures/org-x/contributions');
    expect(res.status).toBe(404);
  });
});

describe('decomposition tree', () => {
  it('reports each task’s parent and the split that produced it, roots first', async () => {
    const create = await createTargetVia({ name: 'Tree', slug: 'tree', kind: 'conjecture' });
    const conj: any = await create.json();
    const dev = await createDev('splitter');
    await setBudget(dev, 100_000);

    // An impetus task, split by a proposal that a peer approves.
    const root = await createTask(conj.id, { max: 800 });
    await checkoutTask(dev, root);
    const sub: any = await submitResult(
      dev,
      root,
      {
        decomposition: {
          subtasks: [
            { title: 'Half one', prompt: 'do the first half', max_cost_cents: 400 },
            { title: 'Half two', prompt: 'do the second half', max_cost_cents: 400 },
          ],
        },
      },
      20,
      null,
      { outcome: 'decomposition', summary: 'too big for one run — splitting into two' },
    );
    // Approve the split via the auto-minted review task, which is what
    // publishes the children.
    expect(sub.review_task_id).toBeDefined();
    const reviewer = await createDev('approver');
    await setBudget(reviewer, 100_000);
    await checkoutTask(reviewer, sub.review_task_id);
    await submitResult(reviewer, sub.review_task_id, { approve: true }, 5, null);

    const res = await req('/conjectures/tree/tree');
    expect(res.status).toBe(200);
    const t: any = await res.json();
    const byTitle: any = Object.fromEntries(t.nodes.map((n: any) => [n.title, n]));
    const children = t.nodes.filter((n: any) => n.parent_id === root);
    expect(children).toHaveLength(2);
    expect(children.map((c: any) => c.title).sort()).toEqual(['Half one', 'Half two']);
    // The edge names who proposed the split — the "why this task exists".
    expect(byTitle['Half one'].via).toMatchObject({ proposed_by: 'splitter' });
    // The impetus task is a root, and carries the decomposition contribution.
    const rootNode = t.nodes.find((n: any) => n.id === root);
    expect(rootNode.parent_id).toBeNull();
    expect(rootNode.via).toBeNull();
    expect(rootNode.contributions).toBeGreaterThan(0);
    // Roots sort before their children (ordered by decomposition depth).
    expect(t.nodes.findIndex((n: any) => n.id === root)).toBeLessThan(
      t.nodes.findIndex((n: any) => n.title === 'Half one'),
    );
  });

  it('keeps peer-review tasks out of the tree, and says how many it dropped', async () => {
    const create = await createTargetVia({ name: 'Tree2', slug: 'tree2', kind: 'conjecture' });
    const conj: any = await create.json();
    const dev = await createDev('splitter2');
    await setBudget(dev, 100_000);
    const root = await createTask(conj.id, { max: 800 });
    await checkoutTask(dev, root);
    await submitResult(
      dev,
      root,
      { decomposition: { subtasks: [{ title: 'Piece', prompt: 'p', max_cost_cents: 400 }] } },
      20,
      null,
      { outcome: 'decomposition', summary: 'split' },
    );
    const t: any = await (await req('/conjectures/tree2/tree')).json();
    // A review task exists, but it has no decomposed_from and would otherwise
    // render as a second impetus task nobody proposed.
    expect(t.review_excluded).toBe(1);
    expect(t.nodes.every((n: any) => !/^Review /.test(n.title))).toBe(true);
  });

  it('404s for an unknown slug and for a non-public kind', async () => {
    expect((await req('/conjectures/nope/tree')).status).toBe(404);
    await createTargetVia({ name: 'Org', slug: 'org-t', kind: 'org_request' });
    expect((await req('/conjectures/org-t/tree')).status).toBe(404);
  });

  it('returns an empty forest for a conjecture with no tasks', async () => {
    await createTargetVia({ name: 'Bare', slug: 'bare', kind: 'conjecture' });
    const t: any = await (await req('/conjectures/bare/tree')).json();
    expect(t.nodes).toEqual([]);
    expect(t.review_excluded).toBe(0);
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

describe('per-contribution status on the public surfaces', () => {
  it('feed and profile say honestly whether a candidate is pending, verified, or rejected', async () => {
    const create = await createTargetVia({
      name: 'Status conjecture',
      slug: 'status-conj',
      kind: 'conjecture',
    });
    const targetId = ((await create.json()) as { id: string }).id;
    const dev = await createDev('vera');
    await setVerified(dev); // even a trusted dev's candidate must read as pending
    await setBudget(dev, 5000);

    // Pending: the incident scenario — a verified dev's candidate_solution on a
    // research target goes through the real submit rail and is NOT accepted.
    const pending = await createTask(targetId, { max: 500 });
    await checkoutTask(dev, pending);
    await submitAndVerify(dev, pending, { claim: 'X' }, 100, null, { summary: 'pending claim' });

    // Verified: an admin reviews and passes a second candidate.
    const passed = await createTask(targetId, { max: 500 });
    await checkoutTask(dev, passed);
    await submitResult(dev, passed, { claim: 'Y' }, 100, null, { summary: 'confirmed claim' });
    await recordHumanReview(passed, 'passed', 'admin');

    // Rejected: an admin reviews and fails a third.
    const failed = await createTask(targetId, { max: 500 });
    await checkoutTask(dev, failed);
    await submitResult(dev, failed, { claim: 'Z' }, 100, null, { summary: 'bogus claim' });
    await recordHumanReview(failed, 'failed', 'admin');

    type Row = {
      summary: string;
      status: string;
      verdict: string | null;
      verified_via: string | null;
    };
    const expectStatuses = (rows: Row[]) => {
      const by = Object.fromEntries(rows.map((r) => [r.summary, r]));
      expect(by['pending claim']).toMatchObject({
        status: 'awaiting_verification',
        verdict: null,
      });
      expect(by['confirmed claim']).toMatchObject({
        status: 'verified',
        verdict: 'passed',
        verified_via: 'human_review',
      });
      expect(by['bogus claim']).toMatchObject({ status: 'rejected', verdict: 'failed' });
    };

    const prog = (await (await req('/conjectures/status-conj')).json()) as {
      recent_contributions: Row[];
    };
    expectStatuses(prog.recent_contributions);

    const profile = (await (await req('/contributors/vera')).json()) as { contributions: Row[] };
    expectStatuses(profile.contributions);
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
      [
        'code',
        'contributor',
        'created_at',
        'outcome',
        'status',
        'summary',
        'verdict',
        'verified_via',
      ].sort(),
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
