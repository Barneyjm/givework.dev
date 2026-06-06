import { closePool, pool } from '../src/db.js';

// One-off: remove the dummy test data seeded by scripts/seed-test-task.ts — the
// 'Givework Test (dummy)' nonprofit, its tasks, their ledger rows — and reset the
// test dev's current-period budget back to zero spend/reserve. Scoped strictly to
// that one nonprofit so it can't touch real data.

const NP_NAME = 'Givework Test (dummy)';
const DEV_HANDLE = process.env.SEED_DEV_HANDLE ?? 'Barneyjm';

async function main() {
  const np = await pool.query<{ id: string }>(`SELECT id FROM nonprofits WHERE name = $1`, [
    NP_NAME,
  ]);
  if (np.rowCount === 0) {
    console.log(`Nothing to clean — no '${NP_NAME}' nonprofit.`);
    return;
  }
  const npId = np.rows[0].id;

  const tasks = await pool.query<{ id: string }>(`SELECT id FROM tasks WHERE nonprofit_id = $1`, [
    npId,
  ]);
  const taskIds = tasks.rows.map((r) => r.id);

  const led = await pool.query(`DELETE FROM ledger WHERE nonprofit_id = $1`, [npId]);
  const tsk = await pool.query(`DELETE FROM tasks WHERE nonprofit_id = $1`, [npId]);
  const npd = await pool.query(`DELETE FROM nonprofits WHERE id = $1`, [npId]);
  console.log(
    `Deleted ${led.rowCount} ledger row(s), ${tsk.rowCount} task(s) (${taskIds.length} ids), ${npd.rowCount} nonprofit.`,
  );

  // Reset the test dev's current-period budget to a clean slate (all spend was test).
  const bud = await pool.query(
    `UPDATE dev_budgets db SET reserved_cents = 0, spent_cents = 0
       FROM devs d
      WHERE db.dev_id = d.id AND d.github_handle = $1
        AND db.period = date_trunc('month', now())::date
      RETURNING db.budget_cents`,
    [DEV_HANDLE],
  );
  if (bud.rowCount)
    console.log(
      `Reset ${DEV_HANDLE}'s budget spend/reserve to 0 (cap ${bud.rows[0].budget_cents}¢).`,
    );

  console.log('✓ Cleanup complete.');
}

main()
  .catch((err) => {
    console.error('cleanup failed:', err.message);
    process.exitCode = 1;
  })
  .finally(closePool);
