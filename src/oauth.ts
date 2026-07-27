import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { signDevToken } from './auth.js';
import { withTransaction } from './db.js';
import { recordEvent } from './funnel.js';
import { OpError } from './operations.js';

// Self-serve developer sign-in via GitHub OAuth (web flow). Two public routes:
//   GET /auth/github/login    -> redirect to GitHub's consent screen
//   GET /auth/github/callback -> exchange code, upsert dev, mint a dev token
// No new dependencies: global `fetch`, `jose` (via signDevToken), and hono/cookie
// all run on both Workers and Node.
//
// Config comes from env (Worker secrets in prod; see wrangler.toml):
//   GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET  — the OAuth app credentials
//   OAUTH_REDIRECT_URI (optional)           — the callback URL registered with
//     GitHub; if unset we derive it from the incoming request origin.
type Env = { Variables: Record<string, never> };

const STATE_COOKIE = 'gw_oauth_state';
const CLI_PORT_COOKIE = 'gw_cli_port';
const GH_AUTHORIZE = 'https://github.com/login/oauth/authorize';

/** Parse a `?cli=<port>` value into a safe loopback port, or null. */
function parseCliPort(raw: string | undefined): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const port = Number(raw);
  // Unprivileged, ephemeral range only — the CLI listens on a random high port.
  return port >= 1024 && port <= 65535 ? port : null;
}
const GH_TOKEN = 'https://github.com/login/oauth/access_token';
const GH_API = 'https://api.github.com';

interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/** Read OAuth config from env, deriving the redirect URI from the request if unset. */
function config(requestUrl: string): OAuthConfig {
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new OpError(
      500,
      'oauth_not_configured',
      'GitHub OAuth is not configured (GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET missing)',
    );
  }
  const redirectUri =
    process.env.OAUTH_REDIRECT_URI ?? new URL('/auth/github/callback', requestUrl).toString();
  return { clientId, clientSecret, redirectUri };
}

export interface GitHubUser {
  id: number;
  login: string;
  email: string | null;
  /** ISO timestamp the GitHub account was created — the auto-verify signal. */
  createdAt: string | null;
  publicRepos: number;
  followers: number;
}

/**
 * Auto-verify policy: completing GitHub OAuth IS the verification, gated by a
 * light bar so throwaway accounts can't claim sensitive (PII) work. A real
 * GitHub account is spoofable but accountable — it pushes authenticity onto the
 * dev. Default bar: account age >= GITHUB_AUTOVERIFY_MIN_AGE_DAYS (30) and a
 * non-empty public footprint. Admins can still verify edge cases by hand, and
 * this never *un*-verifies anyone.
 */
export function shouldAutoVerify(
  user: GitHubUser,
  opts: { minAgeDays?: number; now?: number } = {},
): boolean {
  const minAgeDays = opts.minAgeDays ?? Number(process.env.GITHUB_AUTOVERIFY_MIN_AGE_DAYS ?? 30);
  const now = opts.now ?? Date.now();
  if (!user.createdAt) return false;
  const ageDays = (now - new Date(user.createdAt).getTime()) / 86_400_000;
  if (!Number.isFinite(ageDays) || ageDays < minAgeDays) return false;
  return user.publicRepos + user.followers >= 1;
}

/** Exchange an authorization code for a GitHub access token. Factored for tests. */
export async function exchangeCode(code: string, cfg: OAuthConfig): Promise<string> {
  const res = await fetch(GH_TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      code,
      redirect_uri: cfg.redirectUri,
    }),
  });
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string };
  if (!res.ok || !data.access_token) {
    throw new OpError(
      502,
      'oauth_exchange_failed',
      `GitHub code exchange failed: ${data.error ?? res.status}`,
    );
  }
  return data.access_token;
}

