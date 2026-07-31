import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExecTask } from '../src/executor.js';
import {
  CONTAINER_ENGINE_ENV,
  containerEngineStatusLine,
  extractWorkUnit,
  LEAN4_IMAGE,
  mergeWorkUnitInput,
  resolveContainerEngine,
  synthesizeWorkUnitSummary,
  WorkUnitExecutor,
} from '../src/workunit.js';

// Sandbox-orchestration tests with an injected process runner: no podman, no
// docker, no git, no network.

afterEach(() => {
  delete process.env[CONTAINER_ENGINE_ENV];
});

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

describe('resolveContainerEngine', () => {
  it('probes podman first, then docker, and stops at the first hit', async () => {
    const calls: string[] = [];
    const run = async (cmd: string) => {
      calls.push(cmd);
      if (cmd === 'podman') throw new Error('not found');
      return 'Docker version 24.0.7, build afdd53b';
    };
    expect(await resolveContainerEngine(run)).toEqual({ engine: 'docker', version: '24.0' });
    expect(calls).toEqual(['podman', 'docker']);
  });

  it('probes the daemon (`version`), not just the binary (`--version`), under a timeout', async () => {
    const calls: [string, string[], number | undefined][] = [];
    const run = async (cmd: string, args: string[], opts?: { timeoutMs?: number }) => {
      calls.push([cmd, args, opts?.timeoutMs]);
      return 'podman version 5.3.1';
    };
    await resolveContainerEngine(run);
    // `--version` never contacts the daemon: it exits 0 with Docker Desktop
    // stopped or podman's machine unstarted, which is exactly the false ✓.
    expect(calls[0][1]).toEqual(['version']);
    expect(calls[0][1]).not.toContain('--version');
    // And it must be unable to hang the CLI's start-up path.
    expect(calls[0][2]).toBeGreaterThan(0);
  });

  it('falls through to docker when podman is installed but its daemon is not reachable', async () => {
    const calls: string[] = [];
    const run = async (cmd: string) => {
      calls.push(cmd);
      // What `podman version` does with the machine stopped on macOS.
      if (cmd === 'podman') throw new Error('podman exited 125: Cannot connect to Podman');
      return 'Docker version 27.5.1, build 9f9e405';
    };
    expect(await resolveContainerEngine(run)).toEqual({ engine: 'docker', version: '27.5' });
    expect(calls).toEqual(['podman', 'docker']);
  });

  it('never probes docker once podman answers', async () => {
    const calls: string[] = [];
    const run = async (cmd: string) => {
      calls.push(cmd);
      return 'podman version 5.3.1';
    };
    expect(await resolveContainerEngine(run)).toEqual({ engine: 'podman', version: '5.3' });
    expect(calls).toEqual(['podman']);
  });

  it('resolves to null (not an error) when neither engine answers', async () => {
    const run = async () => {
      throw new Error('command not found');
    };
    expect(await resolveContainerEngine(run)).toBeNull();
  });

  it('GIVEWORK_CONTAINER_ENGINE=podman wins outright, without probing docker', async () => {
    process.env[CONTAINER_ENGINE_ENV] = 'podman';
    const calls: string[] = [];
    const run = async (cmd: string) => {
      calls.push(cmd);
      return 'podman version 5.0.0';
    };
    expect(await resolveContainerEngine(run)).toEqual({ engine: 'podman', version: '5.0' });
    expect(calls).toEqual(['podman']);
  });

  it('GIVEWORK_CONTAINER_ENGINE=docker wins outright, without probing podman', async () => {
    process.env[CONTAINER_ENGINE_ENV] = 'docker';
    const calls: string[] = [];
    const run = async (cmd: string) => {
      calls.push(cmd);
      return 'Docker version 24.0.7, build afdd53b';
    };
    expect(await resolveContainerEngine(run)).toEqual({ engine: 'docker', version: '24.0' });
    expect(calls).toEqual(['docker']);
  });

  it('rejects a garbage GIVEWORK_CONTAINER_ENGINE value naming both accepted values', async () => {
    process.env[CONTAINER_ENGINE_ENV] = 'lxc';
    await expect(resolveContainerEngine(async () => '')).rejects.toThrow(
      /"podman" or "docker".*lxc/,
    );
  });

  // The shapes that mean "unset", not "misconfigured" — a blank var is how a
  // shell profile / .env / compose file turns an override off, and neither
  // that nor a capitalized typo should refuse every work unit.
  for (const [label, value] of [
    ['empty', ''],
    ['whitespace', '  '],
    ['trailing newline from $(cat …)', 'podman\n'],
    ['capitalized', 'Docker'],
    ['upper-case', 'PODMAN'],
  ] as const) {
    it(`treats a ${label} GIVEWORK_CONTAINER_ENGINE as unset-or-typo, never as fatal`, async () => {
      process.env[CONTAINER_ENGINE_ENV] = value;
      const resolved = await resolveContainerEngine(async () => 'podman version 5.3.1');
      expect(resolved).not.toBeNull();
    });
  }

  it('honors a capitalized override as that engine, not as auto-detect', async () => {
    process.env[CONTAINER_ENGINE_ENV] = 'Docker';
    const calls: string[] = [];
    const run = async (cmd: string) => {
      calls.push(cmd);
      return 'Docker version 24.0.7, build afdd53b';
    };
    expect(await resolveContainerEngine(run)).toEqual({ engine: 'docker', version: '24.0' });
    expect(calls).toEqual(['docker']); // podman never probed
  });
});

