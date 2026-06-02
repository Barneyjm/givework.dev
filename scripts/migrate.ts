import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool, closePool } from '../src/db.js';

// Apply migrations/001_init.sql. No migration framework yet — a single file
// applied idempotently-ish (it will error if run twice; drop the DB to re-run).
const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const sql = readFileSync(join(__dirname, '..', 'migrations', '001_init.sql'), 'utf8');
  await pool.query(sql);
  console.log('Migration 001_init.sql applied.');
}

main()
  .catch((err) => {
    console.error('Migration failed:', err.message);
    process.exitCode = 1;
  })
  .finally(closePool);
