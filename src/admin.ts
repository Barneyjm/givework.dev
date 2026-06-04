import { Hono } from 'hono';
import { query } from './db.js';
import { acceptTask, rejectTask, OpError } from './operations.js';
import { requireAdmin, signDevToken } from './auth.js';

// Seed/admin helpers. All require an admin token. STAGE 3: nonprofit-scoped
// tokens so a nonprofit can review its own tasks without an admin credential —
// the intake/decomposition layer reworks the nonprofit side anyway.
export const adminRoutes = new Hono();
adminRoutes.use('*', requireAdmin);

function adminHandle<T>(fn: () => Promise<T>) {
  return async (c: any) => {
    try {
      return c.json((await fn()) as any);
    } catch (err) {
      if (err instanceof OpError) {
        return c.json({ error: err.code, message: err.message }, err.status as any);
      }
      throw err;
    }
  };
}

adminRoutes.post('/devs', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return adminHandle(async () => {
    if (!body.github_handle) throw new OpError(400, 'bad_input', 'Missing github_handle');
    let rows;
    try {
      ({ rows } = await query(
        `INSERT INTO devs (github_handle, email) VALUES ($1, $2) RETURNING id, github_handle, email`,
        [body.github_handle, body.email ?? null],
      ));
    } catch (err: any) {
      // Unique violation on github_handle -> a clean 409 instead of a 500.
      if (err?.code === '23505') {
        throw new OpError(409, 'dev_exists', 'A developer with this GitHub handle already exists');
      }
      throw err;
    }
    // Hand back a dev token so the new dev (or their runner) can authenticate.
    const token = await signDevToken(rows[0].id);
    return { ...rows[0], token };
  })(c);
});

adminRoutes.post('/nonprofits', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return adminHandle(async () => {
    if (!body.name || !body.contact_email) {
      throw new OpError(400, 'bad_input', 'Missing name or contact_email');
    }
    const { rows } = await query(
      `INSERT INTO nonprofits (name, ein, contact_email, verified)
       VALUES ($1, $2, $3, $4) RETURNING id, name, ein, contact_email, verified`,
      [body.name, body.ein ?? null, body.contact_email, body.verified ?? false],
    );
    return rows[0];
  })(c);
});

adminRoutes.post('/tasks', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return adminHandle(async () => {
    for (const f of ['nonprofit_id', 'title', 'spec', 'est_cost_cents', 'max_cost_cents', 'model']) {
      if (body[f] === undefined || body[f] === null) {
        throw new OpError(400, 'bad_input', `Missing field: ${f}`);
      }
    }
    const { rows } = await query(
      `INSERT INTO tasks (nonprofit_id, title, spec, est_cost_cents, max_cost_cents, model, sensitivity)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::data_sensitivity, 'public'))
       RETURNING id, nonprofit_id, title, est_cost_cents, max_cost_cents, model, sensitivity, status`,
      [
        body.nonprofit_id,
        body.title,
        JSON.stringify(body.spec),
        body.est_cost_cents,
        body.max_cost_cents,
        body.model,
        body.sensitivity ?? null,
      ],
    );
    return rows[0];
  })(c);
});

// Set or replace a dev's budget for the current period.
adminRoutes.post('/budgets', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return adminHandle(async () => {
    if (!body.dev_id || body.budget_cents === undefined) {
      throw new OpError(400, 'bad_input', 'Missing dev_id or budget_cents');
    }
    const { rows } = await query(
      `INSERT INTO dev_budgets (dev_id, period, budget_cents)
       VALUES ($1, date_trunc('month', now())::date, $2)
       ON CONFLICT (dev_id, period)
       DO UPDATE SET budget_cents = EXCLUDED.budget_cents
       RETURNING dev_id, period, budget_cents, reserved_cents, spent_cents`,
      [body.dev_id, body.budget_cents],
    );
    return rows[0];
  })(c);
});

adminRoutes.post('/tasks/:id/accept', (c) =>
  adminHandle(() => acceptTask(c.req.param('id')))(c),
);

adminRoutes.post('/tasks/:id/reject', (c) =>
  adminHandle(() => rejectTask(c.req.param('id')))(c),
);
