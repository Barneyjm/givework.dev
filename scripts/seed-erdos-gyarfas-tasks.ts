import { closePool, pool } from '../src/db.js';

// Seed real attack tasks for the erdos-gyarfas target, derived directly from
// an active exhaustive-search campaign at n=30 (see update-erdos-gyarfas.ts
// for the campaign snapshot). Four angles, each pushed somewhere the
// campaign itself identified as the genuine next step -- not busywork:
//   - independent replication of the girth->=7 closure
//   - Lean formalization of the spectral certificate that closed it
//   - a real chunk of the girth-5 exhaustive search (the part that
//     genuinely needs more donated compute, not more thinking)
//   - extending the forbidden-configuration pruning catalog
//
// Idempotent: skips a title that already has a live task for this target.
//
//   npm run seed-erdos-gyarfas-tasks

const CHECKER_REF =
  'https://github.com/Barneyjm/givework-contrib/tree/main/erdos-gyarfas/witness-checker';

interface SeedTask {
  title: string;
  kind: 'computational' | 'counterexample_search' | 'formalization' | 'lemma';
  verify_via: 'auto_rerun' | 'proof_checker' | 'replication' | 'human_review';
  est: number;
  max: number;
  spec: {
    angle: string;
    prompt: string;
    acceptance: string;
    output_schema: Record<string, string>;
  };
}

