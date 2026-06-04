import { Hono } from 'hono';
import { getDevProfile, setOwnBudget, OpError } from './operations.js';
import { requireDev, type Principal } from './auth.js';

// A dev's own self-serve surface. Every route is dev-token gated and acts only
// on the caller: dev_id always comes from the token `sub`, never the body or
// path — matching the convention in src/app.ts so a token can only ever act as
// its own dev. Mounted at /devs in src/app.ts.
type Env = { Variables: { principal: Principal } };

export const devRoutes = new Hono<Env>();
devRoutes.use('*', requireDev);

function handle<T>(fn: () => Promise<T>) {
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

// Who am I + my current budget. The runner can call this at startup to greet the
// dev and show remaining donated budget.
devRoutes.get('/me', (c) => {
  const dev = c.get('principal').dev_id!;
  return handle(async () => {
    const profile = await getDevProfile(dev);
    if (!profile) throw new OpError(404, 'dev_not_found', 'Unknown dev');
    return profile;
  })(c);
});

// Self-set the current-period budget — how much of my own donated Claude credit
// I'll spend this month. No admin needed (it only caps the dev's own credit).
devRoutes.post('/budget', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const dev = c.get('principal').dev_id!;
  return handle(() => {
    if (body.budget_cents === undefined || body.budget_cents === null) {
      throw new OpError(400, 'bad_input', 'Missing field: budget_cents');
    }
    return setOwnBudget(dev, Number(body.budget_cents));
  })(c);
});
