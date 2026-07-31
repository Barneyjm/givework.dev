import { mkdtempSync, readdirSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { signDevToken } from '../src/auth.js';
import { pool } from '../src/db.js';
import { buildContinuationSection, type Executor, reviewContextSection } from '../src/executor.js';
import {
  type Backend,
  HttpBackend,
  runLoop,
  type SubmitArgs,
  type SubmitResult,
} from '../src/run-loop.js';
import { WorkUnitExecutor } from '../src/workunit.js';

// The flow saga — the shared story driver behind scripts/flow-local.ts (the
// pre-release rig) and test/flow-smoke.test.ts (the no-spend CI smoke). It
// exercises the FULL production loop over the real HTTP server against the
// local test Postgres: checkout → submit → decomposition validation/salvage →
// review-task mint → review verdict → rejection flow-back → publish →
// published-subtask checkout. Five releases in one night (v0.3.1–v0.3.5) each
// fixed one bug in this story that only ever ran in production; this file is
// where that story runs locally.
//
// Deliberately HTTP-first: every dev operation goes through HttpBackend
// against a live server, never through operations.ts directly — the point is
// to run the same rail a volunteer's runner rides.

/** Parent task cap, in cents. Small enough that a real sweep can't fit — the C4 shape. */
export const FLOW_PARENT_CAP_CENTS = 40;
/** The computed per-subtask ceiling validation enforces (2x the parent cap). */
export const FLOW_SUBTASK_CEILING_CENTS = FLOW_PARENT_CAP_CENTS * 2;

/** The scripted reviewer's rejection — asserted later in the proposer's next prompt. */
export const REJECT_REASONS =
  'Subtask cost caps look padded relative to the work described, and the slices overlap: ' +
  'tighten the caps and make the ranges disjoint before resubmitting.';

/** A saga assertion failure: which stage broke, with the evidence attached. */
export class StageError extends Error {
  constructor(
    public readonly stage: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(`[${stage}] ${message}`);
    this.name = 'StageError';
  }
}

function expectStage(cond: unknown, stage: string, msg: string, details?: unknown): asserts cond {
  if (!cond) throw new StageError(stage, msg, details);
}

export interface FlowFixture {
  targetId: string;
  parentTaskId: string;
  devA: string; // proposer
  devB: string; // reviewer
  tokenA: string;
  tokenB: string;
}

/** TRUNCATE everything — same scope as test/helpers.resetDb (local test DB only). */
export async function resetFlowData(): Promise<void> {
  await pool.query(
    `TRUNCATE ledger, verifications, contributions, funnel_events, tasks, intake_attachments,
              intake_requests, dev_budgets, target_budgets, target_identifiers, targets, devs
              RESTART IDENTITY CASCADE`,
  );
}

/**
 * Seed the rig's fixture: one flow-rig conjecture, one C4-shaped parent task
 * (a mechanical sweep that plainly cannot run inside a 40¢ model window — the
 * honest deliverable is a decomposition), and two budgeted devs: A proposes,
 * B reviews.
 */
export async function seedFlowFixture(): Promise<FlowFixture> {
  const target = await pool.query<{ id: string }>(
    `INSERT INTO targets (name, kind, slug, statement_plain, contact_email)
     VALUES ('Flow-rig sweep conjecture', 'conjecture', 'flow-rig',
             'Every even integer in [4, 10^7] is the sum of two primes (rig-local restatement).',
             'flow-rig@localhost')
     RETURNING id`,
  );
  const targetId = target.rows[0].id;
  const parent = await pool.query<{ id: string }>(
    `INSERT INTO tasks (target_id, title, spec, est_cost_cents, max_cost_cents, model, effort,
                        kind, verify_via, sensitivity)
     VALUES ($1, $2, $3, 20, $4, 'by-effort', 'medium'::task_effort,
             'computational'::task_kind, 'human_review'::verification_method,
             'public'::data_sensitivity)
     RETURNING id`,
    [
      targetId,
      'Sweep [4, 10^7]: verify the two-prime decomposition and record minimal partitions',
      JSON.stringify({
        prompt:
          'Verify computationally that every even integer n in [4, 10^7] is the sum of two ' +
          'primes, recording for each decade the minimal prime p such that n - p is prime. ' +
          'This requires actually executing a sieve-based search program over the full range ' +
          'and reporting computed counts — imagined or extrapolated output is worthless here.',
        output_schema: {
          ranges_verified: 'string — the exact ranges the executed sweep covered',
          summary: 'string — handoff note',
        },
        acceptance: 'Counts must come from a real program run, reproducible from the artifact.',
      }),
      FLOW_PARENT_CAP_CENTS,
    ],
  );
  const devA = await pool.query<{ id: string }>(
    `INSERT INTO devs (github_handle) VALUES ('flow-rig-proposer') RETURNING id`,
  );
  const devB = await pool.query<{ id: string }>(
    `INSERT INTO devs (github_handle) VALUES ('flow-rig-reviewer') RETURNING id`,
  );
  for (const [dev, cents] of [
    [devA.rows[0].id, 300],
    [devB.rows[0].id, 100],
  ] as const) {
    await pool.query(
      `INSERT INTO dev_budgets (dev_id, period, budget_cents)
       VALUES ($1, date_trunc('month', now())::date, $2)`,
      [dev, cents],
    );
  }
  return {
    targetId,
    parentTaskId: parent.rows[0].id,
    devA: devA.rows[0].id,
    devB: devB.rows[0].id,
    tokenA: await signDevToken(devA.rows[0].id),
    tokenB: await signDevToken(devB.rows[0].id),
  };
}

// ---------------------------------------------------------------------------
// DB peeks — the assertions read the same rows production debugging reads.
// ---------------------------------------------------------------------------

export interface ContributionRow {
  id: number;
  task_id: string;
  dev_id: string;
  outcome: string;
  summary: string | null;
  artifact: any;
  cost_cents: number;
  raw_usage: any;
}

export async function contributionsFor(taskId: string): Promise<ContributionRow[]> {
  const { rows } = await pool.query<ContributionRow>(
    `SELECT id, task_id, dev_id, outcome::text AS outcome, summary, artifact, cost_cents, raw_usage
       FROM contributions WHERE task_id = $1 ORDER BY id ASC`,
    [taskId],
  );
  return rows;
}

/** Open decomposition-review tasks on the target (spec.review_of is the marker). */
export async function openReviewTasks(targetId: string) {
  const { rows } = await pool.query<{ id: string; spec: any; status: string }>(
    `SELECT id, spec, status::text AS status FROM tasks
      WHERE target_id = $1 AND spec ? 'review_of' AND status = 'open'
      ORDER BY created_at ASC`,
    [targetId],
  );
  return rows;
}

/** Every task published from an approved decomposition on this target. */
export async function publishedSubtasks(targetId: string) {
  const { rows } = await pool.query<{
    id: string;
    title: string;
    status: string;
    max_cost_cents: number;
    decomposed_from: number;
    spec: any;
  }>(
    `SELECT id, title, status::text AS status, max_cost_cents, decomposed_from, spec
       FROM tasks WHERE target_id = $1 AND decomposed_from IS NOT NULL ORDER BY created_at ASC`,
    [targetId],
  );
  return rows;
}

export async function totalBookedCents(targetId: string): Promise<number> {
  const { rows } = await pool.query<{ total: number }>(
    `SELECT COALESCE(SUM(cost_cents), 0)::bigint AS total FROM contributions WHERE target_id = $1`,
    [targetId],
  );
  return rows[0].total;
}

export async function devSpentCents(devId: string): Promise<number> {
  const { rows } = await pool.query<{ spent_cents: number }>(
    `SELECT spent_cents FROM dev_budgets
      WHERE dev_id = $1 AND period = date_trunc('month', now())::date`,
    [devId],
  );
  return rows[0]?.spent_cents ?? 0;
}

// ---------------------------------------------------------------------------
// Hand-crafted proposals — the stub saga's scripted model outputs.
// ---------------------------------------------------------------------------

/** A proposal whose only subtask prices itself over the 2x ceiling — tonight's v0.3.2 shape. */
export function overpricedProposal() {
  return {
    reason: 'A 10^7 sweep cannot execute inside a 40 cent model window.',
    subtasks: [
      {
        title: 'Sweep the whole range in one go',
        prompt: 'Run the full sieve over [4, 10^7] and report all minimal partitions.',
        kind: 'computational',
        effort: 'high',
        est_cost_cents: 100,
        max_cost_cents: FLOW_SUBTASK_CEILING_CENTS + 20, // breaks the 2x-parent cap
      },
    ],
  };
}

/** A rule-abiding two-phase proposal (write the program first; fan out later). */
export function correctedProposal(revision: number) {
  return {
    reason:
      'The sweep needs executed code; phase 1 writes the reviewable program, later ' +
      `decompositions fan out pinned chunks (revision ${revision}).`,
    subtasks: [
      {
        title: `Write the sieve program (rev ${revision})`,
        prompt:
          'Write a small, reviewable sieve program that verifies the two-prime decomposition ' +
          'over a given range and emit it as a code_contribution.',
        kind: 'computational',
        effort: 'medium',
        est_cost_cents: 30,
        max_cost_cents: 60,
      },
      {
        title: `Survey known verification frontiers (rev ${revision})`,
        prompt: 'Summarize the published verification frontier for this statement.',
        kind: 'exploration',
        effort: 'low',
        est_cost_cents: 10,
        max_cost_cents: 20,
      },
      {
        title: `Design the chunking scheme (rev ${revision})`,
        prompt: 'Propose disjoint range slices sized for 64-chunk fan-out.',
        kind: 'exploration',
        effort: 'low',
        est_cost_cents: 10,
        max_cost_cents: 20,
      },
    ],
  };
}

/** The proposal whose phase-1 program ships WITH it — the v0.3.8 incident shape. */
export function codeShippingProposal() {
  return {
    reason:
      'The sweep needs executed code; the reviewable sieve program ships with this very ' +
      'proposal as a code_contribution.',
    subtasks: [
      {
        title: 'Validate the shipped sieve against known small ranges',
        prompt:
          'Check the shipped sieve program (see the code contribution riding this proposal) ' +
          'against the published verification frontier for [4, 10^4].',
        kind: 'exploration',
        effort: 'low',
        est_cost_cents: 10,
        max_cost_cents: 20,
      },
      {
        title: 'Design chunk slices for the shipped sieve',
        prompt: 'Propose disjoint range slices sized for 64-chunk fan-out of the shipped sieve.',
        kind: 'exploration',
        effort: 'low',
        est_cost_cents: 10,
        max_cost_cents: 20,
      },
    ],
  };
}

/** The program that ships with codeShippingProposal — asserted inside the review spec. */
export const SHIPPED_CODE = {
  title: 'Range sieve harness',
  description: 'Executable sieve the fan-out chunks will pin once merged.',
  files: [
    {
      path: 'flow-rig/sieve.py',
      content: 'def sieve(lo, hi):\n    """Two-prime check over [lo, hi]."""\n    ...\n',
    },
  ],
};

/** The PR URL the runner would have set as artifact_uri after publishing SHIPPED_CODE. */
export const SHIPPED_CODE_PR = 'https://github.com/Barneyjm/givework-contrib/pull/424242';

/** Terminal review submit payload (the reviewer's whole result object). */
function reviewSubmit(taskId: string, approve: boolean, reasons: string): SubmitArgs {
  return {
    task_id: taskId,
    result: { approve, reasons, summary: `Reviewed the proposed split: ${approve}` },
    actual_cost_cents: 5,
    raw_usage: { rig: 'flow-saga', scripted: true },
    summary: `Reviewed the proposed split (approve: ${approve})`,
  };
}

export interface StubSagaReport {
  stages: string[];
  proposalContributionId: number;
  publishedTaskIds: string[];
  bookedCents: number;
}

/**
 * The deterministic saga: hand-crafted results driven through the REAL server
 * over REAL HTTP. No model anywhere — this is the CI-safe smoke that pins the
 * server-side mechanics (salvage, mint, flow-back, exactly-once publish) and
 * the prompt CONTRACT (what buildContinuationSection renders from a real
 * checkout payload — the executor injects exactly that into the model prompt).
 */
export async function runStubSaga(
  baseUrl: string,
  fx: FlowFixture,
  log: (line: string) => void = console.log,
): Promise<StubSagaReport> {
  const a = new HttpBackend(baseUrl, fx.tokenA);
  const b = new HttpBackend(baseUrl, fx.tokenB);
  const stages: string[] = [];
  const stage = (name: string, note: string) => {
    stages.push(name);
    log(`  ✓ ${name}: ${note}`);
  };

  // S1 — overpriced proposal is salvaged, never vaporized (v0.3.2).
  let co = await a.checkout(fx.parentTaskId);
  expectStage(co.task_id === fx.parentTaskId, 'S1-checkout', 'parent checkout failed', co);
  expectStage(
    buildContinuationSection(co.target_state, co.prior_contributions ?? [], co.max_cost_cents) ===
      '',
    'S1-checkout',
    'first attempt must get a clean prompt (no continuation section)',
    co,
  );
  let submit: SubmitResult = await a.submit({
    task_id: fx.parentTaskId,
    result: { decomposition: overpricedProposal(), summary: 'Split the sweep (one big slice)' },
    actual_cost_cents: 7,
    raw_usage: { rig: 'flow-saga', scripted: true },
    outcome: 'decomposition',
    summary: 'Split the sweep (one big slice)',
  });
  expectStage(
    submit.salvaged_decomposition?.validation_errors.some((e) => /exceeds/.test(e)),
    'S1-salvage',
    'overpriced proposal must be salvaged with the cap-breach error preserved',
    submit,
  );
  let contribs = await contributionsFor(fx.parentTaskId);
  expectStage(
    contribs.length === 1 &&
      contribs[0].outcome === 'progress' &&
      Array.isArray(contribs[0].artifact?.validation_errors) &&
      contribs[0].artifact?.proposed_decomposition != null,
    'S1-salvage',
    'salvaged proposal + validation_errors must land on the contribution row',
    contribs,
  );
  stage('S1 salvage', `cap-breach preserved: ${contribs[0].artifact.validation_errors[0]}`);

  // S2 — the NEXT agent's context contains the salvage and the computed caps (v0.3.1 + v0.3.5).
  co = await a.checkout(fx.parentTaskId);
  const prior0 = co.prior_contributions?.[0] as { artifact?: { validation_errors?: unknown } };
  expectStage(
    Array.isArray(prior0?.artifact?.validation_errors),
    'S2-continuation',
    'checkout must hydrate the salvaged proposal artifact for the next agent',
    co.prior_contributions,
  );
  const rendered = buildContinuationSection(
    co.target_state,
    co.prior_contributions ?? [],
    co.max_cost_cents,
  );
  expectStage(
    rendered.includes('validation_errors') &&
      rendered.includes(`at most ${FLOW_SUBTASK_CEILING_CENTS}`) &&
      rendered.includes('fix exactly those errors'),
    'S2-continuation',
    'the rendered prompt section must carry the errors AND the computed caps',
    rendered,
  );
  stage(
    'S2 continuation',
    `next prompt carries the errors + "at most ${FLOW_SUBTASK_CEILING_CENTS}¢"`,
  );

  // S3 — corrected proposal mints exactly one review task.
  submit = await a.submit({
    task_id: fx.parentTaskId,
    result: { decomposition: correctedProposal(1), summary: 'Two-phase split, rev 1' },
    actual_cost_cents: 8,
    raw_usage: { rig: 'flow-saga', scripted: true },
    outcome: 'decomposition',
    summary: 'Two-phase split, rev 1',
  });
  let reviews = await openReviewTasks(fx.targetId);
  expectStage(
    reviews.length === 1 && Number.isInteger(reviews[0].spec?.review_of),
    'S3-mint',
    'a valid proposal must mint exactly one open review task',
    { submit, reviews },
  );
  expectStage(
    typeof reviews[0].spec?.prompt === 'string' &&
      reviews[0].spec.prompt.includes('rev 1') &&
      reviews[0].spec?.output_schema?.approve?.startsWith('boolean'),
    'S3-mint',
    'the review task must show the reviewer the actual proposal and a boolean contract',
    reviews[0].spec,
  );
  // v0.3.6's incident: the reviewer must be shown the REVIEWED task's caps
  // (baked in at mint time), never its own 15¢ budget rendered as a limit.
  expectStage(
    reviews[0].spec?.reviewed_max_cost_cents === FLOW_PARENT_CAP_CENTS &&
      reviewContextSection(reviews[0].spec).includes(`at most ${FLOW_SUBTASK_CEILING_CENTS}¢`),
    'S3-mint',
    "the review spec must bake the REVIEWED task's cap and render the parent's ceiling (v0.3.6)",
    reviews[0].spec,
  );
  stage('S3 review mint', `review task ${reviews[0].id.slice(0, 8)} minted`);

  // S4 — rejection flows BACK to the parent task (v0.3.5's flow-back half).
  const review1 = await b.checkout(reviews[0].id);
  await b.submit(reviewSubmit(review1.task_id, false, REJECT_REASONS));
  contribs = await contributionsFor(fx.parentTaskId);
  const flowback = contribs[contribs.length - 1];
  expectStage(
    flowback.artifact?.review_rejected === true &&
      flowback.cost_cents === 0 &&
      String(flowback.artifact?.reasons).includes('caps'),
    'S4-flowback',
    'a rejected review must land a zero-cost review_rejected contribution on the PARENT',
    contribs,
  );
  co = await a.checkout(fx.parentTaskId);
  const rendered2 = buildContinuationSection(
    co.target_state,
    co.prior_contributions ?? [],
    co.max_cost_cents,
  );
  expectStage(
    rendered2.includes('REJECTED') && rendered2.includes('tighten the caps'),
    'S4-flowback',
    "the proposer's next prompt must contain the reviewer's reasons",
    rendered2,
  );
  stage('S4 flow-back', "reviewer's reasons reached the proposer's next prompt");

  // S5 — corrected resubmit, approval, publish exactly once.
  submit = await a.submit({
    task_id: fx.parentTaskId,
    result: { decomposition: correctedProposal(2), summary: 'Two-phase split, rev 2' },
    actual_cost_cents: 9,
    raw_usage: { rig: 'flow-saga', scripted: true },
    outcome: 'decomposition',
    summary: 'Two-phase split, rev 2',
  });
  reviews = await openReviewTasks(fx.targetId);
  expectStage(reviews.length === 1, 'S5-remint', 'the resubmit must mint a fresh review task', {
    submit,
    reviews,
  });
  const review2 = await b.checkout(reviews[0].id);
  const approved = await b.submit(
    reviewSubmit(review2.task_id, true, 'Disjoint slices, proportionate caps — publish.'),
  );
  const published = await publishedSubtasks(fx.targetId);
  expectStage(
    published.length === correctedProposal(2).subtasks.length &&
      published.every((t) => t.status === 'open'),
    'S5-publish',
    'approval must publish every subtask of the approved proposal, open and claimable',
    { approved, published },
  );
  const fromIds = new Set(published.map((t) => t.decomposed_from));
  expectStage(
    fromIds.size === 1,
    'S5-publish',
    'published subtasks must all point at ONE proposal contribution (exactly-once)',
    published,
  );
  const proposalContributionId = published[0].decomposed_from;
  stage(
    'S5 publish',
    `${published.length} subtasks published from contribution ${proposalContributionId}`,
  );

  // S6 — a published subtask is real: checkout works and books a reservation.
  const cheapest = [...published].sort((x, y) => x.max_cost_cents - y.max_cost_cents)[0];
  const sub = await a.checkout(cheapest.id);
  expectStage(
    sub.task_id === cheapest.id && typeof sub.spec?.prompt === 'string',
    'S6-subtask',
    'a published subtask must be claimable with its proposed prompt intact',
    sub,
  );
  await a.release(cheapest.id);
  stage('S6 subtask checkout', `claimed + released ${cheapest.id.slice(0, 8)}`);

  // S8 — code shipped WITH a proposal travels to the reviewer (the review-3
  // incident: reviewer rejected a code-shipping proposal because "the actual
  // proposal contains no code_contribution key — the simulation code is
  // absent"). S7 is the outbox stage in runStubOutboxStage.
  await a.checkout(fx.parentTaskId);
  submit = await a.submit({
    task_id: fx.parentTaskId,
    result: {
      decomposition: codeShippingProposal(),
      code_contribution: SHIPPED_CODE,
      summary: 'Split the sweep and shipped the sieve program',
    },
    actual_cost_cents: 6,
    raw_usage: { rig: 'flow-saga', scripted: true },
    outcome: 'decomposition',
    summary: 'Split the sweep and shipped the sieve program',
    artifact_uri: SHIPPED_CODE_PR, // what the runner sets after publishing the code PR
  });
  reviews = await openReviewTasks(fx.targetId);
  expectStage(
    reviews.length === 1,
    'S8-code',
    'the code-shipping proposal must mint exactly one review task',
    { submit, reviews },
  );
  const codeSpec = reviews[0].spec;
  expectStage(
    codeSpec?.code_published_at === SHIPPED_CODE_PR &&
      typeof codeSpec?.prompt === 'string' &&
      codeSpec.prompt.includes(`code published at: ${SHIPPED_CODE_PR}`) &&
      codeSpec.prompt.includes('flow-rig/sieve.py') &&
      codeSpec.prompt.includes('def sieve(lo, hi)') &&
      reviewContextSection(codeSpec).includes(`published at ${SHIPPED_CODE_PR}`),
    'S8-code',
    "the review spec must carry the shipped code — PR URL, file listing, and the executor's context note",
    codeSpec,
  );
  // The inline copy is durable server-side, GitHub up or down.
  contribs = await contributionsFor(fx.parentTaskId);
  const codeProposal = contribs[contribs.length - 1];
  expectStage(
    codeProposal.outcome === 'decomposition' &&
      String(codeProposal.artifact?.code_contribution?.files?.[0]?.content).includes('def sieve'),
    'S8-code',
    "the code_contribution must persist inline on the proposal contribution's artifact",
    codeProposal,
  );
  const review3 = await b.checkout(reviews[0].id);
  await b.submit(
    reviewSubmit(review3.task_id, true, 'The split ships its reviewable program — publish.'),
  );
  const publishedNow = await publishedSubtasks(fx.targetId);
  const fromCode = publishedNow.filter((t) => t.decomposed_from === codeProposal.id);
  expectStage(
    fromCode.length === codeShippingProposal().subtasks.length &&
      fromCode.every((t) => t.status === 'open'),
    'S8-code',
    'approving the code-shipping proposal must publish its subtasks, open and claimable',
    publishedNow,
  );
  stage('S8 code-to-reviewer', `review saw the code; ${fromCode.length} more subtasks published`);

  const bookedCents = await totalBookedCents(fx.targetId);
  await a.close();
  await b.close();
  return {
    stages,
    proposalContributionId,
    publishedTaskIds: published.map((t) => t.id),
    bookedCents,
  };
}

// ---------------------------------------------------------------------------
// Loss-proofing stage (v0.3.3): the REAL runLoop + REAL outbox over REAL HTTP,
// with one simulated network drop between "work finished" and "submit landed".
// ---------------------------------------------------------------------------

/**
 * Delegate everything; while the "network" is down, every submit fails with a
 * transient error (runLoop retries the replay within one call, so a fail-once
 * fake would land the payload before the loop even returned — the drop must
 * persist for the whole first run, then heal for the "next runner start").
 */
class DroppedNetworkBackend implements Backend {
  readonly kind = 'flaky-http';
  private down = true;
  constructor(private readonly inner: Backend) {}
  heal() {
    this.down = false;
  }
  getBudget() {
    return this.inner.getBudget();
  }
  listOpenTasks(args: Parameters<Backend['listOpenTasks']>[0]) {
    return this.inner.listOpenTasks(args);
  }
  checkout(taskId: string) {
    return this.inner.checkout(taskId);
  }
  submit(args: SubmitArgs) {
    if (this.down) {
      return Promise.reject(new Error('simulated network drop (flow rig)'));
    }
    return this.inner.submit(args);
  }
  heartbeat(taskId: string) {
    return this.inner.heartbeat(taskId);
  }
  release(taskId: string) {
    return this.inner.release(taskId);
  }
  close() {
    return this.inner.close();
  }
}

/**
 * Prove the donation survives the worst window: executor finishes (spend is
 * real), the submit's network drops — the payload must spool to disk, the task
 * must stay claimed, and the next runner start must replay it to a booked
 * contribution. Uses the real runLoop and a scripted no-model executor.
 */
export async function runStubOutboxStage(
  baseUrl: string,
  fx: FlowFixture,
  log: (line: string) => void = console.log,
): Promise<void> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO tasks (target_id, title, spec, est_cost_cents, max_cost_cents, model)
     VALUES ($1, 'Loss-proofing probe', '{"prompt":"tiny"}', 5, 10, 'by-effort')
     RETURNING id`,
    [fx.targetId],
  );
  const taskId = rows[0].id;
  const scripted: Executor = {
    execute: async () => ({
      result: { output: 'flow-rig loss-proofing probe' },
      actual_cost_cents: 3,
      raw_usage: { rig: 'flow-saga', scripted: true },
    }),
  };
  const prevOutbox = process.env.GIVEWORK_OUTBOX_DIR;
  const outboxDir = mkdtempSync(join(tmpdir(), 'givework-flow-outbox-'));
  process.env.GIVEWORK_OUTBOX_DIR = outboxDir;
  try {
    const flaky = new DroppedNetworkBackend(new HttpBackend(baseUrl, fx.tokenA));
    const loopOpts = { maxTasks: 1, watch: false, intervalMs: 0, stopOnError: false, taskId };

    await runLoop(flaky, scripted, loopOpts);
    const spooled = readdirSync(outboxDir).filter((n) => n.endsWith('.json'));
    expectStage(
      spooled.length === 1,
      'S7-outbox',
      'a dropped submit must leave exactly one spooled payload on disk',
      spooled,
    );
    let contribs = await contributionsFor(taskId);
    expectStage(
      contribs.length === 0,
      'S7-outbox',
      'nothing must book before the replay',
      contribs,
    );

    // "Next runner start": the network is back, and a fresh loop replays the
    // spool before claiming any new work.
    flaky.heal();
    await runLoop(flaky, scripted, loopOpts);
    contribs = await contributionsFor(taskId);
    expectStage(
      contribs.length === 1 && contribs[0].artifact == null && contribs[0].cost_cents === 3,
      'S7-outbox',
      'the replay must book the spooled work exactly once',
      contribs,
    );
    const left = readdirSync(outboxDir).filter((n) => n.endsWith('.json'));
    expectStage(left.length === 0, 'S7-outbox', 'a landed replay must clear the spool', left);
    log('  ✓ S7 loss-proofing: dropped submit spooled, replayed, booked exactly once');
  } finally {
    if (prevOutbox === undefined) delete process.env.GIVEWORK_OUTBOX_DIR;
    else process.env.GIVEWORK_OUTBOX_DIR = prevOutbox;
  }
}

// ---------------------------------------------------------------------------
// S9 — the formalization rail: proof_checker goes live
// ---------------------------------------------------------------------------

const LEAN_REPO = 'Barneyjm/givework-contrib';
const LEAN_SHA = '7ec361511299227e007d8523b70c4554218a8531';
const LEAN_ENTRYPOINT = 'lean/canary/Canary.lean';
const LEAN_MARKER = '__GIVEWORK_LEAN_EXIT__';

/** A WorkUnitExecutor whose git checkout plants the lean4 manifest and whose
 * podman run replays a captured container transcript — the REAL runtime
 * interpretation (exit marker, sorry guard, artifact shaping) runs on it, so
 * the submitted shapes cannot drift from production. Deterministic, no
 * podman, no spend. */
function scriptedLeanExecutor(transcript: string): WorkUnitExecutor {
  return new WorkUnitExecutor({
    allowedRepo: LEAN_REPO,
    run: async (cmd, args, opts) => {
      if (cmd === 'git' && args[0] === 'checkout' && opts?.cwd) {
        const entryDir = join(opts.cwd, dirname(LEAN_ENTRYPOINT));
        await mkdir(entryDir, { recursive: true });
        await writeFile(join(entryDir, 'manifest.json'), JSON.stringify({ runtime: 'lean4' }));
        return '';
      }
      return cmd === 'podman' && args[0] === 'run' ? transcript : '';
    },
  });
}

async function seedLeanChunkTask(targetId: string, title: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO tasks (target_id, title, spec, est_cost_cents, max_cost_cents, model, effort,
                        kind, verify_via, sensitivity)
     VALUES ($1, $2, $3, 0, 20, 'by-effort', 'low'::task_effort,
             'formalization'::task_kind, 'proof_checker'::verification_method,
             'public'::data_sensitivity)
     RETURNING id`,
    [
      targetId,
      title,
      JSON.stringify({
        prompt: 'Work unit: compile the pinned .lean file; exit 0 is the verdict.',
        code: { repo: LEAN_REPO, sha: LEAN_SHA, entrypoint: LEAN_ENTRYPOINT, input: {} },
      }),
    ],
  );
  return rows[0].id;
}

