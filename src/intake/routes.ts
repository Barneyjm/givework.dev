import { Hono } from 'hono';
import { OpError } from '../operations.js';
import { requireAdmin, type Principal } from '../auth.js';
import {
  receiveIntake,
  redecompose,
  publishIntake,
  rejectIntake,
  listIntake,
  getIntake,
} from './operations.js';

type Env = { Variables: { principal: Principal } };

function handle<T>(fn: () => Promise<T>) {
  return async (c: any) => c.json((await fn()) as any);
}

// Public intake endpoint — simulates an inbound email webhook. Unauthenticated
// on purpose: anyone can email intake@givework.dev. STAGE 5: a real email
// provider (SES/Postmark) posting here behind a shared webhook secret.
export const publicIntakeRoutes = new Hono<Env>();

publicIntakeRoutes.post('/intake', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return handle(() =>
    receiveIntake({
      from_email: body.from_email,
      subject: body.subject,
      body: body.body,
      attachments: body.attachments,
    }),
  )(c);
});

// Admin review/publish surface. Mounted under the already-admin-gated router,
// but we also guard here so it's safe if mounted elsewhere.
export const adminIntakeRoutes = new Hono<Env>();
adminIntakeRoutes.use('*', requireAdmin);

adminIntakeRoutes.get('/intake', (c) => handle(() => listIntake(c.req.query('status')))(c));

adminIntakeRoutes.get('/intake/:id', (c) => handle(() => getIntake(c.req.param('id')))(c));

adminIntakeRoutes.post('/intake/:id/decompose', (c) =>
  handle(() => redecompose(c.req.param('id')))(c),
);

adminIntakeRoutes.post('/intake/:id/publish', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const who = c.get('principal').role === 'admin' ? 'admin' : 'unknown';
  return handle(() => publishIntake(c.req.param('id'), body.tasks, who))(c);
});

adminIntakeRoutes.post('/intake/:id/reject', (c) =>
  handle(() => rejectIntake(c.req.param('id')))(c),
);
