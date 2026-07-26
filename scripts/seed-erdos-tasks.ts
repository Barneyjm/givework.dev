import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { closePool, pool } from '../src/db.js';

// Seed the attack tasks for the curated Erdős problems (see seed-erdos.ts).
// Two per problem, each taking a deliberately different angle — one hands-on
// computational/search attack, one structural or heuristic reframing — so an
// agent picking one up is pushed somewhere the literature hasn't already been.
//
//   npm run seed-erdos-tasks              # every problem
//   npm run seed-erdos-tasks -- --limit 10
//
// Idempotent: skips a (target, title) pair that already has a live task, so a
// re-run tops up rather than duplicating.
//
// Data lives in scripts/erdos-tasks.json, keyed to targets by erdos_number ->
// slug `erdos-<n>`.
const EST_CENTS = 300;
const MAX_CENTS = 700;
// These want genuine mathematical reasoning, not throughput.
const EFFORT = 'high';

interface ErdosTask {
  erdos_number: number;
  title: string;
  kind: string;
  spec: {
    angle: string;
    prompt: string;
    acceptance: string;
    output_schema: Record<string, string>;
  };
}

const dataPath = fileURLToPath(new URL('./erdos-tasks.json', import.meta.url));
const TASKS: ErdosTask[] = JSON.parse(readFileSync(dataPath, 'utf8'));

async function main() {
  const args = process.argv.slice(2);
  const limitArg = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : null;

  // slug -> target id, for the curated Erdős problems only
  const { rows: targets } = await pool.query<{ id: string; slug: string }>(
    `SELECT id, slug FROM targets WHERE slug LIKE 'erdos-%' AND kind::text = 'research_question'`,
  );
  const bySlug = new Map(targets.map((t) => [t.slug, t.id]));

  const slice = limitArg ? TASKS.slice(0, limitArg) : TASKS;
  let inserted = 0;
  let skipped = 0;
  const missing = new Set<string>();

  for (const t of slice) {
    const slug = `erdos-${t.erdos_number}`;
    const targetId = bySlug.get(slug);
    if (!targetId) {
      missing.add(slug);
      continue;
    }
    // idempotency: same target + same title already live?
    const { rows: dupe } = await pool.query(
      `SELECT 1 FROM tasks
        WHERE target_id = $1 AND title = $2
          AND status IN ('open', 'locked', 'submitted', 'accepted')
        LIMIT 1`,
      [targetId, t.title],
    );
    if (dupe.length) {
      skipped++;
      continue;
    }
    await pool.query(
      `INSERT INTO tasks (target_id, title, spec, est_cost_cents, max_cost_cents, effort,
                          kind, verify_via, sensitivity)
       VALUES ($1, $2, $3, $4, $5, $6::task_effort, $7::task_kind, 'human_review', 'public')`,
      [targetId, t.title, t.spec, EST_CENTS, MAX_CENTS, EFFORT, t.kind],
    );
    inserted++;
    console.log(`  + ${slug.padEnd(12)} ${t.title.slice(0, 68)}`);
  }

  console.log(`\nSeeded ${inserted} task(s); ${skipped} already present.`);
  if (missing.size) {
    console.log(`No target for: ${[...missing].join(', ')} — run \`npm run seed-erdos\` first.`);
  }
}

main()
  .catch((err) => {
    console.error('seed-erdos-tasks failed:', err.message ?? err);
    process.exitCode = 1;
  })
  .finally(closePool);
