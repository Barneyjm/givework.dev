import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pool } from '../src/db.js';
import { ClaudeCliExecutor, ExecTimeoutError, type Executor } from '../src/executor.js';
import {
  checkoutTask,
  getBudget,
  heartbeatTask,
  listOpenTasks,
  OpError,
  releaseTask,
} from '../src/operations.js';
import { type Backend, runLoop, type SubmitArgs, ToolError } from '../src/run-loop.js';
import { submitAndVerify } from '../src/verify.js';
import {
  createDev,
  createTarget,
  createTask,
  getBudgetRow,
  resetDb,
  setBudget,
} from './helpers.js';

// Part A of recursive decomposition: a `claude -p` run the timeout kills no
// longer vanishes. The executor salvages whatever streamed before the kill into
// a progress contribution (honest, estimated cost), the task returns to the
// pool WITH that state, and the next agent continues instead of restarting.
// This is the platform's existing resumability doing its job on the failure path.

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

const timeoutTranscript = [
  JSON.stringify({ type: 'system', subtype: 'init' }),
  JSON.stringify({
    type: 'assistant',
    message: {
      content: [{ type: 'text', text: 'Ruled out n < 10^7; the residue-3 case remains.' }],
      usage: { input_tokens: 3000, output_tokens: 400 },
    },
  }),
].join('\n');

const timingOutExecutor = () =>
  new ClaudeCliExecutor({
    run: async () => {
      throw new ExecTimeoutError(timeoutTranscript, 300_000);
    },
  });

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

