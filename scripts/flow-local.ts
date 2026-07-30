// The local flow rig — the pre-release gate. Runs the FULL production story on
// this machine: real Hono server (local port) → real HTTP backend → real
// runLoop → real `claude -p` (your own Claude Code subscription credit; never
// an API key) → real submit/decomposition/review/publish mechanics against the
// local podman test Postgres. Five releases in one night (v0.3.1–v0.3.5) each
// fixed a bug that only ever surfaced by burning volunteer cents in
// production, because nothing ran this story locally. This does.
//
//   npm run flow:local            # real `claude -p` — spends YOUR credit (cents)
//   npm run flow:smoke            # deterministic stub saga — no model, no spend
//
// Flags: --max-runs N   cap on real model invocations (default 8)
//
// The rig TRUNCATEs the database it points at. It therefore refuses anything
// that isn't a local Postgres and defaults to the podman test DB on :5433.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const stubMode = argv.includes('--stub') || process.env.EXECUTOR === 'stub';
const maxRunsFlag = argv[argv.indexOf('--max-runs') + 1];
const MAX_MODEL_RUNS =
  argv.includes('--max-runs') && Number.isInteger(Number(maxRunsFlag)) && Number(maxRunsFlag) > 0
    ? Number(maxRunsFlag)
    : 8;

// --- Environment BEFORE any src import (src/db.ts reads DATABASE_URL at import time).
const LOCAL_DB = 'postgres://postgres:postgres@localhost:5433/givework';
const provided = process.env.FLOW_DATABASE_URL ?? process.env.DATABASE_URL;
const looksLocal = !!provided && /@(localhost|127\.0\.0\.1)[:/]/.test(provided);
if (provided && !looksLocal) {
  console.log(`! DATABASE_URL is not local — the rig TRUNCATEs, so using ${LOCAL_DB} instead.`);
}
process.env.DATABASE_URL = looksLocal ? provided : LOCAL_DB;
process.env.JWT_SECRET ??= 'flow-rig-local-secret';
process.env.EXECUTOR = stubMode ? 'stub' : 'claude';
const promptLogPath = join(tmpdir(), `givework-flow-prompts-${Date.now()}.jsonl`);
process.env.GIVEWORK_PROMPT_LOG = promptLogPath;
// Rig isolation, learned the hard way on the rig's own first real run:
//  - the runner's outbox must NEVER be the volunteer's real ~/.givework/outbox
//    (a rig failure would archive junk into the owner's real dead-letter spool);
//  - a real model happily emits a code_contribution, and the runner would open
//    a REAL PR on the public contrib repo — point it at a black-hole repo so
//    the publish fails fast and the rig exercises the fallback-to-inline path
//    instead of touching GitHub.
process.env.GIVEWORK_OUTBOX_DIR = mkdtempSync(join(tmpdir(), 'givework-flow-outbox-'));
process.env.GIVEWORK_CONTRIB_REPO ??= 'givework-flow-rig/black-hole-does-not-exist';
// A proposal run that also authors a code contribution flirts with the 180s
// default window (observed live: run #2 finished at ~3 min, run #3 timed out).
// The rig's job is to exercise the flow, not the timeout, so default wider —
// the timeout-salvage path still gets organic coverage whenever a run is slow.
process.env.EXECUTOR_TIMEOUT_MS ??= '300000';

const banner = (s: string) => console.log(`\n━━ ${s}`);

banner(`Flow rig — ${stubMode ? 'STUB smoke (no model, no spend)' : 'REAL `claude -p`'}`);
console.log(`   DB:          ${process.env.DATABASE_URL}`);
console.log(`   prompt log:  ${promptLogPath}`);
if (!stubMode) {
  console.log(
    '   ⚠ this mode spends YOUR Claude Code subscription credit (a few cents per run,\n' +
      `     at most ${MAX_MODEL_RUNS} model runs). No API key is used or accepted.`,
  );
}

