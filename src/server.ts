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
import { adminRoutes } from './admin.js';

export const app = new Hono();

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

app.post('/checkout', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return handle(() => {
    requireFields(body, ['dev_id', 'task_id']);
    return checkoutTask(body.dev_id, body.task_id);
  })(c);
});

app.post('/submit', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return handle(() => {
    requireFields(body, ['dev_id', 'task_id', 'actual_cost_cents']);
    return submitResult(
      body.dev_id,
      body.task_id,
      body.result ?? null,
      Number(body.actual_cost_cents),
      body.raw_usage ?? null,
    );
  })(c);
});

app.post('/release', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return handle(() => {
    requireFields(body, ['dev_id', 'task_id']);
    return releaseTask(body.dev_id, body.task_id);
  })(c);
});

app.get('/budget', async (c) => {
  const devId = c.req.query('dev_id');
  return handle(async () => {
    if (!devId) throw new OpError(400, 'bad_input', 'Missing dev_id');
    const b = await getBudget(devId);
    if (!b) throw new OpError(404, 'no_budget', 'No budget for current period');
    return b;
  })(c);
});

app.get('/tasks/open', async (c) => {
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

app.post('/admin/expire', handle(() => expire()));

app.route('/admin', adminRoutes);

const port = Number(process.env.PORT ?? 3000);

// Only start listening when run directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`givework listening on http://localhost:${info.port}`);
  });
}
