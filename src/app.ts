import { Hono } from 'hono';
import {
  checkoutTask,
  submitResult,
  releaseTask,
  expire,
  getBudget,
  listOpenTasks,
  isDevVerified,
  getPublicTransparency,
  OpError,
} from './operations.js';
import { getRequestStatus, getRequestResultsForToken } from './intake/operations.js';
import { resultsToCsv, resultsToJson } from './results.js';
import { query } from './db.js';
import { requireDev, requireAdmin, type Principal } from './auth.js';
import { adminRoutes } from './admin.js';
import { devRoutes } from './devs.js';
import { oauthRoutes } from './oauth.js';
import { adminIntakeRoutes } from './intake/routes.js';

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
  return handle(() => {
    requireFields(body, ['task_id', 'actual_cost_cents']);
    return submitResult(
      dev,
      body.task_id,
      body.result ?? null,
      Number(body.actual_cost_cents),
      body.raw_usage ?? null,
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

app.post('/admin/expire', requireAdmin, handle(() => expire()));

app.route('/admin', adminRoutes);
app.route('/admin', adminIntakeRoutes);

// Self-serve developer onboarding: GitHub OAuth sign-in (public) and the
// dev's own profile/budget endpoints (dev-token gated, mounted internally).
app.route('/auth', oauthRoutes);
app.route('/devs', devRoutes);
