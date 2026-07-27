import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiError, apiRequest } from '../src/cli/api.js';
import {
  arg,
  boolArg,
  contributionLines,
  needsCapBeforeOnboarding,
  pct,
  siteUrlFor,
  suggestedCap,
} from '../src/cli/commands.js';
import { ONBOARDING_MAX_CENTS } from '../src/goldbach.js';

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

describe('siteUrlFor()', () => {
  it('maps the API origin to the site origin', () => {
    expect(siteUrlFor('https://api.givework.dev')).toBe('https://givework.dev');
    expect(siteUrlFor('http://localhost:3000')).toBe('http://localhost:3000');
    expect(siteUrlFor('https://api.givework.dev/')).toBe('https://givework.dev');
  });
});

describe('contributionLines()', () => {
  const swept = {
    range_start: 4,
    range_end: 80_004,
    candidates: 40_000,
    target_name: "Goldbach's conjecture",
    target_slug: 'goldbach',
  };

  it('frames an empty sweep as territory ruled out, never as "no result"', () => {
    const text = contributionLines(swept, { counterexamples: [], spentCents: 2 }).join('\n');
    expect(text).toContain('ruled out 40,000 candidates');
    expect(text).toContain("Goldbach's conjecture");
    // The words that would tell a newcomer their run was worthless.
    expect(text).not.toMatch(/no result|nothing found|failed|unsuccessful/i);
  });

  it('leads with the counterexample when there actually is one', () => {
    const text = contributionLines(swept, { counterexamples: [12345678], spentCents: 3 }).join(
      '\n',
    );
    expect(text).toContain('12345678');
    expect(text).toMatch(/disproves/);
  });

  it('always reports the donated compute and the verdict', () => {
    const text = contributionLines(swept, {
      counterexamples: [],
      spentCents: 2,
      verdict: 'passed',
    }).join('\n');
    expect(text).toContain('2¢');
    expect(text).toContain('passed');
  });

  // submitResult books the spend, writes the ledger row and inserts the
  // contribution BEFORE verification runs. So "this run was not recorded" is
  // false for every verdict — and telling someone to re-run `givework onboard`
  // spends their own Claude credit a second time on a range already booked.
  it('tells the truth after a failed verification: recorded, booked, do not re-run', () => {
    const text = contributionLines(swept, {
      counterexamples: [],
      spentCents: 3,
      verdict: 'failed',
    }).join('\n');
    expect(text).not.toMatch(/not recorded|wasn't recorded|was not recorded/i);
    expect(text).toMatch(/booked/i);
    expect(text).toMatch(/still on the record|recorded/i);
    // Never invite the double-spend.
    expect(text).not.toMatch(/try:\s*givework onboard/i);
    expect(text).toMatch(/nothing to redo/i);
    expect(text).toContain('3¢');
  });

  it('does not claim an inconclusive or pending run was accepted', () => {
    for (const verdict of ['inconclusive', 'pending']) {
      const text = contributionLines(swept, {
        counterexamples: [],
        spentCents: 2,
        verdict,
      }).join('\n');
      // The success copy claims the check itself is done and banked. It is not.
      expect(text).not.toContain('ruled out 40,000 candidates');
      expect(text).not.toMatch(/recorded under your name/i);
      expect(text).toMatch(/queued for a person|could not settle/i);
      // But the accounting is still true, and still stated.
      expect(text).toMatch(/booked/i);
      expect(text).toContain(verdict);
    }
  });
});

describe('needsCapBeforeOnboarding()', () => {
  // The threshold is what mintOnboardingTask reserves, not zero. A dev sitting
  // on 1–4¢ passes an `available > 0` check and then dead-ends on a raw
  // insufficient_budget from the API, reproducibly, on every re-run.
  it('asks for a cap whenever there is less headroom than the task reserves', () => {
    expect(needsCapBeforeOnboarding(undefined)).toBe(true);
    expect(needsCapBeforeOnboarding(null)).toBe(true);
    expect(needsCapBeforeOnboarding({ budget_cents: 500, available_cents: 0 })).toBe(true);
    for (let c = 1; c < ONBOARDING_MAX_CENTS; c++) {
      expect(needsCapBeforeOnboarding({ budget_cents: 500, available_cents: c })).toBe(true);
    }
    expect(
      needsCapBeforeOnboarding({ budget_cents: 500, available_cents: ONBOARDING_MAX_CENTS }),
    ).toBe(false);
  });
});

describe('suggestedCap()', () => {
  it('offers a cap that actually leaves room for the task', () => {
    // Accepting the offer has to make the mint succeed, or the guided flow just
    // dead-ends somewhere else.
    const stuck = { budget_cents: 500, available_cents: 3 };
    expect(
      suggestedCap(stuck) - (stuck.budget_cents - stuck.available_cents),
    ).toBeGreaterThanOrEqual(ONBOARDING_MAX_CENTS);
    expect(suggestedCap(undefined)).toBeGreaterThanOrEqual(ONBOARDING_MAX_CENTS);
  });
});

describe('pct()', () => {
  it('renders an undefined rate as an em-dash, never as 0.0%', () => {
    expect(pct(null)).toBe('—');
    expect(pct(undefined)).toBe('—');
    // A genuine zero is still a zero.
    expect(pct(0)).toBe('0.0%');
    expect(pct(0.25)).toBe('25.0%');
    expect(pct(1)).toBe('100.0%');
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
