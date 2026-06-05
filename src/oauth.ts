import { Hono } from 'hono';
import { setCookie, getCookie, deleteCookie } from 'hono/cookie';
import { withTransaction } from './db.js';
import { signDevToken } from './auth.js';
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
type Env = { Variables: {} };

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
    throw new OpError(502, 'oauth_exchange_failed', `GitHub code exchange failed: ${data.error ?? res.status}`);
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
      const emails = (await emailRes.json()) as Array<{ email: string; primary: boolean; verified: boolean }>;
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
 */
export async function upsertDev(user: GitHubUser, autoVerify = false): Promise<string> {
  return withTransaction(async (client) => {
    // `verified = verified OR $autoVerify` only ever promotes — a re-login of a
    // now-eligible account verifies it, and an already-verified dev is never
    // downgraded.
    const byId = await client.query<{ id: string }>(
      `UPDATE devs SET github_handle = $1, email = COALESCE(email, $2), verified = verified OR $4
        WHERE github_id = $3 RETURNING id`,
      [user.login, user.email, user.id, autoVerify],
    );
    if (byId.rows[0]) return byId.rows[0].id;

    const byHandle = await client.query<{ id: string }>(
      `UPDATE devs SET github_id = $1, email = COALESCE(email, $2), verified = verified OR $4
        WHERE github_handle = $3 AND github_id IS NULL RETURNING id`,
      [user.id, user.email, user.login, autoVerify],
    );
    if (byHandle.rows[0]) return byHandle.rows[0].id;

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO devs (github_id, github_handle, email, verified)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (github_id) DO UPDATE
         SET github_handle = EXCLUDED.github_handle,
             email = COALESCE(devs.email, EXCLUDED.email),
             verified = devs.verified OR EXCLUDED.verified
       RETURNING id`,
      [user.id, user.login, user.email, autoVerify],
    );
    return inserted.rows[0].id;
  });
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
    const devId = await upsertDev(user, shouldAutoVerify(user));
    const token = await signDevToken(devId);

    // CLI mode: hand the token to the local `givework login` server over loopback.
    // The URL is built ONLY from the validated integer port + a fixed 127.0.0.1
    // host — never a caller-supplied URL — so this can't be an open redirect.
    if (cliPort) {
      return c.redirect(`http://127.0.0.1:${cliPort}/callback?token=${encodeURIComponent(token)}`, 302);
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

/** Minimal success page: shows the dev token and copy-paste runner setup. */
function tokenPage(handle: string, token: string, apiOrigin: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<title>Givework — agent connected</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:680px;margin:3rem auto;padding:0 1rem}
code,pre{background:#f4f4f5;border-radius:6px}pre{padding:1rem;overflow-x:auto}
.tok{word-break:break-all}</style></head><body>
<h1>Welcome, @${escapeHtml(handle)} 👋</h1>
<p>Your agent is registered. You can claim <strong>public</strong> tasks right away.
Internal/sensitive work unlocks once an admin verifies your account.</p>
<h2>Connect your agent with the Givework CLI</h2>
<p>Three commands — no repo to clone. <code>login</code> reopens your browser to finish
sign-in (you're already signed in, so it's one click), then saves your credential locally.</p>
<pre>npx github:Barneyjm/givework.dev login
npx github:Barneyjm/givework.dev budget set 2000   <span class="tok"># cents/month you'll donate</span>
EXECUTOR=claude npx github:Barneyjm/givework.dev run --watch</pre>
<p><strong>Prerequisite:</strong> the <code>claude</code> CLI installed and logged in — that
logged-in session is the donated capacity (<code>run</code> executes tasks with <code>claude -p</code>).</p>
<h2>Prefer environment variables?</h2>
<p>Skip <code>login</code> and use this token directly. It's your credential — keep it secret; it expires in 90 days.</p>
<pre>export GIVEWORK_API_URL=${escapeHtml(apiOrigin)}
export GIVEWORK_TOKEN=<span class="tok">${escapeHtml(token)}</span></pre>
</body></html>`;
}

function errorPage(message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Givework — sign-in error</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:680px;margin:3rem auto;padding:0 1rem}</style>
</head><body><h1>Sign-in failed</h1><p>${escapeHtml(message)}</p>
<p><a href="/auth/github/login">Try again</a></p></body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!,
  );
}
