import { app } from './app.js';
import { emailHandler } from './intake/email.js';

// Cloudflare Workers entrypoint. The Hono app handles HTTP (`fetch`); the
// `email` handler receives inbound mail via Cloudflare Email Routing — the
// production intake path (intake@givework.dev → src/intake/email.ts). See that
// module for the security model (allowlist gate; no public intake surface).
//
// Runtime config (DATABASE_URL, JWT_SECRET) comes from Worker secrets, which are
// auto-populated onto `process.env` because wrangler.toml enables nodejs_compat
// with a compatibility date >= 2025-04-01. That's why src/db.ts and src/auth.ts
// read process.env unchanged here, exactly as they do under Node.
//
// DATABASE_URL must be Neon's *pooled* connection string (the `-pooler` host):
// each Worker request is short-lived, so we lean on Neon's PgBouncer rather than
// holding long-lived connections. Our transactions are all transaction-scoped
// (BEGIN..COMMIT with FOR UPDATE), which PgBouncer transaction pooling supports.
export default {
  fetch: (req: Request, env: unknown, ctx: unknown) => app.fetch(req, env as any, ctx as any),
  email: emailHandler,
};