const TASKS: SeedTask[] = [
  {
    title: 'Independently replicate the girth->=7 closure at n=30',
    kind: 'computational',
    verify_via: 'replication',
    est: 600,
    max: 2000,
    spec: {
      angle: 'independent replication',
      prompt:
        'The girth>=7 case at n=30 was closed with an in-house rigid-tree-completion ' +
        'generator, validated at three sizes against independently published data ' +
        '(n=24: exactly 1 class, McGee; n=26: exactly 741,376 raw completions in 3 ' +
        'classes; n=28: found all 21 published Meringer/genreg graphs). The theorem ' +
        '16*c8 >= 1156 - 34n (proof: M = A^4 - 6A^2 + A + 4I gives tr(M^2) = 34n + ' +
        '16*c8 from girth-forced trace identities, while M*1 = 34*1 forces tr(M^2) >= ' +
        '34^2) implies every cubic girth->=7 graph on 30 vertices has c8 >= 9. ' +
        'Independently regenerate the 546 cubic girth-7 graphs on 30 vertices with a ' +
        'different tool (nauty geng with a girth filter, snarkhunter, or your own ' +
        'method) and confirm: (a) the class count is exactly 546, (b) every graph has ' +
        'at least one 8-cycle and at least one 16-cycle. A single exception would be ' +
        'a major result -- report it immediately with the full graph.',
      acceptance:
        'Exact match on both the count (546 classes) and the zero-survivor claim, or ' +
        'a documented exception verified independently before being reported.',
      output_schema: {
        class_count: 'int',
        all_have_8cycle: 'bool',
        all_have_16cycle: 'bool',
        exception_graph6: 'string|null',
      },
    },
  },
  {
    title: 'Formalize the girth->=7 spectral certificate in Lean 4',
    kind: 'formalization',
    verify_via: 'proof_checker',
    est: 700,
    max: 2000,
    spec: {
      angle: 'machine-checked proof',
      prompt:
        'Formalize in Lean 4 (mathlib) the linear-algebra core of the girth->=7 ' +
        'closure: for a symmetric real matrix M with M*1 = c*1 (constant row sum c, ' +
        'as holds for M = A^4 - 6A^2 + A + 4I on a cubic graph, since 3^4-6*3^2+3+4=34), ' +
        'the sum of squared eigenvalues satisfies tr(M^2) >= c^2 (since c is an ' +
        'eigenvalue and the trace is the sum of all squared eigenvalues). Given as a ' +
        'hypothesis the trace identity tr(M^2) = 34n + 16*c8 (derived from girth-forced ' +
        'walk-counting, itself a stretch goal to formalize), conclude 16*c8 >= 1156 - ' +
        '34n, hence c8 > 0 for n <= 33. Cite the walk-counting identity as an axiom or ' +
        'hypothesis if formalizing it from scratch is out of scope for one task.',
      acceptance:
        'A Lean 4 file compiling against a pinned mathlib revision with no `sorry`, ' +
        'proving at minimum the linear-algebra step (row-sum eigenvalue bounds tr(M^2)) ' +
        'and applying it to the n<=33 conclusion given the trace identity as a hypothesis.',
      output_schema: {
        lean_file: 'string',
        compiles: 'bool',
        mathlib_rev: 'string',
        uses_sorry: 'bool',
      },
    },
  },
  {
    title: 'Search a chunk of cubic girth-5 graphs on 30 vertices',
    kind: 'counterexample_search',
    verify_via: 'auto_rerun',
    est: 600,
    max: 2000,
    spec: {
      angle: 'exhaustive chunk search',
      prompt:
        'Girth 5 at n=30 is the genuinely open, compute-bound case: a moment-method ' +
        'feasibility check confirmed no spectral certificate can close it (unlike ' +
        'girth>=7), so it needs real search. Using geng or an equivalent canonical- ' +
        'construction generator, generate connected cubic graphs on 30 vertices with ' +
        'girth exactly 5 for one residue class of a large res/mod split (pick an ' +
        'unclaimed residue from the task state to avoid duplicating another ' +
        "contributor's chunk; start with a modulus that gives your machine a bounded " +
        'run, e.g. a few hours). Filter each graph for an 8-cycle or 16-cycle -- a ' +
        'reference checker is at givework-contrib/erdos-gyarfas/witness-checker ' +
        '(cross-validated against networkx on Heawood and Petersen). Girth 5 already ' +
        'implies no 4-cycle. A graph with none of {4,8,16} is a genuine counterexample ' +
        '-- report it immediately with its full edge list. Otherwise report the exact ' +
        'residue/modulus covered and graph count generated, for completeness ' +
        'accounting against the ~1.46e10 total.',
      acceptance:
        'A progress contribution states the exact residue/modulus/count covered (so ' +
        'the next contributor can pick an unclaimed residue), or a candidate_solution ' +
        'carries a full {n:30, edges:[...]} witness that the erdos_gyarfas checker ' +
        'independently verifies.',
      output_schema: {
        residue: 'int',
        modulus: 'int',
        graphs_generated: 'int',
        survivor_witness: 'object|null',
      },
    },
  },
  {
    title: 'Extend the forbidden two-cycle intersection catalog',
    kind: 'lemma',
    verify_via: 'human_review',
    est: 500,
    max: 1500,
    spec: {
      angle: 'structural pruning lemma',
      prompt:
        'An existing catalog (bounded exhaustive-completion prover, independently ' +
        're-verified by a second cycle-finder and cross-checked against nauty- ' +
        'generated populations) classified how pairs of short cycles intersect in a ' +
        '{4,8}-cycle-free cubic graph -- e.g. two pentagons must be vertex-disjoint or ' +
        'share exactly a 2-edge path; two hexagons never share exactly a 2-path. ' +
        'Extend it: classify pairs not yet covered (octagon-adjacent lengths relevant ' +
        'to girth-5 hosts) or three-cycle configurations (a triangle plus two ' +
        'pentagons, etc.), using the same method -- exhaustive bounded local ' +
        'completion. Every claimed forbidden pattern needs two things before it is ' +
        'trusted: independent re-verification by a second cycle-finder implementation, ' +
        'and a geng-generated population containing the pattern checked to always ' +
        'contain a 4- or 8-cycle. Report each new pattern with its case-enumeration ' +
        'proof and a measured pruning value (fraction of a real generated population ' +
        'it actually kills).',
      acceptance:
        'Each claimed pattern is independently re-verified (two cycle-finders agree; ' +
        'a real generated population confirms it) before being accepted -- an ' +
        'unverified or contradicted claim is rejected, not merely noted.',
      output_schema: {
        new_patterns: 'array',
        proof_method: 'string',
        pruning_coverage_measured: 'object',
      },
    },
  },
];

async function main() {
  const { rows: targetRows } = await pool.query<{ id: string }>(
    `SELECT id FROM targets WHERE slug = 'erdos-gyarfas' AND kind::text = 'conjecture'`,
  );
  const targetId = targetRows[0]?.id;
  if (!targetId) {
    console.error('No target with slug=erdos-gyarfas -- run seed-wiki-conjectures first.');
    process.exitCode = 1;
    return;
  }

  let inserted = 0;
  let skipped = 0;
  for (const t of TASKS) {
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
       VALUES ($1, $2, $3, $4, $5, 'high'::task_effort, $6::task_kind,
               $7::verification_method, 'public')`,
      [targetId, t.title, t.spec, t.est, t.max, t.kind, t.verify_via],
    );
    inserted++;
    console.log(`  + [${t.kind}/${t.verify_via}] ${t.title}`);
  }
  console.log(`\nSeeded ${inserted} task(s) for erdos-gyarfas; ${skipped} already present.`);
  console.log(`Reference checker: ${CHECKER_REF}`);
}

main()
  .catch((err) => {
    console.error('seed-erdos-gyarfas-tasks failed:', err.message ?? err);
    process.exitCode = 1;
  })
  .finally(closePool);
