import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closePool, pool } from '../src/db.js';
import { getFunnel, recordEvent } from '../src/funnel.js';
import { upsertDev } from '../src/oauth.js';
import { checkoutTask, mintOnboardingTask, setOwnBudget, submitResult } from '../src/operations.js';
import { app } from '../src/server.js';
import {
  createDev,
  createOnboardingTarget,
  createTarget,
  createTask,
  getFunnelEvents,
  mintAdminToken,
  mintDevToken,
  resetDb,
  setBudget,
} from './helpers.js';

afterAll(closePool);

// Funnel instrumentation. The question it exists to answer is "what fraction of
// the people who sign up ever submit anything?", which we could not answer at
// all before this.

const ghUser = (id: number, login: string) => ({
  id,
  login,
  email: `${login}@example.com`,
  createdAt: '2019-01-01T00:00:00Z',
  publicRepos: 3,
  followers: 1,
});

describe('funnel events', () => {
  beforeEach(async () => {
    await resetDb();
    await createOnboardingTarget(4);
  });

  it('records a signup exactly once, however many times the dev signs in', async () => {
    const { id, created } = await upsertDev(ghUser(1001, 'signer'));
    expect(created).toBe(true);
    const again = await upsertDev(ghUser(1001, 'signer'));
    expect(again.created).toBe(false);
    expect(again.id).toBe(id);

    const events = await getFunnelEvents(id);
    expect(events.filter((e) => e.event === 'dev_created')).toHaveLength(1);
  });

  it('records each stage of a full first run, in order', async () => {
    const dev = await createDev('full-run');
    await recordEvent(dev, 'dev_created', { via: 'test' });
    await setOwnBudget(dev, 500);
    const task = await mintOnboardingTask(dev);
    await checkoutTask(dev, task.task_id);
    await submitResult(dev, task.task_id, { counterexamples: [] }, 2, null);

    expect((await getFunnelEvents(dev)).map((e) => e.event)).toEqual([
      'dev_created',
      'budget_set',
      'onboarding_minted',
      'checkout',
      'submit',
    ]);
  });

  it('distinguishes a repeat contributor from a one-and-done', async () => {
    const target = await createTarget();
    const once = await createDev('once');
    const twice = await createDev('twice');
    for (const d of [once, twice]) {
      await recordEvent(d, 'dev_created');
      await setBudget(d, 5000);
    }

    const doOneTask = async (dev: string) => {
      const t = await createTask(target, { max: 100 });
      await checkoutTask(dev, t);
      await submitResult(dev, t, { ok: true }, 50, null);
    };
    await doOneTask(once);
    await doOneTask(twice);
    await doOneTask(twice);

    expect((await getFunnelEvents(once)).filter((e) => e.event === 'submit')).toHaveLength(1);
    expect((await getFunnelEvents(twice)).filter((e) => e.event === 'submit')).toHaveLength(2);

    const f = await getFunnel();
    expect(f.counts.submitted).toBe(2);
    expect(f.counts.submitted_again).toBe(1);
    expect(f.counts.one_and_done).toBe(1);
    expect(f.counts.submits_total).toBe(3);
  });

  it('carries enough detail to see what the event was about', async () => {
    const dev = await createDev('detailed');
    await setOwnBudget(dev, 750);
    const events = await getFunnelEvents(dev);
    expect(events[0]).toMatchObject({ event: 'budget_set', detail: { budget_cents: 750 } });
  });

  it('is append-only — a second budget change adds a row rather than replacing one', async () => {
    const dev = await createDev('append-only');
    await setOwnBudget(dev, 500);
    await setOwnBudget(dev, 900);
    const budgets = (await getFunnelEvents(dev)).filter((e) => e.event === 'budget_set');
    expect(budgets.map((b) => b.detail.budget_cents)).toEqual([500, 900]);
  });
});

