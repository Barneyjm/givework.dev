import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pool } from '../src/db.js';
import { StubExecutor } from '../src/executor.js';
import {
  checkoutTask,
  getBudget,
  heartbeatTask,
  listOpenTasks,
  OpError,
  releaseTask,
} from '../src/operations.js';
import { Outbox } from '../src/outbox.js';
import {
  type Backend,
  HttpBackend,
  isDefinitiveReject,
  runLoop,
  type SubmitArgs,
  ToolError,
} from '../src/run-loop.js';
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

// F1 (compute-loss audit): the worst window — a finished result (real tokens
// burned) existing only in process memory between "model done" and "submit
// 2xx". The outbox closes it: every submit payload is spooled to disk first,
// deleted only on success, replayed on later iterations/starts, and archived
// (never silently dropped) under dead/ when the server definitively rejects it.

/** Same in-process backend the other run-loop suites use. */
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

const opts = { maxTasks: 1, watch: false, intervalMs: 1, stopOnError: false };

let outboxDir: string;
let savedEnvDir: string | undefined;
let logs: string[];
let errs: string[];
beforeEach(async () => {
  await resetDb();
  // Fresh spool per test; runLoop's Outbox() reads this env at construction.
  savedEnvDir = process.env.GIVEWORK_OUTBOX_DIR;
  outboxDir = mkdtempSync(join(tmpdir(), 'givework-outbox-'));
  process.env.GIVEWORK_OUTBOX_DIR = outboxDir;
  logs = [];
  errs = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    logs.push(a.join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    errs.push(a.join(' '));
  });
});
afterEach(() => {
  process.env.GIVEWORK_OUTBOX_DIR = savedEnvDir;
  vi.restoreAllMocks();
});

const spoolFiles = () => readdirSync(outboxDir).filter((n) => n.endsWith('.json'));
const deadFiles = () => {
  const dir = join(outboxDir, 'dead');
  return existsSync(dir) ? readdirSync(dir) : [];
};

describe('Outbox (unit)', () => {
  it('save → list → delete round-trips the full payload', () => {
    const box = new Outbox(outboxDir);
    const args: SubmitArgs = {
      task_id: '11111111-1111-1111-1111-111111111111',
      result: { output: 'found a counterexample candidate' },
      actual_cost_cents: 42,
      raw_usage: { model: 'claude-sonnet-4-6' },
      outcome: 'progress',
      summary: 'partial sweep',
    };
    const entry = box.save(args);
    expect(entry).not.toBeNull();
    const listed = box.list();
    expect(listed).toHaveLength(1);
    expect(listed[0].args).toEqual(args);
    box.delete(listed[0]);
    expect(box.list()).toHaveLength(0);
  });

  it('moveToDead archives the payload WITH the server response, out of replay reach', () => {
    const box = new Outbox(outboxDir);
    const entry = box.save({
      task_id: '22222222-2222-2222-2222-222222222222',
      result: null,
      actual_cost_cents: 5,
      raw_usage: null,
    })!;
    const dest = box.moveToDead(entry, { code: 'not_locked', message: 'Task not locked to you' });
    expect(dest).toBeTruthy();
    expect(box.list()).toHaveLength(0); // no longer pending
    const dead = JSON.parse(readFileSync(dest!, 'utf8'));
    expect(dead.args.task_id).toBe('22222222-2222-2222-2222-222222222222');
    expect(dead.rejection).toMatchObject({ code: 'not_locked', message: 'Task not locked to you' });
  });

  it('list skips corrupt files without deleting them and never throws', async () => {
    const box = new Outbox(outboxDir);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(outboxDir, 'half-written.json'), '{"args": {"task_i');
    expect(box.list()).toHaveLength(0);
    expect(spoolFiles()).toContain('half-written.json'); // left for a human
  });
});

