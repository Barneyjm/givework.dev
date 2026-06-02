import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import {
  checkoutTask,
  submitResult,
  releaseTask,
  expire,
  getBudget,
  listOpenTasks,
  OpError,
} from './operations.js';
import { requireDev, requireAdmin, type Principal } from './auth.js';
import { adminRoutes } from './admin.js';
import { publicIntakeRoutes, adminIntakeRoutes } from './intake/routes.js';

type Env = { Variables: { principal: Principal } };

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
  return handle(() =>
    listOpenTasks({
      maxCostCents: maxCost !== undefined ? Number(maxCost) : undefined,
      sensitivity: sensitivity ?? undefined,
      limit: limit !== undefined ? Number(limit) : undefined,
    }),
  )(c);
});

// --- Admin (requires an admin token) ---

app.post('/admin/expire', requireAdmin, handle(() => expire()));

app.route('/admin', adminRoutes);
app.route('/admin', adminIntakeRoutes);

// Public inbound intake (unauthenticated — simulates an email webhook).
app.route('/', publicIntakeRoutes);

const port = Number(process.env.PORT ?? 3000);

// Only start listening when run directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`givework listening on http://localhost:${info.port}`);
  });
}
