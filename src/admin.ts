import { Hono } from 'hono';
import { requireAdmin, signDevToken } from './auth.js';
import { query } from './db.js';
import type { SendEmailBinding } from './mailer.js';
import { OpError } from './operations.js';
import { recordHumanReview } from './verify.js';

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
    let rows: Array<{ id: string; github_handle: string; email: string | null }>;
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

const TARGET_KINDS = new Set(['conjecture', 'research_question', 'org_request']);

/** URL-safe slug from a name/label: lowercase, non-alphanumerics to hyphens. */
function slugify(s: string): string {
  return String(s)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

// Create a target. During the math phase this is how conjectures are seeded:
// name + slug + statement + kind. contact_email is optional (org-specific,
// dormant); it's only meaningful for the org_request kind.
adminRoutes.post('/targets', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return adminHandle(async () => {
    if (!body.name) throw new OpError(400, 'bad_input', 'Missing name');
    const kind = body.kind ?? 'conjecture';
    if (!TARGET_KINDS.has(kind)) {
      throw new OpError(400, 'bad_input', `kind must be one of ${[...TARGET_KINDS].join(', ')}`);
    }
    const slug = body.slug ? slugify(body.slug) : null;
    try {
      const { rows } = await query(
        `INSERT INTO targets
           (name, kind, slug, statement_plain, statement_formal, source_ref, checker,
            ein, contact_email, verified)
         VALUES ($1, $2::target_kind, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id, name, kind, slug, status, statement_plain, statement_formal, source_ref,
                   checker, ein, contact_email, verified`,
        [
          body.name,
          kind,
          slug,
          body.statement_plain ?? null,
          body.statement_formal ?? null,
          body.source_ref ?? null,
          body.checker ?? null,
          body.ein ?? null,
          body.contact_email ?? null,
          body.verified ?? false,
        ],
      );
      return rows[0];
    } catch (err: any) {
      // Unique violation on slug -> a clean 409 instead of a 500.
      if (err?.code === '23505') {
        throw new OpError(409, 'slug_taken', 'That slug is already in use');
      }
      throw err;
    }
  })(c);
});

// List every nonprofit with its identifier and task counts — the admin's
// management/transparency view of who's in the system.
adminRoutes.get('/targets', (c) =>
  adminHandle(async () => {
    const { rows } = await query(
      `SELECT n.id, n.name, n.contact_email, n.verified, n.listed,
              (SELECT count(*)::int FROM target_identifiers i WHERE i.target_id = n.id) AS identifier_count,
              (SELECT count(*)::int FROM tasks t WHERE t.target_id = n.id) AS tasks_total,
              (SELECT count(*)::int FROM tasks t WHERE t.target_id = n.id AND t.status = 'accepted') AS tasks_accepted
         FROM targets n
        ORDER BY n.created_at ASC`,
    );
    return rows;
  })(c),
);

// One nonprofit plus all its allowlist identifiers — what an admin edits.
adminRoutes.get('/targets/:id', (c) =>
  adminHandle(async () => {
    const { rows } = await query(
      `SELECT id, name, ein, contact_email, verified, listed FROM targets WHERE id = $1`,
      [c.req.param('id')],
    );
    if (rows.length === 0) throw new OpError(404, 'target_not_found', 'Unknown nonprofit');
    const ids = await query(
      `SELECT id, kind, value, created_at FROM target_identifiers
        WHERE target_id = $1 ORDER BY kind, value`,
      [c.req.param('id')],
    );
    return { ...rows[0], identifiers: ids.rows };
  })(c),
);

const TARGET_STATUSES = new Set(['open', 'partially_resolved', 'resolved', 'disproven', 'closed']);

// Override any of a target's fields — verify/unverify, list/unlist publicly, set
// its status (resolve/disprove/close a conjecture), or fix its name/contact/EIN.
// Only provided fields change (COALESCE keeps the rest).
adminRoutes.post('/targets/:id', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return adminHandle(async () => {
    if (body.status != null && !TARGET_STATUSES.has(body.status)) {
      throw new OpError(
        400,
        'bad_input',
        `status must be one of ${[...TARGET_STATUSES].join(', ')}`,
      );
    }
    const { rows } = await query(
      `UPDATE targets SET
          name = COALESCE($2, name),
          ein = COALESCE($3, ein),
          contact_email = COALESCE($4, contact_email),
          verified = COALESCE($5::boolean, verified),
          listed = COALESCE($6::boolean, listed),
          status = COALESCE($7::target_status, status)
        WHERE id = $1
        RETURNING id, name, kind, slug, status, ein, contact_email, verified, listed`,
      [
        c.req.param('id'),
        body.name ?? null,
        body.ein ?? null,
        body.contact_email ?? null,
        body.verified ?? null,
        body.listed ?? null,
        body.status ?? null,
      ],
    );
    if (rows.length === 0) throw new OpError(404, 'target_not_found', 'Unknown target');
    return rows[0];
  })(c);
});