/** Fetch the authenticated GitHub user (and a primary verified email). Factored for tests. */
export async function fetchGitHubUser(accessToken: string): Promise<GitHubUser> {
  const headers = {
    authorization: `Bearer ${accessToken}`,
    accept: 'application/vnd.github+json',
    // GitHub requires a User-Agent on all API requests.
    'user-agent': 'givework-oauth',
  };
  const res = await fetch(`${GH_API}/user`, { headers });
  if (!res.ok) {
    throw new OpError(502, 'oauth_user_failed', `GitHub user lookup failed: ${res.status}`);
  }
  const user = (await res.json()) as {
    id: number;
    login: string;
    email: string | null;
    created_at?: string;
    public_repos?: number;
    followers?: number;
  };

  // The public profile email is often null; fall back to the primary verified
  // address from /user/emails (granted by the `user:email` scope).
  let email = user.email;
  if (!email) {
    const emailRes = await fetch(`${GH_API}/user/emails`, { headers });
    if (emailRes.ok) {
      const emails = (await emailRes.json()) as Array<{
        email: string;
        primary: boolean;
        verified: boolean;
      }>;
      email = emails.find((e) => e.primary && e.verified)?.email ?? null;
    }
  }
  return {
    id: user.id,
    login: user.login,
    email,
    createdAt: user.created_at ?? null,
    publicRepos: user.public_repos ?? 0,
    followers: user.followers ?? 0,
  };
}

/**
 * Upsert the GitHub identity into devs and return the dev id. There are two
 * UNIQUE columns (github_id, github_handle) and ON CONFLICT can only target one,
 * so we resolve by precedence in a single transaction:
 *   1. by github_id — the stable key; handles repeat logins AND handle renames
 *      (same id, new handle) without tripping UNIQUE(github_id).
 *   2. by github_handle (only rows with no github_id yet) — adopts a pre-existing
 *      admin-seeded dev, linking the OAuth identity onto it.
 *   3. insert — first time we've seen this account. ON CONFLICT (github_id) makes
 *      a concurrent first-login race resolve to an update instead of a 23505.
 *
 * Returns the dev id plus whether this call actually created the row — the top of
 * the signup funnel, which we can only observe here (`xmax = 0` distinguishes a
 * real insert from an ON CONFLICT update).
 */
export async function upsertDev(
  user: GitHubUser,
  autoVerify = false,
): Promise<{ id: string; created: boolean }> {
  const result = await withTransaction(async (client) => {
    // `verified = verified OR $autoVerify` only ever promotes — a re-login of a
    // now-eligible account verifies it, and an already-verified dev is never
    // downgraded.
    const byId = await client.query<{ id: string }>(
      `UPDATE devs SET github_handle = $1, email = COALESCE(email, $2), verified = verified OR $4
        WHERE github_id = $3 RETURNING id`,
      [user.login, user.email, user.id, autoVerify],
    );
    if (byId.rows[0]) return { id: byId.rows[0].id, created: false };

    const byHandle = await client.query<{ id: string }>(
      `UPDATE devs SET github_id = $1, email = COALESCE(email, $2), verified = verified OR $4
        WHERE github_handle = $3 AND github_id IS NULL RETURNING id`,
      [user.id, user.email, user.login, autoVerify],
    );
    if (byHandle.rows[0]) return { id: byHandle.rows[0].id, created: false };

    const inserted = await client.query<{ id: string; created: boolean }>(
      `INSERT INTO devs (github_id, github_handle, email, verified)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (github_id) DO UPDATE
         SET github_handle = EXCLUDED.github_handle,
             email = COALESCE(devs.email, EXCLUDED.email),
             verified = devs.verified OR EXCLUDED.verified
       RETURNING id, (xmax = 0) AS created`,
      [user.id, user.login, user.email, autoVerify],
    );
    return { id: inserted.rows[0].id, created: inserted.rows[0].created };
  });
  if (result.created) await recordEvent(result.id, 'dev_created', { via: 'github_oauth' });
  return result;
}

export const oauthRoutes = new Hono<Env>();

