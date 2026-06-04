import { pool, closePool } from '../src/db.js';

// One-off: drop a single PUBLIC test task into the database so a self-serve
// (unverified) dev can claim it with `givework run`. Self-guards against writing
// to the wrong database: it only proceeds if it finds the dev row that the prod
// OAuth login created (github_handle below, with a github_id set) — i.e. this
// DATABASE_URL is really the DB the control plane reads.

const DEV_HANDLE = process.env.SEED_DEV_HANDLE ?? 'Barneyjm';

async function main() {
  const dev = await pool.query<{ id: string; github_id: string | null; verified: boolean }>(
    `SELECT id, github_id, verified FROM devs WHERE github_handle = $1`,
    [DEV_HANDLE],
  );
  if (dev.rowCount === 0 || !dev.rows[0].github_id) {
    throw new Error(
      `Refusing to seed: no OAuth-created dev '${DEV_HANDLE}' in this database. ` +
        `This DATABASE_URL is probably not the production DB the Worker uses.`,
    );
  }
  console.log(`✓ Confirmed prod DB (found dev ${DEV_HANDLE}, verified=${dev.rows[0].verified}).`);

  // Find-or-create a throwaway nonprofit to own the task.
  const npName = 'Givework Test (dummy)';
  let np = await pool.query<{ id: string }>(`SELECT id FROM nonprofits WHERE name = $1`, [npName]);
  if (np.rowCount === 0) {
    np = await pool.query<{ id: string }>(
      `INSERT INTO nonprofits (name, contact_email, verified) VALUES ($1, $2, true) RETURNING id`,
      [npName, 'test@givework.dev'],
    );
    console.log(`+ created nonprofit ${np.rows[0].id}`);
  }
  const nonprofitId = np.rows[0].id;

  // A small, genuinely-doable PUBLIC task: cheap cap, real prompt, simple schema —
  // so it works with the stub executor AND with EXECUTOR=claude (`claude -p`).
  const spec = {
    prompt:
      'Summarize the following note in one short, plain-English sentence.\n\n' +
      '"The Tuesday volunteer dinner is moving from the church basement to the ' +
      'community center on Elm St, starting next week, same 6pm time."',
    output_schema: { summary: 'string' },
    acceptance: 'A single plain-English sentence.',
  };

  const task = await pool.query<{ id: string }>(
    `INSERT INTO tasks (nonprofit_id, title, spec, est_cost_cents, max_cost_cents, model, sensitivity)
     VALUES ($1, $2, $3, $4, $5, $6, 'public')
     RETURNING id`,
    [nonprofitId, 'Summarize a short note (test)', JSON.stringify(spec), 20, 100, 'claude-sonnet-4-6'],
  );

  console.log(`\n✓ Seeded PUBLIC task ${task.rows[0].id}`);
  console.log(`  title: "Summarize a short note (test)"  cap: 100¢  model: claude-sonnet-4-6`);
  console.log(`\nClaim it:`);
  console.log(`  npx github:Barneyjm/givework.dev run --once               # stub executor (no credit)`);
  console.log(`  EXECUTOR=claude npx github:Barneyjm/givework.dev run --once  # real claude -p`);
}

main()
  .catch((err) => {
    console.error('seed failed:', err.message);
    process.exitCode = 1;
  })
  .finally(closePool);