describe('timeout → salvaged progress contribution', () => {
  it('records the partial work, returns the task to the pool, and hydrates the next agent', async () => {
    const dev = await createDev('sisyphus');
    const target = await createTarget('Collatz');
    const task = await createTask(target, {
      est: 20,
      max: 100,
      title: 'Attack the residue classes',
    });
    await setBudget(dev, 1000);

    const done = await runLoop(inProcessBackend(dev), timingOutExecutor(), opts);
    expect(done).toBe(1); // a contribution WAS recorded — not a wasted run

    // The task is back in the pool, not stuck or lost.
    const { rows: t } = await pool.query(`SELECT status FROM tasks WHERE id = $1`, [task]);
    expect(t[0].status).toBe('open');

    // The contribution is a progress chunk with the honest timeout record.
    const { rows: c } = await pool.query(`SELECT * FROM contributions WHERE task_id = $1`, [task]);
    expect(c).toHaveLength(1);
    expect(c[0].outcome).toBe('progress');
    expect(c[0].summary).toContain('timed out after 5 minute(s)');
    expect(c[0].raw_usage).toMatchObject({ timed_out: true, estimated: true, elapsed_ms: 300_000 });
    expect(Number(c[0].cost_cents)).toBeGreaterThanOrEqual(1); // burned tokens are never "free"

    // Budget: reservation released, the estimated spend booked.
    const b = await getBudgetRow(dev);
    expect(Number(b.reserved_cents)).toBe(0);
    expect(Number(b.spent_cents)).toBe(Number(c[0].cost_cents));

    // The NEXT checkout continues from the salvage instead of restarting.
    const dev2 = await createDev('next-agent');
    await setBudget(dev2, 1000);
    const co = await checkoutTask(dev2, task);
    expect((co.target_state as any).timeout_salvage.partial).toContain('residue-3 case remains');
    expect(co.prior_contributions[0].summary).toContain('timed out');

    // Runner messaging is truthful: salvage, estimate, back in the pool.
    const all = logs.join('\n');
    expect(all).toContain('timed out — salvaged partial work as a progress contribution');
    expect(all).toContain('estimated');
    expect(all).toContain('returned to the pool');
    expect(all).not.toContain('✗ execution failed'); // not reported as a failure
  });

  it('does not clobber an existing target state — the salvage merges in beside it', async () => {
    const dev = await createDev('careful');
    const target = await createTarget('Collatz');
    await pool.query(`UPDATE targets SET state = $2 WHERE id = $1`, [
      target,
      JSON.stringify({ frontier: 'n < 10^6 verified', next: 'residue classes' }),
    ]);
    await createTask(target, { est: 20, max: 100 });
    await setBudget(dev, 1000);

    await runLoop(inProcessBackend(dev), timingOutExecutor(), opts);

    const { rows } = await pool.query(`SELECT state FROM targets WHERE id = $1`, [target]);
    expect(rows[0].state.frontier).toBe('n < 10^6 verified'); // untouched
    expect(rows[0].state.next).toBe('residue classes'); // untouched
    expect(rows[0].state.timeout_salvage.partial).toContain('10^7'); // added beside
  });

  it('three consecutive timeouts stop the loop with advice — but are never counted as config failures', async () => {
    const dev = await createDev('unlucky');
    const target = await createTarget('Collatz');
    for (let i = 0; i < 4; i++) await createTask(target, { est: 10, max: 50, title: `chunk ${i}` });
    await setBudget(dev, 1000);

    const done = await runLoop(inProcessBackend(dev), timingOutExecutor(), {
      ...opts,
      maxTasks: 10,
    });

    // Three salvage submits happened, then the loop stopped itself: burning a
    // fourth full window would help nobody until the timeout is re-sized.
    expect(done).toBe(3);
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM contributions`);
    expect(rows[0].n).toBe(3);
    expect(errs.join('\n')).toContain('consecutive timeouts');
    expect(errs.join('\n')).toContain('EXECUTOR_TIMEOUT_MS');
    // The config-failure abort message must NOT appear — nothing was released.
    expect(errs.join('\n')).not.toContain('config/credential problem');
  });

  it('a successful run resets the timeout streak', async () => {
    const dev = await createDev('mixed');
    const target = await createTarget('Collatz');
    for (let i = 0; i < 6; i++) await createTask(target, { est: 10, max: 50, title: `chunk ${i}` });
    await setBudget(dev, 1000);

    // timeout, timeout, success, timeout, timeout, success — never 3 in a row.
    let call = 0;
    const alternating: Executor = {
      execute: async (t) => {
        call++;
        if (call % 3 !== 0) {
          return new ClaudeCliExecutor({
            run: async () => {
              throw new ExecTimeoutError(timeoutTranscript, 120_000);
            },
          }).execute(t);
        }
        return { result: { output: 'done' }, actual_cost_cents: 5, raw_usage: {} };
      },
    };
    const done = await runLoop(inProcessBackend(dev), alternating, { ...opts, maxTasks: 6 });
    expect(done).toBe(6); // the loop never tripped either abort heuristic
  });
});

describe('run-loop decomposition messaging', () => {
  it('reports a proposal as success-pending-review, never as a finished result', async () => {
    const dev = await createDev('planner');
    const target = await createTarget('Erdos');
    await createTask(target, { est: 50, max: 200, title: 'Oversized sweep' });
    await setBudget(dev, 1000);

    const proposing: Executor = {
      execute: async () => ({
        result: {
          decomposition: {
            reason: 'needs ~50x this budget',
            subtasks: [{ title: 's', prompt: 'p', max_cost_cents: 100 }],
          },
        },
        outcome: 'decomposition',
        summary: 'proposed a 1-way split',
        actual_cost_cents: 30,
        raw_usage: {},
      }),
    };
    const done = await runLoop(inProcessBackend(dev), proposing, opts);
    expect(done).toBe(1);

    const all = logs.join('\n');
    expect(all).toContain('decomposition proposal');
    expect(all).toContain('review task was created');
    expect(all).toContain("publish only if another volunteer's agent approves");
    // it must NOT claim acceptance or a verified result
    expect(all).not.toContain('verified & accepted');

    // And the platform side really did mint the review gate.
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM tasks WHERE spec ? 'review_of'`,
    );
    expect(rows[0].n).toBe(1);
  });
});
