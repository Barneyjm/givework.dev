import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// CLI telemetry runs on volunteers' own machines, so its guarantees are not
// "nice to have": opt-out must work, the payload must be an allowlist, and a
// broken analytics endpoint must never surface to the person donating compute.
// Each test re-imports the module so its per-process caches (the resolved
// ingest config, the disclosure flag) start clean.

let home: string;

async function loadTelemetry() {
  vi.resetModules();
  return await import('../src/cli/telemetry.js');
}

function configFile(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(join(home, '.givework', 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}

let realHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'givework-telemetry-test-'));
  // src/cli/config.ts resolves the config path from os.homedir(), which on POSIX
  // is $HOME. Pointing it at a temp dir keeps every test off the real
  // ~/.givework — this suite writes install ids and disclosure flags.
  realHome = process.env.HOME;
  process.env.HOME = home;
  process.env.GIVEWORK_API_URL = 'http://control-plane.test';
  delete process.env.GIVEWORK_TELEMETRY;
  delete process.env.DO_NOT_TRACK;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  delete process.env.GIVEWORK_API_URL;
  delete process.env.GIVEWORK_TELEMETRY;
  delete process.env.DO_NOT_TRACK;
  vi.restoreAllMocks();
});

/** A fetch stub that answers the config route and records capture POSTs. */
function stubFetch(opts: { token?: string } = {}) {
  const captures: any[] = [];
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
    const url = String(input);
    if (url.includes('/analytics-config.json')) {
      return new Response(
        JSON.stringify({ token: opts.token ?? 'phc_test', host: 'https://ingest.test' }),
        { headers: { 'content-type': 'application/json' } },
      );
    }
    captures.push(JSON.parse(String(init?.body ?? '{}')));
    return new Response('{"status":1}', { headers: { 'content-type': 'application/json' } });
  });
  return { captures, spy };
}

describe('CLI telemetry opt-out', () => {
  it.each([
    ['GIVEWORK_TELEMETRY', '0'],
    ['GIVEWORK_TELEMETRY', 'false'],
    ['GIVEWORK_TELEMETRY', 'off'],
    ['DO_NOT_TRACK', '1'],
  ])('sends nothing when %s=%s', async (name, value) => {
    process.env[name] = value;
    const { captureCliEvent, flushTelemetry, telemetryEnabled } = await loadTelemetry();
    const { spy } = stubFetch();

    expect(telemetryEnabled()).toBe(false);
    captureCliEvent('cli_command_run', { command: 'run' });
    await flushTelemetry();

    // Not one request — not even the config fetch, which would itself disclose
    // to the control plane that this machine ran the CLI.
    expect(spy).not.toHaveBeenCalled();
    // And nothing is written to disk, so opting out leaves no install id behind.
    expect(configFile().telemetryId).toBeUndefined();
  });

  it('prints the disclosure once, then remembers it', async () => {
    const { captureCliEvent, flushTelemetry } = await loadTelemetry();
    stubFetch();
    const warn = console.error as unknown as ReturnType<typeof vi.fn>;

    captureCliEvent('cli_command_run', { command: 'run' });
    await flushTelemetry();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('GIVEWORK_TELEMETRY=0');
    expect(configFile().telemetryNoticeShown).toBe(true);

    captureCliEvent('cli_command_run', { command: 'whoami' });
    await flushTelemetry();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('CLI telemetry payload', () => {
  it('sends only the allowlisted, content-free properties', async () => {
    const { captureCliEvent, flushTelemetry } = await loadTelemetry();
    const { captures } = stubFetch();

    captureCliEvent('cli_command_run', { command: 'run', ok: true, duration_ms: 42 });
    await flushTelemetry();

    expect(captures).toHaveLength(1);
    const [body] = captures;
    expect(body.api_key).toBe('phc_test');
    expect(body.event).toBe('cli_command_run');
    expect(Object.keys(body.properties).sort()).toEqual([
      '$process_person_profile',
      'ci',
      'cli_version',
      'command',
      'duration_ms',
      'node_version',
      'ok',
      'os',
      'os_release',
    ]);
    // No argv, no cwd, no home directory anywhere in the serialised event.
    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain(home);
    expect(serialised).not.toContain(process.cwd());
  });

  it('reuses one anonymous install id across events, and mints it randomly', async () => {
    const { captureCliEvent, flushTelemetry } = await loadTelemetry();
    const { captures } = stubFetch();

    captureCliEvent('cli_command_run', { command: 'run' });
    captureCliEvent('cli_execution_failed', { code: 'execution_error' });
    await flushTelemetry();

    const ids = new Set(captures.map((c) => c.distinct_id));
    expect(ids.size).toBe(1);
    const id = [...ids][0];
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(configFile().telemetryId).toBe(id);
  });

  it('attributes events to the dev id once logged in, so they join server-side events', async () => {
    const devId = '11111111-2222-3333-4444-555555555555';
    const payload = Buffer.from(JSON.stringify({ sub: devId })).toString('base64url');
    process.env.GIVEWORK_TOKEN = `header.${payload}.signature`;
    try {
      const { captureCliEvent, flushTelemetry } = await loadTelemetry();
      const { captures } = stubFetch();

      captureCliEvent('cli_command_run', { command: 'run' });
      await flushTelemetry();

      expect(captures[0].distinct_id).toBe(devId);
    } finally {
      delete process.env.GIVEWORK_TOKEN;
    }
  });
});

describe('CLI telemetry never disturbs the command', () => {
  it('stays silent when the control plane reports no token configured', async () => {
    const { captureCliEvent, flushTelemetry } = await loadTelemetry();
    const { captures } = stubFetch({ token: '' });

    captureCliEvent('cli_command_run', { command: 'run' });
    await flushTelemetry();

    expect(captures).toHaveLength(0);
  });

  it('swallows a failing ingest endpoint', async () => {
    const { captureCliEvent, flushTelemetry } = await loadTelemetry();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));

    expect(() => captureCliEvent('cli_command_run', { command: 'run' })).not.toThrow();
    await expect(flushTelemetry()).resolves.toBeUndefined();
  });

  it('bounds flush so a hanging request cannot hold the CLI open', async () => {
    const { captureCliEvent, flushTelemetry } = await loadTelemetry();
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}));

    captureCliEvent('cli_command_run', { command: 'run' });
    const started = Date.now();
    await flushTelemetry(150);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('errorCode', () => {
  it('extracts a machine-readable code and never a message', async () => {
    const { errorCode } = await loadTelemetry();
    expect(
      errorCode(Object.assign(new Error('/home/someone/secret.txt'), { code: 'ENOENT' })),
    ).toBe('ENOENT');
    expect(errorCode(new Error('claude -p failed in /home/someone/work'))).toBe('unknown');
    expect(errorCode('a string')).toBe('unknown');
    expect(errorCode(undefined)).toBe('unknown');
  });
});
