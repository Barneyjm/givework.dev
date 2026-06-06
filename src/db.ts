import pg from 'pg';

const { Pool, Client } = pg;

// Postgres returns BIGINT (OID 20) as a string by default to avoid precision
// loss. All our money columns are BIGINT but always well within Number's safe
// integer range (cents), so parse them to JS numbers for ergonomic arithmetic.
pg.types.setTypeParser(20, (val: string) => parseInt(val, 10));

// On Cloudflare Workers a socket may only be used within the request that
// created it: a connection held in a module-scope pool across requests hangs
// (the runtime then cancels the request). So on Workers we open a fresh
// connection per call and close it before responding. On Node — tests, scripts,
// local dev — a long-lived shared pool is correct and much faster.
const isWorkers =
  typeof navigator !== 'undefined' &&
  (navigator as { userAgent?: string }).userAgent === 'Cloudflare-Workers';

const connectionString = process.env.DATABASE_URL;

// Shared pool for the Node runtime. Unused on Workers (the request path uses
// per-request connections via acquire()), but still imported by scripts/tests.
export const pool = new Pool({ connectionString });

// Either kind of connection — both expose .query, which is all callers use.
export type Client = pg.PoolClient | pg.Client;

/**
 * Acquire a client and a matching release function: a per-request connection on
 * Workers (connected here, closed on release), or a pooled client on Node.
 */
async function acquire(): Promise<{ client: Client; release: () => Promise<void> }> {
  if (isWorkers) {
    // Prefer the Hyperdrive binding (edge-pooled, low-latency) when present;
    // fall back to the direct DATABASE_URL secret. The dynamic import resolves
    // only in the Workers runtime and is never reached on Node.
    // @ts-expect-error - 'cloudflare:workers' is a Workers-runtime built-in module
    const { env } = await import('cloudflare:workers');
    const cs =
      (env as Record<string, { connectionString?: string }>).HYPERDRIVE?.connectionString ??
      connectionString;
    // Cap query time so a slow/cold origin (e.g. a Neon free-tier compute waking
    // from autosuspend) can't hang a Worker request indefinitely. statement_timeout
    // makes Postgres cancel the query; query_timeout is a client-side backstop in
    // case the cancel itself stalls (e.g. a wedged connection through Hyperdrive).
    const client = new Client({
      connectionString: cs,
      connectionTimeoutMillis: 10_000,
      statement_timeout: 15_000,
      query_timeout: 20_000,
    });
    // When query_timeout fires, pg destroys the socket and emits 'error' on the
    // client; with no listener that's an unhandled exception that crashes the
    // request. Swallow it — the rejected query already surfaces the failure.
    client.on('error', () => {});
    await client.connect();
    return { client, release: () => client.end() };
  }
  const client = await pool.connect();
  return { client, release: async () => client.release() };
}

/**
 * Run `fn` inside a single transaction. Commits on success, rolls back on any
 * thrown error and re-throws. The one well-factored transaction helper — every
 * state-changing operation goes through this rather than scattering BEGIN/COMMIT.
 */
export async function withTransaction<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const { client, release } = await acquire();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    // Don't let a rollback failure mask the original error.
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await release();
  }
}

/** Convenience for one-off reads that don't need a transaction. */
export async function query<T extends pg.QueryResultRow = any>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  if (!isWorkers) return pool.query<T>(text, params as any[]);
  const { client, release } = await acquire();
  try {
    return await client.query<T>(text, params as any[]);
  } finally {
    await release();
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
