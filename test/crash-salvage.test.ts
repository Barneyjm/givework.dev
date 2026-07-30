import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pool } from '../src/db.js';
import { ClaudeCliExecutor, ExecFailedError, type ExecTask } from '../src/executor.js';
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

// F2 (compute-loss audit): a `claude -p` run that exits nonzero, reports
// is_error, or returns an empty result used to discard its stdout and release
// with zero record — the burned tokens appeared nowhere. Now those runs ride
// the same salvage path as timeouts: whatever accumulated (PROGRESS.md first,
// stream partials second) books as a flagged progress contribution with an
// honest (estimated or CLI-reported) cost. Only a run that left truly nothing
// still releases — loudly.

/** Same in-process backend the timeout-salvage suite uses. */
function inProcessBackend(devId: string): Backend {
  const wrap = async <T>(p: Promise<T>): Promise<T> => {
    try {
      return await p;
    } catch (err) {
      if (err instanceof OpError) throw new ToolError(err.code, err.message, err.status);
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

const task: ExecTask = {
  task_id: 't-1',
  title: 'probe the residue classes',
  model: 'by-effort',
  max_cost_cents: 100,
  spec: { prompt: 'summarize this' },
};

const crashTranscript = [
  JSON.stringify({ type: 'system', subtype: 'init' }),
  JSON.stringify({
    type: 'assistant',
    message: {
      content: [{ type: 'text', text: 'Verified n < 10^6; the odd residues remain open.' }],
      usage: { input_tokens: 2000, output_tokens: 300 },
    },
  }),
].join('\n');

const crashingExecutor = (transcript = crashTranscript) =>
  new ClaudeCliExecutor({
    run: async () => {
      throw new ExecFailedError(transcript, 'JavaScript heap out of memory', 137, 90_000);
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

describe('executor-level salvage of failed runs', () => {
  it('nonzero exit with streamed partials → flagged progress with estimated cost + crash forensics', async () => {
    const r = await crashingExecutor().execute(task);
    expect(r.crashed).toBe(true);
    expect(r.outcome).toBe('progress');
    expect(r.actual_cost_cents).toBeGreaterThanOrEqual(1); // burned tokens are never "free"
    expect(r.raw_usage).toMatchObject({
      crashed: true,
      exit_code: 137,
      estimated: true,
      estimator: 'streamed_usage',
      salvage_source: 'stream',
    });
    expect((r.raw_usage as any).stderr_tail).toContain('heap out of memory');
    expect((r.result as any).partial_output).toContain('odd residues remain open');
    expect((r.result as any).exit_code).toBe(137);
    expect(r.summary).toContain('failed (claude -p exited 137)');
  });

  it("prefers the agent's own PROGRESS.md over the stream capture", async () => {
    const exec = new ClaudeCliExecutor({
      run: async (_args, _input, _t, o) => {
        writeFileSync(
          join(o!.cwd!, 'PROGRESS.md'),
          '## Frontier\nRuled out all n < 10^7 except residue 3.',
        );
        throw new ExecFailedError('', 'killed', 1, 30_000);
      },
    });
    const r = await exec.execute(task);
    expect(r.crashed).toBe(true);
    expect((r.raw_usage as any).salvage_source).toBe('progress_file');
    expect((r.result as any).progress_file).toContain('except residue 3');
    expect((r.state_update as any).crash_salvage.partial).toContain('except residue 3');
  });

  it('is_error run that billed → salvaged with the CLI’s REAL cost, not an estimate', async () => {
    const exec = new ClaudeCliExecutor({
      run: async () =>
        JSON.stringify({
          type: 'result',
          is_error: true,
          result: 'usage limit reached mid-run',
          total_cost_usd: 0.25,
          usage: { input_tokens: 9000, output_tokens: 1200 },
        }),
    });
    const r = await exec.execute(task);
    expect(r.crashed).toBe(true);
    expect(r.actual_cost_cents).toBe(25);
    expect(r.raw_usage).toMatchObject({ estimated: false, estimator: 'cli_total_cost_usd' });
    expect((r.result as any).reason).toContain('usage limit reached mid-run');
  });

  it('truly nothing recoverable → throws so the runner releases, and says exactly that', async () => {
    const exec = new ClaudeCliExecutor({
      run: async () => {
        throw new ExecFailedError('', 'Invalid API key. Please run /login', 1, 400);
      },
    });
    await expect(exec.execute(task)).rejects.toThrow(/nothing recoverable/);
    await expect(exec.execute(task)).rejects.toThrow(/Invalid API key/);
  });
});

describe('run loop — crashed runs book their spend and hand off their state', () => {
  it('records the salvage, returns the task to the pool, and messages honestly', async () => {
    const dev = await createDev('oom-victim');
    const target = await createTarget('Collatz');
    const dbTask = await createTask(target, { est: 20, max: 100, title: 'Sweep a block' });
    await setBudget(dev, 1000);

    const done = await runLoop(inProcessBackend(dev), crashingExecutor(), opts);
    expect(done).toBe(1); // a contribution WAS recorded — not a wasted run

    const { rows: t } = await pool.query(`SELECT status FROM tasks WHERE id = $1`, [dbTask]);
    expect(t[0].status).toBe('open');

    const { rows: c } = await pool.query(`SELECT * FROM contributions WHERE task_id = $1`, [
      dbTask,
    ]);
    expect(c).toHaveLength(1);
    expect(c[0].outcome).toBe('progress');
    expect(c[0].raw_usage).toMatchObject({ crashed: true, exit_code: 137, estimated: true });
    expect(Number(c[0].cost_cents)).toBeGreaterThanOrEqual(1);

    const b = await getBudgetRow(dev);
    expect(Number(b.reserved_cents)).toBe(0);
    expect(Number(b.spent_cents)).toBe(Number(c[0].cost_cents));

    // The NEXT agent continues from the crash salvage instead of restarting.
    const dev2 = await createDev('next-agent');
    await setBudget(dev2, 1000);
    const co = await checkoutTask(dev2, dbTask);
    expect((co.target_state as any).crash_salvage.partial).toContain('odd residues remain open');

    // Truthful messaging: salvaged, estimated, back in the pool — NOT a failure.
    const all = logs.join('\n');
    expect(all).toContain('crashed mid-run — salvaged the partial work');
    expect(errs.join('\n')).not.toContain('✗ execution failed');
    expect(errs.join('\n')).not.toContain('config/credential problem');
  });

  it('a run that left nothing releases cleanly and still counts as a config failure', async () => {
    const dev = await createDev('bad-auth');
    const target = await createTarget();
    const dbTask = await createTask(target, { max: 100 });
    await setBudget(dev, 1000);

    const nothing = new ClaudeCliExecutor({
      run: async () => {
        throw new ExecFailedError('', 'Invalid API key', 1, 300);
      },
    });
    const done = await runLoop(inProcessBackend(dev), nothing, opts);
    expect(done).toBe(0);

    // Released with the truth on the console; nothing fabricated, nothing booked.
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM contributions`);
    expect(rows[0].n).toBe(0);
    const { rows: t } = await pool.query(`SELECT status FROM tasks WHERE id = $1`, [dbTask]);
    expect(t[0].status).toBe('open');
    expect(Number((await getBudgetRow(dev)).reserved_cents)).toBe(0);
    const allErrs = errs.join('\n');
    expect(allErrs).toContain('execution failed');
    expect(allErrs).toContain('nothing recoverable');
  });

  it('three consecutive crash salvages stop the loop with advice — never as config failures', async () => {
    const dev = await createDev('unlucky');
    const target = await createTarget();
    for (let i = 0; i < 4; i++) await createTask(target, { est: 10, max: 50, title: `chunk ${i}` });
    await setBudget(dev, 1000);

    const done = await runLoop(inProcessBackend(dev), crashingExecutor(), {
      ...opts,
      maxTasks: 10,
    });

    expect(done).toBe(3); // three booked salvages, then the circuit breaker
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM contributions`);
    expect(rows[0].n).toBe(3);
    expect(errs.join('\n')).toContain('consecutive crashed runs');
    expect(errs.join('\n')).not.toContain('config/credential problem');
  });
});
