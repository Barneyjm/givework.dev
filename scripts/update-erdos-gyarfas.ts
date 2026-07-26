import { closePool, pool } from '../src/db.js';

// One-off enrichment of the erdos-gyarfas target row, seeded bare by
// seed-wiki-conjectures.ts (statement + one-line "why", no checker, no
// progress state). This fills in significance, source_ref, tags, checker,
// and a real `state` snapshot from an active exhaustive-search campaign at
// n=30 -- the largest size where a counterexample only has to dodge three
// cycle lengths (4, 8, 16; a 32-cycle cannot fit). Idempotent: safe to re-run
// with fresh `state` numbers as the campaign progresses.
//
//   npm run update-erdos-gyarfas          # against .env DATABASE_URL

const SIGNIFICANCE =
  'A 30-vertex counterexample only has to dodge three cycle lengths -- 4, 8, ' +
  '16; a 32-cycle cannot fit that few vertices -- making n=30 the largest ' +
  'size where the search stays this tractable. An exhaustive campaign has ' +
  'closed girth >= 7 as a genuine theorem, not just an exhausted search ' +
  'space: a spectral moment certificate (M = A^4 - 6A^2 + A + 4I forces ' +
  'tr(M^2) >= 34^2, which pins an 8-cycle into every cubic girth->=7 graph ' +
  'up to n=33) rules out that whole case by hand-checkable algebra. Girth 6 ' +
  'is being swept exhaustively (122,090,544 graphs; zero survivors so far). ' +
  'A feasibility check confirmed no comparable spectral certificate exists ' +
  'at girth 5 or 6, so those cases are provably search-only, not ' +
  'theorem-shaped -- which is exactly where donated compute matters most.';

const SOURCE_REF = 'https://github.com/Barneyjm/givework-contrib';

async function main() {
  // Live campaign snapshot -- edit before each re-run to reflect current progress.
  const state = {
    frontier_n: 30,
    conditions: 'no 4-cycle, no 8-cycle, no 16-cycle (a 32-cycle cannot fit n=30)',
    girth_ge_7: 'closed -- theorem (spectral moment certificate, valid up to n=33)',
    girth_6: {
      method: 'exhaustive geng generation + cycle filter, chunked across cores',
      chunks_done: 31,
      chunks_total: 48,
      graphs_checked: 73_454_856,
      graphs_total: 122_090_544,
      survivors: 0,
    },
    girth_5: 'open -- ~1.46e10 graphs; no spectral certificate exists (checked)',
    girth_3:
      'open -- largest case; a triangle-contraction reduction to n=28 is validated and ready',
  };

  const { rows } = await pool.query<{ updated: boolean }>(
    `UPDATE targets SET
       significance = $2,
       source_ref   = $3,
       tags         = (SELECT array_agg(DISTINCT t) FROM unnest(tags || $4::text[]) AS t),
       checker      = $5,
       state        = $6::jsonb
     WHERE slug = $1
     RETURNING true AS updated`,
    [
      'erdos-gyarfas',
      SIGNIFICANCE,
      SOURCE_REF,
      ['small-cases', 'computational-search'],
      'erdos_gyarfas',
      JSON.stringify(state),
    ],
  );

  if (!rows.length) {
    console.error('No target with slug=erdos-gyarfas found -- run seed-wiki-conjectures first.');
    process.exitCode = 1;
    return;
  }
  console.log('Updated erdos-gyarfas: significance, source_ref, tags, checker, state.');
  console.log('  source_ref:', SOURCE_REF);
  console.log('  checker:', 'erdos_gyarfas');
  console.log('  state:', JSON.stringify(state, null, 2));
}

main()
  .catch((err) => {
    console.error('update-erdos-gyarfas failed:', err.message ?? err);
    process.exitCode = 1;
  })
  .finally(closePool);
