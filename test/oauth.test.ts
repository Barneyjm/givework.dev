import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, pool } from '../src/db.js';
import { shouldAutoVerify } from '../src/oauth.js';
import { app } from '../src/server.js';
import {
  createDev,
  createNonprofit,
  createTask,
  getBudgetRow,
  mintAdminToken,
  mintDevToken,
  resetDb,
  setBudget,
  setVerified,
} from './helpers.js';

afterAll(closePool);

describe('shouldAutoVerify (GitHub-signal policy)', () => {
  const old = '2015-01-01T00:00:00Z';
  const base = { id: 1, login: 'x', email: null, createdAt: old, publicRepos: 3, followers: 1 };
  it('verifies an established account with a public footprint', () => {
    expect(shouldAutoVerify(base)).toBe(true);
  });
  it('rejects a brand-new account (under the age bar)', () => {
    const now = new Date('2020-01-15T00:00:00Z').getTime();
    expect(shouldAutoVerify({ ...base, createdAt: '2020-01-01T00:00:00Z' }, { now })).toBe(false);
  });
  it('rejects an old account with zero public footprint', () => {
    expect(shouldAutoVerify({ ...base, publicRepos: 0, followers: 0 })).toBe(false);
  });
  it('rejects when createdAt is missing (incomplete GitHub data → conservative)', () => {
    expect(shouldAutoVerify({ ...base, createdAt: null })).toBe(false);
  });
  it('honors a custom minimum age', () => {
    const now = new Date('2015-02-01T00:00:00Z').getTime(); // ~31 days old
    expect(shouldAutoVerify(base, { now, minAgeDays: 90 })).toBe(false);
    expect(shouldAutoVerify(base, { now, minAgeDays: 7 })).toBe(true);
  });
});

function req(path: string, init?: RequestInit) {
  return app.fetch(new Request(`http://test${path}`, init));
}
const bearer = (t: string) => ({
  authorization: `Bearer ${t}`,
  'content-type': 'application/json',
});

beforeEach(async () => {
  await resetDb();
  process.env.GITHUB_CLIENT_ID = 'test-client-id';
  process.env.GITHUB_CLIENT_SECRET = 'test-client-secret';
});

// ---------------------------------------------------------------------------
// GitHub OAuth sign-in
// ---------------------------------------------------------------------------

