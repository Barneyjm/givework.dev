import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pool } from '../src/db.js';
import { ClaudeCliExecutor, type Executor } from '../src/executor.js';
import {
  checkoutTask,
  getBudget,
  heartbeatTask,
  listOpenTasks,
  OpError,
  releaseTask,
  submitResult,
  validateDecomposition,
} from '../src/operations.js';
import { type Backend, runLoop, type SubmitArgs, ToolError } from '../src/run-loop.js';
import { submitAndVerify } from '../src/verify.js';
import {
  createDev,
  createTarget,
  createTask,
  getBudgetRow,
  getLedger,
  getTaskRow,
  resetDb,
  setBudget,
} from './helpers.js';

// A near-miss decomposition proposal — parseable subtasks that broke a rule —
// is SALVAGED, never vaporized: the volunteer's tokens were already burned
// producing it, so it books as a progress contribution carrying the FULL
// proposal + a structured validation_errors list, the reservation is released,
// and the task returns to the pool. The next agent sees the proposal and the
// exact errors in its continuation context and can resubmit it corrected.
// Only a proposal with no parseable subtasks at all still hard-rejects.
//
// This mirrors the production incident: parent cap 40¢, a subtask asking for
// 100¢ against the 2x ceiling of 80¢ — previously "work not recorded".

/** A thin Backend over the real operations layer — same code the servers wrap. */
function inProcessBackend(devId: string): Backend {
  const wrap = async <T>(p: Promise<T>): Promise<T> => {
    try {
      return await p;
    } catch (err) {
      if (err instanceof OpError) throw new ToolError(err.code, err.message);
      throw err;
    }
  };
  return {
    kind: 'in-process',
    getBudget: () =>
      wrap(
        getBudget(devId).then((b) => {
          if (!b) throw new OpError(402, 'no_budget', 'no budget');
          return b;
        }),
      ),
    listOpenTasks: (args) =>
      wrap(
        listOpenTasks({ maxCostCents: args.max_cost_cents, limit: args.limit, devId }).then(
          (rows) =>
            rows.map((r) => ({
              id: r.id,
              title: r.title,
              max_cost_cents: r.max_cost_cents,
              model: r.model,
            })),
        ),
      ),
    checkout: (taskId) => wrap(checkoutTask(devId, taskId)),
    submit: (a: SubmitArgs) =>
      wrap(
        submitAndVerify(devId, a.task_id, a.result, a.actual_cost_cents, a.raw_usage, {
          outcome: a.outcome,
          summary: a.summary,
          artifactUri: a.artifact_uri,
          artifact: a.artifact,
          stateUpdate: a.state_update,
        }),
      ),
    heartbeat: async (taskId) => {
      await wrap(heartbeatTask(devId, taskId));
    },
    release: async (taskId) => {
      await wrap(releaseTask(devId, taskId));
    },
    close: async () => {},
  };
}

const CAP_BREACH_ERROR = "subtask 2: max_cost_cents 100 exceeds 2x the parent task's cap (80)";

/** The production near-miss: subtask 2 wants 100¢ against a 2x ceiling of 80¢. */
const capBreachProposal = {
  reason: 'this needs code execution the agent does not have',
  subtasks: [
    {
      title: 'write the sweep program',
      prompt: 'write a reviewable sweep script',
      max_cost_cents: 40,
    },
    { title: 'sweep even residues', prompt: 'sweep the even residue classes', max_cost_cents: 40 },
    { title: 'sweep odd residues', prompt: 'sweep the odd residue classes', max_cost_cents: 100 },
  ],
};

const proposingExecutor = (decomposition: unknown): Executor => ({
  execute: async () => ({
    result: { decomposition },
    outcome: 'decomposition',
    summary: 'too big for its budget — proposing a split',
    actual_cost_cents: 30,
    raw_usage: { tokens: 1 },
  }),
});

