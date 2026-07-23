import { signAdminToken, signDevToken } from '../src/auth.js';
import { closePool, pool } from '../src/db.js';

// Seeds a volunteer dev plus a few open conjectures with budgeted attack tasks,
// for manual curl-ing against `npm run dev`. Targets are upserted by slug, so
// this composes with (and overlaps) scripts/seed-conjectures.ts. Two conjectures
// are wired to the built-in auto_rerun witness checkers (src/verify.ts), so a
// submitted counterexample is machine-verified end to end — the Euler one can
// actually be flipped to 'disproven' with the classic Lander–Parkin witness
// (see the curl example printed at the end).

interface TaskFixture {
  title: string;
  kind: 'computational' | 'counterexample_search' | 'formalization' | 'lemma' | 'exploration';
  verify_via: 'auto_rerun' | 'proof_checker' | 'replication' | 'human_review';
  spec: Record<string, unknown>;
  est: number;
  max: number;
}

interface ConjectureFixture {
  slug: string;
  name: string;
  statement_plain: string;
  statement_formal: string | null;
  source_ref: string | null;
  checker: string | null; // names a built-in checker in src/verify.ts
  tasks: TaskFixture[];
}

const CONJECTURES: ConjectureFixture[] = [
  {
    slug: 'goldbach',
    name: "Goldbach's conjecture",
    statement_plain: 'Every even integer greater than 2 is the sum of two primes.',
    statement_formal: '∀ n ∈ ℤ, n > 2 ∧ 2 ∣ n → ∃ p q, prime(p) ∧ prime(q) ∧ n = p + q',
    source_ref: 'OEIS A002375',
    checker: 'goldbach',
    tasks: [
      {
        title: 'Counterexample sweep: even n in [4, 1,000,000]',
        kind: 'counterexample_search',
        verify_via: 'auto_rerun',
        spec: {
          prompt:
            'Search even integers in the assigned range for one with no two-prime ' +
            'decomposition. Submit any hit as a candidate_solution with result {"n": <int>}; ' +
            'otherwise report progress with the highest n verified in state_update.cursor.',
          range: [4, 1_000_000],
          witness_shape: { n: 'even integer > 2' },
        },
        est: 200,
        max: 400,
      },
      {
        title: 'Extend verified range past prior cursor',
        kind: 'computational',
        verify_via: 'auto_rerun',
        spec: {
          prompt:
            'Resume from state.cursor (see checkout target_state) and extend the verified ' +
            'range. Chip what your budget allows; hand off with an updated cursor.',
          resumable: true,
        },
        est: 300,
        max: 500,
      },
    ],
  },
  {
    slug: 'euler-sum-of-powers',
    name: "Euler's sum of powers conjecture (k = 5)",
    statement_plain:
      'No four positive fifth powers sum to a fifth power: a⁵+b⁵+c⁵+d⁵ = e⁵ has no solution.',
    statement_formal: '¬∃ a b c d e ∈ ℤ⁺, a⁵ + b⁵ + c⁵ + d⁵ = e⁵',
    source_ref: 'Lander & Parkin 1966, Math. Comp. 21',
    checker: 'euler_sum_of_powers',
    tasks: [
      {
        title: 'Witness search: e ≤ 250',
        kind: 'counterexample_search',
        verify_via: 'auto_rerun',
        spec: {
          prompt:
            'Search for positive integers with a⁵+b⁵+c⁵+d⁵ = e⁵, e ≤ 250. Submit a hit as a ' +
            'candidate_solution with result {"bases": [a,b,c,d], "target": e}.',
          witness_shape: { bases: '[4 positive ints]', target: 'positive int' },
        },
        est: 150,
        max: 300,
      },
    ],
  },
  {
    slug: 'collatz',
    name: 'Collatz conjecture',
    statement_plain:
      'Iterating n → n/2 (even) / 3n+1 (odd) from any positive integer eventually reaches 1.',
    statement_formal: null,
    source_ref: 'OEIS A006577',
    checker: null, // no built-in checker — submissions wait for human review
    tasks: [
      {
        title: 'Convergence sweep: n in [1, 10^7], log max excursion',
        kind: 'computational',
        verify_via: 'replication',
        spec: {
          prompt:
            'Verify every n in the assigned range reaches 1; record the largest intermediate ' +
            'value and total stopping time extremes in the artifact. Resumable via state.cursor.',
          range: [1, 10_000_000],
          resumable: true,
        },
        est: 400,
        max: 600,
      },
      {
        title: 'Survey: constraints on nontrivial cycle length',
        kind: 'exploration',
        verify_via: 'human_review',
        spec: {
          prompt:
            'Summarize known lower bounds on the length of a nontrivial Collatz cycle and the ' +
            'techniques behind them; cite sources. Deliver a handoff note a prover could build on.',
        },
        est: 150,
        max: 250,
      },
    ],
  },
];

