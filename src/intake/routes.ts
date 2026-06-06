import { Hono } from 'hono';
import { type Principal, requireAdmin } from '../auth.js';
import {
  getIntake,
  listIntake,
  publishIntake,
  receiveIntake,
  redecompose,
  rejectIntake,
  uploadDraft,
} from './operations.js';

type Env = { Variables: { principal: Principal } };

function handle<T>(fn: () => Promise<T>) {
  return async (c: any) => c.json((await fn()) as any);
}

// Admin review/publish surface. Mounted under the already-admin-gated router,
// but we also guard here so it's safe if mounted elsewhere.
//
// Inbound nonprofit mail now arrives via the Cloudflare Email Worker
// (src/intake/email.ts), which calls receiveIntake() in-process — so there is
// no public, unauthenticated HTTP intake endpoint to spoof or spam. The manual
// POST /admin/intake below is admin-only, for ops to enter or replay a request.
export const adminIntakeRoutes = new Hono<Env>();
adminIntakeRoutes.use('*', requireAdmin);

adminIntakeRoutes.post('/intake', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return handle(() =>
    receiveIntake({
      from_email: body.from_email,
      subject: body.subject,
      body: body.body,
      attachments: body.attachments,
      nonprofit_id: body.nonprofit_id,
    }),
  )(c);
});

adminIntakeRoutes.get('/intake', (c) => handle(() => listIntake(c.req.query('status')))(c));

adminIntakeRoutes.get('/intake/:id', (c) => handle(() => getIntake(c.req.param('id')))(c));

adminIntakeRoutes.post('/intake/:id/decompose', (c) =>
  handle(() => redecompose(c.req.param('id')))(c),
);

// Upload a draft decomposed off-Worker (the `admin decompose` watcher running a
// real local model posts here).
adminIntakeRoutes.post('/intake/:id/draft', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return handle(() =>
    uploadDraft(c.req.param('id'), body.proposed, String(body.triaged_by ?? 'local')),
  )(c);
});

adminIntakeRoutes.post('/intake/:id/publish', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const who = c.get('principal').role === 'admin' ? 'admin' : 'unknown';
  return handle(() => publishIntake(c.req.param('id'), body.tasks, who))(c);
});

adminIntakeRoutes.post('/intake/:id/reject', (c) =>
  handle(() => rejectIntake(c.req.param('id')))(c),
);
