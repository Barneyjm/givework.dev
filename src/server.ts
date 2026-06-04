import { serve } from '@hono/node-server';
import { app } from './app.js';

// Node entrypoint for local dev (`npm run dev`). The Hono app itself lives in
// src/app.ts; on Cloudflare it's served by src/worker.ts instead.
export { app };

const port = Number(process.env.PORT ?? 3000);

// Only start listening when run directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`givework listening on http://localhost:${info.port}`);
  });
}
