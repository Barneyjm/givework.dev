import { closePool, pool } from '../src/db.js';

// Seed a starter set of well-known open problems as public `conjecture` targets.
// Idempotent (ON CONFLICT on the slug), so it's safe to re-run. Edit this list or
// add your own via the admin API: POST /admin/targets
//   { name, slug, kind:"conjecture", statement_plain, source_ref, checker? }
//
// `checker` names a built-in auto_rerun verifier (see src/verify.ts). A conjecture
// with a checker can have a submitted counterexample machine-verified; without
// one, candidate solutions fall to human review.

interface SeedConjecture {
  name: string;
  slug: string;
  statement_plain: string;
  source_ref: string;
  checker?: string;
}

const CONJECTURES: SeedConjecture[] = [
  {
    name: 'Collatz conjecture',
    slug: 'collatz',
    statement_plain:
      'For every positive integer n, iterating n → n/2 (if even) or 3n+1 (if odd) eventually reaches 1.',
    source_ref: 'OEIS A006577',
  },
  {
    name: "Goldbach's conjecture",
    slug: 'goldbach',
    statement_plain: 'Every even integer greater than 2 is the sum of two primes.',
    source_ref: 'OEIS A002375',
    checker: 'goldbach',
  },
  {
    name: 'Twin prime conjecture',
    slug: 'twin-primes',
    statement_plain: 'There are infinitely many primes p such that p + 2 is also prime.',
    source_ref: 'OEIS A001359',
  },
  {
    name: "Euler's sum of powers conjecture (k = 5)",
    slug: 'euler-sum-of-powers',
    statement_plain:
      'No fifth power of a positive integer is the sum of four smaller positive fifth powers. (Historically disproven — a live demo of machine-verified disproof.)',
    source_ref: 'Lander & Parkin, 1966',
    checker: 'euler_sum_of_powers',
  },
];

async function main() {
  let inserted = 0;
  for (const c of CONJECTURES) {
    const { rowCount } = await pool.query(
      `INSERT INTO targets (name, kind, slug, statement_plain, source_ref, checker)
       VALUES ($1, 'conjecture', $2, $3, $4, $5)
       ON CONFLICT (slug) WHERE slug IS NOT NULL DO NOTHING`,
      [c.name, c.slug, c.statement_plain, c.source_ref, c.checker ?? null],
    );
    const isNew = rowCount === 1;
    if (isNew) inserted++;
    console.log(`  ${isNew ? '+' : '·'} ${c.slug.padEnd(22)} ${c.name}`);
  }
  console.log(
    `\nSeeded ${inserted} new conjecture(s) (${CONJECTURES.length - inserted} already present).`,
  );
  console.log('Public progress pages: GET /conjectures/<slug>   ·   leaderboard: GET /leaderboard');
}

main()
  .catch((err) => {
    console.error('seed-conjectures failed:', err.message ?? err);
    process.exitCode = 1;
  })
  .finally(closePool);