describe('getFunnel report', () => {
  beforeEach(async () => {
    await resetDb();
    await createOnboardingTarget(4);
  });

  it('reports an empty funnel without dividing by zero', async () => {
    const f = await getFunnel();
    expect(f.counts.signed_up).toBe(0);
    expect(f.devs_total).toBe(0);
    expect(f.first_event_at).toBeNull();
    for (const s of f.stages) {
      expect(s.devs).toBe(0);
      // Undefined, not zero: there is no denominator to divide by.
      expect(s.conversion_from_previous).toBeNull();
      expect(s.conversion_from_signup).toBeNull();
    }
  });

  it('reports an undefined rate as null when the baseline predates the log', async () => {
    // The realistic case the moment this shipped: the devs already in the
    // database never emitted dev_created, so signed_up is 0 while every later
    // stage is non-zero. A 0 rate here would tell the reader that onboarding
    // converted nobody, when it in fact converted everybody it was given.
    const target = await createTarget();
    const dev = await createDev('predates-the-log');
    await setOwnBudget(dev, 5000);
    const t = await createTask(target, { max: 100 });
    await checkoutTask(dev, t);
    await submitResult(dev, t, { ok: true }, 50, null);

    const f = await getFunnel();
    expect(f.counts.signed_up).toBe(0);
    expect(f.counts.submitted).toBe(1);
    expect(f.devs_total).toBe(1);
    expect(f.untracked_devs).toBe(1); // the gap is reported, not hidden

    const byStage = Object.fromEntries(f.stages.map((s) => [s.stage, s]));
    expect(byStage.submitted.devs).toBe(1);
    expect(byStage.submitted.conversion_from_signup).toBeNull();
    expect(byStage.set_budget.conversion_from_previous).toBeNull(); // signed_up is 0
    // A stage whose predecessor DOES have devs still gets a real number.
    expect(byStage.submitted.conversion_from_previous).toBe(1);
  });

  it('computes the drop-off from signup to first submit', async () => {
    // Four signups: one submits, one checks out and stops, one sets a budget and
    // stops, one does nothing at all. The classic funnel shape.
    const devs = await Promise.all(
      ['finisher', 'quitter', 'browser', 'ghost'].map((h) => createDev(h)),
    );
    for (const d of devs) await recordEvent(d, 'dev_created');

    const target = await createTarget();
    for (const d of devs.slice(0, 3)) await setOwnBudget(d, 5000);

    const t1 = await createTask(target, { max: 100 });
    await checkoutTask(devs[0], t1);
    await submitResult(devs[0], t1, { ok: true }, 50, null);

    const t2 = await createTask(target, { max: 100 });
    await checkoutTask(devs[1], t2);

    const f = await getFunnel();
    expect(f.counts.signed_up).toBe(4);
    expect(f.counts.set_budget).toBe(3);
    expect(f.counts.checked_out).toBe(2);
    expect(f.counts.submitted).toBe(1);
    expect(f.devs_total).toBe(4);

    const byStage = Object.fromEntries(f.stages.map((s) => [s.stage, s]));
    expect(byStage.set_budget.conversion_from_previous).toBe(0.75); // 3 of 4
    expect(byStage.submitted.conversion_from_signup).toBe(0.25); // 1 of 4
    expect(byStage.submitted.conversion_from_previous).toBe(0.5); // 1 of 2 who checked out
    expect(f.first_event_at).not.toBeNull();
  });

  it('counts devs that predate the log separately from tracked signups', async () => {
    await createDev('legacy'); // exists, but never emitted dev_created
    const f = await getFunnel();
    expect(f.devs_total).toBe(1);
    expect(f.counts.signed_up).toBe(0);
  });

  it('counts a dev that minted an onboarding task', async () => {
    const dev = await createDev('onboarder');
    await recordEvent(dev, 'dev_created');
    await setBudget(dev, 500);
    await mintOnboardingTask(dev);
    await mintOnboardingTask(dev); // idempotent — must not double-count

    const f = await getFunnel();
    expect(f.counts.minted_onboarding).toBe(1);
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM funnel_events WHERE event = 'onboarding_minted'`,
    );
    expect(rows[0].n).toBe(1);
  });
});

describe('GET /admin/funnel', () => {
  function req(path: string, init?: RequestInit) {
    return app.fetch(new Request(`http://test${path}`, init));
  }

  beforeEach(async () => {
    await resetDb();
  });

  it('is admin-only — this is product analytics, not public transparency', async () => {
    expect((await req('/admin/funnel')).status).toBe(401);
    const dev = await createDev('nosy');
    const asDev = await req('/admin/funnel', {
      headers: { authorization: `Bearer ${await mintDevToken(dev)}` },
    });
    expect(asDev.status).toBe(403);
  });

  it('reports counts and conversion rates', async () => {
    const a = await createDev('a');
    const b = await createDev('b');
    await recordEvent(a, 'dev_created');
    await recordEvent(b, 'dev_created');
    await setOwnBudget(a, 500);

    const res = await req('/admin/funnel', {
      headers: { authorization: `Bearer ${await mintAdminToken()}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.counts.signed_up).toBe(2);
    expect(body.counts.set_budget).toBe(1);
    expect(body.stages.map((s: any) => s.stage)).toEqual([
      'signed_up',
      'set_budget',
      'minted_onboarding',
      'checked_out',
      'submitted',
      'submitted_again',
    ]);
    expect(body.stages[1].conversion_from_signup).toBe(0.5);
  });
});

describe('recordEvent resilience', () => {
  beforeEach(resetDb);

  it('swallows a write it cannot make instead of throwing', async () => {
    // No such dev — the foreign key rejects the row. The caller must not care.
    await expect(
      recordEvent('00000000-0000-0000-0000-000000000000', 'checkout'),
    ).resolves.toBeUndefined();
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM funnel_events`);
    expect(rows[0].n).toBe(0);
  });
});

// The funnel rides the money operation's own connection. It has to: on Workers
// every `query()` opens, connects and closes a fresh pg.Client, so a standalone
// analytics insert would double the connects on POST /checkout and POST /submit
// — the hot donation path, against a possibly-cold Neon compute. On Node,
// pool.connect() is called once per acquired connection (pool.query acquires one
// too), which makes the count directly observable.
describe('funnel writes cost no extra database connection', () => {
  beforeEach(resetDb);

  it('checkout and submit each take exactly one connection, event included', async () => {
    const dev = await createDev('one-connect');
    await setBudget(dev, 5000);
    const target = await createTarget();
    const task = await createTask(target, { max: 100 });

    const spy = vi.spyOn(pool, 'connect');
    try {
      await checkoutTask(dev, task);
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockClear();

      await submitResult(dev, task, { ok: true }, 50, null);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }

    // …and the events really were written, on that one connection.
    expect((await getFunnelEvents(dev)).map((e) => e.event)).toEqual(['checkout', 'submit']);
  });

  it('minting an onboarding task takes exactly one connection', async () => {
    await createOnboardingTarget(4);
    const dev = await createDev('one-connect-mint');
    await setBudget(dev, 5000);

    const spy = vi.spyOn(pool, 'connect');
    try {
      await mintOnboardingTask(dev);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
    expect((await getFunnelEvents(dev)).map((e) => e.event)).toEqual(['onboarding_minted']);
  });
});
