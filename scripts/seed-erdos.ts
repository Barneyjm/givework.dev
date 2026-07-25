import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { closePool, pool } from '../src/db.js';

// Seed a curated subset of open, computationally-tractable Erdős problems as
// public `research_question` targets (distinct from the marquee `conjecture`
// targets). Sourced from erdosproblems.com and filtered for a concrete finite
// attack (counterexample search, small-case computation, sequence extension).
// Idempotent (ON CONFLICT on slug), so it's safe to re-run.
//
//   npm run seed-erdos            # against .env DATABASE_URL
//
// Data lives in scripts/erdos-tractable.json (curated + verified). Each record:
//   { number, title, statement_plain, tags[], attack_angle, prize|null, source_url }

interface ErdosProblem {
  number: number;
  title: string;
  statement_plain: string;
  tags: string[];
  attack_angle: string;
  prize: string | null;
  source_url: string;
}

const dataPath = fileURLToPath(new URL('./erdos-tractable.json', import.meta.url));
const PROBLEMS: ErdosProblem[] = JSON.parse(readFileSync(dataPath, 'utf8'));

async function main() {
  let inserted = 0;
  for (const p of PROBLEMS) {
    const slug = `erdos-${p.number}`;
    // Significance doubles as the "how to chip at it" hook on the public page,
    // plus the Erdős bounty when there is one.
    const significance =
      `A tractable open Erdős problem. ${p.attack_angle}` +
      (p.prize ? `  Erdős prize: ${p.prize}.` : '');
    const tags = Array.from(new Set([...p.tags, 'erdos-problem']));
    const { rows } = await pool.query<{ inserted: boolean }>(
      `INSERT INTO targets (name, kind, slug, statement_plain, source_ref, significance, tags)
       VALUES ($1, 'research_question', $2, $3, $4, $5, $6)
       ON CONFLICT (slug) WHERE slug IS NOT NULL DO UPDATE SET
         name = EXCLUDED.name,
         statement_plain = EXCLUDED.statement_plain,
         source_ref = EXCLUDED.source_ref,
         significance = EXCLUDED.significance,
         tags = EXCLUDED.tags
       RETURNING (xmax = 0) AS inserted`,
      [p.title, slug, p.statement_plain, p.source_url, significance, tags],
    );
    const isNew = rows[0]?.inserted ?? false;
    if (isNew) inserted++;
    console.log(`  ${isNew ? '+' : '·'} ${slug.padEnd(14)} ${p.title}`);
  }
  console.log(
    `\nSeeded ${inserted} new Erdős problem(s) (${PROBLEMS.length - inserted} already present).`,
  );
}

main()
  .catch((err) => {
    console.error('seed-erdos failed:', err.message ?? err);
    process.exitCode = 1;
  })
  .finally(closePool);
