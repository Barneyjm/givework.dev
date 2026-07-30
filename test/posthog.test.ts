import { Hono } from 'hono';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/app.js';
import { closePool } from '../src/db.js';
import { captureFunnelEvent, capturePosthog, hashDevId } from '../src/posthog.js';
import {
  createDev,
  createOnboardingTarget,
  createTarget,
  createTask,
  mintDevToken,
  resetDb,
  setBudget,
} from './helpers.js';

afterAll(closePool);

// The bindings under test. Never a real host — nothing here may touch the network.
const ENV = {
  POSTHOG_PROJECT_TOKEN: 'phc_test_token',
  POSTHOG_API_HOST: 'https://ph.invalid',
};

/** A fetch stub that records calls and answers 200 OK. */
function okFetch() {
  return vi.fn(
    async (..._args: Parameters<typeof fetch>) => new Response('{"status":1}', { status: 200 }),
  );
}

/** The JSON body of the nth call to a fetch stub. */
function sentBody(fetchStub: ReturnType<typeof vi.fn>, n = 0) {
  return JSON.parse((fetchStub.mock.calls[n]![1] as RequestInit).body as string);
}

// capturePosthog reads process.env as a fallback; make sure ambient variables
// (a developer's .env) can never leak into — or satisfy — these tests.
const SAVED: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ['POSTHOG_PROJECT_TOKEN', 'POSTHOG_API_HOST']) {
    SAVED[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.unstubAllGlobals();
});

describe('hashDevId', () => {
  it('is the first 16 hex chars of SHA-256, never the raw id', async () => {
    // Known vector: SHA-256("abc") = ba7816bf8f01cfea414140de5dae2223...
    expect(await hashDevId('abc')).toBe('ba7816bf8f01cfea');
    const id = 'e7b2a1c4-1111-2222-3333-444455556666';
    const h = await hashDevId(id);
    expect(h).toMatch(/^[0-9a-f]{16}$/);
    expect(h).not.toContain(id);
    expect(id).not.toContain(h);
    expect(await hashDevId(id)).toBe(h); // stable
    expect(await hashDevId('other')).not.toBe(h); // distinct
  });
});

describe('capturePosthog', () => {
  it('hard no-ops when either binding is missing', async () => {
    const f = okFetch();
    await capturePosthog({}, 'checkout', 'abcd', {}, f);
    await capturePosthog(undefined, 'checkout', 'abcd', {}, f);
    await capturePosthog({ POSTHOG_PROJECT_TOKEN: 'phc_x' }, 'checkout', 'abcd', {}, f);
    await capturePosthog({ POSTHOG_API_HOST: 'https://ph.invalid' }, 'checkout', 'abcd', {}, f);
    expect(f).not.toHaveBeenCalled();
  });

  it('POSTs the PostHog capture shape to $HOST/capture/', async () => {
    const f = okFetch();
    const before = Date.now();
    await capturePosthog(ENV, 'checkout', 'deadbeef00112233', { target_slug: 'goldbach' }, f);
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('https://ph.invalid/capture/');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(init.signal).toBeInstanceOf(AbortSignal); // the ~3s timeout
    const body = sentBody(f);
    expect(body).toEqual({
      api_key: 'phc_test_token',
      event: 'checkout',
      distinct_id: 'deadbeef00112233',
      properties: { target_slug: 'goldbach' },
      timestamp: expect.any(String),
    });
    const ts = Date.parse(body.timestamp);
    expect(ts).toBeGreaterThanOrEqual(before - 1000);
    expect(ts).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('tolerates a trailing slash on the host binding', async () => {
    const f = okFetch();
    await capturePosthog({ ...ENV, POSTHOG_API_HOST: 'https://ph.invalid/' }, 'e', 'd', {}, f);
    expect(f.mock.calls[0]![0]).toBe('https://ph.invalid/capture/');
  });

  it('never throws: network failure and non-2xx both resolve quietly', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const failing = vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      });
      await expect(capturePosthog(ENV, 'submit', 'd', {}, failing)).resolves.toBeUndefined();
      const rejected = vi.fn(async () => new Response('nope', { status: 503 }));
      await expect(capturePosthog(ENV, 'submit', 'd', {}, rejected)).resolves.toBeUndefined();
    } finally {
      err.mockRestore();
    }
  });
});