async function reviewTaskCount() {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM tasks WHERE spec ? 'review_of'`,
  );
  return rows[0].n as number;
}

const opts = { maxTasks: 1, watch: false, intervalMs: 1, stopOnError: false };

let logs: string[];
let errs: string[];
beforeEach(async () => {
  await resetDb();
  logs = [];
  errs = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    logs.push(a.join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    errs.push(a.join(' '));
  });
});
afterEach(() => vi.restoreAllMocks());

describe('validateDecomposition — the salvage/hard-reject line', () => {
  it('is crisp: parseable = a non-empty array of subtask objects', () => {
    // Nothing to preserve → hard-reject territory.
    expect(validateDecomposition(undefined, 40).parseable).toBe(false);
    expect(validateDecomposition({ subtasks: [] }, 40).parseable).toBe(false);
    expect(validateDecomposition({ subtasks: 'split it' }, 40).parseable).toBe(false);
    expect(validateDecomposition({ subtasks: ['a', 'b'] }, 40).parseable).toBe(false);

    // A real list of subtask objects that broke a rule → salvageable.
    const v = validateDecomposition(capBreachProposal, 40);
    expect(v.parseable).toBe(true);
    expect(v.proposal).toBeNull();
    expect(v.errors).toEqual([CAP_BREACH_ERROR]);

    // A fully valid proposal normalizes with no errors.
    const ok = validateDecomposition(
      { subtasks: [{ title: 't', prompt: 'p', max_cost_cents: 40 }] },
      40,
    );
    expect(ok.errors).toEqual([]);
    expect(ok.proposal?.subtasks).toHaveLength(1);
  });

  it('collects EVERY violation, not just the first — the next agent fixes them all at once', () => {
    const v = validateDecomposition(
      {
        subtasks: [
          { title: 'no prompt here', max_cost_cents: 10 },
          { title: 'over cap', prompt: 'p', max_cost_cents: 100 },
          { title: 'float money', prompt: 'p', max_cost_cents: 10.5 },
        ],
      },
      40,
    );
    expect(v.parseable).toBe(true);
    expect(v.errors).toHaveLength(3);
    expect(v.errors[0]).toMatch(/subtask 0: prompt is required/);
    expect(v.errors[1]).toMatch(/subtask 1: max_cost_cents 100 exceeds/);
    expect(v.errors[2]).toMatch(/subtask 2: max_cost_cents must be a positive integer/);
  });
});

describe('submitResult salvages a near-miss decomposition', () => {
  it('cap breach → progress contribution with the FULL proposal + structured errors; reservation released; task open', async () => {
    const dev = await createDev('proposer');
    const target = await createTarget('Erdos problem');
    const parent = await createTask(target, { est: 20, max: 40, title: 'Oversized attack' });
    await setBudget(dev, 1000);
    await checkoutTask(dev, parent);

    const res = await submitResult(
      dev,
      parent,
      { decomposition: capBreachProposal },
      30,
      { tokens: 1 },
      { outcome: 'decomposition', summary: 'proposing a split' },
    );

    // Booked as progress, honestly reported as a salvage.
    expect(res.outcome).toBe('progress');
    expect(res.status).toBe('open');
    expect(res.salvaged_decomposition).toEqual({ validation_errors: [CAP_BREACH_ERROR] });
    expect(res.review_task_id).toBeUndefined();
    expect(await reviewTaskCount()).toBe(0); // nothing minted, nothing can publish

    // The contribution preserves the whole proposal and the exact errors.
    const { rows } = await pool.query(`SELECT * FROM contributions WHERE id = $1`, [
      res.contribution_id,
    ]);
    expect(rows[0].outcome).toBe('progress');
    expect(rows[0].summary).toBe(
      `Proposed a decomposition that failed validation: ${CAP_BREACH_ERROR}`,
    );
    expect(rows[0].artifact.validation_errors).toEqual([CAP_BREACH_ERROR]);
    expect(rows[0].artifact.proposed_decomposition).toEqual(capBreachProposal);

    // Task back in the pool; budget settled exactly like any progress outcome.
    expect((await getTaskRow(parent)).status).toBe('open');
    const b = await getBudgetRow(dev);
    expect(Number(b.reserved_cents)).toBe(0);
    expect(Number(b.spent_cents)).toBe(30);
    const submitEvents = (await getLedger(dev)).filter((l) => l.event_type === 'submit');
    expect(submitEvents).toHaveLength(1);
    expect(Number(submitEvents[0].delta_cents)).toBe(30 - 40); // spend − released reservation

    // The NEXT checkout hydrates the salvage: proposal + errors ride the
    // prior-contribution artifact, the channel the continuation reads.
    const dev2 = await createDev('next-agent');
    await setBudget(dev2, 1000);
    const co = await checkoutTask(dev2, parent);
    expect(co.prior_contributions[0].outcome).toBe('progress');
    expect(co.prior_contributions[0].summary).toContain('failed validation');
    expect((co.prior_contributions[0].artifact as any).proposed_decomposition).toEqual(
      capBreachProposal,
    );
    expect((co.prior_contributions[0].artifact as any).validation_errors).toEqual([
      CAP_BREACH_ERROR,
    ]);
  });

  it('a valid proposal is untouched by the salvage path: review task minted, no salvage marker', async () => {
    const dev = await createDev('proposer');
    const target = await createTarget();
    const parent = await createTask(target, { est: 20, max: 40 });
    await setBudget(dev, 1000);
    await checkoutTask(dev, parent);

    const res = await submitResult(
      dev,
      parent,
      { decomposition: { subtasks: [{ title: 't', prompt: 'p', max_cost_cents: 40 }] } },
      30,
      null,
      { outcome: 'decomposition', summary: 'a clean split' },
    );
    expect(res.outcome).toBe('decomposition');
    expect(res.salvaged_decomposition).toBeUndefined();
    expect(res.review_task_id).toBeDefined();
    expect(await reviewTaskCount()).toBe(1);
    const { rows } = await pool.query(`SELECT summary FROM contributions WHERE id = $1`, [
      res.contribution_id,
    ]);
    expect(rows[0].summary).toBe('a clean split'); // the agent's own summary survives
  });

  it('other prior contributions do NOT leak their artifacts into checkout', async () => {
    const dev = await createDev('worker');
    const target = await createTarget();
    const task = await createTask(target, { est: 20, max: 40 });
    await setBudget(dev, 1000);
    await checkoutTask(dev, task);
    await submitResult(dev, task, { big: 'x'.repeat(500) }, 10, null, {
      outcome: 'progress',
      summary: 'ordinary progress',
    });

    const dev2 = await createDev('next');
    await setBudget(dev2, 1000);
    const co = await checkoutTask(dev2, task);
    expect(co.prior_contributions[0].summary).toBe('ordinary progress');
    expect(co.prior_contributions[0].artifact ?? null).toBeNull(); // whole-result artifacts stay server-side
  });
});

describe('run loop — salvage and hard-reject never strand the reservation', () => {
  it('salvaged proposal: truthful message, task back in pool, reservation released', async () => {
    const dev = await createDev('planner');
    const target = await createTarget('Erdos');
    const task = await createTask(target, { est: 20, max: 40, title: 'Oversized sweep' });
    await setBudget(dev, 1000);

    const done = await runLoop(inProcessBackend(dev), proposingExecutor(capBreachProposal), opts);
    expect(done).toBe(1); // real tokens were spent and a contribution WAS recorded

    const all = logs.join('\n');
    expect(all).toContain('decomposition proposal failed validation');
    expect(all).toContain(CAP_BREACH_ERROR); // the exact errors, not a vague failure
    expect(all).toContain('preserved as a progress contribution for the next agent');
    expect(all).toContain('task returned to the pool');
    // It must NOT claim a review gate exists or that work went unrecorded.
    expect(all).not.toContain('review task was created');
    expect(errs.join('\n')).not.toContain('work not recorded');

    expect((await getTaskRow(task)).status).toBe('open');
    const b = await getBudgetRow(dev);
    expect(Number(b.reserved_cents)).toBe(0);
    expect(Number(b.spent_cents)).toBe(30);
  });

  it('unparseable proposal: hard reject, but the runner releases — reservation freed, task open', async () => {
    const dev = await createDev('confused');
    const target = await createTarget();
    const task = await createTask(target, { est: 20, max: 40 });
    await setBudget(dev, 1000);

    const done = await runLoop(inProcessBackend(dev), proposingExecutor({ subtasks: [] }), opts);
    expect(done).toBe(0);

    // Truthful messaging: rejected AND released, not silently stranded.
    const allErrs = errs.join('\n');
    expect(allErrs).toContain('submit rejected');
    expect(allErrs).toContain('releasing the task');

    // The whole submit rolled back and the runner's release freed the claim:
    // no contribution, no spend, no reservation left to lease-expiry.
    expect((await getTaskRow(task)).status).toBe('open');
    const b = await getBudgetRow(dev);
    expect(Number(b.reserved_cents)).toBe(0);
    expect(Number(b.spent_cents)).toBe(0);
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM contributions`);
    expect(rows[0].n).toBe(0);
  });

  it("end to end: salvaged proposal + exact errors reach the NEXT attempt's CONTINUATION block", async () => {
    // Attempt 1: an agent that cannot execute code proposes a decomposition;
    // validation rejects it (cap breach); the server salvages it as progress.
    const dev = await createDev('first-attempt');
    const target = await createTarget('Erdos');
    await createTask(target, { est: 20, max: 40, title: 'Oversized sweep' });
    await setBudget(dev, 1000);
    await runLoop(inProcessBackend(dev), proposingExecutor(capBreachProposal), opts);

    // Attempt 2: a different dev, fresh checkout, real prompt assembly. The
    // model prompt must contain the preserved proposal AND the exact errors so
    // the agent can resubmit it corrected.
    const dev2 = await createDev('second-attempt');
    await setBudget(dev2, 1000);
    let promptSeen = '';
    const capturing = new ClaudeCliExecutor({
      run: async (_args, input) => {
        promptSeen = input;
        return JSON.stringify({
          result: '{"summary":"resubmitting corrected"}',
          total_cost_usd: 0.01,
        });
      },
    });
    await runLoop(inProcessBackend(dev2), capturing, opts);

    expect(promptSeen).toContain('CONTINUATION — you are CONTINUING accumulated work');
    // the salvage, listed as a prior attempt with the errors in its summary
    expect(promptSeen).toContain('Proposed a decomposition that failed validation');
    expect(promptSeen).toContain(CAP_BREACH_ERROR);
    // the FULL preserved proposal — content, not just a pointer
    expect(promptSeen).toContain('proposed_decomposition');
    expect(promptSeen).toContain('sweep the odd residue classes');
    expect(promptSeen).toContain('"max_cost_cents":100');
    // and the standing instruction to fix exactly those errors and resubmit
    expect(promptSeen).toContain('fix exactly those errors and resubmit the corrected proposal');
  });
});
