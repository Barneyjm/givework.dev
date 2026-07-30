import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closePool } from '../src/db.js';
import { app } from '../src/server.js';
import {
  createDev,
  createTarget,
  createTask,
  mintDevToken,
  resetDb,
  setBudget,
} from './helpers.js';

afterAll(closePool);

function req(path: string, init?: RequestInit) {
  return app.fetch(new Request(`http://test${path}`, init));
}
const bearer = (t: string) => ({
  authorization: `Bearer ${t}`,
  'content-type': 'application/json',
});

const TOKEN_VAR = 'POSTHOG_PROJECT_TOKEN';
const HOST_VAR = 'POSTHOG_API_HOST';

afterEach(() => {
  delete process.env[TOKEN_VAR];
  delete process.env[HOST_VAR];
  vi.restoreAllMocks();
});

// The two config routes are the ONLY place the PostHog project token enters the
// product. Both are public and unauthenticated by design (the browser form is
// loaded by every visitor), and both must answer even when nothing is
// configured — "analytics off" is a supported deploy, not an error.
describe('analytics config routes', () => {
  it('serves the browser form as JavaScript, with an empty token when unset', async () => {
    const res = await req('/analytics-config.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/javascript');
    const body = await res.text();
    // posthog-init.js bails on a falsy token, so an unconfigured deploy loads
    // no snippet at all rather than initialising against a bogus project.
    expect(body).toContain('window.__POSTHOG_TOKEN__=""');
    expect(body).toContain('window.__POSTHOG_HOST__="https://us.i.posthog.com"');
  });

  it('serves the CLI form as JSON, with an empty token when unset', async () => {
    const res = await req('/analytics-config.json');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ token: '', host: 'https://us.i.posthog.com' });
  });

  it('reflects the configured token and host into both forms', async () => {
    process.env[TOKEN_VAR] = 'phc_test_token';
    process.env[HOST_VAR] = 'https://eu.i.posthog.com';

    const js = await (await req('/analytics-config.js')).text();
    expect(js).toContain('window.__POSTHOG_TOKEN__="phc_test_token"');
    expect(js).toContain('window.__POSTHOG_HOST__="https://eu.i.posthog.com"');

    expect(await (await req('/analytics-config.json')).json()).toEqual({
      token: 'phc_test_token',
      host: 'https://eu.i.posthog.com',
    });
  });

  // The values are interpolated into a <script> body. JSON.stringify is what
  // keeps a quote or a backslash in a misconfigured variable from ending the
  // string literal and breaking every page on the site.
  it('escapes a token containing quotes rather than emitting broken JavaScript', async () => {
    process.env[TOKEN_VAR] = 'ph"c\\_odd';
    const body = await (await req('/analytics-config.js')).text();
    expect(body).toContain(String.raw`"ph\"c\\_odd"`);
    // Still parseable as JS — the whole point of the escaping.
    expect(() => new Function(body)).not.toThrow();
  });

  it('needs no authentication (the browser form is loaded by every visitor)', async () => {
    expect((await req('/analytics-config.js')).status).toBe(200);
    expect((await req('/analytics-config.json')).status).toBe(200);
  });
});

// The property that matters, and the reason captureAfterResponse exists: a
// PostHog outage must be invisible to the volunteer. funnel.ts states the rule
// ("a missing analytics row is a reporting gap; a failed checkout is a lost
// donation") and it applies to the PostHog mirror just as much as to the table.
describe('analytics never breaks the money path', () => {
  let dev: string;
  let tok: string;
  let task: string;

  beforeEach(async () => {
    await resetDb();
    const target = await createTarget();
    dev = await createDev('analytics-dev');
    tok = await mintDevToken(dev);
    await setBudget(dev, 5000);
    task = await createTask(target, { max: 500 });
  });

  it('checks out successfully while PostHog ingest is hard-down', async () => {
    process.env[TOKEN_VAR] = 'phc_test_token';
    // Every outbound call fails, the way a DNS failure or a 500 from the ingest
    // endpoint would. posthog-node is given a real token here, so this exercises
    // the actual client rather than the unconfigured short-circuit.
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('posthog unreachable'));

    const res = await req('/checkout', {
      method: 'POST',
      headers: bearer(tok),
      body: JSON.stringify({ task_id: task }),
    });

    expect(res.status).toBe(200);
    expect(((await res.json()) as { task_id: string }).task_id).toBe(task);
    fetchSpy.mockRestore();
  });

  it('does not delay the response on a PostHog request that never resolves', async () => {
    process.env[TOKEN_VAR] = 'phc_test_token';
    // A capture that hangs forever. If the response were awaiting the flush,
    // this test would time out instead of returning.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}));

    const res = await req('/checkout', {
      method: 'POST',
      headers: bearer(tok),
      body: JSON.stringify({ task_id: task }),
    });

    expect(res.status).toBe(200);
    fetchSpy.mockRestore();
  }, 5000);
});