const IDENTIFIER_KINDS = new Set(['email', 'domain', 'email_deny', 'domain_deny']);

// Add an allowlist identifier (email/domain, allow or deny) to a nonprofit.
adminRoutes.post('/targets/:id/identifiers', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return adminHandle(async () => {
    const kind = String(body.kind ?? '');
    if (!IDENTIFIER_KINDS.has(kind)) {
      throw new OpError(
        400,
        'bad_input',
        `kind must be one of ${[...IDENTIFIER_KINDS].join(', ')}`,
      );
    }
    // Normalize: lowercase, trim, and strip a leading '@' from bare domains.
    let value = String(body.value ?? '')
      .trim()
      .toLowerCase();
    if (kind.startsWith('domain')) value = value.replace(/^@/, '');
    if (!value) throw new OpError(400, 'bad_input', 'value is required');
    const isEmail = kind.startsWith('email');
    if (isEmail && !value.includes('@')) {
      throw new OpError(400, 'bad_input', 'an email identifier must contain @');
    }
    if (!isEmail && value.includes('@')) {
      throw new OpError(400, 'bad_input', 'a domain identifier must not contain @');
    }
    const np = await query(`SELECT 1 FROM targets WHERE id = $1`, [c.req.param('id')]);
    if (np.rowCount === 0) throw new OpError(404, 'target_not_found', 'Unknown nonprofit');
    try {
      const { rows } = await query(
        `INSERT INTO target_identifiers (target_id, kind, value)
         VALUES ($1, $2, $3) RETURNING id, target_id, kind, value, created_at`,
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
adminRoutes.delete('/targets/:id/identifiers/:identifierId', (c) =>
  adminHandle(async () => {
    const { rowCount } = await query(
      `DELETE FROM target_identifiers WHERE id = $1 AND target_id = $2`,
      [c.req.param('identifierId'), c.req.param('id')],
    );
    if (rowCount === 0)
      throw new OpError(404, 'identifier_not_found', 'Unknown identifier for this nonprofit');
    return { deleted: true };
  })(c),
);

adminRoutes.post('/tasks', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return adminHandle(async () => {
    for (const f of ['target_id', 'title', 'spec', 'est_cost_cents', 'max_cost_cents', 'model']) {
      if (body[f] === undefined || body[f] === null) {
        throw new OpError(400, 'bad_input', `Missing field: ${f}`);
      }
    }
    const { rows } = await query(
      `INSERT INTO tasks (target_id, title, spec, est_cost_cents, max_cost_cents, model, sensitivity)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::data_sensitivity, 'public'))
       RETURNING id, target_id, title, est_cost_cents, max_cost_cents, model, sensitivity, status`,
      [
        body.target_id,
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

const TASK_STATUSES = new Set(['open', 'locked', 'submitted', 'accepted', 'rejected', 'expired']);

// List tasks (optionally by status) for the admin review loop — e.g. the small
// queue of submitted work from unverified devs that still needs a manual accept.
adminRoutes.get('/tasks', (c) =>
  adminHandle(async () => {
    const status = c.req.query('status');
    if (status && !TASK_STATUSES.has(status)) {
      throw new OpError(400, 'bad_input', `unknown status: ${status}`);
    }
    const { rows } = await query(
      `SELECT t.id, t.title, t.status, t.actual_cost_cents, t.intake_request_id,
              d.github_handle AS dev, t.result
         FROM tasks t
         LEFT JOIN devs d ON d.id = t.assigned_dev_id
        WHERE ($1::text IS NULL OR t.status = $1::task_status)
        ORDER BY t.submitted_at DESC NULLS LAST, t.created_at DESC
        LIMIT 50`,
      [status ?? null],
    );
    return rows;
  })(c),
);

adminRoutes.post('/tasks/:id/accept', (c) =>
  adminHandle(() => {
    const binding = (c.env as { SEND_EMAIL?: SendEmailBinding } | undefined)?.SEND_EMAIL;
    // Human-review verdict: accept + notify + record the verification row.
    return recordHumanReview(c.req.param('id'), 'passed', 'admin', binding);
  })(c),
);

adminRoutes.post('/tasks/:id/reject', (c) =>
  adminHandle(() => recordHumanReview(c.req.param('id'), 'failed', 'admin'))(c),
);
