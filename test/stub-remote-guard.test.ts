import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubExecutorRemoteRefusal } from '../src/run-loop.js';

// Incident: a stub run against api.givework.dev submitted 7 fabricated results
// and booked 1028¢ of fake spend, repaired by hand. The runner's wiring step now
// refuses to point a stub executor at a remote control plane. These tests pin
// the guard itself, and that `givework run` refuses BEFORE any network call.

describe('stubExecutorRemoteRefusal()', () => {
  const env = (over: Record<string, string | undefined> = {}) => ({
    EXECUTOR: undefined,
    GIVEWORK_ALLOW_STUB_REMOTE: undefined,
    ...over,
  });

  it('refuses a stub executor against a remote control plane', () => {
    const msg = stubExecutorRemoteRefusal('https://api.givework.dev', env());
    expect(msg).toMatch(/fabricated results/);
    expect(msg).toMatch(/EXECUTOR=claude/);
    expect(msg).toMatch(/GIVEWORK_ALLOW_STUB_REMOTE=1/);
    // EXECUTOR=stub is just as stub as unset.
    expect(
      stubExecutorRemoteRefusal('https://api.givework.dev', env({ EXECUTOR: 'stub' })),
    ).toMatch(/fabricated/);
  });

  it('allows every local spelling of the control plane', () => {
    for (const url of [
      'http://localhost:3000',
      'http://127.0.0.1:8787',
      'http://[::1]:3000',
      'https://localhost',
    ]) {
      expect(stubExecutorRemoteRefusal(url, env())).toBeNull();
    }
  });

  it('allows EXECUTOR=claude anywhere — real capacity is the point', () => {
    expect(
      stubExecutorRemoteRefusal('https://api.givework.dev', env({ EXECUTOR: 'claude' })),
    ).toBeNull();
  });

  it('honors the deliberate escape hatch', () => {
    expect(
      stubExecutorRemoteRefusal(
        'https://api.givework.dev',
        env({ GIVEWORK_ALLOW_STUB_REMOTE: '1' }),
      ),
    ).toBeNull();
    // Only the exact opt-in value counts.
    expect(
      stubExecutorRemoteRefusal(
        'https://api.givework.dev',
        env({ GIVEWORK_ALLOW_STUB_REMOTE: '0' }),
      ),
    ).toMatch(/fabricated/);
  });

  it('treats an unparseable base URL as remote — when in doubt, refuse', () => {
    expect(stubExecutorRemoteRefusal('not a url', env())).toMatch(/fabricated/);
  });
});

describe('givework run wiring', () => {
  const saved = {
    home: process.env.HOME,
    api: process.env.GIVEWORK_API_URL,
    token: process.env.GIVEWORK_TOKEN,
    executor: process.env.EXECUTOR,
    allow: process.env.GIVEWORK_ALLOW_STUB_REMOTE,
    fetch: globalThis.fetch,
  };
  let home: string;
  let fetches: number;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'gw-guard-'));
    process.env.HOME = home; // no real ~/.givework/config.json can leak in
    process.env.GIVEWORK_API_URL = 'https://api.givework.dev';
    process.env.GIVEWORK_TOKEN = 'dev-token';
    delete process.env.EXECUTOR;
    delete process.env.GIVEWORK_ALLOW_STUB_REMOTE;
    fetches = 0;
    globalThis.fetch = (async () => {
      fetches++;
      throw new Error('network must not be touched');
    }) as typeof fetch;
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = saved.fetch;
    rmSync(home, { recursive: true, force: true });
    for (const [k, v] of [
      ['HOME', saved.home],
      ['GIVEWORK_API_URL', saved.api],
      ['GIVEWORK_TOKEN', saved.token],
      ['EXECUTOR', saved.executor],
      ['GIVEWORK_ALLOW_STUB_REMOTE', saved.allow],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('refuses stub + remote before any network call', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const { run } = await import('../src/cli/commands.js');
    await expect(run([])).rejects.toThrow('exit 1');
    expect(exit).toHaveBeenCalledWith(1);
    expect(fetches).toBe(0); // refused before the first request left the machine
  });
});