// --- Migrate (subprocess so the migration runner's own pool lifecycle stays intact).
banner('Migrating the local database');
const mig = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/migrate.ts'], {
  stdio: 'inherit',
  env: process.env,
});
if (mig.status !== 0) {
  console.error('Migration failed — is the podman Postgres up? (podman start givework-pg)');
  process.exit(1);
}

// --- Now it is safe to import the app and the saga driver.
const { serve } = await import('@hono/node-server');
const { app } = await import('../src/app.js');
const { closePool, pool } = await import('../src/db.js');
const { HttpBackend, runLoop } = await import('../src/run-loop.js');
const { getExecutor } = await import('../src/executor.js');
const saga = await import('./flow-saga.js');
const {
  contributionsFor,
  devSpentCents,
  FLOW_SUBTASK_CEILING_CENTS,
  openReviewTasks,
  publishedSubtasks,
  REJECT_REASONS,
  resetFlowData,
  runStubOutboxStage,
  runStubSaga,
  seedFlowFixture,
  StageError,
  totalBookedCents,
} = saga;

banner('Booting the control plane (real Hono server, local port)');
const { server, port } = await new Promise<{ server: { close(): void }; port: number }>(
  (resolve) => {
    const s = serve({ fetch: app.fetch, port: 0 }, (info) =>
      resolve({ server: s, port: info.port }),
    );
  },
);
const baseUrl = `http://127.0.0.1:${port}`;
console.log(`   listening on ${baseUrl}`);

banner('Seeding the flow fixture (target + C4-shaped parent task + two budgeted devs)');
await resetFlowData();
const fx = await seedFlowFixture();
console.log(`   parent task ${fx.parentTaskId} (cap ${saga.FLOW_PARENT_CAP_CENTS}¢)`);

interface PromptEvent {
  event: 'prompt' | 'result';
  task_id: string;
  prompt?: string;
  outcome?: string;
  parse_mode?: string;
  actual_cost_cents?: number;
  timed_out?: boolean;
  crashed?: boolean;
  [k: string]: unknown;
}

function readPromptLog(): PromptEvent[] {
  if (!existsSync(promptLogPath)) return [];
  return readFileSync(promptLogPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as PromptEvent);
}

function lastPromptFor(taskId: string): string {
  const prompts = readPromptLog().filter((e) => e.event === 'prompt' && e.task_id === taskId);
  return prompts.at(-1)?.prompt ?? '';
}

async function parentStatus(): Promise<string> {
  const { rows } = await pool.query<{ status: string }>(
    `SELECT status::text AS status FROM tasks WHERE id = $1`,
    [fx.parentTaskId],
  );
  return rows[0].status;
}

function fail(stage: string, msg: string, details?: unknown): never {
  throw new StageError(stage, msg, details);
}

/**
 * The real-model saga. Server mechanics that must be exercised
 * DETERMINISTICALLY (the rejection flow-back) are scripted over the same HTTP
 * surface at zero model cost; everything else — proposals, reviews, prompt
 * assembly, parsing, submits — is the genuine `claude -p` path, asserted after
 * every run against the DB and against the prompt the model was actually shown.
 */
