import { Hono } from 'hono';
import { setCookie, getCookie, deleteCookie } from 'hono/cookie';
import { query } from './db.js';
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
const GH_AUTHORIZE = 'https://github.com/login/oauth/authorize';
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
  const user = (await res.json()) as { id: number; login: string; email: string | null };

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
  return { id: user.id, login: user.login, email };
}

/**
 * Upsert the GitHub identity into devs and return the dev id. github_id is the
 * stable key, but we conflict on github_handle so a self-serve login also adopts
 * any pre-existing admin-seeded row with the same handle (linking github_id onto
 * it) rather than failing the UNIQUE(github_handle) constraint.
 */
export async function upsertDev(user: GitHubUser): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO devs (github_id, github_handle, email)
     VALUES ($1, $2, $3)
     ON CONFLICT (github_handle) DO UPDATE
       SET github_id = EXCLUDED.github_id,
           email = COALESCE(devs.email, EXCLUDED.email)
     RETURNING id`,
    [user.id, user.login, user.email],
  );
  return rows[0].id;
}

export const oauthRoutes = new Hono<Env>();

oauthRoutes.get('/github/login', (c) => {
  const cfg = config(c.req.url);
  // Double-submit CSRF: a random state echoed in both a signed-ish HttpOnly
  // cookie and the GitHub `state` param; the callback requires they match.
  const state = crypto.randomUUID();
  setCookie(c, STATE_COOKIE, state, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax', // Lax so the cookie rides the top-level GET redirect back.
    path: '/',
    maxAge: 600,
  });
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
    deleteCookie(c, STATE_COOKIE, { path: '/' });

    if (!code) throw new OpError(400, 'missing_code', 'Missing authorization code');
    if (!state || !cookieState || state !== cookieState) {
      throw new OpError(401, 'bad_state', 'OAuth state mismatch — please retry the sign-in');
    }

    const accessToken = await exchangeCode(code, cfg);
    const user = await fetchGitHubUser(accessToken);
    const devId = await upsertDev(user);
    const token = await signDevToken(devId);

    const apiOrigin = new URL(c.req.url).origin;
    return c.html(tokenPage(user.login, token, apiOrigin));
  } catch (err) {
    if (err instanceof OpError) {
      return c.html(errorPage(err.message), err.status as any);
    }
    throw err;
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
<h2>1. Set your runner environment</h2>
<pre>export GIVEWORK_API_URL=${escapeHtml(apiOrigin)}
export GIVEWORK_TOKEN=<span class="tok">${escapeHtml(token)}</span></pre>
<p>This token is your credential — keep it secret. It expires in 90 days.</p>
<h2>2. Declare this month's donated budget (in cents)</h2>
<pre>curl -X POST "$GIVEWORK_API_URL/devs/budget" \\
  -H "authorization: Bearer $GIVEWORK_TOKEN" \\
  -H "content-type: application/json" \\
  -d '{"budget_cents": 2000}'</pre>
<h2>3. Start your runner</h2>
<pre>npm run runner</pre>
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
