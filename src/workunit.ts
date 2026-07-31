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
// mount), not from the language, so an added runtime doesn't weaken the
// sandbox — it only widens what real computational work can be donated
// (each verified end-to-end against this exact flag set before shipping).
// lean4 is the proof-checking rail: exit 0 from the compiler IS the verdict
// (verify.ts's proof_checker method), so the interpretation of the container's
// output is per-runtime, not one JSON contract.
interface RuntimeConfig {
  /** repo@sha256:... — never a mutable tag. */
  image: string;
  /** The podman-run trailing command (after the image arg) for this entrypoint. */
  command: (entrypoint: string) => string[];
  /**
   * `--entrypoint` override for images whose baked-in ENTRYPOINT would swallow
   * `command` (lean4's is `/bin/bash -l`, which treats our `sh` as a script
   * path). '' resets it so `command[0]` is the binary that runs. Omitted for
   * images with no ENTRYPOINT (python, gcc).
   */
  entrypoint?: string;
  /**
   * Parse the container's stdout into the contribution. Default: strict JSON —
   * the driver contract every python/C work unit speaks. A proof-checking
   * runtime overrides this because its "driver" is the compiler itself: the
   * output is diagnostics, not JSON, and the verdict is the exit code.
   */
  interpret?: (out: string, entrypoint: string) => InterpretedOutput;
  /**
   * Salvage a run the timeout killed as a progress contribution instead of
   * throwing (which releases the task with no record). For a proof check a
   * timeout IS a result — "did not check within the budget window" — and the
   * donated CPU time must end in a recorded artifact, never vanish.
   */
  salvageTimeout?: boolean;
}

/** What a runtime's output interpreter contributes to the ExecResult. */
interface InterpretedOutput {
  result: unknown;
  outcome?: 'progress' | 'dead_end' | 'candidate_solution';
  summary?: string;
  state_update?: unknown;
  /** Inline artifact (e.g. a failed build's compiler output for the next agent). */
  artifact?: unknown;
}

/** Single-quote a string for safe interpolation into a POSIX `sh -c` command. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * The pinned lean4 runtime image (exported so the real-podman canary test can
 * probe for it and skip when absent). Lean 4.10.0 via elan; linux/amd64 only
 * upstream — arm64 hosts run it under podman's emulation.
 */
export const LEAN4_IMAGE =
  'docker.io/leanprovercommunity/lean4@sha256:d61f7052fa82e7e726db46984ef4f11c84525eabd4a8d1d20ba80f1ccee34018';

/** Marker the lean4 command prints after the compiler run so the exit code
 * survives the shell (the sh itself always exits 0 — a red build is a RESULT
 * to interpret, not a process failure to throw on). */
const LEAN_EXIT_MARKER = '__GIVEWORK_LEAN_EXIT__';
/** Cap on compiler output carried inline (errors live at the tail, so keep it). */
const LEAN_OUTPUT_MAX_CHARS = 16_000;
/** Cap on the summary's first-error excerpt. */
const LEAN_SUMMARY_ERROR_CHARS = 300;
/**
 * The diagnostic `lean` prints for an incomplete proof — as a WARNING, exit 0
 * (verified in the pinned image). A sorried "proof" must never auto-pass, so
 * the interpreter checks for it explicitly. (An `axiom` smuggle compiles
 * silently green — that one is PR review's job; see contrib-templates/lean.)
 */
const LEAN_SORRY_WARNING = "declaration uses 'sorry'";

/**
 * Turn a lean4 container transcript into the contribution. Exit 0 with no
 * sorry warning = the proof checks: a terminal candidate_solution whose result
 * carries the machine verdict (`proof_checked: true`) that verify.ts's
 * proof_checker method honors. Nonzero (or sorried) = failed: still terminal — verification records
 * `failed` and pools the task — with the compiler tail preserved BOTH in the
 * result and as an inline `compiler_output` artifact, which checkoutTask
 * hydrates for the next agent exactly like a salvaged invalid decomposition
 * (build errors are correction context, not noise).
 */
