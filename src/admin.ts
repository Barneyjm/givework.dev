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

// List every nonprofit with its identifier and task counts — the admin's
// management/transparency view of who's in the system.
adminRoutes.get('/nonprofits', (c) =>
  adminHandle(async () => {
    const { rows } = await query(
      `SELECT n.id, n.name, n.contact_email, n.verified, n.listed,
              (SELECT count(*)::int FROM nonprofit_identifiers i WHERE i.nonprofit_id = n.id) AS identifier_count,
              (SELECT count(*)::int FROM tasks t WHERE t.nonprofit_id = n.id) AS tasks_total,
              (SELECT count(*)::int FROM tasks t WHERE t.nonprofit_id = n.id AND t.status = 'accepted') AS tasks_accepted
         FROM nonprofits n
        ORDER BY n.created_at ASC`,
    );
    return rows;
  })(c),
);

// One nonprofit plus all its allowlist identifiers — what an admin edits.
adminRoutes.get('/nonprofits/:id', (c) =>
  adminHandle(async () => {
    const { rows } = await query(
      `SELECT id, name, ein, contact_email, verified, listed FROM nonprofits WHERE id = $1`,
      [c.req.param('id')],
    );
    if (rows.length === 0) throw new OpError(404, 'nonprofit_not_found', 'Unknown nonprofit');
    const ids = await query(
      `SELECT id, kind, value, created_at FROM nonprofit_identifiers
        WHERE nonprofit_id = $1 ORDER BY kind, value`,
      [c.req.param('id')],
    );
    return { ...rows[0], identifiers: ids.rows };
  })(c),
);

// Override any of a nonprofit's fields — verify/unverify, list/unlist publicly,
// or fix its name/contact/EIN. Only provided fields change (COALESCE keeps the
// rest); pass verified/listed explicitly to flip them.
adminRoutes.post('/nonprofits/:id', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return adminHandle(async () => {
    const { rows } = await query(
      `UPDATE nonprofits SET
          name = COALESCE($2, name),
          ein = COALESCE($3, ein),
          contact_email = COALESCE($4, contact_email),
          verified = COALESCE($5::boolean, verified),
          listed = COALESCE($6::boolean, listed)
        WHERE id = $1
        RETURNING id, name, ein, contact_email, verified, listed`,
      [
        c.req.param('id'),
        body.name ?? null,
        body.ein ?? null,
        body.contact_email ?? null,
        body.verified ?? null,
        body.listed ?? null,
      ],
    );
    if (rows.length === 0) throw new OpError(404, 'nonprofit_not_found', 'Unknown nonprofit');
    return rows[0];
  })(c);
});

const IDENTIFIER_KINDS = new Set(['email', 'domain', 'email_deny', 'domain_deny']);

// Add an allowlist identifier (email/domain, allow or deny) to a nonprofit.
adminRoutes.post('/nonprofits/:id/identifiers', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return adminHandle(async () => {
    const kind = String(body.kind ?? '');
    if (!IDENTIFIER_KINDS.has(kind)) {
      throw new OpError(400, 'bad_input', `kind must be one of ${[...IDENTIFIER_KINDS].join(', ')}`);
    }
    // Normalize: lowercase, trim, and strip a leading '@' from bare domains.
    let value = String(body.value ?? '').trim().toLowerCase();
    if (kind.startsWith('domain')) value = value.replace(/^@/, '');
    if (!value) throw new OpError(400, 'bad_input', 'value is required');
    const isEmail = kind.startsWith('email');
    if (isEmail && !value.includes('@')) {
      throw new OpError(400, 'bad_input', 'an email identifier must contain @');
    }
    if (!isEmail && value.includes('@')) {
      throw new OpError(400, 'bad_input', 'a domain identifier must not contain @');
    }
    const np = await query(`SELECT 1 FROM nonprofits WHERE id = $1`, [c.req.param('id')]);
    if (np.rowCount === 0) throw new OpError(404, 'nonprofit_not_found', 'Unknown nonprofit');
    try {
      const { rows } = await query(
        `INSERT INTO nonprofit_identifiers (nonprofit_id, kind, value)
         VALUES ($1, $2, $3) RETURNING id, nonprofit_id, kind, value, created_at`,
        [c.req.param('id'), kind, value],
      );
      return rows[0];
    } catch (err: any) {
      if (err?.code === '23505') {
        throw new OpError(409, 'identifier_taken', 'That identifier is already registered');
      }
      throw err;
    }
  })(c);
});

// Remove an allowlist identifier.
adminRoutes.delete('/nonprofits/:id/identifiers/:identifierId', (c) =>
  adminHandle(async () => {
    const { rowCount } = await query(
      `DELETE FROM nonprofit_identifiers WHERE id = $1 AND nonprofit_id = $2`,
      [c.req.param('identifierId'), c.req.param('id')],
    );
    if (rowCount === 0) throw new OpError(404, 'identifier_not_found', 'Unknown identifier for this nonprofit');
    return { deleted: true };
  })(c),
);

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

// Verify a dev — promotes a self-serve (GitHub) signup to handle internal/
// sensitive tasks. Until this is called, the dev can only claim public work.
adminRoutes.post('/devs/:id/verify', (c) =>
  adminHandle(async () => {
    const { rows } = await query(
      `UPDATE devs SET verified = true WHERE id = $1
       RETURNING id, github_handle, verified`,
      [c.req.param('id')],
    );
    if (rows.length === 0) throw new OpError(404, 'dev_not_found', 'Unknown dev');
    return rows[0];
  })(c),
);

adminRoutes.post('/tasks/:id/accept', (c) =>
  adminHandle(() => acceptTask(c.req.param('id')))(c),
);

adminRoutes.post('/tasks/:id/reject', (c) =>
  adminHandle(() => rejectTask(c.req.param('id')))(c),
);
