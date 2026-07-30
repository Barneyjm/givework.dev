import { app } from './app.js';
import { emailHandler } from './intake/email.js';
import { expire } from './operations.js';

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
  fetch: async (req: Request, env: unknown, ctx: unknown) => {
    // Branded contributor share cards are rendered by a Worker-only module
    // (resvg-wasm + bundled fonts). Import it lazily so the wasm/font assets
    // only load on the isolate that actually serves a card, and never leak into
    // the Node code paths that share app.ts.
    if (new URL(req.url).pathname.startsWith('/og/contributor/')) {
      const { handleOgContributor } = await import('./og/image.js');
      const res = await handleOgContributor(req);
      if (res) return res;
    }
    return app.fetch(req, env as any, ctx as any);
  },
  email: emailHandler,
  // Cron trigger (wrangler.toml [triggers]): the lease-expiry sweep. A crashed
  // runner never calls /release; without this, its task is stranded out of the
  // pool and its reservation blocks the volunteer's budget until someone
  // remembers to POST /admin/expire. Thin shim by design — all the logic (and
  // its tests) live in operations.expire().
  scheduled: async (_controller: unknown, _env: unknown, _ctx: unknown) => {
    const r = await expire();
    if (r.expired_count > 0) {
      console.log(`expire sweep: reclaimed ${r.expired_count} lapsed task(s)`);
    }
  },
};