describe('run loop + outbox — finished work survives a failed submit', () => {
  it('transient failure: work is spooled, task NOT released, replay lands it next iteration', async () => {
    const dev = await createDev('unlucky-network');
    const target = await createTarget();
    const task = await createTask(target, { max: 100 });
    await setBudget(dev, 1000);

    const backend = inProcessBackend(dev);
    const realSubmit = backend.submit.bind(backend);
    let failures = 1;
    backend.submit = async (a: SubmitArgs) => {
      if (failures-- > 0) throw new Error('fetch failed: ECONNRESET'); // network-shaped, not a ToolError
      return realSubmit(a);
    };

    await runLoop(backend, new StubExecutor(), opts);

    // The replay landed the work: contribution + spend booked, task settled.
    const { rows: c } = await pool.query(`SELECT * FROM contributions WHERE task_id = $1`, [task]);
    expect(c).toHaveLength(1);
    expect((await getTaskRow(task)).status).toBe('submitted');
    const b = await getBudgetRow(dev);
    expect(Number(b.reserved_cents)).toBe(0);
    expect(Number(b.spent_cents)).toBe(Number(c[0].cost_cents));

    // The task was never released to be re-claimed (and re-spent on) by others.
    expect((await getLedger(dev)).map((l) => l.event_type)).not.toContain('release');

    // Spool is clean again, and the volunteer was told the truth at each step.
    expect(spoolFiles()).toHaveLength(0);
    expect(deadFiles()).toHaveLength(0);
    const allErrs = errs.join('\n');
    expect(allErrs).toContain('your work is SAVED');
    expect(allErrs).not.toContain('work not recorded');
    expect(logs.join('\n')).toContain('replayed a spooled submit');
  });

  it('definitive 4xx reject: payload archived to dead/ with the response, task released', async () => {
    const dev = await createDev('buggy-client');
    const target = await createTarget();
    const task = await createTask(target, { max: 100 });
    await setBudget(dev, 1000);

    // A cost the server hard-rejects up front (non-integer) — a genuine 400.
    const badExecutor = {
      execute: async () => ({ result: { output: 'x' }, actual_cost_cents: 3.5, raw_usage: {} }),
    };
    const done = await runLoop(inProcessBackend(dev), badExecutor, opts);
    expect(done).toBe(0);

    // Released, not stranded; nothing booked (the reject was pre-spend server-side).
    expect((await getTaskRow(task)).status).toBe('open');
    expect(Number((await getBudgetRow(dev)).reserved_cents)).toBe(0);

    // The payload was preserved under dead/ with the server's rejection attached.
    expect(spoolFiles()).toHaveLength(0);
    expect(deadFiles()).toHaveLength(1);
    const dead = JSON.parse(readFileSync(join(outboxDir, 'dead', deadFiles()[0]), 'utf8'));
    expect(dead.args.task_id).toBe(task);
    expect(dead.rejection.code).toBe('bad_input');
    const allErrs = errs.join('\n');
    expect(allErrs).toContain('submit rejected');
    expect(allErrs).toContain('releasing the task');
    expect(allErrs).toContain('preserved at');
  });

  it('replay on start: a spool left by a dead runner submits before any new checkout', async () => {
    const dev = await createDev('rebooted');
    const target = await createTarget();
    const task = await createTask(target, { max: 100 });
    await setBudget(dev, 1000);

    // Simulate the previous run: checked out, executed, spooled — then died.
    await checkoutTask(dev, task);
    new Outbox(outboxDir).save({
      task_id: task,
      result: { output: 'finished before the crash' },
      actual_cost_cents: 37,
      raw_usage: { model: 'claude-sonnet-4-6' },
    });

    await runLoop(inProcessBackend(dev), new StubExecutor(), opts);

    const { rows: c } = await pool.query(`SELECT * FROM contributions WHERE task_id = $1`, [task]);
    expect(c).toHaveLength(1);
    expect(Number(c[0].cost_cents)).toBe(37);
    expect((await getTaskRow(task)).status).toBe('submitted');
    expect(spoolFiles()).toHaveLength(0);
    expect(logs.join('\n')).toContain('replayed a spooled submit');
  });

  it('replay conflict (lease lost, task re-claimed): entry goes to dead/, the loop lives on', async () => {
    const dev = await createDev('slow-return');
    const target = await createTarget();
    const lostTask = await createTask(target, { max: 100, title: 'lost to lease expiry' });
    const freshTask = await createTask(target, { max: 100, title: 'fresh work' });
    await setBudget(dev, 1000);

    // The lease lapsed and ANOTHER runner re-claimed the task in the meantime.
    const rival = await createDev('rival-runner');
    await setBudget(rival, 1000);
    await checkoutTask(rival, lostTask);

    // A spooled result for a task we no longer hold (expire() reclaimed it).
    new Outbox(outboxDir).save({
      task_id: lostTask,
      result: { output: 'work that lost its lease' },
      actual_cost_cents: 20,
      raw_usage: null,
    });

    const done = await runLoop(inProcessBackend(dev), new StubExecutor(), opts);

    // The stale entry was archived — with the conflict — and normal work went on.
    expect(deadFiles()).toHaveLength(1);
    const dead = JSON.parse(readFileSync(join(outboxDir, 'dead', deadFiles()[0]), 'utf8'));
    expect(dead.args.task_id).toBe(lostTask);
    expect(dead.rejection.code).toBe('not_locked');
    expect(errs.join('\n')).toContain('preserved at');
    expect(done).toBe(1); // freshTask completed normally
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM contributions WHERE task_id = $1`,
      [freshTask],
    );
    expect(rows[0].n).toBe(1);
  });
});

describe('HttpBackend transport — status-aware errors and a bounded submit', () => {
  const fakeRes = (status: number, body: unknown) => ({
    ok: status < 400,
    status,
    text: async () => JSON.stringify(body),
  });

  afterEach(() => vi.unstubAllGlobals());

  it('carries the HTTP status onto ToolError so the retry policy can classify it', async () => {
    const seen: RequestInit[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      seen.push(init);
      return fakeRes(400, { error: 'bad_input', message: 'nope' });
    });
    const backend = new HttpBackend('http://api.test', 'tok');
    const err = await backend
      .submit({ task_id: 't', result: null, actual_cost_cents: 1, raw_usage: null })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect(err.status).toBe(400);
    expect(isDefinitiveReject(err)).toBe(true);
    // Every request is bounded — a hung submit must fall back to the spool.
    expect(seen[0].signal).toBeInstanceOf(AbortSignal);
  });

  it('a 5xx (even a non-JSON 502 page) is transient: spool-and-retry, never dead-lettered', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: false,
      status: 502,
      text: async () => '<html>Bad Gateway</html>',
    }));
    const backend = new HttpBackend('http://api.test', 'tok');
    const err = await backend
      .submit({ task_id: 't', result: null, actual_cost_cents: 1, raw_usage: null })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect(err.status).toBe(502);
    expect(isDefinitiveReject(err)).toBe(false);
  });

  it('classification without a status (MCP/in-process): platform codes definitive, transport codes not', () => {
    expect(isDefinitiveReject(new ToolError('bad_decomposition', 'x'))).toBe(true);
    expect(isDefinitiveReject(new ToolError('not_locked', 'x'))).toBe(true);
    expect(isDefinitiveReject(new ToolError('internal_error', 'x'))).toBe(false);
    expect(isDefinitiveReject(new ToolError('tool_error', 'x'))).toBe(false);
    expect(isDefinitiveReject(new ToolError('http_503', 'x'))).toBe(false);
    expect(isDefinitiveReject(new Error('ECONNRESET'))).toBe(false);
  });
});
