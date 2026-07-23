import { Hono } from 'hono';
import { adminRoutes } from './admin.js';
import { type Principal, requireAdmin, requireDev } from './auth.js';
import { query } from './db.js';
import { devRoutes } from './devs.js';
import { getRequestResultsForToken, getRequestStatus, receiveIntake } from './intake/operations.js';
import { adminIntakeRoutes } from './intake/routes.js';
import type { SendEmailBinding } from './mailer.js';
import { oauthRoutes } from './oauth.js';
import {
  checkoutTask,
  expire,
  getBudget,
  getLeaderboard,
  getPublicTransparency,
  getTargetProgress,
  isDevVerified,
  listOpenTasks,
  OpError,
  releaseTask,
} from './operations.js';
import { resultsToCsv, resultsToJson } from './results.js';
import { submitAndVerify } from './verify.js';

type Env = { Variables: { principal: Principal } };

// The Hono app, with no runtime binding. Both entrypoints import this:
// src/server.ts serves it under Node (@hono/node-server) for local dev, and
// src/worker.ts exports it as a Cloudflare Worker. Keep this file free of
// Node-only imports so the Worker bundle stays clean.
export const app = new Hono<Env>();

// OpError thrown anywhere (including auth middleware, which runs before the
// per-route handlers) maps to its HTTP status; everything else is a real 500.
app.onError((err, c) => {
  if (err instanceof OpError) {
    return c.json({ error: err.code, message: err.message }, err.status as any);
  }
  console.error(err);
  return c.json({ error: 'internal_error' }, 500);
});

/** Wrap a handler so OpError -> its HTTP status, anything else -> 500. */
function handle<T>(fn: () => Promise<T>) {
  return async (c: any) => {
    try {
      return c.json((await fn()) as any);
    } catch (err) {
      if (err instanceof OpError) {
        return c.json({ error: err.code, message: err.message }, err.status as any);
      }
      throw err; // genuine failure -> Hono surfaces 500
    }
  };
}

function requireFields(body: any, fields: string[]): void {
  for (const f of fields) {
    const v = body?.[f];
    if (v === undefined || v === null || v === '') {
      throw new OpError(400, 'bad_input', `Missing field: ${f}`);
    }
  }
}

// Build/version info — public, unauthenticated, no secrets. The runner pulls
// this at startup so volunteers can see which control-plane build they're talking
// to (i.e. confirm an update landed). GIT_SHA / GIT_REF / DEPLOYED_AT are injected
// as plain-text vars by the CI deploy (`wrangler deploy --var ...`); on local Node
// they're unset and fall back to 'dev'/'local'.
app.get('/version', (c) => {
  const deployedAt = process.env.DEPLOYED_AT; // epoch seconds (string) from CI
  let deployedAtIso: string | null = null;
  if (deployedAt && /^\d+$/.test(deployedAt)) {
    const d = new Date(Number(deployedAt) * 1000);
    // An out-of-range epoch yields an Invalid Date; .toISOString() would throw
    // and crash this public endpoint, so guard before formatting.
    if (!Number.isNaN(d.getTime())) deployedAtIso = d.toISOString();
  }
  return c.json({
    service: 'givework-api',
    commit: process.env.GIT_SHA ?? 'dev',
    ref: process.env.GIT_REF ?? 'local',
    deployed_at: deployedAtIso,
  });
});

// Liveness/readiness probe — public, unauthenticated. A nice landing for the API
// host root (api.givework.dev/health) and what uptime checks / load balancers
// hit. Pings the database so a 200 means "control plane can actually serve", not
// just "the Worker booted". DB unreachable -> 503 with status 'degraded'.
app.get('/health', async (c) => {
  try {
    await query('SELECT 1');
    return c.json({ status: 'ok', db: 'up' });
  } catch {
    return c.json({ status: 'degraded', db: 'down' }, 503);
  }
});

// Public transparency — who we work with + per-org task counts. Unauthenticated
// and opt-in: only nonprofits an admin marked `listed` appear, and only their
// name + counts (no contact info or task content). The marketing site can fetch
// this to render a "who we work with" section.
app.get('/transparency', (c) => handle(() => getPublicTransparency())(c));

// Public per-conjecture progress — keyed by a human-readable slug (conjectures
// carry no PII, so no unguessable token is needed). Statement, status, the
// current compacted working set, roll-up metrics, and a feed of recent
// contributions. 404 for an unknown slug or a non-public target kind.
//
// Content-negotiated: a browser (Accept: text/html) gets the static detail page
// (site/conjecture.html), which client-renders this same JSON; everything else —
// runners, curl, fetch — gets the JSON. The ASSETS binding only exists on the
// deployed Worker/wrangler dev, so the Node server (API-only) always serves JSON.
app.get('/conjectures/:slug', (c) => {
  const assets = (c.env as { ASSETS?: { fetch: typeof fetch } } | undefined)?.ASSETS;
  if (assets && c.req.header('accept')?.includes('text/html')) {
    return assets.fetch(new URL('/conjecture', c.req.url));
  }
  return handle(async () => {
    const p = await getTargetProgress(c.req.param('slug'));
    if (!p) throw new OpError(404, 'target_not_found', 'Unknown conjecture');
    return p;
  })(c);
});

