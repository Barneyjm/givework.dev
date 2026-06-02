import pg from 'pg';

const { Pool } = pg;

// Postgres returns BIGINT (OID 20) as a string by default to avoid precision
// loss. All our money columns are BIGINT but always well within Number's safe
// integer range (cents), so parse them to JS numbers for ergonomic arithmetic.
pg.types.setTypeParser(20, (val: string) => parseInt(val, 10));

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export type Client = pg.PoolClient;

/**
 * Run `fn` inside a single transaction. Commits on success, rolls back on any
 * thrown error and re-throws. The one well-factored transaction helper — every
 * state-changing operation goes through this rather than scattering BEGIN/COMMIT.
 */
export async function withTransaction<T>(
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Convenience for one-off reads that don't need a transaction. */
export async function query<T extends pg.QueryResultRow = any>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params as any[]);
}

export async function closePool(): Promise<void> {
  await pool.end();
}
