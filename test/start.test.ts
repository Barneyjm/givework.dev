import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `givework start` is the single front door: it looks at what is already true
// and does only what is missing. What these tests pin down is the routing (each
// state enters the right step, satisfied steps are skipped), the re-run promise
// (never a second mint, never a second spend), and the one deliberate design
// decision — `start` reports and hands over, `start --watch` is the only
// spelling that leaves a process burning the volunteer's credit.
//
// Everything is driven through a fake control plane (fetch) and a fake executor,
// so no `claude -p` is ever spawned and no database is touched.

const h = vi.hoisted(() => ({
  logins: 0,
  runLoopOpts: [] as any[],
  // Default: sandbox found. Individual tests reassign to exercise the
  // not-found line — real `podman`/`docker` are never spawned here.
  engineLine: 'sandbox: podman 5.3 ✓ — CPU work units and Lean proof checking enabled',
}));

vi.mock('../src/cli/login.js', () => ({
  login: async () => {
    h.logins++;
    process.env.GIVEWORK_TOKEN = 'dev-token'; // what a real login persists
  },
}));

vi.mock('../src/executor.js', () => ({
  getExecutor: () => ({
    execute: async () => ({
      result: { range_start: 4, range_end: 80_004, counterexamples: [] },
      actual_cost_cents: 2,
      raw_usage: { stub: true },
    }),
  }),
}));

// Only the sandbox-status line is faked — no real `podman`/`docker` process
// may be spawned by a unit test, and the line's own wording is covered by
// workunit.test.ts.
vi.mock('../src/workunit.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/workunit.js')>();
  return {
    ...actual,
    containerEngineStatusLine: async () => h.engineLine,
  };
});

// Only runLoop is replaced — onboard uses HttpBackend/withLease from the same
// module and those must stay real, or the guided-task path stops being tested.
vi.mock('../src/run-loop.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/run-loop.js')>();
  return {
    ...actual,
    runLoop: async (_backend: unknown, _executor: unknown, opts: unknown) => {
      h.runLoopOpts.push(opts);
    },
  };
});

const { hasContributed, readyLines, run, start } = await import('../src/cli/commands.js');