describe('containerEngineStatusLine', () => {
  it('reports the engine and version when one is found', async () => {
    const line = await containerEngineStatusLine(async () => 'podman version 5.3.1');
    expect(line).toBe('sandbox: podman 5.3 ✓ — CPU work units and Lean proof checking enabled');
  });

  it('names both engines and the env var when nothing is found', async () => {
    const line = await containerEngineStatusLine(async () => {
      throw new Error('not found');
    });
    expect(line).toBe(
      'sandbox: no container engine found — model tasks only. ' +
        `Install podman or docker (or set ${CONTAINER_ENGINE_ENV}) to donate CPU.`,
    );
  });

  it('never throws on a garbage env override — reports the bad value, not "not found"', async () => {
    process.env[CONTAINER_ENGINE_ENV] = 'lxc';
    const line = await containerEngineStatusLine(async () => 'lxc version 1.0');
    // "install podman or docker (or set GIVEWORK_CONTAINER_ENGINE)" would send
    // someone to fix the one thing that is already the cause. Name it instead.
    expect(line).toContain('lxc');
    expect(line).toContain(CONTAINER_ENGINE_ENV);
    expect(line).not.toContain('no container engine found');
  });
});

describe('WorkUnitExecutor', () => {
  it('refuses repos outside the allowlist', async () => {
    const ex = new WorkUnitExecutor({ allowedRepo: REPO, run: async () => '' });
    await expect(ex.execute(task({ code: { ...CODE, repo: 'someone/else' } }))).rejects.toThrow(
      /not allowlisted/,
    );
  });

  it('refuses to run without the sandbox — neither podman nor docker answers', async () => {
    const ex = new WorkUnitExecutor({
      allowedRepo: REPO,
      run: async (cmd) => {
        if (cmd === 'podman' || cmd === 'docker') throw new Error('not found');
        return '';
      },
    });
    await expect(ex.execute(task({ code: CODE }))).rejects.toThrow(/sandbox unavailable/);
    await expect(ex.execute(task({ code: CODE }))).rejects.toThrow(/podman.*docker/);
    await expect(ex.execute(task({ code: CODE }))).rejects.toThrow(
      new RegExp(CONTAINER_ENGINE_ENV),
    );
  });

  it('falls back to docker when podman does not answer', async () => {
    const calls: string[][] = [];
    const ex = new WorkUnitExecutor({
      allowedRepo: REPO,
      run: async (cmd, args) => {
        calls.push([cmd, ...args]);
        if (cmd === 'podman') throw new Error('not found');
        if (cmd === 'docker' && args[0] === 'run') return '{"outcome":"progress"}';
        return '';
      },
    });
    await ex.execute(task({ code: CODE }));
    expect(calls.some((c) => c[0] === 'podman' && c[1] === 'version')).toBe(true);
    expect(calls.some((c) => c[0] === 'docker' && c[1] === 'version')).toBe(true);
    const run = calls.find((c) => c[0] === 'docker' && c[1] === 'run');
    expect(run).toBeDefined();
    expect(calls.some((c) => c[0] === 'podman' && c[1] === 'run')).toBe(false);
  });

  it('honors GIVEWORK_CONTAINER_ENGINE=docker and never probes podman at all', async () => {
    process.env[CONTAINER_ENGINE_ENV] = 'docker';
    const calls: string[][] = [];
    const ex = new WorkUnitExecutor({
      allowedRepo: REPO,
      run: async (cmd, args) => {
        calls.push([cmd, ...args]);
        return cmd === 'docker' && args[0] === 'run' ? '{"outcome":"progress"}' : '';
      },
    });
    await ex.execute(task({ code: CODE }));
    expect(calls.some((c) => c[0] === 'podman')).toBe(false);
    expect(calls.some((c) => c[0] === 'docker' && c[1] === 'run')).toBe(true);
  });

  it('rejects a garbage GIVEWORK_CONTAINER_ENGINE value with a clear error naming both engines', async () => {
    process.env[CONTAINER_ENGINE_ENV] = 'lxc';
    const ex = new WorkUnitExecutor({ allowedRepo: REPO, run: async () => '' });
    await expect(ex.execute(task({ code: CODE }))).rejects.toThrow(/podman.*docker|docker.*podman/);
    await expect(ex.execute(task({ code: CODE }))).rejects.toThrow(/lxc/);
  });

  it('caches the resolved engine per instance instead of probing every task', async () => {
    let probes = 0;
    const ex = new WorkUnitExecutor({
      allowedRepo: REPO,
      run: async (cmd, args) => {
        if (args[0] === 'version') probes++;
        return cmd === 'podman' && args[0] === 'run' ? '{"outcome":"progress"}' : '';
      },
    });
    await ex.execute(task({ code: CODE }));
    await ex.execute(task({ code: CODE }));
    await ex.execute(task({ code: CODE }));
    expect(probes).toBe(1); // one probe total, not one per task
  });

  // The cache is for successes only. `getExecutor()` builds one executor per
  // runLoop and `start --watch` runs for days: a volunteer who installs podman
  // five minutes in must get work units for the rest of that run.
  it('re-probes after a failed probe, so a sandbox that appears mid-run is picked up', async () => {
    let engineUp = false;
    let probes = 0;
    const ex = new WorkUnitExecutor({
      allowedRepo: REPO,
      run: async (cmd, args) => {
        if (args[0] === 'version') {
          probes++;
          if (!engineUp) throw new Error('not found');
          return 'podman version 5.3.1';
        }
        return cmd === 'podman' && args[0] === 'run' ? '{"outcome":"progress"}' : '';
      },
    });
    await expect(ex.execute(task({ code: CODE }))).rejects.toThrow(/sandbox unavailable/);
    engineUp = true;
    await expect(ex.execute(task({ code: CODE }))).resolves.toBeDefined();
    expect(probes).toBeGreaterThan(2); // both engines on the failed round, then again
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

// Incident: 14 CPU chunk contributions rendered "(no summary)" on the public
// feed — the driver's JSON had the numbers but no `summary` string — and the
// rows needed a manual DB repair. A work-unit submit now always carries one.
describe('work-unit summary synthesis', () => {
  it('builds title + up to 4 shallow scalar fields, deterministically, in key order', () => {
    const result = {
      giant_fraction: 0.8,
      slimness_mean: 2.458,
      delta_n: -21,
      p_slim_gt_delta_n: 1,
      fifth_field: 99, // beyond the 4-field cap — never included
    };
    expect(synthesizeWorkUnitSummary('slim_sim n=1000 c=2', result)).toBe(
      'slim_sim n=1000 c=2 — giant_fraction: 0.8, slimness_mean: 2.458, delta_n: -21, p_slim_gt_delta_n: 1',
    );
  });

  it('skips arrays, nested objects, huge strings, and envelope keys', () => {
    const result = {
      outcome: 'progress', // envelope routing, not a headline
      state_update: { cursor: 5 },
      witnesses: [1, 2, 3],
      detail: { nested: true },
      blob: 'x'.repeat(500),
      status: 'ok',
      count: 7,
    };
    expect(synthesizeWorkUnitSummary('sweep', result)).toBe('sweep — status: ok, count: 7');
  });

  it('falls back to the bare title when the result has no headline scalars', () => {
    expect(synthesizeWorkUnitSummary('chunk 3/64', { rows: [[1]], deep: { a: 1 } })).toBe(
      'chunk 3/64',
    );
    expect(synthesizeWorkUnitSummary('chunk 3/64', 'not an object')).toBe('chunk 3/64');
    expect(synthesizeWorkUnitSummary('chunk 3/64', null)).toBe('chunk 3/64');
  });

  it('truncates cleanly at the cap', () => {
    const result = Object.fromEntries(
      Array.from({ length: 4 }, (_, i) => [`really_long_field_name_number_${i}`, 1e15 + i]),
    );
    const s = synthesizeWorkUnitSummary(`a long chunk title ${'x'.repeat(120)}`, result);
    expect(s.length).toBeLessThanOrEqual(200);
    expect(s.endsWith('…')).toBe(true);
  });

  it('the executor synthesizes a summary when the driver emitted none', async () => {
    const ex = new WorkUnitExecutor({
      allowedRepo: REPO,
      run: async (cmd, args) =>
        cmd === 'podman' && args[0] === 'run'
          ? '{"giant_fraction": 0.8, "slimness_mean": 2.458, "delta_n": -21, "p_slim_gt_delta_n": 1}'
          : '',
    });
    const t = { ...task({ code: CODE }), title: 'slim_sim n=1000 c=2' };
    const res = await ex.execute(t);
    expect(res.summary).toBe(
      'slim_sim n=1000 c=2 — giant_fraction: 0.8, slimness_mean: 2.458, delta_n: -21, p_slim_gt_delta_n: 1',
    );
  });

  it('never overwrites a summary the driver produced itself', async () => {
    const ex = new WorkUnitExecutor({
      allowedRepo: REPO,
      run: async (cmd, args) =>
        cmd === 'podman' && args[0] === 'run' ? '{"summary": "driver said so", "gap": 1.1}' : '',
    });
    const res = await ex.execute(task({ code: CODE }));
    expect(res.summary).toBe('driver said so');
  });

  it('treats a whitespace-only driver summary as absent', async () => {
    const ex = new WorkUnitExecutor({
      allowedRepo: REPO,
      run: async (cmd, args) =>
        cmd === 'podman' && args[0] === 'run' ? '{"summary": "  ", "gap": 1.1}' : '',
    });
    const res = await ex.execute(task({ code: CODE }));
    expect(res.summary).toBe('wu — gap: 1.1');
  });
});

describe('WorkUnitExecutor runtime dispatch', () => {
  const ENTRYPOINT = 'example-conjecture/native-check/check.c';

  /** Mocks the real `git checkout` side effect: a manifest.json (and, for a
   * compiled runtime, the source file) landing next to the entrypoint in the
   * checkout dir — exactly what a real merged contribution provides. */
  function runWriting(manifest: unknown, calls: string[][]) {
    return async (cmd: string, args: string[], opts?: { cwd?: string; input?: string }) => {
      calls.push([cmd, ...args]);
      if (cmd === 'git' && args[0] === 'checkout' && opts?.cwd) {
        const entryDir = path.join(opts.cwd, path.dirname(ENTRYPOINT));
        await mkdir(entryDir, { recursive: true });
        await writeFile(path.join(entryDir, 'manifest.json'), JSON.stringify(manifest));
        await writeFile(path.join(opts.cwd, ENTRYPOINT), '// stub — podman is mocked below');
        return '';
      }
      if (cmd === 'podman' && args[0] === 'run') {
        return '{"outcome":"progress","summary":"ok"}';
      }
      return '';
    };
  }

  it('dispatches to the gcc image and a compile-then-run command for c11-gcc', async () => {
    const calls: string[][] = [];
    const ex = new WorkUnitExecutor({
      allowedRepo: REPO,
      run: runWriting({ runtime: 'c11-gcc' }, calls),
    });
    await ex.execute(task({ code: { ...CODE, entrypoint: ENTRYPOINT } }));

    const run = calls.find((c) => c[0] === 'podman' && c[1] === 'run');
    expect(run).toBeDefined();
    expect(run?.some((a) => a.startsWith('docker.io/library/gcc@sha256:'))).toBe(true);
    expect(run).toContain('sh');
    expect(run?.some((a) => a.includes('cc -O2 -std=c11') && a.includes(ENTRYPOINT))).toBe(true);
    expect(run?.some((a) => a.includes('&& /tmp/wu_bin'))).toBe(true);
    // never the python image for this runtime
    expect(run?.some((a) => a.includes('python'))).toBe(false);
  });

  it('still dispatches to python3 when the manifest says so explicitly', async () => {
    const calls: string[][] = [];
    const ex = new WorkUnitExecutor({
      allowedRepo: REPO,
      run: runWriting({ runtime: 'python3-stdlib' }, calls),
    });
    await ex.execute(task({ code: { ...CODE, entrypoint: ENTRYPOINT } }));

    const run = calls.find((c) => c[0] === 'podman' && c[1] === 'run');
    expect(run).toContain('python3');
    expect(run).toContain(ENTRYPOINT);
    expect(run?.some((a) => a.startsWith('docker.io/library/python@sha256:'))).toBe(true);
  });

  it('falls back to python3-stdlib for an unrecognized runtime name', async () => {
    const calls: string[][] = [];
    const ex = new WorkUnitExecutor({
      allowedRepo: REPO,
      run: runWriting({ runtime: 'rust-nightly-unsandboxed' }, calls),
    });
    await ex.execute(task({ code: { ...CODE, entrypoint: ENTRYPOINT } }));

    const run = calls.find((c) => c[0] === 'podman' && c[1] === 'run');
    expect(run).toContain('python3'); // unknown runtime never silently gets a wider sandbox
  });

  it('falls back to python3-stdlib for a prototype key like "constructor"', async () => {
    // `runtime in RUNTIMES` was true for every Object.prototype member, so these
    // passed the whitelist and then resolved to something that is not a
    // RuntimeConfig — throwing instead of falling back.
    for (const proto of ['constructor', 'toString', '__proto__']) {
      const calls: string[][] = [];
      const ex = new WorkUnitExecutor({
        allowedRepo: REPO,
        run: runWriting({ runtime: proto }, calls),
      });
      await ex.execute(task({ code: { ...CODE, entrypoint: ENTRYPOINT } }));

      const run = calls.find((c) => c[0] === 'podman' && c[1] === 'run');
      expect(run).toContain('python3');
      expect(run?.join(' ')).not.toContain('gcc');
    }
  });

  it('falls back to python3-stdlib when no manifest.json is present at all', async () => {
    const calls: string[][] = [];
    const ex = new WorkUnitExecutor({
      allowedRepo: REPO,
      run: async (cmd, args) => {
        calls.push([cmd, ...args]);
        return cmd === 'podman' && args[0] === 'run' ? '{"outcome":"progress"}' : '';
      },
    });
    await ex.execute(task({ code: CODE })); // no checkout side effect -> empty dir
    const run = calls.find((c) => c[0] === 'podman' && c[1] === 'run');
    expect(run).toContain('python3');
  });

  it('honors a per-runtime image override for c11-gcc without touching python', async () => {
    const calls: string[][] = [];
    const ex = new WorkUnitExecutor({
      allowedRepo: REPO,
      runtimeImages: { 'c11-gcc': `docker.io/example/pinned-gcc@sha256:${'ab'.repeat(32)}` },
      run: runWriting({ runtime: 'c11-gcc' }, calls),
    });
    await ex.execute(task({ code: { ...CODE, entrypoint: ENTRYPOINT } }));
    const run = calls.find((c) => c[0] === 'podman' && c[1] === 'run');
    expect(run).toContain(`docker.io/example/pinned-gcc@sha256:${'ab'.repeat(32)}`);
  });

  it('single-quote-escapes an entrypoint path for the lean4 shell command too', async () => {
    const tricky = "lean/it's a dir/Check.lean";
    const calls: string[][] = [];
    const run = async (cmd: string, args: string[], opts?: { cwd?: string }) => {
      calls.push([cmd, ...args]);
      if (cmd === 'git' && args[0] === 'checkout' && opts?.cwd) {
        const entryDir = path.join(opts.cwd, path.dirname(tricky));
        await mkdir(entryDir, { recursive: true });
        await writeFile(path.join(entryDir, 'manifest.json'), JSON.stringify({ runtime: 'lean4' }));
        return '';
      }
      return cmd === 'podman' && args[0] === 'run' ? 'ok\n__GIVEWORK_LEAN_EXIT__ 0\n' : '';
    };
    const ex = new WorkUnitExecutor({ allowedRepo: REPO, run });
    await ex.execute(task({ code: { ...CODE, entrypoint: tricky } }));
    const podmanRun = calls.find((c) => c[0] === 'podman' && c[1] === 'run');
    const shCmd = podmanRun?.at(-1) ?? '';
    expect(shCmd).toContain(`'lean/it'\\''s a dir/Check.lean'`);
  });

  it('single-quote-escapes an entrypoint path for the c11-gcc shell command', async () => {
    // isSafeRelPath already forbids '..', leading '/', backslashes and NUL, but a
    // segment may still contain shell metacharacters (spaces, quotes) — the sh -c
    // interpolation must not let that break out of the intended `cc ... && run` form.
    const tricky = "example-conjecture/it's a dir/check.c";
    const calls: string[][] = [];
    const run = async (cmd: string, args: string[], opts?: { cwd?: string }) => {
      calls.push([cmd, ...args]);
      if (cmd === 'git' && args[0] === 'checkout' && opts?.cwd) {
        const entryDir = path.join(opts.cwd, path.dirname(tricky));
        await mkdir(entryDir, { recursive: true });
        await writeFile(
          path.join(entryDir, 'manifest.json'),
          JSON.stringify({ runtime: 'c11-gcc' }),
        );
        return '';
      }
      return cmd === 'podman' && args[0] === 'run' ? '{"outcome":"progress"}' : '';
    };
    const ex = new WorkUnitExecutor({ allowedRepo: REPO, run });
    await ex.execute(task({ code: { ...CODE, entrypoint: tricky } }));
    const podmanRun = calls.find((c) => c[0] === 'podman' && c[1] === 'run');
    const shCmd = podmanRun?.at(-1) ?? '';
    expect(shCmd).toContain(`'example-conjecture/it'\\''s a dir/check.c'`);
  });
});

describe('lean4 runtime (the proof-checking rail)', () => {
  const ENTRYPOINT = 'lean/canary/Canary.lean';
  const MARKER = '__GIVEWORK_LEAN_EXIT__';

  /** Fake checkout that plants a lean4 manifest, and a podman run that prints
   * `transcript` — the compiler diagnostics plus the exit marker the real
   * container command emits. */
  function leanRun(transcript: string, calls: string[][]) {
    return async (cmd: string, args: string[], opts?: { cwd?: string }) => {
      calls.push([cmd, ...args]);
      if (cmd === 'git' && args[0] === 'checkout' && opts?.cwd) {
        const entryDir = path.join(opts.cwd, path.dirname(ENTRYPOINT));
        await mkdir(entryDir, { recursive: true });
        await writeFile(path.join(entryDir, 'manifest.json'), JSON.stringify({ runtime: 'lean4' }));
        return '';
      }
      return cmd === 'podman' && args[0] === 'run' ? transcript : '';
    };
  }

  it('dispatches to the pinned lean image with the ENTRYPOINT reset and a lean command', async () => {
    const calls: string[][] = [];
    const ex = new WorkUnitExecutor({ allowedRepo: REPO, run: leanRun(`\n${MARKER} 0\n`, calls) });
    await ex.execute(task({ code: { ...CODE, entrypoint: ENTRYPOINT } }));

    const run = calls.find((c) => c[0] === 'podman' && c[1] === 'run');
    expect(run).toContain(LEAN4_IMAGE);
    expect(LEAN4_IMAGE).toMatch(/^docker\.io\/leanprovercommunity\/lean4@sha256:[0-9a-f]{64}$/); // digest-pinned, never a tag
    // The image bakes ENTRYPOINT ["/bin/bash","-l"], which would swallow our
    // `sh` — the invocation must reset it.
    const entryFlag = run?.indexOf('--entrypoint') ?? -1;
    expect(entryFlag).toBeGreaterThan(-1);
    expect(run?.[entryFlag + 1]).toBe('');
    // Same sandbox as every other runtime.
    expect(run).toContain('--network=none');
    expect(run?.some((a) => a.endsWith(':/work:ro'))).toBe(true);
    // Single-file `lean` on the pinned entrypoint, diagnostics captured, exit
    // code carried by the marker (the sh must exit 0 on a red build).
    const shCmd = run?.at(-1) ?? '';
    expect(run).toContain('sh');
    expect(shCmd).toContain(`lean '${ENTRYPOINT}' 2>&1`);
    expect(shCmd).toContain(MARKER);
  });

  it('green build: terminal candidate_solution carrying the machine verdict, 0 cents', async () => {
    const calls: string[][] = [];
    const ex = new WorkUnitExecutor({ allowedRepo: REPO, run: leanRun(`\n${MARKER} 0\n`, calls) });
    const res = await ex.execute(task({ code: { ...CODE, entrypoint: ENTRYPOINT } }));

    expect(res.outcome).toBe('candidate_solution');
    expect(res.result).toMatchObject({
      proof_checker: 'lean4',
      proof_checked: true,
      exit_code: 0,
      entrypoint: ENTRYPOINT,
    });
    expect(res.summary).toMatch(/PASSED/);
    expect(res.actual_cost_cents).toBe(0); // CPU donation
    expect(res.raw_usage).toMatchObject({ workunit: true, runtime: 'lean4' });
    expect(res.artifact).toBeUndefined(); // nothing to correct
  });

  it('red build: verdict false, compiler output preserved in result AND hydration artifact', async () => {
    const diagnostics =
      `${ENTRYPOINT}:1:42: error: tactic 'decide' proved that the proposition\n` +
      `  1 + 1 = 3\nis false`;
    const calls: string[][] = [];
    const ex = new WorkUnitExecutor({
      allowedRepo: REPO,
      run: leanRun(`${diagnostics}\n\n${MARKER} 1\n`, calls),
    });
    const res = await ex.execute(task({ code: { ...CODE, entrypoint: ENTRYPOINT } }));

    expect(res.outcome).toBe('candidate_solution'); // terminal: verification records the failure
    expect(res.result).toMatchObject({
      proof_checker: 'lean4',
      proof_checked: false,
      exit_code: 1,
    });
    expect((res.result as { compiler_output: string }).compiler_output).toContain(
      "tactic 'decide' proved",
    );
    // The correction-context channel: `compiler_output` is the key checkoutTask
    // hydrates (like validation_errors), so the next agent sees the exact errors.
    expect(res.artifact).toMatchObject({ proof_checker: 'lean4', exit_code: 1 });
    expect((res.artifact as { compiler_output: string }).compiler_output).toContain('error:');
    expect(res.summary).toMatch(/FAILED/);
    expect(res.summary).toContain("error: tactic 'decide'");
    expect(res.actual_cost_cents).toBe(0);
  });

  it('a sorried proof can NEVER pass, even though lean exits 0 on the warning', async () => {
    // Verified against the pinned image: `sorry` is a warning, exit code 0 —
    // without this check a one-line `by sorry` would auto-accept the claim.
    const transcript = `${ENTRYPOINT}:1:8: warning: declaration uses 'sorry'\n\n${MARKER} 0\n`;
    const calls: string[][] = [];
    const ex = new WorkUnitExecutor({ allowedRepo: REPO, run: leanRun(transcript, calls) });
    const res = await ex.execute(task({ code: { ...CODE, entrypoint: ENTRYPOINT } }));

    expect(res.result).toMatchObject({ proof_checked: false, exit_code: 0, incomplete: 'sorry' });
    expect(res.summary).toMatch(/sorry/);
    expect(res.artifact).toMatchObject({ proof_checker: 'lean4' }); // still correction context
  });

  it('a transcript with no exit marker is a process failure, not a red build', async () => {
    const calls: string[][] = [];
    const ex = new WorkUnitExecutor({
      allowedRepo: REPO,
      run: leanRun('half a line and then', calls),
    });
    await expect(ex.execute(task({ code: { ...CODE, entrypoint: ENTRYPOINT } }))).rejects.toThrow(
      /no exit marker/,
    );
  });

  it('a timed-out check is salvaged as a progress contribution, never silently released', async () => {
    const calls: string[][] = [];
    const base = leanRun('', calls);
    const ex = new WorkUnitExecutor({
      allowedRepo: REPO,
      run: async (cmd, args, opts) => {
        if (cmd === 'podman' && args[0] === 'run') {
          calls.push([cmd, ...args]);
          throw new Error('podman timed out after 100ms'); // execProc's timeout shape
        }
        return base(cmd, args, opts);
      },
    });
    const res = await ex.execute(task({ code: { ...CODE, entrypoint: ENTRYPOINT } }));

    // The donated CPU time ends in a recorded artifact — the invariant.
    expect(res.outcome).toBe('progress');
    expect(res.timed_out).toBe(true);
    expect(res.result).toMatchObject({ timed_out: true, runtime: 'lean4' });
    expect(res.summary).toMatch(/timed out/);
    expect(res.actual_cost_cents).toBe(0);
    expect(res.raw_usage).toMatchObject({ workunit: true, runtime: 'lean4', timed_out: true });
    // The container that outlived the killed client is still reaped.
    expect(calls.some((c) => c[0] === 'podman' && c[1] === 'rm' && c[2] === '-f')).toBe(true);
  });

  it('a timed-out python work unit still throws (salvage is per-runtime opt-in)', async () => {
    const ex = new WorkUnitExecutor({
      allowedRepo: REPO,
      run: async (cmd, args) => {
        if (cmd === 'podman' && args[0] === 'run') throw new Error('podman timed out after 100ms');
        return '';
      },
    });
    // No manifest -> python3-stdlib: the long-standing release-on-failure path.
    await expect(ex.execute(task({ code: CODE }))).rejects.toThrow(/timed out/);
  });

  it('honors a per-runtime image override for lean4', async () => {
    const override = `docker.io/example/pinned-lean@sha256:${'cd'.repeat(32)}`;
    const calls: string[][] = [];
    const ex = new WorkUnitExecutor({
      allowedRepo: REPO,
      runtimeImages: { lean4: override },
      run: leanRun(`\n${MARKER} 0\n`, calls),
    });
    await ex.execute(task({ code: { ...CODE, entrypoint: ENTRYPOINT } }));
    const run = calls.find((c) => c[0] === 'podman' && c[1] === 'run');
    expect(run).toContain(override);
  });
});