oauthRoutes.get('/github/login', (c) => {
  const cfg = config(c.req.url);
  // Double-submit CSRF: a random state echoed in both a signed-ish HttpOnly
  // cookie and the GitHub `state` param; the callback requires they match.
  const state = crypto.randomUUID();
  const isSecure = new URL(c.req.url).protocol === 'https:';
  setCookie(c, STATE_COOKIE, state, {
    httpOnly: true,
    // Secure in prod (always HTTPS); off for plain-HTTP local dev on non-localhost
    // origins, where browsers reject Secure cookies and would break the flow.
    secure: isSecure,
    sameSite: 'Lax', // Lax so the cookie rides the top-level GET redirect back.
    path: '/',
    maxAge: 600,
  });
  // CLI mode: `givework login` opens this with ?cli=<loopback-port>. Remember the
  // port (validated) so the callback redirects the token back to the local CLI
  // instead of rendering the browser setup page.
  const cliPort = parseCliPort(c.req.query('cli'));
  if (cliPort) {
    setCookie(c, CLI_PORT_COOKIE, String(cliPort), {
      httpOnly: true,
      secure: isSecure,
      sameSite: 'Lax',
      path: '/',
      maxAge: 600,
    });
  }
  const url = new URL(GH_AUTHORIZE);
  url.searchParams.set('client_id', cfg.clientId);
  url.searchParams.set('redirect_uri', cfg.redirectUri);
  url.searchParams.set('scope', 'read:user user:email');
  url.searchParams.set('state', state);
  return c.redirect(url.toString(), 302);
});

oauthRoutes.get('/github/callback', async (c) => {
  try {
    const cfg = config(c.req.url);
    const code = c.req.query('code');
    const state = c.req.query('state');
    const cookieState = getCookie(c, STATE_COOKIE);
    const cliPort = parseCliPort(getCookie(c, CLI_PORT_COOKIE));
    deleteCookie(c, STATE_COOKIE, { path: '/' });
    deleteCookie(c, CLI_PORT_COOKIE, { path: '/' });

    if (!code) throw new OpError(400, 'missing_code', 'Missing authorization code');
    if (!state || !cookieState || state !== cookieState) {
      throw new OpError(401, 'bad_state', 'OAuth state mismatch — please retry the sign-in');
    }

    const accessToken = await exchangeCode(code, cfg);
    const user = await fetchGitHubUser(accessToken);
    // GitHub identity IS the verification (gated by a light bar) — no manual step.
    const { id: devId } = await upsertDev(user, shouldAutoVerify(user));
    const token = await signDevToken(devId);

    // CLI mode: hand the token to the local `givework login` server over loopback.
    // The URL is built ONLY from the validated integer port + a fixed 127.0.0.1
    // host — never a caller-supplied URL — so this can't be an open redirect.
    if (cliPort) {
      return c.redirect(
        `http://127.0.0.1:${cliPort}/callback?token=${encodeURIComponent(token)}`,
        302,
      );
    }

    const apiOrigin = new URL(c.req.url).origin;
    return c.html(tokenPage(user.login, token, apiOrigin));
  } catch (err) {
    // Render the HTML error page for ALL failures (a raw JSON 500 from the global
    // handler is a poor browser experience). OpErrors carry a safe, specific
    // message; anything else (network/DB) is logged server-side and shown
    // generically so we never leak internals to the browser.
    if (err instanceof OpError) {
      return c.html(errorPage(err.message), err.status as any);
    }
    console.error('OAuth callback failed:', err);
    return c.html(errorPage('Something went wrong during sign-in. Please try again.'), 500);
  }
});

// The canonical marketing site (this page is served from the api.* origin, so
// links back must be absolute to land the user on the main site, not the API).
const SITE = 'https://givework.dev';

// Shared Bauhaus chrome so the post-sign-in pages feel connected to the site and
// nobody is stranded on a bare page.
const CHROME_CSS = `
:root{--paper:#f4f1e6;--ink:#161310;--red:#e1342b;--blue:#21449c;--yellow:#f3c20a}
*{box-sizing:border-box}
body{font:16px/1.6 system-ui,-apple-system,sans-serif;color:var(--ink);background:var(--paper);margin:0}
.bar{display:flex;align-items:center;gap:1.2rem;flex-wrap:wrap;padding:1.1rem 1.5rem;border-bottom:3px solid var(--ink)}
.brand{display:flex;align-items:center;gap:.6rem;text-decoration:none;color:var(--ink);margin-right:auto}
.brand .name{font-weight:800;letter-spacing:-.01em;font-size:1.25rem}
.nav a{color:var(--ink);text-decoration:none;font-size:.92rem;margin-left:1.1rem;border-bottom:2px solid var(--yellow);padding-bottom:1px}
.nav a:hover{border-color:var(--red)}
main{max-width:720px;margin:2.5rem auto;padding:0 1.25rem}
h1{font-size:2rem;letter-spacing:-.02em;margin:.2rem 0 1rem}
h2{font-size:1.15rem;margin:2rem 0 .5rem}
code{background:#e9e5d6;border-radius:5px;padding:.05rem .35rem;font-size:.92em}
pre{background:var(--ink);color:var(--paper);border-radius:8px;padding:1rem 1.15rem;overflow-x:auto;font-size:.9rem;line-height:1.7}
.tok{word-break:break-all}
.note{font-size:.9rem;opacity:.8}
.foot{border-top:1px solid #16131033;margin-top:2.5rem;padding:1.5rem 1.25rem;text-align:center;font-size:.9rem}
.foot a{color:var(--ink)}
.cta{display:inline-block;margin-top:.5rem;background:var(--ink);color:var(--paper);text-decoration:none;padding:.6rem 1.1rem;border-radius:8px;font-weight:600}
.cta:hover{background:var(--red)}`;

