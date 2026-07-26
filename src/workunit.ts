import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ExecResult, ExecTask, Executor } from './executor.js';

// Work-unit execution — the CPU half of the "folding@home driven by code"
// design (CODE_CONTRIB.md). A task whose spec carries `code` names merged
// contrib-repo code at a pinned SHA; the runner fetches exactly that SHA from
// exactly the allowlisted repo and executes it inside a podman sandbox with no
// network. CPU time is the donation here, not tokens: actual_cost_cents is 0,
// and runs may take hours — the run-loop's lease heartbeat keeps the claim
// alive while this executes.

const DEFAULT_ALLOWED_REPO = 'Barneyjm/givework-contrib';
/** CPU time is cheap; default to 6h. Override with WORKUNIT_TIMEOUT_MS. */
const DEFAULT_TIMEOUT_MS = 6 * 60 * 60 * 1000;

// Runtimes a merged contribution's manifest.json may declare. Pinned by
// digest, not tag — a tag can be repointed later; a digest cannot. "Loosened
// later via pinned base images, never via 'trust me'" (CODE_CONTRIB.md) is
// what licenses adding c11-gcc here: the isolation comes from the podman
// flags below (--network=none, capped memory/cpus/pids, read-only source
// mount), not from the language, so a second runtime doesn't weaken the
// sandbox — it only widens what real computational work can be donated
// (verified end-to-end against this exact flag set before shipping).
interface RuntimeConfig {
  /** repo@sha256:... — never a mutable tag. */
  image: string;
  /** The podman-run trailing command (after the image arg) for this entrypoint. */
  command: (entrypoint: string) => string[];
}

/** Single-quote a string for safe interpolation into a POSIX `sh -c` command. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

const RUNTIMES: Record<string, RuntimeConfig> = {
  'python3-stdlib': {
    image:
      'docker.io/library/python@sha256:6d43704baacd1bfbe7c295d7f13079d5d8104ed33568873133f8fc69980419df', // python:3.12-alpine
    command: (entrypoint) => ['python3', entrypoint],
  },
  'c11-gcc': {
    image:
      'docker.io/library/gcc@sha256:15c73bc59ae88b3fd563ef2ec4a8743a8848a9f74362b6d116c4543c4844b6e0', // gcc:13.2.0
    // The source mount is read-only, so compile to the writable tmpfs at
    // /tmp, then run it — both in one podman invocation (the container, and
    // its /tmp, don't survive between separate `podman run` calls). No
    // -Werror: review is the correctness gate, not the compiler flag; a
    // style warning in already-merged, already-reviewed code shouldn't turn
    // a work unit into a silent no-op.
    command: (entrypoint) => [
      'sh',
      '-c',
      `cc -O2 -std=c11 -o /tmp/wu_bin ${shQuote(entrypoint)} && /tmp/wu_bin`,
    ],
  },
};
const DEFAULT_RUNTIME = 'python3-stdlib';

export interface WorkUnitSpec {
  repo: string;
  /** Full 40-hex commit SHA — content-addressed, never a branch or tag. */
  sha: string;
  /** Repo-relative path of the script to run. */
  entrypoint: string;
  /** JSON handed to the script on stdin (defaults to {}). */
  input?: unknown;
}

function isSafeRelPath(p: string): boolean {
  if (typeof p !== 'string' || p.length === 0 || p.length > 300) return false;
  if (p.startsWith('/') || p.includes('\\') || p.includes('\0')) return false;
  const segments = p.split('/');
  return segments.every((s) => {
    if (s.length === 0 || s === '.' || s === '..') return false;
    // Case-insensitive, matching src/code-contrib.ts: '.GIT'/'.github' resolve
    // to the real dirs on case-insensitive filesystems.
    const lower = s.toLowerCase();
    return lower !== '.git' && lower !== '.github';
  });
}

/**
 * Build the JSON a work-unit driver reads on stdin: the static spec input (fixed
 * params like n/budget/seed) as the base, with the target's live compacted state
 * overlaid on top so the moving fields (cursor, best-so-far) win. A plain object
 * merge — both are JSON. If either side isn't an object it's ignored (spec input
 * defaults to {}), so a malformed state can never wipe the spec params.
 */