/**
 * The formalization stage: a SHA-pinned lean4 chunk rides the SAME HTTP rail a
 * volunteer's runner uses — checkout over HTTP, the real work-unit runtime
 * interpretation on a captured container transcript, submit over HTTP — and
 * the proof_checker verification decides it machine-side. Green: verified &
 * accepted, target untouched (resolution stays an admin act). Red: verdict
 * failed, task pooled, and the next checkout hydrates the compiler output as
 * correction context.
 */
export async function runStubProofCheckerStage(
  baseUrl: string,
  fx: FlowFixture,
  log: (line: string) => void = console.log,
): Promise<void> {
  const a = new HttpBackend(baseUrl, fx.tokenA);

  const runChunk = async (taskId: string, transcript: string): Promise<SubmitResult> => {
    const co = await a.checkout(taskId);
    expectStage(co.task_id === taskId, 'S9-proof-checker', 'chunk checkout failed', co);
    const exec = await scriptedLeanExecutor(transcript).execute(co);
    return a.submit({
      task_id: taskId,
      result: exec.result,
      actual_cost_cents: exec.actual_cost_cents,
      raw_usage: exec.raw_usage,
      outcome: exec.outcome,
      summary: exec.summary,
      artifact: exec.artifact,
    });
  };

  // Green: the machine verdict accepts the chunk with no human in the loop.
  const greenTask = await seedLeanChunkTask(fx.targetId, 'Proof-check the canary lemma (green)');
  const green = await runChunk(greenTask, `\n${LEAN_MARKER} 0\n`);
  expectStage(
    green.status === 'accepted' && green.verification?.verdict === 'passed',
    'S9-proof-checker',
    'a green lean build must verify passed and auto-accept',
    green,
  );
  const target = await pool.query(`SELECT status::text AS status FROM targets WHERE id = $1`, [
    fx.targetId,
  ]);
  expectStage(
    target.rows[0].status === 'open',
    'S9-proof-checker',
    'a green lemma must NOT resolve the conjecture (admin-gated)',
    target.rows[0],
  );

  // Red: the verdict fails the claim, pools the task, and preserves the
  // compiler output where the NEXT agent's checkout will surface it.
  const redTask = await seedLeanChunkTask(fx.targetId, 'Proof-check the canary lemma (red)');
  const diagnostics = `${LEAN_ENTRYPOINT}:1:42: error: unsolved goals\n⊢ False`;
  const red = await runChunk(redTask, `${diagnostics}\n\n${LEAN_MARKER} 1\n`);
  expectStage(
    red.status === 'open' && red.verification?.verdict === 'failed',
    'S9-proof-checker',
    'a red lean build must verify failed and return the task to the pool',
    red,
  );
  const co = await a.checkout(redTask);
  const artifact = co.prior_contributions?.[0]?.artifact as { compiler_output?: string };
  expectStage(
    typeof artifact?.compiler_output === 'string' &&
      artifact.compiler_output.includes('unsolved goals'),
    'S9-proof-checker',
    "the next checkout must hydrate the failed build's compiler output",
    co.prior_contributions,
  );
  const rendered = buildContinuationSection(co.target_state, co.prior_contributions ?? []);
  expectStage(
    rendered.includes('proof checker REJECTED') && rendered.includes('unsolved goals'),
    'S9-proof-checker',
    'the continuation prompt must render the compiler errors as correction context',
    rendered,
  );
  await a.release(redTask);
  log(
    '  ✓ S9 proof_checker: green verified & accepted (target untouched); red pooled with compiler errors flowing back',
  );
}