const GLYPH = `<svg width="34" height="34" viewBox="0 0 40 40" aria-hidden="true"><rect width="40" height="40" fill="#161310"/><circle cx="11" cy="13" r="7" fill="#e1342b"/><rect x="21" y="6" width="13" height="13" fill="#21449c"/><polygon points="7,34 19,21 31,34" fill="#f3c20a"/></svg>`;

function header(): string {
  return `<header><div class="bar">
<a class="brand" href="${SITE}">${GLYPH}<span class="name">Givework</span></a>
<nav class="nav"><a href="${SITE}/conjectures">All conjectures</a><a href="${SITE}/volunteers">For contributors</a><a href="${SITE}/">Home</a></nav>
</div></header>`;
}

function footer(): string {
  return `<div class="foot"><a class="cta" href="${SITE}/conjectures">Browse the open problems →</a>
<p class="note" style="margin-top:1rem">Powered by volunteers · <a href="${SITE}">givework.dev</a></p></div>`;
}

/** Success page: shows the dev token and copy-paste runner setup, wrapped in the
 * site chrome with clear navigation back into Givework. */
function tokenPage(handle: string, token: string, apiOrigin: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Givework — agent connected</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' fill='%23161310'/%3E%3Ccircle cx='9' cy='10' r='6' fill='%23E1342B'/%3E%3Crect x='17' y='4' width='12' height='12' fill='%2321449C'/%3E%3Cpolygon points='6,28 16,16 26,28' fill='%23F3C20A'/%3E%3C/svg%3E">
<style>${CHROME_CSS}</style></head><body>
${header()}
<main>
<h1>Welcome, @${escapeHtml(handle)} 👋</h1>
<p>Your agent is registered. You can claim <strong>public</strong> tasks right away.
Internal/sensitive work unlocks once an admin verifies your account.</p>
<h2>Connect your agent with the Givework CLI</h2>
<p>One command — no repo to clone. <code>onboard</code> finishes sign-in (you're already
signed in, so it's one click), asks what you'll donate this month, then hands you a
<strong>real task on a live open problem</strong> and runs it. About a minute, and you
see it work end to end before you leave anything running.</p>
<pre>npx givework onboard</pre>
<p class="note">Safe to re-run — it resumes where it left off rather than starting over.</p>
<p>Then keep a runner going:</p>
<pre>EXECUTOR=claude npx givework run --watch</pre>
<p><strong>Prerequisite:</strong> the <code>claude</code> CLI installed and logged in — that
logged-in session is the donated capacity (<code>run</code> executes tasks with <code>claude -p</code>).</p>
<h2>Prefer environment variables?</h2>
<p>Skip <code>login</code> and use this token directly. It's your credential — keep it secret; it expires in 90 days.</p>
<pre>export GIVEWORK_API_URL=${escapeHtml(apiOrigin)}
export GIVEWORK_TOKEN=<span class="tok">${escapeHtml(token)}</span></pre>
</main>
${footer()}
</body></html>`;
}

function errorPage(message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Givework — sign-in error</title>
<style>${CHROME_CSS}</style></head><body>
${header()}
<main>
<h1>Sign-in failed</h1>
<p>${escapeHtml(message)}</p>
<p><a class="cta" href="/auth/github/login">Try again</a></p>
</main>
${footer()}
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!,
  );
}
