import { describe, expect, it } from 'vitest';
import type { ExecTask } from '../src/executor.js';
import { extractWorkUnit, WorkUnitExecutor } from '../src/workunit.js';

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

  it('fails loudly on non-JSON script output', async () => {
    const ex = new WorkUnitExecutor({
      allowedRepo: REPO,
      run: async (cmd, args) => (cmd === 'podman' && args[0] === 'run' ? 'garbage' : ''),
    });
    await expect(ex.execute(task({ code: CODE }))).rejects.toThrow(/non-JSON/);
  });
});
