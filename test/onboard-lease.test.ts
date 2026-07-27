import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A checked-out task's lease expires ten minutes after checkout. Any path that
// executes one has to renew it while the work runs, or a slow machine, a long
// CLI startup or one retried call means submitResult's guarded UPDATE matches
// zero rows and throws `not_locked` — the volunteer's real Claude credit spent
// and nothing booked at all. `givework onboard` exists specifically to rule that
// failure out for a newcomer, so it must heartbeat like the run loop does.

/** Resolves the in-flight execute(), so the test controls how long "work" takes. */
let finishExecution: (r: unknown) => void = () => {};

vi.mock('../src/executor.js', () => ({
  getExecutor: () => ({
    execute: () =>
      new Promise((resolve) => {
        finishExecution = resolve;
      }),
  }),
}));

const { onboard } = await import('../src/cli/commands.js');
const { HEARTBEAT_INTERVAL_MS } = await import('../src/run-loop.js');

const TASK = {
  task_id: '11111111-1111-1111-1111-111111111111',
  title: 'Goldbach sweep 4–80,004',
  status: 'open',
  max_cost_cents: 5,
  range_start: 4,
  range_end: 80_004,
  candidates: 40_000,
  target_name: "Goldbach's conjecture",
  target_slug: 'goldbach',
};

describe('givework onboard holds its lease while the task runs', () => {
  const saved = {
    fetch: globalThis.fetch,
    api: process.env.GIVEWORK_API_URL,
    token: process.env.GIVEWORK_TOKEN,
    executor: process.env.EXECUTOR,
  };
  let calls: string[];

  beforeEach(() => {
    calls = [];
    process.env.GIVEWORK_API_URL = 'http://control-plane.test';
    process.env.GIVEWORK_TOKEN = 'dev-token';
    process.env.EXECUTOR = 'stub'; // never let onboard reach for a real `claude`
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.useFakeTimers();

    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    globalThis.fetch = (async (url: any, init?: any) => {
      const path = new URL(String(url)).pathname;
      calls.push(`${init?.method ?? 'GET'} ${path}`);
      if (path === '/devs/me') {
        // Plenty of headroom, so the guided flow goes straight to the task.
        return json({
          github_handle: 'newcomer',
          budget: { budget_cents: 500, available_cents: 500 },
        });
      }
      if (path === '/devs/onboarding') return json(TASK);
      if (path === '/checkout') {
        return json({
          task_id: TASK.task_id,
          title: TASK.title,
          model: 'claude-sonnet-4-6',
          max_cost_cents: 5,
          spec: { range_start: TASK.range_start, range_end: TASK.range_end },
        });
      }
      if (path === '/heartbeat') return json({ ok: true });
      if (path === '/submit') {
        return json({ spent_applied: 2, status: 'accepted', verification: { verdict: 'passed' } });
      }
      throw new Error(`unexpected request: ${path}`);
    }) as typeof fetch;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    globalThis.fetch = saved.fetch;
    for (const [k, v] of [
      ['GIVEWORK_API_URL', saved.api],
      ['GIVEWORK_TOKEN', saved.token],
      ['EXECUTOR', saved.executor],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('heartbeats a run that outlives the ten-minute lease, then submits', async () => {
    const done = onboard([]);

    // Let the flow reach execution (identity -> task -> checkout).
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toContain('POST /checkout');
    expect(calls).not.toContain('POST /heartbeat');

    // A slow run: past the 10-minute lease, which is what would otherwise make
    // the submit below throw not_locked.
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 2 + 1000);
    const beats = calls.filter((c) => c === 'POST /heartbeat').length;
    expect(beats).toBeGreaterThanOrEqual(2);

    finishExecution({
      result: { range_start: TASK.range_start, range_end: TASK.range_end, counterexamples: [] },
      actual_cost_cents: 2,
      raw_usage: { stub: true },
    });
    await done;

    expect(calls).toContain('POST /submit');
    // And the interval is cleared once the work is done — no beat after submit.
    const beatsAtEnd = calls.filter((c) => c === 'POST /heartbeat').length;
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 2);
    expect(calls.filter((c) => c === 'POST /heartbeat').length).toBe(beatsAtEnd);
  });
});
