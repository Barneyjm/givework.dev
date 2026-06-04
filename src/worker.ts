import { app } from './app.js';

// Cloudflare Workers entrypoint. A Hono app is itself a `{ fetch }` handler, so
// exporting it as the default export is all Workers needs.
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
export default app;
