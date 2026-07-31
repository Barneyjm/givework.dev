import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

// The property that matters, and the reason captureFunnelEvent (src/posthog.ts)
// is fire-and-forget: a
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
    process.env[HOST_VAR] = 'https://ingest.test';
    // Every outbound call fails, the way a DNS failure or a 500 from the ingest
    // endpoint would. src/posthog.ts is given both bindings here, so this
    // exercises the real capture path rather than the unconfigured short-circuit.
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
    process.env[HOST_VAR] = 'https://ingest.test';
    // A capture that hangs forever. If the response were awaiting the capture,
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

// The reconciliation of PR #99 and PR #100 ruled: exactly ONE server-side
// capture path (src/posthog.ts). This guards against the superseded
// src/posthog-server.ts (or an import of it) ever coming back in a merge and
// double-firing every funnel event.
describe('single server-side capture path', () => {
  it('nothing in src/ or test/ references posthog-server', () => {
    const self = fileURLToPath(import.meta.url);
    const repo = join(self, '..', '..');
    const roots = [join(repo, 'src'), join(repo, 'test')];
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (/\.(ts|js)$/.test(entry.name) && p !== self) {
          if (readFileSync(p, 'utf8').includes('posthog-server')) offenders.push(p);
        }
      }
    };
    for (const root of roots) walk(root);
    expect(offenders).toEqual([]);
  });
});

// PR #97's blocking defect: a bot rewrote ASCII quotes as typographic quotes
// INSIDE inline JavaScript, so three pages did not parse and rendered nothing —
// and CI stayed green because no test executed the site's scripts. This is that
// test: every inline <script> on every page (plus posthog-init.js) must at
// least COMPILE as JavaScript.
describe('site scripts parse', () => {
  const siteDir = fileURLToPath(new URL('../site', import.meta.url));

  it('every inline <script> in site/*.html compiles', () => {
    const pages = readdirSync(siteDir).filter((f) => f.endsWith('.html'));
    expect(pages.length).toBeGreaterThan(0);
    // The glob picks up every page automatically; pin the ones whose inline
    // scripts do real rendering so a rename can't silently drop them from the
    // net (videos.html is the film gallery — probe + player, all inline).
    expect(pages).toContain('videos.html');
    expect(pages).toContain('conjectures.html');
    expect(pages).toContain('conjecture.html');
    for (const page of pages) {
      const html = readFileSync(join(siteDir, page), 'utf8');
      // Inline scripts only — a src= script has no body to compile.
      const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
      let m: RegExpExecArray | null = re.exec(html);
      let found = 0;
      while (m !== null) {
        const body = m[1];
        if (body.trim()) {
          found++;
          // new Function compiles (never runs) the script body; a typographic
          // quote where a string delimiter should be throws a SyntaxError here.
          expect(() => new Function(body), `${page} inline script #${found}`).not.toThrow();
        }
        m = re.exec(html);
      }
    }
  });

  it('site/posthog-init.js compiles', () => {
    const body = readFileSync(join(siteDir, 'posthog-init.js'), 'utf8');
    expect(() => new Function(body)).not.toThrow();
  });
});
