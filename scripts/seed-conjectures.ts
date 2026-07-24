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
  significance: string;
  tags: string[];
  checker?: string;
}

const CONJECTURES: SeedConjecture[] = [
  {
    name: 'Collatz conjecture',
    slug: 'collatz',
    statement_plain:
      'For every positive integer n, iterating n → n/2 (if even) or 3n+1 (if odd) eventually reaches 1.',
    source_ref: 'OEIS A006577',
    significance:
      'The emblem of how little we understand simple iteration — Erdős said mathematics is not yet ready for such problems.',
    tags: ['number-theory', 'dynamical-systems'],
  },
  {
    name: "Goldbach's conjecture",
    slug: 'goldbach',
    statement_plain: 'Every even integer greater than 2 is the sum of two primes.',
    source_ref: 'OEIS A002375',
    significance:
      'The oldest famous problem in number theory (1742); the odd/ternary version finally fell in 2013.',
    tags: ['number-theory'],
    checker: 'goldbach',
  },
  {
    name: 'Twin prime conjecture',
    slug: 'twin-primes',
    statement_plain: 'There are infinitely many primes p such that p + 2 is also prime.',
    source_ref: 'OEIS A001359',
    significance:
      'Zhang and Maynard proved gaps of at most 246 recur forever; closing 246 down to 2 is the prize.',
    tags: ['number-theory'],
  },
  {
    name: "Euler's sum of powers conjecture (k = 5)",
    slug: 'euler-sum-of-powers',
    statement_plain:
      'No fifth power of a positive integer is the sum of four smaller positive fifth powers. (Historically disproven — a live demo of machine-verified disproof.)',
    source_ref: 'Lander & Parkin, 1966',
    significance:
      "Euler's 1769 generalization of Fermat stood for two centuries until a computer search found 27⁵+84⁵+110⁵+133⁵ = 144⁵ — the platform re-verifies that witness live.",
    tags: ['number-theory'],
    checker: 'euler_sum_of_powers',
  },
];

async function main() {
  let inserted = 0;
  for (const c of CONJECTURES) {
    const { rows } = await pool.query<{ inserted: boolean }>(
      `INSERT INTO targets (name, kind, slug, statement_plain, source_ref, significance, tags, checker)
       VALUES ($1, 'conjecture', $2, $3, $4, $5, $6, $7)
       ON CONFLICT (slug) WHERE slug IS NOT NULL DO UPDATE SET
         name = EXCLUDED.name,
         statement_plain = EXCLUDED.statement_plain,
         source_ref = EXCLUDED.source_ref,
         significance = EXCLUDED.significance,
         tags = EXCLUDED.tags,
         checker = EXCLUDED.checker
       RETURNING (xmax = 0) AS inserted`,
      [c.name, c.slug, c.statement_plain, c.source_ref, c.significance, c.tags, c.checker ?? null],
    );
    const isNew = rows[0]?.inserted ?? false;
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
