import { closePool, pool } from '../src/db.js';

// Seed one "author an explainer video" task per public target that doesn't have a
// video yet. The deliverable is the two files our production pipeline consumes —
// a narration/copy spec and a diagram-first Manim scene — both documented in
// video/README.md (the authoring kit, with viz.py and two reference scenes).
//
//   npm run seed-video-tasks              # every video-less public target
//   npm run seed-video-tasks -- --kind conjecture --limit 40
//
// Idempotent: skips a target that already has an open/locked video task (matched
// on spec->>'deliverable' = 'explainer_video').
//
// These are authoring tasks that run on a volunteer's own agent, so they carry a
// smaller budget than a math attack task.
const EST_CENTS = 150;
const MAX_CENTS = 400;
const MODEL = 'claude-opus-4-8';
// The runner has no checkout of this repo, so the guide is referenced by raw URL.
const RAW = 'https://raw.githubusercontent.com/Barneyjm/givework.dev/main/video';

// Slugs whose video already exists in R2 (givework.dev/videos/<slug>.mp4). Passed
// in so this script needs no network: refresh with scripts/list-videos.sh or by
// probing the public URL.
const HAVE_VIDEO = new Set(
  (process.env.HAVE_VIDEO ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

interface Row {
  id: string;
  slug: string;
  name: string;
  statement_plain: string | null;
  significance: string | null;
}

function prompt(t: Row): string {
  return [
    `Write a short (~90 second) diagram-first explainer video for "${t.name}" — the kind of video where an animation carries the idea and text is only a caption.`,
    '',
    t.statement_plain ? `The problem: ${t.statement_plain}` : '',
    t.significance ? `Why it matters: ${t.significance}` : '',
    '',
    'Read the authoring kit first — it is binding. Fetch all four:',
    `  ${RAW}/README.md   (file shapes, narration rules, house style)`,
    `  ${RAW}/viz.py      (the shared kit: BeatScene, palette, helpers)`,
    `  ${RAW}/sc_collatz.py  and  ${RAW}/collatz.json   (a complete reference scene and its spec)`,
    '',
    'Produce exactly two files:',
    `  1. ${t.slug}/explainer/${t.slug}.json — the spec: name, subtitle, statement, optional tex, background[], why[], impact[], and a narration{} script with one spoken line per beat (title, statement, background, why, impact).`,
    `  2. ${t.slug}/explainer/sc_${t.slug}.py — a Manim scene, class ConjectureVideo(BeatScene), importing the shared kit from viz.py. Each beat calls self.narrate("<beat>") first and self.close_beat() last; use self.pace(...) for waits between. Do NOT write a close beat — the shared call-to-action outro is appended downstream.`,
    '',
    'The single most important requirement: DRAW THE MATHEMATICS. Find the one picture that makes this problem click — the trajectory, the graph, the curve, the distribution, the counterexample — and animate it. A beat that is just a bulleted list of sentences is a failed beat. Study the two reference scenes shipped in video/ (sc_collatz.py, sc_reconstruction.py) and match their idioms and palette.',
    '',
    'Verify your scene actually renders before submitting, using the podman/docker command in the README, and extract a few frames to confirm the diagrams are legible and nothing overlaps or runs off-screen. Compute the data you display rather than hard-coding it, so the picture cannot drift from the arithmetic.',
    '',
    'Every factual claim will be fact-checked before publishing. State honestly what is known versus conjectured, and never invent bounds, dates, or attributions. If you are unsure of a historical detail, leave it out.',
    '',
    `Deliver all of it in the code_contribution field of your JSON output, as files under ${t.slug}/explainer/ — that is what opens the pull request. If you run out of budget partway, submit what you have as progress with a clear note on what remains; the next contributor picks up from your spec.`,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const kindArg = args.includes('--kind') ? args[args.indexOf('--kind') + 1] : null;
  const limitArg = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : null;

  const { rows } = await pool.query<Row>(
    `SELECT t.id, t.slug, t.name, t.statement_plain, t.significance
       FROM targets t
      WHERE t.slug IS NOT NULL
        AND t.kind::text = ANY($1::text[])
        AND ($2::text IS NULL OR t.kind::text = $2)
        AND NOT EXISTS (
          SELECT 1 FROM tasks k
           WHERE k.target_id = t.id
             AND k.spec->>'deliverable' = 'explainer_video'
             AND k.status IN ('open', 'locked', 'submitted', 'accepted')
        )
      ORDER BY t.kind, t.name`,
    [['conjecture', 'research_question'], kindArg],
  );

  const targets = rows.filter((r) => !HAVE_VIDEO.has(r.slug));
  const slice = limitArg ? targets.slice(0, limitArg) : targets;
  console.log(
    `${rows.length} target(s) without a video task; ${targets.length} still need a video` +
      `${limitArg ? `; seeding ${slice.length}` : ''}`,
  );

  let inserted = 0;
  for (const t of slice) {
    const spec = {
      deliverable: 'explainer_video',
      angle: 'find the one picture that makes this problem click, and animate it',
      prompt: prompt(t),
      guide: 'video/README.md',
      files: [`${t.slug}/explainer/${t.slug}.json`, `${t.slug}/explainer/sc_${t.slug}.py`],
      // Authoring a full scene took ~13 minutes in testing; the executor's 3-minute
      // default kills it. Runners read this to widen their timeout for this task.
      suggested_timeout_ms: 1_500_000,
      acceptance:
        'Both files submitted; the scene renders with no errors; every beat is a diagram, not a list of text; all factual claims are accurate and verifiable.',
      output_schema: {
        code_contribution:
          '{title, description, files:[{path, content}]} — the spec, the scene, and a short README under <slug>/explainer/',
        summary: 'string — one-line handoff for the contribution feed',
        honest_status:
          'string — did it render? which beats are diagram-complete, and what remains?',
      },
    };
    await pool.query(
      `INSERT INTO tasks (target_id, title, spec, est_cost_cents, max_cost_cents, model, kind, verify_via, sensitivity)
       VALUES ($1, $2, $3, $4, $5, $6, 'exploration', 'human_review', 'public')`,
      [t.id, `Make the explainer video for ${t.name}`, spec, EST_CENTS, MAX_CENTS, MODEL],
    );
    inserted++;
    console.log(`  + ${t.slug}`);
  }
  console.log(`\nSeeded ${inserted} explainer-video task(s).`);
}

main()
  .catch((err) => {
    console.error('seed-video-tasks failed:', err.message ?? err);
    process.exitCode = 1;
  })
  .finally(closePool);
