import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Executor } from '../src/executor.js';
import {
  type Backend,
  type OpenTask,
  runLoop,
  type SubmitArgs,
  ToolError,
} from '../src/run-loop.js';

// The runner side of "pick your conjecture": --target narrows which tasks the
// loop will even consider, --task claims one specific task and stops. Neither
// touches money — the fake backend here mirrors the server's SELECTION
// behaviour only, and the budget gate stays where it always was (checkoutTask,
// covered by the DB suites). What these tests pin down:
//
//   * default posture: no flag → the loop takes the pool as offered (general
//     chipping away is the platform's default, deliberately);
//   * --target: never claims another target's task, even when that other task
//     is cheaper and first in the pool;
//   * --task: claims exactly that task, and when it's gone (someone else took
//     it) it reports cleanly and stops instead of retrying forever.

interface FakeTask extends OpenTask {
  target: string;
  status: 'open' | 'locked' | 'submitted';
}

class FakeBackend implements Backend {
  readonly kind = 'fake';
  checkoutAttempts: string[] = [];
  released: string[] = [];
  listCalls: { target?: string }[] = [];
  available = 1000;

  constructor(public tasks: FakeTask[]) {}

  async getBudget() {
    return {
      budget_cents: 1000,
      reserved_cents: 0,
      spent_cents: 1000 - this.available,
      available_cents: this.available,
    };
  }
  // Mirrors the server: target filters selection, oldest (array order) first.
  async listOpenTasks(args: { max_cost_cents?: number; limit?: number; target?: string }) {
    this.listCalls.push({ target: args.target });
    return this.tasks
      .filter(
        (t) =>
          t.status === 'open' &&
          (!args.target || t.target === args.target) &&
          t.max_cost_cents <= (args.max_cost_cents ?? Infinity),
      )
      .slice(0, args.limit ?? 10);
  }
  async checkout(taskId: string) {
    this.checkoutAttempts.push(taskId);
    const t = this.tasks.find((x) => x.id === taskId);
    if (!t) throw new ToolError('task_not_found', 'Unknown task');
    if (t.status !== 'open') throw new ToolError('task_not_open', 'Task already claimed');
    t.status = 'locked';
    return {
      task_id: t.id,
      spec: { prompt: 'work' },
      title: t.title,
      model: t.model,
      max_cost_cents: t.max_cost_cents,
    };
  }
  async submit(args: SubmitArgs) {
    const t = this.tasks.find((x) => x.id === args.task_id);
    if (t) t.status = 'submitted';
    this.available -= args.actual_cost_cents;
    return { spent_applied: args.actual_cost_cents };
  }
  async heartbeat() {}
  async release(taskId: string) {
    this.released.push(taskId);
    const t = this.tasks.find((x) => x.id === taskId);
    if (t) t.status = 'open';
  }
  async close() {}
}

const stubExecutor: Executor = {
  execute: async () => ({ result: { ok: true }, actual_cost_cents: 1, raw_usage: {} }),
} as Executor;

const task = (id: string, target: string, cents: number): FakeTask => ({
  id,
  title: `task ${id}`,
  max_cost_cents: cents,
  model: 'stub',
  target,
  status: 'open',
});

const opts = { maxTasks: Infinity, watch: false, intervalMs: 1, stopOnError: false };

let logs: string[];
beforeEach(() => {
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    logs.push(a.join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('runLoop --target', () => {
  it('never claims another target’s task, even a cheaper one listed first', async () => {
    // The collatz task is cheaper AND first in pool order — the strongest pull
    // the general loop has. With --target it must still never be touched.
    const backend = new FakeBackend([
      task('collatz-1', 'collatz', 5),
      task('twin-1', 'twin-primes', 50),
    ]);
    const done = await runLoop(backend, stubExecutor, { ...opts, targetSlug: 'twin-primes' });
    expect(done).toBe(1);
    expect(backend.checkoutAttempts).toEqual(['twin-1']);
    expect(backend.tasks.find((t) => t.id === 'collatz-1')?.status).toBe('open');
    // Every poll carried the narrowing — the server does the filtering.
    expect(backend.listCalls.every((c) => c.target === 'twin-primes')).toBe(true);
  });

  it('defaults to general chipping away: no flag, whole pool, offered order', async () => {
    const backend = new FakeBackend([
      task('collatz-1', 'collatz', 5),
      task('twin-1', 'twin-primes', 50),
    ]);
    const done = await runLoop(backend, stubExecutor, { ...opts });
    expect(done).toBe(2);
    expect(backend.checkoutAttempts).toEqual(['collatz-1', 'twin-1']);
    expect(backend.listCalls[0].target).toBeUndefined();
  });

  it('stops cleanly when the named conjecture has nothing open (not --watch)', async () => {
    const backend = new FakeBackend([task('collatz-1', 'collatz', 5)]);
    const done = await runLoop(backend, stubExecutor, { ...opts, targetSlug: 'twin-primes' });
    expect(done).toBe(0);
    expect(backend.checkoutAttempts).toEqual([]);
    expect(logs.join('\n')).toContain('twin-primes');
  });
});

describe('runLoop --task', () => {
  it('claims exactly the named task, without even polling the pool', async () => {
    const backend = new FakeBackend([task('other', 'collatz', 5), task('mine', 'twin-primes', 50)]);
    const done = await runLoop(backend, stubExecutor, { ...opts, maxTasks: 1, taskId: 'mine' });
    expect(done).toBe(1);
    expect(backend.checkoutAttempts).toEqual(['mine']);
    expect(backend.listCalls).toEqual([]); // the pool was never consulted
  });

  it('refuses cleanly when someone else already took it — one attempt, no retry', async () => {
    const backend = new FakeBackend([task('mine', 'twin-primes', 50)]);
    backend.tasks[0].status = 'locked'; // raced away
    const done = await runLoop(backend, stubExecutor, { ...opts, taskId: 'mine' });
    expect(done).toBe(0);
    expect(backend.checkoutAttempts).toEqual(['mine']); // exactly once
    expect(logs.join('\n')).toMatch(/not open/i);
  });

  it('reports an unknown task id instead of throwing', async () => {
    const backend = new FakeBackend([]);
    await expect(runLoop(backend, stubExecutor, { ...opts, taskId: 'ghost' })).resolves.toBe(0);
    expect(logs.join('\n')).toMatch(/unknown task id/i);
  });

  it('releases and stops after a single failed execution — never a second spend', async () => {
    const backend = new FakeBackend([task('mine', 'twin-primes', 50)]);
    const failing = {
      execute: async () => {
        throw new Error('claude fell over');
      },
    } as unknown as Executor;
    // maxTasks deliberately > 1: the one-shot property must come from taskId
    // itself, not from the CLI happening to pass maxTasks: 1.
    const done = await runLoop(backend, failing, { ...opts, maxTasks: 5, taskId: 'mine' });
    expect(done).toBe(0);
    expect(backend.checkoutAttempts).toEqual(['mine']);
    expect(backend.released).toEqual(['mine']);
  });
});

describe('site: conjecture page claim command', () => {
  it('renders the per-slug command at the moment of motivation', () => {
    const html = readFileSync(new URL('../site/conjecture.html', import.meta.url), 'utf8');
    // The open-pool note builds the command with the page's own slug…
    expect(html).toContain("npx givework run --watch --target ' + esc(slug)");
    // …instead of the old generic pointer.
    expect(html).not.toContain('Claim one with <span class="mono">npx givework start</span>');
  });
});