function interpretLeanOutput(out: string, entrypoint: string): InterpretedOutput {
  const m = out.match(new RegExp(`${LEAN_EXIT_MARKER} (\\d+)\\s*$`));
  if (!m) {
    // No marker means the shell itself never finished (OOM-killed container,
    // broken image) — that is a process failure, not a red build.
    throw new Error(`lean work unit produced no exit marker: ${out.slice(-200)}`);
  }
  const exitCode = Number(m[1]);
  const compilerOutput = out.slice(0, m.index).trim().slice(-LEAN_OUTPUT_MAX_CHARS);
  // A sorried declaration compiles with exit 0 — an incomplete proof, not a
  // checked one (verified against the pinned image). Without this a single
  // `sorry` would auto-accept the whole claim.
  const sorried = compilerOutput.includes(LEAN_SORRY_WARNING);
  const passed = exitCode === 0 && !sorried;
  const result = {
    proof_checker: 'lean4',
    proof_checked: passed,
    exit_code: exitCode,
    compiler_output: compilerOutput,
    entrypoint,
    ...(sorried ? { incomplete: 'sorry' } : {}),
  };
  if (passed) {
    return {
      result,
      outcome: 'candidate_solution',
      summary: `Lean 4 proof check PASSED: ${entrypoint} compiled cleanly (lean exited 0).`,
    };
  }
  const firstError =
    compilerOutput
      .split('\n')
      .find((l) => l.includes('error'))
      ?.trim() ??
    compilerOutput.split('\n')[0]?.trim() ??
    '';
  return {
    result,
    outcome: 'candidate_solution',
    summary: sorried
      ? `Lean 4 proof check FAILED: ${entrypoint} is incomplete — a declaration uses 'sorry' (an unproven hole never verifies).`
      : `Lean 4 proof check FAILED: ${entrypoint} (lean exited ${exitCode})` +
        (firstError ? ` — ${firstError.slice(0, LEAN_SUMMARY_ERROR_CHARS)}` : ''),
    // The hydration key checkoutTask looks for — the next agent's correction
    // context rides the same channel as a salvaged invalid decomposition.
    artifact: {
      proof_checker: 'lean4',
      exit_code: exitCode,
      compiler_output: compilerOutput,
      entrypoint,
    },
  };
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
  lean4: {
    // Lean 4.10.0 toolchain (elan-managed), the community-published image —
    // digest-pinned like the others. amd64-only upstream: Apple Silicon /
    // arm64 machines run it under podman's qemu/Rosetta emulation, which is
    // fine for the small core-Lean proofs v1 accepts (the canary checks in
    // ~2s emulated). NO mathlib in v1 — a mathlib toolchain is a multi-GB
    // image and needs a cached-.olean layer plan; that is the explicit v2
    // step (see CODE_CONTRIB.md). Verified end-to-end against the exact
    // podman flag set below before wiring in: green canary exits 0, a false
    // `by decide` theorem exits 1 with the diagnostic on stdout.
    image: LEAN4_IMAGE,
    // Single-file `lean` on the pinned entrypoint — the simplest contract that
    // expresses "this .lean file must compile". (`lake build` is the v2 shape,
    // once contributions grow multi-module and mathlib-backed.) The compiler's
    // stdout+stderr are ALWAYS captured (2>&1) — build failures are the next
    // agent's correction context — and the exit code rides the marker line
    // because the sh must exit 0 either way: a red build is a result, not a
    // process error.
    command: (entrypoint) => [
      'sh',
      '-c',
      `lean ${shQuote(entrypoint)} 2>&1; printf '\\n${LEAN_EXIT_MARKER} %s\\n' "$?"`,
    ],
    // The image's ENTRYPOINT is `/bin/bash -l`, which would treat our `sh` as
    // a script path ("cannot execute binary file"). Reset it.
    entrypoint: '',
    interpret: interpretLeanOutput,
    salvageTimeout: true,
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

// Caps for a synthesized work-unit summary. Production incident: 14 CPU chunk
// contributions rendered "(no summary)" on the public feed because the executed
// program's JSON carried results but no `summary` string, and the feed needed a
// manual DB repair. A work unit's submit now always carries a summary.
const SUMMARY_MAX_CHARS = 200;
const SUMMARY_MAX_FIELDS = 4;
const SUMMARY_MAX_VALUE_CHARS = 40;
/** Continuation/envelope keys are routing metadata, not headline results. */
const SUMMARY_SKIP_KEYS = new Set(['summary', 'outcome', 'state_update', 'artifact_uri']);

/**
 * Build a compact human summary from a work unit's JSON result: the task title
 * plus up to a few headline scalar fields. Deterministic and generic — shallow
 * numeric/boolean/short-string values in the object's own key order, skipping
 * arrays, nested objects, and huge strings — so any driver's output produces a
 * readable feed line without the platform knowing its schema. Used only when
 * the executed program supplied no `summary` of its own.
 */
export function synthesizeWorkUnitSummary(title: string, result: unknown): string {
  const fields: string[] = [];
  if (result !== null && typeof result === 'object' && !Array.isArray(result)) {
    for (const [key, value] of Object.entries(result as Record<string, unknown>)) {
      if (fields.length >= SUMMARY_MAX_FIELDS) break;
      if (SUMMARY_SKIP_KEYS.has(key)) continue;
      if (typeof value === 'number' && Number.isFinite(value)) {
        fields.push(`${key}: ${value}`);
      } else if (typeof value === 'boolean') {
        fields.push(`${key}: ${value}`);
      } else if (typeof value === 'string') {
        const v = value.trim();
        if (v.length > 0 && v.length <= SUMMARY_MAX_VALUE_CHARS && !v.includes('\n')) {
          fields.push(`${key}: ${v}`);
        }
      }
      // arrays, nested objects, and huge strings are never headline material
    }
  }
  const s = fields.length > 0 ? `${title} — ${fields.join(', ')}` : title;
  return s.length > SUMMARY_MAX_CHARS ? `${s.slice(0, SUMMARY_MAX_CHARS - 1)}…` : s;
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
      lean4: opts.runtimeImages?.lean4 ?? process.env.WORKUNIT_LEAN_IMAGE,
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
  private async resolveRuntime(
    dir: string,
    entrypoint: string,
  ): Promise<{ name: string; config: RuntimeConfig }> {
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
    return { name, config: override ? { ...base, image: override } : base };
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

      const { name: runtimeName, config: runtime } = await this.resolveRuntime(dir, wu.entrypoint);
      const rawUsage = (extra: Record<string, unknown> = {}) => ({
        workunit: true,
        runtime: runtimeName,
        repo: wu.repo,
        sha: wu.sha,
        entrypoint: wu.entrypoint,
        duration_ms: Date.now() - started,
        ...extra,
      });

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
            ...(runtime.entrypoint !== undefined ? ['--entrypoint', runtime.entrypoint] : []),
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
        // Runtimes that opted in (proof checking) salvage a timed-out run as a
        // recorded progress contribution: the donated CPU time was genuinely
        // burned, and "did not check within the window" is itself a finding
        // the next agent should see — never a silent release. Other failures
        // (and other runtimes) still throw for a clean release.
        if (runtime.salvageTimeout && err instanceof Error && /timed out after/.test(err.message)) {
          const seconds = Math.round((Date.now() - started) / 1000);
          return {
            result: { timed_out: true, runtime: runtimeName, entrypoint: wu.entrypoint },
            outcome: 'progress',
            timed_out: true,
            summary:
              `Lean 4 proof check of ${wu.entrypoint} timed out after ~${seconds}s — the proof ` +
              `did not check within the budget window. Recorded so the donated CPU time is not ` +
              `lost; consider splitting the proof or raising WORKUNIT_TIMEOUT_MS.`,
            actual_cost_cents: 0, // CPU donation — no token spend to book
            raw_usage: rawUsage({ timed_out: true }),
          };
        }
        throw err;
      }

      // The runtime's own interpreter (proof checking: exit-marker + compiler
      // diagnostics), or the default driver contract: strict JSON on stdout.
      let interpreted: InterpretedOutput;
      if (runtime.interpret) {
        interpreted = runtime.interpret(out, wu.entrypoint);
      } else {
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
        interpreted = {
          result,
          outcome: r.outcome,
          summary: typeof r.summary === 'string' ? r.summary.slice(0, 500) : undefined,
          state_update: r.state_update,
        };
      }
      return {
        ...interpreted,
        // The runtime's own summary wins; a run that produced none gets a
        // synthesized headline (title + top scalar fields) so the public feed
        // never renders "(no summary)" for a completed CPU chunk. Applied
        // after interpretation so it covers EVERY runtime — the JSON drivers
        // and the lean4 proof-check results alike.
        summary:
          typeof interpreted.summary === 'string' && interpreted.summary.trim().length > 0
            ? interpreted.summary
            : synthesizeWorkUnitSummary(task.title, interpreted.result),
        actual_cost_cents: 0, // CPU donation — no token spend to book
        raw_usage: rawUsage(),
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