async function main() {
  const dev = (
    await pool.query(
      `INSERT INTO devs (github_handle, email) VALUES ($1, $2)
       ON CONFLICT (github_handle) DO UPDATE SET email = EXCLUDED.email
       RETURNING id`,
      ['demo-dev', 'demo@example.com'],
    )
  ).rows[0];

  // $20 budget for the current period.
  await pool.query(
    `INSERT INTO dev_budgets (dev_id, period, budget_cents)
     VALUES ($1, date_trunc('month', now())::date, 2000)
     ON CONFLICT (dev_id, period) DO UPDATE SET budget_cents = EXCLUDED.budget_cents`,
    [dev.id],
  );

  const taskIds: string[] = [];
  const slugs: string[] = [];
  for (const c of CONJECTURES) {
    const target = (
      await pool.query(
        `INSERT INTO targets (kind, slug, name, statement_plain, statement_formal, source_ref, checker)
         VALUES ('conjecture', $1, $2, $3, $4, $5, $6)
         ON CONFLICT (slug) WHERE slug IS NOT NULL DO UPDATE SET
           name = EXCLUDED.name,
           statement_plain = EXCLUDED.statement_plain,
           statement_formal = EXCLUDED.statement_formal,
           source_ref = EXCLUDED.source_ref,
           checker = EXCLUDED.checker
         RETURNING id`,
        [c.slug, c.name, c.statement_plain, c.statement_formal, c.source_ref, c.checker],
      )
    ).rows[0];
    slugs.push(c.slug);

    for (const t of c.tasks) {
      // Tasks have no natural unique key, so re-runs dedupe on (target, title)
      // to keep the script idempotent (no inflated tasks_total on the public
      // pages after a second seed).
      const existing = await pool.query<{ id: string }>(
        `SELECT id FROM tasks WHERE target_id = $1 AND title = $2 LIMIT 1`,
        [target.id, t.title],
      );
      if (existing.rows[0]) {
        taskIds.push(existing.rows[0].id);
        continue;
      }
      const row = (
        await pool.query(
          `INSERT INTO tasks
             (target_id, title, spec, est_cost_cents, max_cost_cents, model, kind, verify_via)
           VALUES ($1, $2, $3, $4, $5, $6, $7::task_kind, $8::verification_method) RETURNING id`,
          [
            target.id,
            t.title,
            JSON.stringify(t.spec),
            t.est,
            t.max,
            'claude-opus-4-8',
            t.kind,
            t.verify_via,
          ],
        )
      ).rows[0];
      taskIds.push(row.id);
    }
  }

  // Tokens so the authenticated endpoints are immediately curl-able.
  const devToken = await signDevToken(dev.id);
  const adminToken = await signAdminToken();

  console.log('Seeded demo fixtures:');
  console.log('  dev_id     =', dev.id);
  console.log('  conjectures =', slugs.join(', '));
  console.log('  task_ids   =', taskIds.join(', '));
  console.log('\n  DEV_TOKEN  =', devToken);
  console.log('  ADMIN_TOKEN=', adminToken);
  console.log('\nTry (identity comes from the token, not the body):');
  console.log(`  curl http://localhost:3000/conjectures/${slugs[0]}`);
  console.log(`  curl -H "authorization: Bearer ${devToken}" http://localhost:3000/tasks/open`);
  console.log(
    `  curl -X POST http://localhost:3000/checkout \\\n    -H "authorization: Bearer ${devToken}" -H 'content-type: application/json' \\\n    -d '{"task_id":"${taskIds[0]}"}'`,
  );
  console.log(
    '\nDisprove Euler (k=5) with the Lander–Parkin witness — checkout the ' +
      `"Witness search: e ≤ 250" task, then:\n` +
      `  curl -X POST http://localhost:3000/submit \\\n    -H "authorization: Bearer ${devToken}" -H 'content-type: application/json' \\\n    -d '{"task_id":"<that task id>","actual_cost_cents":50,"outcome":"candidate_solution","summary":"Lander–Parkin 1966","result":{"bases":[27,84,110,133],"target":144}}'`,
  );
}

main()
  .catch((err) => {
    console.error('Seed failed:', err.message);
    process.exitCode = 1;
  })
  .finally(closePool);