/** Drive the login route, then the callback, stubbing GitHub's HTTP calls. */
async function signInWithGitHub(ghUser: {
  id: number;
  login: string;
  email?: string | null;
  created_at?: string;
  public_repos?: number;
  followers?: number;
}) {
  // 1. Login -> 302 with a state param + a matching state cookie.
  const login = await req('/auth/github/login');
  expect(login.status).toBe(302);
  const location = new URL(login.headers.get('location')!);
  const state = location.searchParams.get('state')!;
  const setCookie = login.headers.get('set-cookie') ?? '';
  expect(setCookie).toContain(`gw_oauth_state=${state}`);

  // 2. Stub GitHub: code exchange + user lookup.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any) => {
    const url = String(typeof input === 'string' ? input : input.url);
    if (url.includes('login/oauth/access_token')) {
      return new Response(JSON.stringify({ access_token: 'gho_test' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.endsWith('/user')) {
      return new Response(
        JSON.stringify({
          id: ghUser.id,
          login: ghUser.login,
          email: ghUser.email ?? null,
          created_at: ghUser.created_at, // omitted → not auto-verified
          public_repos: ghUser.public_repos ?? 0,
          followers: ghUser.followers ?? 0,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.endsWith('/user/emails')) {
      return new Response(
        JSON.stringify([
          { email: `${ghUser.login}@users.noreply.github.com`, primary: true, verified: true },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;

  try {
    const cb = await req(`/auth/github/callback?code=abc&state=${state}`, {
      headers: { cookie: `gw_oauth_state=${state}` },
    });
    return cb;
  } finally {
    globalThis.fetch = realFetch;
  }
}

/** Pull the dev token out of the success page's `export GIVEWORK_TOKEN=...` line. */
function tokenFromPage(html: string): string {
  const m = html.match(/GIVEWORK_TOKEN=(?:<span class="tok">)?([A-Za-z0-9._-]+)/);
  if (!m) throw new Error('no token in page');
  return m[1];
}

describe('GitHub OAuth sign-in', () => {
  it('creates a dev and issues a working token on callback', async () => {
    const res = await signInWithGitHub({ id: 4242, login: 'octocat' });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('@octocat');

    const { rows } = await pool.query(`SELECT id, github_id, github_handle, verified FROM devs`);
    expect(rows.length).toBe(1);
    expect(rows[0].github_handle).toBe('octocat');
    expect(Number(rows[0].github_id)).toBe(4242);
    expect(rows[0].verified).toBe(false); // no qualifying GitHub signal → not auto-verified

    // The minted token authenticates against a real dev route.
    const token = tokenFromPage(html);
    const me = await req('/devs/me', { headers: bearer(token) });
    expect(me.status).toBe(200);
    expect(((await me.json()) as any).github_handle).toBe('octocat');
  });

  it('auto-verifies an established GitHub account on sign-in', async () => {
    await signInWithGitHub({
      id: 777,
      login: 'veteran',
      created_at: '2014-05-01T00:00:00Z',
      public_repos: 12,
      followers: 30,
    });
    const { rows } = await pool.query(`SELECT verified FROM devs WHERE github_id = 777`);
    expect(rows[0].verified).toBe(true); // GitHub identity is the verification
  });

  it('does not auto-verify a brand-new throwaway account', async () => {
    const recent = new Date(Date.now() - 2 * 86_400_000).toISOString(); // 2 days old
    await signInWithGitHub({
      id: 888,
      login: 'throwaway',
      created_at: recent,
      public_repos: 0,
      followers: 0,
    });
    const { rows } = await pool.query(`SELECT verified FROM devs WHERE github_id = 888`);
    expect(rows[0].verified).toBe(false);
  });

  it('rejects a state mismatch (401) — CSRF guard', async () => {
    const login = await req('/auth/github/login');
    const state = new URL(login.headers.get('location')!).searchParams.get('state')!;
    // Cookie carries a different state than the query param.
    const res = await req(`/auth/github/callback?code=abc&state=${state}`, {
      headers: { cookie: `gw_oauth_state=someone-elses-state` },
    });
    expect(res.status).toBe(401);
  });

  it('reuses the same dev row on a second login (upsert on github_id/handle)', async () => {
    await signInWithGitHub({ id: 99, login: 'repeat' });
    await signInWithGitHub({ id: 99, login: 'repeat' });
    const { rows } = await pool.query(`SELECT id FROM devs`);
    expect(rows.length).toBe(1);
  });

  it('handles a GitHub username rename without a unique-constraint error', async () => {
    await signInWithGitHub({ id: 1234, login: 'oldname' });
    // Same github_id, new handle — must update the existing row, not fail on
    // UNIQUE(github_id).
    const res = await signInWithGitHub({ id: 1234, login: 'newname' });
    expect(res.status).toBe(200);
    const { rows } = await pool.query(`SELECT github_handle FROM devs WHERE github_id = 1234`);
    expect(rows.length).toBe(1);
    expect(rows[0].github_handle).toBe('newname');
  });

  it('adopts a pre-existing admin-seeded dev with the same handle', async () => {
    const seeded = await createDev('seeded-handle'); // github_id NULL
    const res = await signInWithGitHub({ id: 555, login: 'seeded-handle' });
    expect(res.status).toBe(200);
    const { rows } = await pool.query(`SELECT id, github_id FROM devs`);
    expect(rows.length).toBe(1); // adopted, not duplicated
    expect(rows[0].id).toBe(seeded);
    expect(Number(rows[0].github_id)).toBe(555);
  });

  it('returns a configuration error when OAuth env is unset', async () => {
    delete process.env.GITHUB_CLIENT_ID;
    const res = await req('/auth/github/login');
    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// Sensitivity trust gate
// ---------------------------------------------------------------------------

describe('sensitivity trust gate', () => {
  let dev: string;
  let tok: string;
  let np: string;
  let publicTask: string;
  let sensitiveTask: string;

  beforeEach(async () => {
    np = await createNonprofit();
    dev = await createDev('gated'); // unverified by default
    tok = await mintDevToken(dev);
    await setBudget(dev, 5000);
    publicTask = await createTask(np, { max: 500, sensitivity: 'public' });
    sensitiveTask = await createTask(np, { max: 500, sensitivity: 'sensitive' });
  });

  it('hides non-public tasks from an unverified dev in /tasks/open', async () => {
    const res = await req('/tasks/open', { headers: bearer(tok) });
    const tasks = (await res.json()) as any[];
    const ids = tasks.map((t) => t.id);
    expect(ids).toContain(publicTask);
    expect(ids).not.toContain(sensitiveTask);
  });

  it('rejects checkout of a sensitive task by an unverified dev (403)', async () => {
    const res = await req('/checkout', {
      method: 'POST',
      headers: bearer(tok),
      body: JSON.stringify({ task_id: sensitiveTask }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error).toBe('not_verified');
  });

  it('allows a verified dev to see and check out a sensitive task', async () => {
    await setVerified(dev);
    const list = await req('/tasks/open', { headers: bearer(tok) });
    expect(((await list.json()) as any[]).map((t) => t.id)).toContain(sensitiveTask);

    const res = await req('/checkout', {
      method: 'POST',
      headers: bearer(tok),
      body: JSON.stringify({ task_id: sensitiveTask }),
    });
    expect(res.status).toBe(200);
  });

  it('admin verify route flips the flag and unlocks sensitive work', async () => {
    const admin = await mintAdminToken();
    const v = await req(`/admin/devs/${dev}/verify`, { method: 'POST', headers: bearer(admin) });
    expect(v.status).toBe(200);
    expect(((await v.json()) as any).verified).toBe(true);

    const res = await req('/checkout', {
      method: 'POST',
      headers: bearer(tok),
      body: JSON.stringify({ task_id: sensitiveTask }),
    });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Self-serve budget
// ---------------------------------------------------------------------------

describe('self-serve budget', () => {
  let dev: string;
  let tok: string;

  beforeEach(async () => {
    dev = await createDev('budgeteer');
    tok = await mintDevToken(dev);
  });

  it('sets the current-period budget and reflects it in /devs/me', async () => {
    const res = await req('/devs/budget', {
      method: 'POST',
      headers: bearer(tok),
      body: JSON.stringify({ budget_cents: 2500 }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).budget_cents).toBe(2500);

    const me = await req('/devs/me', { headers: bearer(tok) });
    expect(((await me.json()) as any).budget.budget_cents).toBe(2500);
  });

  it('rejects a budget below what is already reserved (409)', async () => {
    const np = await createNonprofit();
    const task = await createTask(np, { max: 500 });
    await setBudget(dev, 1000);
    // Reserve 500 by checking out.
    await req('/checkout', {
      method: 'POST',
      headers: bearer(tok),
      body: JSON.stringify({ task_id: task }),
    });
    expect((await getBudgetRow(dev)).reserved_cents).toBe(500);

    const res = await req('/devs/budget', {
      method: 'POST',
      headers: bearer(tok),
      body: JSON.stringify({ budget_cents: 400 }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error).toBe('budget_below_committed');
  });

  it('rejects a negative budget (400)', async () => {
    const res = await req('/devs/budget', {
      method: 'POST',
      headers: bearer(tok),
      body: JSON.stringify({ budget_cents: -5 }),
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// CLI (loopback) OAuth mode — powers `givework login`
// ---------------------------------------------------------------------------

/** Stub GitHub's token-exchange + user lookup; returns a restore fn. */
function stubGitHubFetch(ghUser: { id: number; login: string }) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any) => {
    const url = String(typeof input === 'string' ? input : input.url);
    if (url.includes('login/oauth/access_token')) {
      return new Response(JSON.stringify({ access_token: 'gho_test' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.endsWith('/user')) {
      return new Response(JSON.stringify({ id: ghUser.id, login: ghUser.login, email: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.endsWith('/user/emails')) {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = realFetch;
  };
}

describe('GitHub OAuth — CLI (loopback) mode', () => {
  it('login?cli=<port> sets the cli-port cookie', async () => {
    const login = await req('/auth/github/login?cli=49160');
    expect(login.status).toBe(302);
    expect(login.headers.get('set-cookie') ?? '').toContain('gw_cli_port=49160');
  });

  it('callback 302-redirects the token to http://127.0.0.1:<port>/callback', async () => {
    const login = await req('/auth/github/login?cli=49160');
    const state = new URL(login.headers.get('location')!).searchParams.get('state')!;
    const restore = stubGitHubFetch({ id: 7, login: 'cliuser' });
    try {
      const cb = await req(`/auth/github/callback?code=abc&state=${state}`, {
        headers: { cookie: `gw_oauth_state=${state}; gw_cli_port=49160` },
      });
      expect(cb.status).toBe(302);
      expect(cb.headers.get('location') ?? '').toMatch(
        /^http:\/\/127\.0\.0\.1:49160\/callback\?token=.+/,
      );
    } finally {
      restore();
    }
  });

  it('ignores an out-of-range cli port (no cookie set)', async () => {
    const login = await req('/auth/github/login?cli=80'); // privileged port -> rejected
    expect(login.headers.get('set-cookie') ?? '').not.toContain('gw_cli_port');
  });

  it('without a cli cookie, callback still renders the HTML token page', async () => {
    const login = await req('/auth/github/login');
    const state = new URL(login.headers.get('location')!).searchParams.get('state')!;
    const restore = stubGitHubFetch({ id: 8, login: 'webuser' });
    try {
      const cb = await req(`/auth/github/callback?code=abc&state=${state}`, {
        headers: { cookie: `gw_oauth_state=${state}` },
      });
      expect(cb.status).toBe(200);
      expect(cb.headers.get('content-type') ?? '').toContain('text/html');
    } finally {
      restore();
    }
  });
});