async function runClaudeSaga(): Promise<void> {
  const backendA = new HttpBackend(baseUrl, fx.tokenA);
  const backendB = new HttpBackend(baseUrl, fx.tokenB);
  const executor = getExecutor();
  const loopOpts = { maxTasks: 1, watch: false, intervalMs: 1000, stopOnError: true };
  let modelRuns = 0;
  let forcedRejectionDone = false;
  let flowbackPromptAsserted = false;

  const guard = () => {
    if (modelRuns >= MAX_MODEL_RUNS) {
      fail(
        'budget-guard',
        `saga did not converge within ${MAX_MODEL_RUNS} model runs — stopping before more spend`,
      );
    }
    modelRuns++;
  };

  for (;;) {
    // Terminal success: subtasks published → prove they're claimable and stop.
    const published = await publishedSubtasks(fx.targetId);
    if (published.length > 0) {
      const fromIds = new Set(published.map((t) => t.decomposed_from));
      if (fromIds.size !== 1) {
        fail('publish', 'published subtasks point at more than one proposal', published);
      }
      banner(
        `PUBLISHED: ${published.length} subtasks from contribution ${published[0].decomposed_from}`,
      );
      for (const t of published) console.log(`   - [${t.max_cost_cents}¢] ${t.title}`);
      const cheapest = [...published].sort((x, y) => x.max_cost_cents - y.max_cost_cents)[0];
      const co = await backendA.checkout(cheapest.id);
      if (typeof co.spec?.prompt !== 'string') {
        fail('publish', 'published subtask checkout lacks its proposed prompt', co);
      }
      await backendA.release(cheapest.id);
      console.log(
        `   ✓ published subtask ${cheapest.id.slice(0, 8)} is claimable (checked out + released)`,
      );
      return;
    }

    // A review is pending: first one gets the scripted rejection (deterministic
    // flow-back exercise, zero model cost); later ones go to the real model.
    const reviews = await openReviewTasks(fx.targetId);
    if (reviews.length > 0) {
      const review = reviews[0];
      if (!forcedRejectionDone) {
        banner(
          `Scripted rejection of review ${review.id.slice(0, 8)} (no model spend — exercises flow-back)`,
        );
        const co = await backendB.checkout(review.id);
        await backendB.submit({
          task_id: co.task_id,
          result: { approve: false, reasons: REJECT_REASONS, summary: 'Scripted rig rejection' },
          actual_cost_cents: 0,
          raw_usage: { rig: 'flow-local', scripted: true },
          summary: 'Scripted rig rejection (flow-back exercise)',
        });
        forcedRejectionDone = true;
        const contribs = await contributionsFor(fx.parentTaskId);
        const back = contribs.at(-1);
        if (back?.artifact?.review_rejected !== true || back.cost_cents !== 0) {
          fail(
            'flow-back',
            'rejected review did not land a review_rejected contribution on the parent',
            contribs,
          );
        }
        console.log('   ✓ review_rejected contribution landed on the PARENT task, cost 0');
        continue;
      }
      guard();
      banner(
        `Model run #${modelRuns}: real \`claude -p\` REVIEWS ${review.id.slice(0, 8)} (dev B)`,
      );
      await runLoop(backendB, executor, { ...loopOpts, taskId: review.id });
      // v0.3.6's incident, asserted on the wire: the reviewer's prompt must
      // state the REVIEWED task's caps (REVIEW CONTEXT) and must NOT render a
      // decomposition limit from the review task's own 15¢ budget.
      const reviewPrompt = lastPromptFor(review.id);
      if (reviewPrompt) {
        if (
          !reviewPrompt.includes('REVIEW CONTEXT') ||
          !reviewPrompt.includes(`at most ${FLOW_SUBTASK_CEILING_CENTS}¢`) ||
          reviewPrompt.includes('DECOMPOSITION LIMITS for THIS task')
        ) {
          fail(
            'prompt-review-caps',
            "the review prompt did not state the REVIEWED task's caps (v0.3.6 regression)",
            { promptLogPath },
          );
        }
        console.log(
          `   ✓ review prompt stated the REVIEWED task's caps (ceiling ${FLOW_SUBTASK_CEILING_CENTS}¢)`,
        );
      }
      const stillOpen = (await openReviewTasks(fx.targetId)).some((r) => r.id === review.id);
      const ev = readPromptLog()
        .filter((e) => e.event === 'result' && e.task_id === review.id)
        .at(-1);
      console.log(
        `   review run: parse_mode=${ev?.parse_mode ?? 'n/a'} cost=${ev?.actual_cost_cents ?? '?'}¢ still_open=${stillOpen}`,
      );
      if (stillOpen && ev == null) {
        fail('review', 'review run produced neither a verdict nor a recorded execution', {
          review,
        });
      }
      continue;
    }

    // No review pending: the parent needs a proposal run.
    const status = await parentStatus();
    if (status === 'submitted') {
      fail(
        'proposal',
        'the model answered the parent TERMINALLY instead of decomposing — a sweep it cannot ' +
          'execute was "completed"; inspect the prompt log and the contribution artifact',
        { promptLogPath, contributions: await contributionsFor(fx.parentTaskId) },
      );
    }
    const before = await contributionsFor(fx.parentTaskId);
    guard();
    banner(`Model run #${modelRuns}: real \`claude -p\` PROPOSES on the parent (dev A)`);
    await runLoop(backendA, executor, { ...loopOpts, taskId: fx.parentTaskId });
    const after = await contributionsFor(fx.parentTaskId);
    if (after.length <= before.length) {
      fail(
        'proposal',
        'model run recorded NO contribution (execution failed and the task was released) — ' +
          'donated-compute-never-lost is violated if tokens were burned',
        { promptLogPath },
      );
    }
    const last = after.at(-1);
    console.log(
      `   contribution #${last?.id}: outcome=${last?.outcome} cost=${last?.cost_cents}¢ ` +
        `parse_mode=${last?.raw_usage?.parse_mode ?? last?.raw_usage?.usage?.parse_mode ?? 'n/a'}`,
    );
    if (last?.summary) console.log(`   summary: ${String(last.summary).slice(0, 160)}`);

    // Prompt-contract assertions — what the model was ACTUALLY shown.
    const prompt = lastPromptFor(fx.parentTaskId);
    if (
      !prompt.includes('DECOMPOSITION LIMITS') ||
      !prompt.includes(`at most ${FLOW_SUBTASK_CEILING_CENTS}`)
    ) {
      fail(
        'prompt-caps',
        'the prompt did not state the COMPUTED decomposition caps (v0.3.5 regression)',
        {
          promptLogPath,
        },
      );
    }
    console.log(
      `   ✓ prompt stated the computed caps (at most ${FLOW_SUBTASK_CEILING_CENTS}¢/subtask)`,
    );
    if (before.length > 0 && !prompt.includes('CONTINUATION')) {
      fail(
        'prompt-continuation',
        'a re-attempt prompt carried NO continuation section (v0.3.1 regression)',
        {
          promptLogPath,
        },
      );
    }
    if (before.length > 0) console.log('   ✓ prompt carried the continuation section');
    if (forcedRejectionDone && !flowbackPromptAsserted) {
      if (!prompt.includes('REJECTED') || !prompt.includes('tighten the caps')) {
        fail(
          'prompt-flow-back',
          "the proposer's prompt after a rejection did not contain the reviewer's reasons (v0.3.5 regression)",
          { promptLogPath },
        );
      }
      flowbackPromptAsserted = true;
      console.log("   ✓ prompt carried the reviewer's rejection reasons");
    }
  }
}