export function mergeWorkUnitInput(specInput: unknown, targetState: unknown): unknown {
  const base =
    specInput && typeof specInput === 'object' && !Array.isArray(specInput) ? specInput : {};
  const overlay =
    targetState && typeof targetState === 'object' && !Array.isArray(targetState)
      ? targetState
      : {};
  return { ...base, ...overlay };
}

/** Pull a well-formed work-unit spec out of a task spec, or null. */
export function extractWorkUnit(spec: unknown): WorkUnitSpec | null {
  const code = (spec as { code?: unknown } | null)?.code as WorkUnitSpec | undefined;
  if (!code || typeof code !== 'object') return null;
  if (typeof code.repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(code.repo)) return null;
  if (typeof code.sha !== 'string' || !/^[0-9a-f]{40}$/.test(code.sha)) return null;
  if (!isSafeRelPath(code.entrypoint)) return null;
  return { repo: code.repo, sha: code.sha, entrypoint: code.entrypoint, input: code.input };
}

export interface ProcOpts {
  cwd?: string;
  input?: string;
  timeoutMs?: number;
}
type RunProc = (cmd: string, args: string[], opts?: ProcOpts) => Promise<string>;

function execProc(cmd: string, args: string[], opts: ProcOpts = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`${cmd} timed out after ${opts.timeoutMs}ms`));
        }, opts.timeoutMs)
      : null;
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      reject(new Error(`${cmd} failed to spawn: ${e.message}`));
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} exited ${code}: ${err.slice(0, 300)}`));
    });
    // EPIPE from a fast-exiting child must not crash the runner.
    child.stdin.on('error', () => {});
    if (opts.input !== undefined) child.stdin.write(opts.input);
    child.stdin.end();
  });
}

/**
 * Executes a work unit: fetch the pinned SHA from the allowlisted repo, run
 * the entrypoint in a podman sandbox (no network, capped memory/pids,
 * read-only checkout), and parse its stdout as the task result. Refuses to
 * run without the sandbox — there is no unsandboxed fallback.
 */
export class WorkUnitExecutor implements Executor {
  private run: RunProc;
  private timeoutMs: number;
  private allowedRepo: string;
  private runtimeOverrides: Partial<Record<string, string>>;

  constructor(
    opts: {
      run?: RunProc;
      timeoutMs?: number;
      allowedRepo?: string;
      /** Back-compat: overrides the python3-stdlib image specifically. */
      image?: string;
      /** Per-runtime image overrides, keyed by runtime name (e.g. 'c11-gcc'). */
      runtimeImages?: Partial<Record<string, string>>;
    } = {},
  ) {
    this.run = opts.run ?? execProc;
    const envTimeout = Number(process.env.WORKUNIT_TIMEOUT_MS);
    this.timeoutMs =
      opts.timeoutMs ??
      (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : DEFAULT_TIMEOUT_MS);
    this.allowedRepo =
      opts.allowedRepo ?? process.env.GIVEWORK_CONTRIB_REPO ?? DEFAULT_ALLOWED_REPO;
    this.runtimeOverrides = {
      'python3-stdlib': opts.image ?? process.env.WORKUNIT_IMAGE,
      'c11-gcc': opts.runtimeImages?.['c11-gcc'] ?? process.env.WORKUNIT_C_IMAGE,
      ...opts.runtimeImages,
    };
  }

  /**
   * The runtime a contribution declares in its manifest.json, sitting next to
   * the entrypoint (the same layout every existing contribution already
   * uses). Unreadable/malformed/unrecognized manifest -> the long-standing
   * default, so every contribution merged before this feature existed keeps
   * behaving exactly as it always has.
   */
  private async resolveRuntime(dir: string, entrypoint: string): Promise<RuntimeConfig> {
    const manifestPath = path.join(dir, path.dirname(entrypoint), 'manifest.json');
    let name = DEFAULT_RUNTIME;
    try {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      // hasOwn, not `in`: `in` walks the prototype chain, so "constructor",
      // "toString" and "__proto__" would all pass this whitelist and then
      // resolve to something that is not a RuntimeConfig — throwing instead of
      // falling back, which defeats the fallback below.
      if (typeof manifest.runtime === 'string' && Object.hasOwn(RUNTIMES, manifest.runtime)) {
        name = manifest.runtime;
      }
    } catch {
      // no manifest, unreadable, or not JSON -> fall back to the default.
    }
    const base = RUNTIMES[name];
    const override = this.runtimeOverrides[name];
    return override ? { ...base, image: override } : base;
  }

  async execute(task: ExecTask): Promise<ExecResult> {
    const wu = extractWorkUnit(task.spec);
    if (!wu) throw new Error('task has no valid work-unit spec');
    if (wu.repo !== this.allowedRepo) {
      throw new Error(`work-unit repo not allowlisted: ${wu.repo} (allowed: ${this.allowedRepo})`);
    }
    // Feed the live cursor: overlay the target's compacted state (advanced by
    // each prior run's state_update) on the static spec input, so a re-picked
    // resumable task continues from where the last run left off instead of
    // restarting. Spec input provides the fixed params (n, budget, seed); the
    // state provides the moving cursor and carried-forward best-so-far.
    const stdinInput = mergeWorkUnitInput(wu.input, task.target_state);
    // No sandbox, no execution — a volunteer without podman releases the task
    // rather than running contributed code on the bare machine.
    await this.run('podman', ['--version']).catch(() => {
      throw new Error('podman is required to run work units (sandbox unavailable)');
    });

    const dir = await mkdtemp(path.join(tmpdir(), 'givework-wu-'));
    const started = Date.now();
    try {
      // Fetch exactly the pinned SHA — never a branch, never HEAD.
      await this.run('git', ['init', '-q'], { cwd: dir });
      await this.run('git', ['remote', 'add', 'origin', `https://github.com/${wu.repo}.git`], {
        cwd: dir,
      });
      await this.run('git', ['fetch', '-q', '--depth', '1', 'origin', wu.sha], { cwd: dir });
      await this.run('git', ['checkout', '-q', 'FETCH_HEAD'], { cwd: dir });

      const runtime = await this.resolveRuntime(dir, wu.entrypoint);

      // Name the container so a timeout can force-remove it: killing the podman
      // client (SIGKILL on timeout) does NOT stop the container it launched, so
      // without this a timed-out work unit leaks a running container.
      const containerName = `givework-wu-${path.basename(dir)}`;
      let out: string;
      try {
        out = await this.run(
          'podman',
          [
            'run',
            '--rm',
            '-i',
            '--name',
            containerName,
            '--network=none',
            '--memory=1g',
            '--cpus=2',
            '--pids-limit=256',
            '--read-only',
            '--tmpfs',
            '/tmp',
            '-v',
            `${dir}:/work:ro`,
            '-w',
            '/work',
            runtime.image,
            ...runtime.command(wu.entrypoint),
          ],
          { input: JSON.stringify(stdinInput), timeoutMs: this.timeoutMs },
        );
      } catch (err) {
        // Best-effort reap of a container that outlived a killed client.
        await this.run('podman', ['rm', '-f', containerName]).catch(() => {});
        throw err;
      }

      let result: unknown;
      try {
        result = JSON.parse(out);
      } catch {
        throw new Error(`work unit produced non-JSON output: ${out.slice(0, 200)}`);
      }
      // A work-unit script may steer the contribution loop by including the
      // continuation fields in its output, exactly like an LLM executor.
      const r = result as {
        outcome?: 'progress' | 'dead_end' | 'candidate_solution';
        summary?: unknown;
        state_update?: unknown;
      };
      return {
        result,
        outcome: r.outcome,
        summary: typeof r.summary === 'string' ? r.summary.slice(0, 500) : undefined,
        state_update: r.state_update,
        actual_cost_cents: 0, // CPU donation — no token spend to book
        raw_usage: {
          workunit: true,
          repo: wu.repo,
          sha: wu.sha,
          entrypoint: wu.entrypoint,
          duration_ms: Date.now() - started,
        },
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
