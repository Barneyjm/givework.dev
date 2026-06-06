import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiError, apiRequest } from '../src/cli/api.js';
import { arg, boolArg } from '../src/cli/commands.js';

// CLI unit tests — pure pieces only (arg parsing, API error mapping, config
// round-trip). The browser/loopback login is exercised manually, not in CI.

describe('arg()', () => {
  it('reads --name value and returns undefined when absent', () => {
    const a = ['set', '2000', '--interval', '30', '--watch'];
    expect(arg(a, '--interval')).toBe('30');
    expect(arg(a, '--max')).toBeUndefined();
  });
});

describe('boolArg()', () => {
  it('parses true/false and returns undefined when the flag is absent', () => {
    expect(boolArg(['set', 'id', '--verified', 'true'], '--verified')).toBe(true);
    expect(boolArg(['set', 'id', '--listed', 'false'], '--listed')).toBe(false);
    expect(boolArg(['set', 'id', '--name', 'x'], '--verified')).toBeUndefined();
  });
});

describe('apiRequest error mapping', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('maps a 4xx { error, message } into a thrown ApiError(code)', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'budget_below_committed', message: 'too low' }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    await expect(
      apiRequest('http://x', { path: '/devs/budget', method: 'POST' }),
    ).rejects.toMatchObject({ code: 'budget_below_committed', status: 409 });
  });

  it('returns the parsed body on 200', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: true, n: 7 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    const r = await apiRequest<any>('http://x', { path: '/version' });
    expect(r).toEqual({ ok: true, n: 7 });
  });

  it('wraps non-JSON error bodies (e.g. a 502 HTML page) as ApiError', async () => {
    globalThis.fetch = (async () =>
      new Response('<html>502</html>', { status: 502 })) as typeof fetch;
    await expect(apiRequest('http://x', { path: '/budget' })).rejects.toBeInstanceOf(ApiError);
  });
});

describe('config store', () => {
  let home: string;
  const savedHome = process.env.HOME;
  const savedApi = process.env.GIVEWORK_API_URL;
  const savedTok = process.env.GIVEWORK_TOKEN;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'gw-cli-'));
    process.env.HOME = home;
    delete process.env.GIVEWORK_API_URL;
    delete process.env.GIVEWORK_TOKEN;
  });
  afterEach(() => {
    process.env.HOME = savedHome;
    if (savedApi === undefined) delete process.env.GIVEWORK_API_URL;
    else process.env.GIVEWORK_API_URL = savedApi;
    if (savedTok === undefined) delete process.env.GIVEWORK_TOKEN;
    else process.env.GIVEWORK_TOKEN = savedTok;
    rmSync(home, { recursive: true, force: true });
  });

  it('round-trips saved values and defaults the api url', async () => {
    const { loadConfig, saveConfig, DEFAULT_API_URL } = await import('../src/cli/config.js');
    expect(loadConfig().apiUrl).toBe(DEFAULT_API_URL); // nothing saved yet
    saveConfig({ token: 'tok-123' });
    const c = loadConfig();
    expect(c.token).toBe('tok-123');
    // File is written private (0600).
    const mode =
      (await import('node:fs')).statSync(join(home, '.givework', 'config.json')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('lets env override the saved file', async () => {
    const { loadConfig, saveConfig } = await import('../src/cli/config.js');
    saveConfig({ apiUrl: 'http://from-file', token: 'file-tok' });
    process.env.GIVEWORK_API_URL = 'http://from-env';
    process.env.GIVEWORK_TOKEN = 'env-tok';
    const c = loadConfig();
    expect(c.apiUrl).toBe('http://from-env');
    expect(c.token).toBe('env-tok');
  });
});
