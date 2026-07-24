import { describe, expect, it } from 'vitest';
import type { ExecTask } from '../src/executor.js';
import { extractWorkUnit, mergeWorkUnitInput, WorkUnitExecutor } from '../src/workunit.js';

// Sandbox-orchestration tests with an injected process runner: no podman, no
// git, no network.

const SHA = '7ec361511299227e007d8523b70c4554218a8531';
const REPO = 'Barneyjm/givework-contrib';
const CODE = { repo: REPO, sha: SHA, entrypoint: 'tsp-four-thirds/gap-harness/gap_harness.py' };

function task(spec: unknown): ExecTask {
  return { task_id: 't1', title: 'wu', model: 'unused', max_cost_cents: 10, spec } as ExecTask;
}

describe('extractWorkUnit', () => {
  it('accepts a pinned, well-formed work unit', () => {
    expect(extractWorkUnit({ code: CODE })?.sha).toBe(SHA);
  });

  it('rejects short SHAs, branches, and unsafe paths', () => {
    expect(extractWorkUnit({ code: { ...CODE, sha: '7ec36151' } })).toBeNull(); // short
    expect(extractWorkUnit({ code: { ...CODE, sha: 'main' } })).toBeNull(); // ref, not pin
    expect(extractWorkUnit({ code: { ...CODE, entrypoint: '../x.py' } })).toBeNull();
    expect(extractWorkUnit({ code: { ...CODE, repo: 'https://evil.com/x' } })).toBeNull();
    expect(extractWorkUnit({})).toBeNull();
    expect(extractWorkUnit({ prompt: 'hi' })).toBeNull();
  });
});

describe('mergeWorkUnitInput', () => {
  it('overlays live state on the static spec input (state wins the moving fields)', () => {
    const spec = { n: 8, budget: 3000, seed: 1 };
    const state = { cursor: 3000, best_gap: { fraction: '11/10' } };
    expect(mergeWorkUnitInput(spec, state)).toEqual({
      n: 8,
      budget: 3000,
      seed: 1,
      cursor: 3000,
      best_gap: { fraction: '11/10' },
    });
  });

  it('a missing/malformed state leaves the spec params intact', () => {
    const spec = { n: 8, budget: 3000 };
    expect(mergeWorkUnitInput(spec, undefined)).toEqual(spec);
    expect(mergeWorkUnitInput(spec, null)).toEqual(spec);
    expect(mergeWorkUnitInput(spec, [1, 2, 3])).toEqual(spec); // arrays ignored
    expect(mergeWorkUnitInput(undefined, undefined)).toEqual({});
  });
});

describe('WorkUnitExecutor', () => {
  it('refuses repos outside the allowlist', async () => {
    const ex = new WorkUnitExecutor({ allowedRepo: REPO, run: async () => '' });
    await expect(ex.execute(task({ code: { ...CODE, repo: 'someone/else' } }))).rejects.toThrow(
      /not allowlisted/,
    );
  });

  it('refuses to run without the sandbox', async () => {
    const ex = new WorkUnitExecutor({
      allowedRepo: REPO,
      run: async (cmd) => {
        if (cmd === 'podman') throw new Error('not found');
        return '';
      },
    });
    await expect(ex.execute(task({ code: CODE }))).rejects.toThrow(/sandbox unavailable/);
  });

  it('fetches the pinned SHA and runs sandboxed, booking 0 cents', async () => {
    const calls: string[][] = [];
    const ex = new WorkUnitExecutor({
      allowedRepo: REPO,
      run: async (cmd, args, opts) => {
        calls.push([cmd, ...args]);
        if (cmd === 'podman' && args[0] === 'run') {
          expect(opts?.input).toBe(JSON.stringify({ dist: [[0]] }));
          return '{"gap": 1.1, "summary": "petersen gap 11/10"}';
        }
        return '';
      },
    });
    const res = await ex.execute(task({ code: { ...CODE, input: { dist: [[0]] } } }));
    expect(res.actual_cost_cents).toBe(0);
    expect((res.result as { gap: number }).gap).toBe(1.1);
    expect(res.summary).toBe('petersen gap 11/10');

    const fetch = calls.find((c) => c[0] === 'git' && c[1] === 'fetch');
    expect(fetch).toContain(SHA); // pinned fetch, not a branch
    const run = calls.find((c) => c[0] === 'podman' && c[1] === 'run');
    expect(run).toContain('--network=none');
    expect(run?.some((a) => a.endsWith(':/work:ro'))).toBe(true);
    expect(run).toContain(CODE.entrypoint);
  });

  it('feeds the live target_state cursor into the container, overriding the static input', async () => {
    let seenInput = '';
    const ex = new WorkUnitExecutor({
      allowedRepo: REPO,
      run: async (cmd, args, opts) => {
        if (cmd === 'podman' && args[0] === 'run') {
          seenInput = opts?.input ?? '';
          return '{"outcome":"progress","state_update":{"cursor":6000}}';
        }
        return '';
      },
    });
    // Spec pins n/budget/seed with cursor 0; the target's live state has advanced
    // the cursor. The driver must receive the advanced cursor, not the spec's 0.
    const t = task({ code: { ...CODE, input: { n: 8, budget: 3000, seed: 1, cursor: 0 } } });
    t.target_state = { cursor: 3000, best_gap: { fraction: '11/10' } };
    await ex.execute(t);
    expect(JSON.parse(seenInput)).toEqual({
      n: 8,
      budget: 3000,
      seed: 1,
      cursor: 3000, // state won — the search continues instead of restarting
      best_gap: { fraction: '11/10' },
    });
  });

  it('fails loudly on non-JSON script output', async () => {
    const ex = new WorkUnitExecutor({
      allowedRepo: REPO,
      run: async (cmd, args) => (cmd === 'podman' && args[0] === 'run' ? 'garbage' : ''),
    });
    await expect(ex.execute(task({ code: CODE }))).rejects.toThrow(/non-JSON/);
  });
});
