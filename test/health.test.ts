import { afterAll, describe, expect, it } from 'vitest';
import { closePool } from '../src/db.js';
import { app } from '../src/server.js';

afterAll(closePool);

describe('GET /health', () => {
  // Liveness by default: no DB round-trip, so an uptime monitor cannot hold
  // Neon's compute awake (and bill for it) just by checking we are up.
  it('answers without touching the database (no auth required)', async () => {
    const res = await app.fetch(new Request('http://test/health'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', db: 'unchecked' });
  });

  it('probes the database only when asked for it with ?db=1', async () => {
    const res = await app.fetch(new Request('http://test/health?db=1'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', db: 'up' });
  });
});

describe('GET /version', () => {
  it('reports build info (no auth required); falls back to dev/local when unset', async () => {
    const res = await app.fetch(new Request('http://test/version'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.service).toBe('givework-api');
    // CI injects GIT_SHA; in the test env it's unset -> 'dev'.
    expect(body).toHaveProperty('commit');
    expect(body).toHaveProperty('ref');
    expect(body).toHaveProperty('deployed_at');
  });

  it('converts an injected epoch DEPLOYED_AT into ISO', async () => {
    process.env.GIT_SHA = 'abc1234deadbeef';
    process.env.DEPLOYED_AT = '1700000000';
    try {
      const res = await app.fetch(new Request('http://test/version'));
      const body = (await res.json()) as any;
      expect(body.commit).toBe('abc1234deadbeef');
      expect(body.deployed_at).toBe(new Date(1700000000 * 1000).toISOString());
    } finally {
      delete process.env.GIT_SHA;
      delete process.env.DEPLOYED_AT;
    }
  });
});
