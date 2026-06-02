import { pool, closePool } from '../src/db.js';

// Creates a dev, a nonprofit, and a few open tasks for manual curl-ing.
// Mirrors acceptance criterion 1 (a $5-max task against a $20 budget).
async function main() {
  const dev = (
    await pool.query(
      `INSERT INTO devs (github_handle, email) VALUES ($1, $2) RETURNING id`,
      ['demo-dev', 'demo@example.com'],
    )
  ).rows[0];

  const np = (
    await pool.query(
      `INSERT INTO nonprofits (name, contact_email, verified) VALUES ($1, $2, true) RETURNING id`,
      ['Demo Charity', 'charity@example.com'],
    )
  ).rows[0];

  // $20 budget for the current period.
  await pool.query(
    `INSERT INTO dev_budgets (dev_id, period, budget_cents)
     VALUES ($1, date_trunc('month', now())::date, 2000)
     ON CONFLICT (dev_id, period) DO UPDATE SET budget_cents = EXCLUDED.budget_cents`,
    [dev.id],
  );

  const tasks: string[] = [];
  for (const [title, est, max] of [
    ['Summarize annual report', 300, 500],
    ['Draft grant thank-you emails', 150, 250],
    ['Categorize survey responses', 600, 900],
  ] as const) {
    const t = (
      await pool.query(
        `INSERT INTO tasks (nonprofit_id, title, spec, est_cost_cents, max_cost_cents, model)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [np.id, title, JSON.stringify({ prompt: title }), est, max, 'claude-opus-4-8'],
      )
    ).rows[0];
    tasks.push(t.id);
  }

  console.log('Seeded demo fixtures:');
  console.log('  dev_id      =', dev.id);
  console.log('  nonprofit_id=', np.id);
  console.log('  task_ids    =', tasks.join(', '));
  console.log('\nTry:');
  console.log(`  curl "http://localhost:3000/budget?dev_id=${dev.id}"`);
  console.log(
    `  curl -X POST http://localhost:3000/checkout -H 'content-type: application/json' \\\n    -d '{"dev_id":"${dev.id}","task_id":"${tasks[0]}"}'`,
  );
}

main()
  .catch((err) => {
    console.error('Seed failed:', err.message);
    process.exitCode = 1;
  })
  .finally(closePool);