const MINTED = {
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

/** Mutable state of the fake control plane for one test. */
interface Plane {
  budget: { budget_cents: number; available_cents: number } | null;
  tasksCompleted: number;
  mints: number;
  submits: number;
  /** Status the mint route reports — flips to 'submitted' once the task is done. */
  taskStatus: string;
}

describe('givework start', () => {
  const saved = {
    fetch: globalThis.fetch,
    home: process.env.HOME,
    api: process.env.GIVEWORK_API_URL,
    token: process.env.GIVEWORK_TOKEN,
    executor: process.env.EXECUTOR,
    allowStubRemote: process.env.GIVEWORK_ALLOW_STUB_REMOTE,
  };
  let home: string;
  let calls: string[];
  let plane: Plane;

  beforeEach(() => {
    // An empty HOME so a real ~/.givework/config.json can never leak a token in.
    home = mkdtempSync(join(tmpdir(), 'gw-start-'));
    process.env.HOME = home;
    process.env.GIVEWORK_API_URL = 'http://control-plane.test';
    process.env.EXECUTOR = 'stub'; // never reach for a real `claude`
    // The control plane above is a mocked fetch, not a real remote — opt out of
    // the stub-vs-remote refusal so `start --watch` can reach the (mocked) loop.
    process.env.GIVEWORK_ALLOW_STUB_REMOTE = '1';
    delete process.env.GIVEWORK_TOKEN;
    h.logins = 0;
    h.runLoopOpts = [];
    h.engineLine = 'sandbox: podman 5.3 ✓ — CPU work units and Lean proof checking enabled';
    calls = [];
    plane = { budget: null, tasksCompleted: 0, mints: 0, submits: 0, taskStatus: 'open' };
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    globalThis.fetch = (async (url: any, init?: any) => {
      const u = new URL(String(url));
      calls.push(`${init?.method ?? 'GET'} ${u.pathname}`);
      switch (u.pathname) {
        case '/devs/me':
          return json({ github_handle: 'newcomer', verified: false, budget: plane.budget });
        case '/devs/me/stats':
          return json({ tasks_completed: plane.tasksCompleted, total_donated_cents: 0 });
        case '/devs/budget': {
          const body = JSON.parse(init.body);
          plane.budget = { budget_cents: body.budget_cents, available_cents: body.budget_cents };
          return json(plane.budget);
        }
        case '/devs/onboarding':
          plane.mints++;
          return json({ ...MINTED, status: plane.taskStatus });
        case '/checkout':
          return json({
            task_id: MINTED.task_id,
            title: MINTED.title,
            model: 'claude-sonnet-4-6',
            max_cost_cents: 5,
            spec: { range_start: MINTED.range_start, range_end: MINTED.range_end },
          });
        case '/heartbeat':
        case '/release':
          return json({ ok: true });
        case '/submit':
          plane.submits++;
          plane.tasksCompleted++;
          plane.taskStatus = 'submitted';
          plane.budget = {
            budget_cents: plane.budget?.budget_cents ?? 0,
            available_cents: (plane.budget?.available_cents ?? 0) - 2,
          };
          return json({
            spent_applied: 2,
            status: 'accepted',
            verification: { verdict: 'passed' },
          });
        case '/tasks/open':
          return json([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
        default:
          throw new Error(`unexpected request: ${u.pathname}`);
      }
    }) as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = saved.fetch;
    rmSync(home, { recursive: true, force: true });
    for (const [k, v] of [
      ['HOME', saved.home],
      ['GIVEWORK_API_URL', saved.api],
      ['GIVEWORK_TOKEN', saved.token],
      ['EXECUTOR', saved.executor],
      ['GIVEWORK_ALLOW_STUB_REMOTE', saved.allowStubRemote],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const did = (call: string) => calls.includes(call);

  // --- state 1: not signed in ---

  it('signs in first when there is no token, then carries straight on', async () => {
    await start([]);
    expect(h.logins).toBe(1);
    // …and does not stop there: the rest of the setup ran in the same command.
    expect(did('POST /devs/budget')).toBe(true);
    expect(did('POST /devs/onboarding')).toBe(true);
  });

  it('skips sign-in silently when a token already exists', async () => {
    process.env.GIVEWORK_TOKEN = 'dev-token';
    await start([]);
    expect(h.logins).toBe(0);
  });

  // --- state 2: signed in, no cap ---

  it('sets a monthly cap when none exists, then goes on to the first task', async () => {
    process.env.GIVEWORK_TOKEN = 'dev-token';
    await start([]);
    expect(did('POST /devs/budget')).toBe(true);
    expect(plane.budget?.budget_cents).toBeGreaterThan(0);
    expect(did('POST /devs/onboarding')).toBe(true);
  });

  it('honours an explicit --budget instead of asking', async () => {
    process.env.GIVEWORK_TOKEN = 'dev-token';
    await start(['--budget', '750']);
    expect(plane.budget?.budget_cents).toBe(750);
  });

  it('leaves an existing cap alone when it already has headroom', async () => {
    process.env.GIVEWORK_TOKEN = 'dev-token';
    plane.budget = { budget_cents: 500, available_cents: 500 };
    await start([]);
    expect(did('POST /devs/budget')).toBe(false);
    expect(plane.budget).toEqual({ budget_cents: 500, available_cents: 498 }); // only the run's spend
  });

  // A returning contributor's cap is per period, so a new month leaves them with
  // everything done except the one thing that gates checkout.
  it('asks a returning contributor for a cap in a new month, without re-onboarding', async () => {
    process.env.GIVEWORK_TOKEN = 'dev-token';
    plane.tasksCompleted = 4;
    plane.budget = null;
    await start([]);
    expect(did('POST /devs/budget')).toBe(true);
    expect(did('POST /devs/onboarding')).toBe(false);
  });

  // --- state 3: cap set, never completed a task ---

  it('runs the guided real task and reports what was contributed', async () => {
    process.env.GIVEWORK_TOKEN = 'dev-token';
    plane.budget = { budget_cents: 500, available_cents: 500 };
    const printed: string[] = [];
    (console.log as any).mockImplementation((...a: unknown[]) => printed.push(a.join(' ')));
    await start([]);
    expect(did('POST /devs/onboarding')).toBe(true);
    expect(did('POST /checkout')).toBe(true);
    expect(did('POST /submit')).toBe(true);
    const text = printed.join('\n');
    expect(text).toContain('ruled out 40,000 candidates');
    expect(text).toContain("Goldbach's conjecture");
  });

  // --- state 4: everything already done ---

  it('does nothing but report once the dev has a cap and a completed task', async () => {
    process.env.GIVEWORK_TOKEN = 'dev-token';
    plane.tasksCompleted = 2;
    plane.budget = { budget_cents: 500, available_cents: 500 };
    await start([]);
    expect(h.logins).toBe(0);
    expect(did('POST /devs/budget')).toBe(false);
    expect(did('POST /devs/onboarding')).toBe(false);
    expect(did('POST /checkout')).toBe(false);
    expect(did('POST /submit')).toBe(false);
    // But it did tell them where they stand.
    expect(did('GET /tasks/open')).toBe(true);
  });

  // --- re-running ---

  it('is safe to re-run: no second mint, no second spend', async () => {
    process.env.GIVEWORK_TOKEN = 'dev-token';
    plane.budget = { budget_cents: 500, available_cents: 500 };
    await start([]);
    expect(plane.mints).toBe(1);
    expect(plane.submits).toBe(1);

    calls = [];
    await start([]);
    expect(plane.mints).toBe(1); // the second run never asked for a task
    expect(plane.submits).toBe(1); // …and never spent again
    expect(did('POST /checkout')).toBe(false);
  });

  // Belt and braces: even if the completed-task signal were unavailable, the
  // guided flow itself must not re-run an already-submitted onboarding task.
  it('does not re-run an onboarding task the server already has a submission for', async () => {
    process.env.GIVEWORK_TOKEN = 'dev-token';
    plane.budget = { budget_cents: 500, available_cents: 500 };
    plane.taskStatus = 'submitted';
    await start([]);
    expect(plane.mints).toBe(1);
    expect(did('POST /checkout')).toBe(false);
    expect(plane.submits).toBe(0);
  });

  // --- the deliberate design decision ---

  it('does NOT enter the work loop on its own, and says how to start it', async () => {
    process.env.GIVEWORK_TOKEN = 'dev-token';
    plane.tasksCompleted = 1;
    plane.budget = { budget_cents: 500, available_cents: 500 };
    const printed: string[] = [];
    (console.log as any).mockImplementation((...a: unknown[]) => printed.push(a.join(' ')));
    await start([]);
    expect(h.runLoopOpts).toEqual([]);
    expect(printed.join('\n')).toContain('givework start --watch');
  });

  it('enters the loop with --watch, and only after setup is complete', async () => {
    process.env.GIVEWORK_TOKEN = 'dev-token';
    await start(['--watch']);
    // Setup happened first…
    expect(did('POST /devs/budget')).toBe(true);
    expect(did('POST /devs/onboarding')).toBe(true);
    // …and only then did the loop start, in watch mode.
    expect(h.runLoopOpts).toHaveLength(1);
    expect(h.runLoopOpts[0]).toMatchObject({ watch: true });
    expect(calls.indexOf('POST /submit')).toBeLessThan(calls.lastIndexOf('GET /tasks/open'));
  });

  it('--watch donates real capacity rather than silently looping on the stub', async () => {
    process.env.GIVEWORK_TOKEN = 'dev-token';
    delete process.env.EXECUTOR;
    plane.tasksCompleted = 1;
    plane.budget = { budget_cents: 500, available_cents: 500 };
    await start(['--watch']);
    expect(process.env.EXECUTOR).toBe('claude');
  });

  // A report that fails must not turn a finished setup into a non-zero exit —
  // the cap is written and the contribution is booked by this point.
  it('still succeeds when the closing pool read fails', async () => {
    process.env.GIVEWORK_TOKEN = 'dev-token';
    plane.tasksCompleted = 1;
    plane.budget = { budget_cents: 500, available_cents: 500 };
    const inner = globalThis.fetch;
    globalThis.fetch = (async (url: any, init?: any) => {
      if (new URL(String(url)).pathname === '/tasks/open') throw new Error('network down');
      return inner(url, init);
    }) as typeof fetch;
    await expect(start([])).resolves.toBeUndefined();
  });

  // --- sandbox preflight (GIVEWORK_CONTAINER_ENGINE detection) ---
  //
  // No real `podman`/`docker` process is ever spawned here — containerEngineStatusLine
  // is faked at the top of this file, and these tests only pin down that `start`
  // and `run` each print whatever it returns, once, regardless of what it says.

  it('start prints the sandbox line when a container engine is found', async () => {
    process.env.GIVEWORK_TOKEN = 'dev-token';
    plane.tasksCompleted = 1;
    plane.budget = { budget_cents: 500, available_cents: 500 };
    const printed: string[] = [];
    (console.log as any).mockImplementation((...a: unknown[]) => printed.push(a.join(' ')));
    await start([]);
    expect(printed).toContain(
      'sandbox: podman 5.3 ✓ — CPU work units and Lean proof checking enabled',
    );
  });

  it('start prints the sandbox line when no container engine is found, and does not fail', async () => {
    h.engineLine =
      'sandbox: no container engine found — model tasks only. Install podman or docker ' +
      '(or set GIVEWORK_CONTAINER_ENGINE) to donate CPU.';
    process.env.GIVEWORK_TOKEN = 'dev-token';
    plane.tasksCompleted = 1;
    plane.budget = { budget_cents: 500, available_cents: 500 };
    const printed: string[] = [];
    (console.log as any).mockImplementation((...a: unknown[]) => printed.push(a.join(' ')));
    await expect(start([])).resolves.toBeUndefined(); // never fatal
    expect(printed).toContain(h.engineLine);
  });

  it('run prints the sandbox line exactly once per invocation', async () => {
    process.env.GIVEWORK_TOKEN = 'dev-token';
    const printed: string[] = [];
    (console.log as any).mockImplementation((...a: unknown[]) => printed.push(a.join(' ')));
    await run([]);
    const occurrences = printed.filter((l) => l === h.engineLine).length;
    expect(occurrences).toBe(1);
  });

  it('start --watch prints the sandbox line exactly once and still starts the loop', async () => {
    process.env.GIVEWORK_TOKEN = 'dev-token';
    plane.tasksCompleted = 1;
    plane.budget = { budget_cents: 500, available_cents: 500 };
    const printed: string[] = [];
    (console.log as any).mockImplementation((...a: unknown[]) => printed.push(a.join(' ')));
    await start(['--watch']);
    // `start` prints it in its preflight and then calls straight through to
    // `run`, which prints it too unless told not to — twice reads like two
    // checks disagreeing, and re-spawns the probe.
    expect(printed.filter((l) => l === h.engineLine)).toHaveLength(1);
    expect(h.runLoopOpts).toHaveLength(1);
  });
});

describe('hasContributed()', () => {
  // The signal is the ledger-derived tally, not a funnel event: funnel writes are
  // swallowed on failure by design, and a dropped analytics row must never march
  // a real contributor back through onboarding.
  it('is true only once a task has actually been completed', () => {
    expect(hasContributed(undefined)).toBe(false);
    expect(hasContributed(null)).toBe(false);
    expect(hasContributed({})).toBe(false);
    expect(hasContributed({ tasks_completed: 0 })).toBe(false);
    expect(hasContributed({ tasks_completed: 1 })).toBe(true);
  });
});

describe('readyLines()', () => {
  const budget = { budget_cents: 2000, available_cents: 1900 };

  it('tells the user how to begin instead of claiming to have begun', () => {
    const text = readyLines('ada', budget, { count: 3, capped: false }).join('\n');
    expect(text).toContain('@ada');
    expect(text).toContain('2000¢');
    expect(text).toContain('3 tasks available');
    expect(text).toContain('givework start --watch');
    // It must not imply a loop is already running.
    expect(text).not.toMatch(/now running|started the loop|working in the background/i);
  });

  it('does not read as a dead end when the pool is momentarily empty', () => {
    const text = readyLines('ada', budget, { count: 0, capped: false }).join('\n');
    expect(text).toMatch(/No tasks open right now/);
    expect(text).toContain('givework start --watch');
  });

  it('marks a capped page rather than under-reporting the pool', () => {
    expect(readyLines('ada', budget, { count: 100, capped: true }).join('\n')).toContain('100+');
  });
});