// Public leaderboard — curated conjectures with progress + top contributors by
// donated compute. Drives the marketing site's "what's being worked on" surface.
app.get('/leaderboard', (c) => handle(() => getLeaderboard())(c));

// Public problem submission — anyone can propose an open problem in plain
// language. No allowlist/DMARC vetting (that gated PII; open math has none), and
// safe to open because nothing is spent until an admin reviews and publishes the
// draft. Public-safe response: never expose the proposed tasks, costs, or models.
// STAGE: add rate-limiting before launch (this triggers a stub decomposition).
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
app.post('/submissions', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return handle(async () => {
    const email = String(body.from_email ?? '').trim();
    const text = String(body.body ?? '').trim();
    if (!EMAIL_RE.test(email)) {
      throw new OpError(400, 'bad_input', 'a valid from_email is required');
    }
    if (text.length < 10 || text.length > 10_000) {
      throw new OpError(400, 'bad_input', 'body must be between 10 and 10000 characters');
    }
    const subject = body.subject != null ? String(body.subject).slice(0, 200) : undefined;
    const r = await receiveIntake({ from_email: email, subject, body: text });
    return {
      submission_id: r.intake_id,
      status: 'received',
      status_url: `/requests/${r.intake_id}`,
    };
  })(c);
});

// Public per-request status — the capability is the unguessable request id in the
// link a nonprofit gets by email. Plain-language stage + progress only; 404 for
// an unknown/invalid id. Backs the status.html page.
app.get('/requests/:id', (c) =>
  handle(async () => {
    const status = await getRequestStatus(c.req.param('id'));
    if (!status) throw new OpError(404, 'request_not_found', 'Unknown request');
    return status;
  })(c),
);

// Public results — same unguessable-id capability, but only once the request is
// complete (no partial-output leak). Default returns JSON for the page preview;
// ?download=csv|json returns a file. 404 until complete / unknown id.
app.get('/requests/:id/results', async (c) => {
  const results = await getRequestResultsForToken(c.req.param('id'));
  if (!results) {
    return c.json({ error: 'not_ready', message: 'Results are not available yet' }, 404);
  }
  const download = c.req.query('download');
  if (download === 'csv') {
    return c.body(resultsToCsv(results), 200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="givework-results.csv"',
    });
  }
  if (download === 'json') {
    return c.body(resultsToJson(results), 200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="givework-results.json"',
    });
  }
  return c.json({ results });
});

// --- Dev-authenticated endpoints. dev_id always comes from the token (sub),
//     never the request body, so a token can only act as its own dev. ---

app.post('/checkout', requireDev, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const dev = c.get('principal').dev_id!;
  return handle(() => {
    requireFields(body, ['task_id']);
    return checkoutTask(dev, body.task_id);
  })(c);
});

app.post('/submit', requireDev, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const dev = c.get('principal').dev_id!;
  return handle(async () => {
    requireFields(body, ['task_id', 'actual_cost_cents']);
    const binding = (c.env as { SEND_EMAIL?: SendEmailBinding } | undefined)?.SEND_EMAIL;
    return submitAndVerify(
      dev,
      body.task_id,
      body.result ?? null,
      Number(body.actual_cost_cents),
      body.raw_usage ?? null,
      {
        outcome: body.outcome,
        summary: body.summary,
        artifactUri: body.artifact_uri,
        artifact: body.artifact,
        stateUpdate: body.state_update,
      },
      binding,
    );
  })(c);
});

app.post('/release', requireDev, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const dev = c.get('principal').dev_id!;
  return handle(() => {
    requireFields(body, ['task_id']);
    return releaseTask(dev, body.task_id);
  })(c);
});

app.get('/budget', requireDev, async (c) => {
  const dev = c.get('principal').dev_id!;
  return handle(async () => {
    const b = await getBudget(dev);
    if (!b) throw new OpError(404, 'no_budget', 'No budget for current period');
    return b;
  })(c);
});

app.get('/tasks/open', requireDev, async (c) => {
  const maxCost = c.req.query('max_cost_cents');
  const sensitivity = c.req.query('sensitivity');
  const limit = c.req.query('limit');
  const dev = c.get('principal').dev_id!;
  return handle(async () =>
    listOpenTasks({
      maxCostCents: maxCost !== undefined ? Number(maxCost) : undefined,
      sensitivity: sensitivity ?? undefined,
      limit: limit !== undefined ? Number(limit) : undefined,
      // Unverified devs are pinned to public tasks; authoritative DB read.
      devVerified: await isDevVerified(dev),
    }),
  )(c);
});

// --- Admin (requires an admin token) ---

app.post(
  '/admin/expire',
  requireAdmin,
  handle(() => expire()),
);

app.route('/admin', adminRoutes);
app.route('/admin', adminIntakeRoutes);

// Self-serve developer onboarding: GitHub OAuth sign-in (public) and the
// dev's own profile/budget endpoints (dev-token gated, mounted internally).
app.route('/auth', oauthRoutes);
app.route('/devs', devRoutes);
