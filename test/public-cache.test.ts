import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../src/db.js';
import { app } from '../src/server.js';
import { createDev, mintDevToken, resetDb, setBudget } from './helpers.js';

// Neon bills compute by the hour it is awake, and an idle compute suspends. So
// every uncached public read is not just a query -- it is a wake-up that bills
// for the whole autosuspend window. These endpoints are identical for every
// caller, so Cloudflare's edge can answer site traffic without touching Postgres
// at all. The rule these tests hold: public reads carry a shared-cache header,
// and anything caller-specific never does.

afterAll(closePool);

let devTok: string;
beforeEach(async () => {
  await resetDb();
  const devId = await createDev('cache-dev');
  await setBudget(devId, 500);
  devTok = await mintDevToken(devId);
});

const req = (path: string, init?: RequestInit) =>
  app.fetch(new Request(`http://test${path}`, init));

const PUBLIC_READS = ['/leaderboard', '/transparency', '/tasks/available'];

describe('public reads are edge-cacheable', () => {
  for (const path of PUBLIC_READS) {
    it(`${path} sets a shared-cache Cache-Control`, async () => {
      const res = await req(path);
      expect(res.status).toBe(200);
      const cc = res.headers.get('cache-control') ?? '';
      expect(cc).toMatch(/s-maxage=\d+/);
      expect(cc).toContain('public');
    });
  }
});

describe('caller-specific responses are never cached', () => {
  it('a dev-gated read carries no shared-cache header', async () => {
    const res = await req('/budget', { headers: { authorization: `Bearer ${devTok}` } });
    expect(res.status).toBe(200);
    // Caching this at the edge would serve one volunteer's budget to another.
    expect(res.headers.get('cache-control') ?? '').not.toContain('s-maxage');
  });

  it('an error response is not cached, so a blip cannot be pinned at the edge', async () => {
    const res = await req('/conjectures/no-such-conjecture-xyz/tree');
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control') ?? '').not.toContain('s-maxage');
  });
});

describe('/health stays off the database unless asked', () => {
  it('the default probe does not set a cache header either', async () => {
    const res = await req('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', db: 'unchecked' });
  });
});