let exitCode = 0;
try {
  if (stubMode) {
    banner('Running the deterministic stub saga (server mechanics + prompt contract)');
    const report = await runStubSaga(baseUrl, fx);
    banner('Running the loss-proofing stage (real runLoop + outbox over HTTP)');
    await runStubOutboxStage(baseUrl, fx);
    banner(`STUB SAGA GREEN — ${report.stages.length + 1} stages`);
  } else {
    await runClaudeSaga();
    banner('REAL-MODEL SAGA GREEN');
  }
  const booked = await totalBookedCents(fx.targetId);
  const [spentA, spentB] = [await devSpentCents(fx.devA), await devSpentCents(fx.devB)];
  banner('Cost meter');
  console.log(`   booked contributions: ${booked}¢ total`);
  console.log(`   dev A (proposer) spent ${spentA}¢ · dev B (reviewer) spent ${spentB}¢`);
  console.log(`   prompt/result transcript: ${promptLogPath}`);
} catch (err) {
  exitCode = 1;
  if (err instanceof StageError) {
    banner(`FAILED at stage: ${err.stage}`);
    console.error(`   ${err.message}`);
    if (err.details !== undefined) {
      console.error('   evidence:');
      console.error(JSON.stringify(err.details, null, 2).slice(0, 4000));
    }
    console.error(`   full prompt/result transcript: ${promptLogPath}`);
  } else {
    banner('FAILED (unexpected error)');
    console.error(err);
  }
} finally {
  server.close();
  await closePool().catch(() => {});
}
process.exit(exitCode);