describe('captureFunnelEvent', () => {
  it('no-ops without bindings — not even the hash is computed', () => {
    const f = okFetch();
    const waitUntil = vi.fn();
    captureFunnelEvent({ env: {}, executionCtx: { waitUntil } }, 'checkout', 'dev-1', {}, f);
    expect(waitUntil).not.toHaveBeenCalled();
    expect(f).not.toHaveBeenCalled();
  });

  it('hands the capture to executionCtx.waitUntil (Worker path) with a hashed distinct_id', async () => {
    const f = okFetch();
    const handed: Promise<unknown>[] = [];
    const ctx = { env: ENV, executionCtx: { waitUntil: (p: Promise<unknown>) => handed.push(p) } };
    captureFunnelEvent(ctx, 'release', 'dev-uuid-1', { task_kind: 'exploration' }, f);
    expect(handed).toHaveLength(1);
    await handed[0];
    const body = sentBody(f);
    expect(body.event).toBe('release');
    expect(body.distinct_id).toBe(await hashDevId('dev-uuid-1'));
    expect(body.distinct_id).not.toContain('dev-uuid-1');
    expect(body.properties).toEqual({ task_kind: 'exploration' });
  });

  it('a hung PostHog endpoint cannot delay the handler response', async () => {
    // fetch that never settles until we say so — PostHog "hanging".
    let unblock!: () => void;
    const gate = new Promise<Response>((resolve) => {
      unblock = () => resolve(new Response('ok'));
    });
    const hanging = vi.fn(() => gate);
    const mini = new Hono();
    mini.post('/checkout', (c) => {
      captureFunnelEvent(c, 'checkout', 'dev-1', { target_slug: 'goldbach' }, hanging as any);
      return c.json({ ok: true });
    });
    const res = await mini.request('/checkout', { method: 'POST' }, ENV);
    // The response completed while the capture is still in flight…
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // …and the capture really did start (async hash first), yet is still hung.
    await vi.waitFor(() => expect(hanging).toHaveBeenCalledTimes(1));
    unblock(); // let the floating promise finish so nothing leaks across tests
    await gate;
  });

  it('a failing PostHog endpoint cannot fail the handler', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const failing = vi.fn(async () => {
        throw new Error('posthog is down');
      });
      const mini = new Hono();
      mini.post('/submit', (c) => {
        captureFunnelEvent(c, 'submit', 'dev-1', {}, failing as any);
        return c.json({ ok: true });
      });
      const res = await mini.request('/submit', { method: 'POST' }, ENV);
      expect(res.status).toBe(200);
      await vi.waitFor(() => expect(failing).toHaveBeenCalled());
    } finally {
      err.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Through the real app: the funnel stages forward with the right event names
// and properties, and an unconfigured control plane sends nothing at all.
// ---------------------------------------------------------------------------
describe('funnel forwarding through the HTTP handlers', () => {
  const bearer = (t: string) => ({
    authorization: `Bearer ${t}`,
    'content-type': 'application/json',
  });

  let dev: string;
  let devTok: string;
  let taskId: string;

  beforeEach(async () => {
    await resetDb();
    const target = await createTarget('Analytics NP');
    await poolSetSlug(target, 'analytics-np');
    dev = await createDev('phdev');
    devTok = await mintDevToken(dev);
    await setBudget(dev, 2000);
    taskId = await createTask(target, { max: 500 });
  });

  /** Give a target the slug the assertions look for. */
  async function poolSetSlug(targetId: string, slug: string) {
    const { pool } = await import('../src/db.js');
    await pool.query(`UPDATE targets SET slug = $2 WHERE id = $1`, [targetId, slug]);
  }

  /** Stub global fetch (what the handlers' capture path uses) and return the spy. */
  function stubFetch() {
    const f = okFetch();
    vi.stubGlobal('fetch', f);
    return f;
  }

  /** The forwarded event, once the floating (Node-path) capture promise lands. */
  async function forwarded(f: ReturnType<typeof vi.fn>, n = 0) {
    await vi.waitFor(() => expect(f.mock.calls.length).toBeGreaterThan(n));
    return sentBody(f, n);
  }

  it('POST /checkout forwards a checkout event with slug/kind/cents and a hashed dev id', async () => {
    const f = stubFetch();
    const res = await app.request(
      '/checkout',
      { method: 'POST', headers: bearer(devTok), body: JSON.stringify({ task_id: taskId }) },
      ENV,
    );
    expect(res.status).toBe(200);
    const body = await forwarded(f);
    expect(body.event).toBe('checkout');
    expect(body.distinct_id).toBe(await hashDevId(dev));
    expect(body.properties).toEqual({
      target_slug: 'analytics-np',
      task_kind: 'exploration',
      max_cost_cents: 500,
    });
  });

  it('POST /submit forwards outcome + booked cents (and nothing content-shaped)', async () => {
    let f = stubFetch();
    await app.request(
      '/checkout',
      { method: 'POST', headers: bearer(devTok), body: JSON.stringify({ task_id: taskId }) },
      ENV,
    );
    await forwarded(f); // drain the checkout event
    f = stubFetch();
    const res = await app.request(
      '/submit',
      {
        method: 'POST',
        headers: bearer(devTok),
        body: JSON.stringify({
          task_id: taskId,
          actual_cost_cents: 321,
          outcome: 'progress',
          result: { secret: 'never forwarded' },
          summary: 'never forwarded either',
        }),
      },
      ENV,
    );
    expect(res.status).toBe(200);
    const body = await forwarded(f);
    expect(body.event).toBe('submit');
    expect(body.distinct_id).toBe(await hashDevId(dev));
    expect(body.properties).toEqual({
      target_slug: 'analytics-np',
      task_kind: 'exploration',
      outcome: 'progress',
      status: 'open',
      spent_cents: 321,
    });
    // The submitted content never leaves the control plane.
    expect(JSON.stringify(body)).not.toContain('never forwarded');
  });

  it('POST /release forwards a release event', async () => {
    let f = stubFetch();
    await app.request(
      '/checkout',
      { method: 'POST', headers: bearer(devTok), body: JSON.stringify({ task_id: taskId }) },
      ENV,
    );
    await forwarded(f);
    f = stubFetch();
    const res = await app.request(
      '/release',
      { method: 'POST', headers: bearer(devTok), body: JSON.stringify({ task_id: taskId }) },
      ENV,
    );
    expect(res.status).toBe(200);
    const body = await forwarded(f);
    expect(body.event).toBe('release');
    expect(body.properties).toEqual({
      target_slug: 'analytics-np',
      task_kind: 'exploration',
      reserved_released_cents: 500,
    });
  });

  it('POST /devs/budget and /devs/onboarding forward budget_set / onboarding_minted', async () => {
    await createOnboardingTarget();
    let f = stubFetch();
    const budgetRes = await app.request(
      '/devs/budget',
      { method: 'POST', headers: bearer(devTok), body: JSON.stringify({ budget_cents: 2500 }) },
      ENV,
    );
    expect(budgetRes.status).toBe(200);
    const budgetEvt = await forwarded(f);
    expect(budgetEvt.event).toBe('budget_set');
    expect(budgetEvt.properties).toEqual({ budget_cents: 2500 });

    f = stubFetch();
    const mintRes = await app.request(
      '/devs/onboarding',
      { method: 'POST', headers: bearer(devTok) },
      ENV,
    );
    expect(mintRes.status).toBe(200);
    const mintEvt = await forwarded(f);
    expect(mintEvt.event).toBe('onboarding_minted');
    expect(mintEvt.properties).toMatchObject({
      target_slug: 'goldbach',
      task_kind: 'computational',
    });

    // Idempotent re-mint returns the existing task and forwards NOTHING.
    f = stubFetch();
    const again = await app.request(
      '/devs/onboarding',
      { method: 'POST', headers: bearer(devTok) },
      ENV,
    );
    expect(again.status).toBe(200);
    expect(((await again.json()) as { existing: boolean }).existing).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(f).not.toHaveBeenCalled();
  });

  it('without the bindings the handlers forward nothing (local dev / tests / forks)', async () => {
    const f = stubFetch();
    const res = await app.request('/checkout', {
      method: 'POST',
      headers: bearer(devTok),
      body: JSON.stringify({ task_id: taskId }),
    }); // no env → unconfigured
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(f).not.toHaveBeenCalled();
  });
});
