import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool, closePool, withTransaction } from '../src/db.js';

// Minimal migration runner: tracks applied files in schema_migrations and
// applies every migrations/*.sql not yet recorded, in filename order, each in
// its own transaction. No framework — just enough to add migrations safely.
const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, '..', 'migrations');

async function main() {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       filename TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ DEFAULT now()
     )`,
  );

  const { rows } = await pool.query<{ filename: string }>(
    `SELECT filename FROM schema_migrations`,
  );
  const applied = new Set(rows.map((r) => r.filename));

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  let ran = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    await withTransaction(async (client) => {
      await client.query(sql);
      await client.query(`INSERT INTO schema_migrations (filename) VALUES ($1)`, [file]);
    });
    console.log(`Applied ${file}`);
    ran++;
  }

  console.log(ran === 0 ? 'No pending migrations.' : `Applied ${ran} migration(s).`);
}

main()
  .catch((err) => {
    console.error('Migration failed:', err.message);
    process.exitCode = 1;
  })
  .finally(closePool);
