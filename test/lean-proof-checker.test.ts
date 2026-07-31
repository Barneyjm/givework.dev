import { spawn, spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, pool } from '../src/db.js';
import { buildContinuationSection, type ExecResult, type ExecTask } from '../src/executor.js';
import { checkoutTask } from '../src/operations.js';
import { submitAndVerify } from '../src/verify.js';
import { LEAN4_IMAGE, type ProcOpts, WorkUnitExecutor } from '../src/workunit.js';
import { createDev, createTask, resetDb, setBudget } from './helpers.js';

// The proof_checker rail, end to end: a formalization chunk task pins a .lean
// file, the lean4 work-unit runtime checks it, and verification honors the
// machine verdict — green auto-accepts (target stays admin-gated), red pools
// the task with the compiler output preserved as correction context, timeout
// salvages instead of losing the donated CPU time.
//
// Two layers:
//   - hermetic (always runs): the runtime's process runner is injected, so the
//     exact transcripts the pinned image produces (captured from real runs)
//     drive the REAL interpret → submit → verify path against the real DB.
//   - canary (skipped unless podman AND the pinned lean image are present):
//     the same executor with podman passthrough actually compiles a genuine
//     core-Lean theorem inside the sandbox flags. CI never has the image, so
//     this runs where it matters: a maintainer's machine before release.

afterAll(closePool);
beforeEach(resetDb);

const REPO = 'Barneyjm/givework-contrib';
const SHA = '7ec361511299227e007d8523b70c4554218a8531';
const ENTRYPOINT = 'lean/canary/Canary.lean';
const MARKER = '__GIVEWORK_LEAN_EXIT__';

/** The trivially-true canary module (contrib-templates/lean) — verified green
 * in the pinned image before this file asserted anything. */
const CANARY_LEAN = `theorem add_comm_canary (a b : Nat) : a + b = b + a := Nat.add_comm a b

theorem small_power_check : 2 ^ 10 = 1024 := by decide
`;
/** A genuinely false claim — `decide` refutes it, lean exits 1. */
const BROKEN_LEAN = `theorem obviously_false : 1 + 1 = 3 := by decide
`;

async function createConjecture(slug: string): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO targets (name, kind, slug, contact_email)
     VALUES ($1, 'conjecture', $2, NULL) RETURNING id`,
    [`Conj ${slug}`, slug],
  );
  return rows[0].id;
}

/** A platform-authored formalization CHUNK: SHA-pinned lean source, proof_checker rail. */
function leanChunkTask(targetId: string, entrypoint = ENTRYPOINT) {
  return createTask(targetId, {
    max: 50,
    kind: 'formalization',
    verify_via: 'proof_checker',
    title: 'Check the pinned Lean module',
    spec: {
      prompt: 'Work unit: compile the pinned .lean file; exit 0 is the verdict.',
      code: { repo: REPO, sha: SHA, entrypoint, input: {} },
    },
  });
}

async function fundedDev(handle: string): Promise<string> {
  const dev = await createDev(handle);
  await setBudget(dev, 5000);
  return dev;
}

async function taskStatus(taskId: string): Promise<string> {
  const { rows } = await pool.query(`SELECT status FROM tasks WHERE id = $1`, [taskId]);
  return rows[0].status;
}
async function targetRow(id: string) {
  const { rows } = await pool.query(
    `SELECT status::text AS status, resolved_by FROM targets WHERE id = $1`,
    [id],
  );
  return rows[0];
}
async function verificationsFor(taskId: string) {
  const { rows } = await pool.query(
    `SELECT method::text AS method, verdict, verifier, detail FROM verifications WHERE task_id = $1 ORDER BY id`,
    [taskId],
  );
  return rows;
}

/** WorkUnitExecutor whose git checkout plants the lean4 manifest and whose
 * podman run replays `transcript` — the shape the real container emits. */
function scriptedLeanExecutor(transcript: string, entrypoint = ENTRYPOINT) {
  return new WorkUnitExecutor({
    allowedRepo: REPO,
    run: async (cmd, args, opts) => {
      if (cmd === 'git' && args[0] === 'checkout' && opts?.cwd) {
        const entryDir = path.join(opts.cwd, path.dirname(entrypoint));
        await mkdir(entryDir, { recursive: true });
        await writeFile(path.join(entryDir, 'manifest.json'), JSON.stringify({ runtime: 'lean4' }));
        return '';
      }
      return cmd === 'podman' && args[0] === 'run' ? transcript : '';
    },
  });
}

/** Run the chunk through the executor, then submit exactly as run-loop.ts does. */
async function executeAndSubmit(dev: string, taskId: string, executor: WorkUnitExecutor) {
  const checkout = await checkoutTask(dev, taskId);
  const exec: ExecResult = await executor.execute(checkout as unknown as ExecTask);
  const submit = await submitAndVerify(
    dev,
    taskId,
    exec.result,
    exec.actual_cost_cents,
    exec.raw_usage,
    { outcome: exec.outcome, summary: exec.summary, artifact: exec.artifact },
  );
  return { exec, submit };
}

describe('proof_checker via the lean4 rail (hermetic — scripted transcripts)', () => {
  it('green build: verification passed, task auto-accepted, target NOT flipped', async () => {
    const target = await createConjecture('lean-green');
    const task = await leanChunkTask(target);
    const dev = await fundedDev('lean-green-dev');

    const { exec, submit } = await executeAndSubmit(
      dev,
      task,
      scriptedLeanExecutor(`\n${MARKER} 0\n`),
    );
    expect(exec.outcome).toBe('candidate_solution');

    expect(submit.status).toBe('accepted');
    expect(submit.verification).toEqual({ verdict: 'passed', target_status: null });
    expect(await taskStatus(task)).toBe('accepted');

    const vs = await verificationsFor(task);
    expect(vs).toHaveLength(1);
    expect(vs[0]).toMatchObject({
      method: 'proof_checker',
      verdict: 'passed',
      verifier: 'platform',
    });
    expect(vs[0].detail).toMatchObject({ runtime: 'lean4', exit_code: 0 });

    // A green lemma is not a resolved conjecture: resolution stays admin-gated
    // (adminVerify's formalization→resolved mapping, unchanged and tested in
    // verify.test.ts, is the only automatic flip).
    const tg = await targetRow(target);
    expect(tg.status).toBe('open');
    expect(tg.resolved_by).toBeNull();
  });

  it('red build: verification failed, task pooled, spend booked, compiler output hydrates next checkout', async () => {
    const target = await createConjecture('lean-red');
    const task = await leanChunkTask(target);
    const dev = await fundedDev('lean-red-dev');

    const transcript =
      `${ENTRYPOINT}:1:42: error: tactic 'decide' proved that the proposition\n` +
      `  1 + 1 = 3\nis false\n\n${MARKER} 1\n`;
    const { submit } = await executeAndSubmit(dev, task, scriptedLeanExecutor(transcript));

    // Rejected back to the pool with the verdict recorded.
    expect(submit.status).toBe('open');
    expect(submit.verification).toMatchObject({ verdict: 'failed' });
    expect(await taskStatus(task)).toBe('open');
    expect((await targetRow(target)).status).toBe('open');
    const vs = await verificationsFor(task);
    expect(vs[0]).toMatchObject({
      method: 'proof_checker',
      verdict: 'failed',
      verifier: 'platform',
    });
    expect((vs[0].detail as { compiler_tail: string }).compiler_tail).toContain(
      "tactic 'decide' proved",
    );

    // The spend (0¢ CPU donation) is BOOKED — the contribution row exists with
    // the compiler output preserved. Donated compute is never lost.
    const { rows: contribs } = await pool.query(
      `SELECT outcome::text AS outcome, artifact, cost_cents FROM contributions WHERE task_id = $1`,
      [task],
    );
    expect(contribs).toHaveLength(1);
    expect(contribs[0].cost_cents).toBe(0);
    expect(contribs[0].artifact.compiler_output).toContain('error:');

    // The next agent's checkout hydrates the compiler output (the same channel
    // as a salvaged invalid decomposition) and the continuation section renders
    // it as correction context.
    const dev2 = await fundedDev('lean-red-dev-2');
    const co = await checkoutTask(dev2, task);
    const prior = co.prior_contributions?.[0];
    expect((prior?.artifact as { compiler_output?: string })?.compiler_output).toContain('error:');
    const rendered = buildContinuationSection(co.target_state, co.prior_contributions ?? []);
    expect(rendered).toContain('proof checker REJECTED');
    expect(rendered).toContain("tactic 'decide' proved");
  });

  it("a sorried proof records failed — lean's exit 0 on the warning must not auto-accept", async () => {
    const target = await createConjecture('lean-sorry');
    const task = await leanChunkTask(target);
    const dev = await fundedDev('lean-sorry-dev');

    const transcript = `${ENTRYPOINT}:1:8: warning: declaration uses 'sorry'\n\n${MARKER} 0\n`;
    const { submit } = await executeAndSubmit(dev, task, scriptedLeanExecutor(transcript));
    expect(submit.status).toBe('open');
    expect(submit.verification).toMatchObject({ verdict: 'failed' });
    expect((await verificationsFor(task))[0].detail).toMatchObject({ exit_code: 0 });
  });

  it('a fabricated machine verdict on a NON-chunk task stays pending for a human', async () => {
    // An LLM-path formalization task (no spec.code): an agent echoing the
    // machine-result keys in its JSON must not be able to self-accept.
    const target = await createConjecture('lean-fabricated');
    const task = await createTask(target, {
      max: 50,
      kind: 'formalization',
      verify_via: 'proof_checker',
      spec: { prompt: 'Write a Lean proof of the lemma.' },
    });
    const dev = await fundedDev('lean-fab-dev');
    await checkoutTask(dev, task);

    const submit = await submitAndVerify(
      dev,
      task,
      { proof_checker: 'lean4', proof_checked: true, exit_code: 0, compiler_output: '' },
      10,
      null,
    );
    expect(submit.status).toBe('submitted'); // held, not accepted
    expect(submit.verification).toMatchObject({ verdict: 'pending' });
    expect(await taskStatus(task)).toBe('submitted');
    const vs = await verificationsFor(task);
    expect(vs[0]).toMatchObject({ method: 'proof_checker', verdict: 'pending' });
  });

  it('timeout: the run is salvaged as a booked progress contribution, task back in the pool', async () => {
    const target = await createConjecture('lean-timeout');
    const task = await leanChunkTask(target);
    const dev = await fundedDev('lean-timeout-dev');

    const executor = new WorkUnitExecutor({
      allowedRepo: REPO,
      run: async (cmd, args, opts) => {
        if (cmd === 'git' && args[0] === 'checkout' && opts?.cwd) {
          const entryDir = path.join(opts.cwd, path.dirname(ENTRYPOINT));
          await mkdir(entryDir, { recursive: true });
          await writeFile(
            path.join(entryDir, 'manifest.json'),
            JSON.stringify({ runtime: 'lean4' }),
          );
          return '';
        }
        if (cmd === 'podman' && args[0] === 'run') {
          throw new Error('podman timed out after 100ms');
        }
        return '';
      },
    });
    const { exec, submit } = await executeAndSubmit(dev, task, executor);
    expect(exec.timed_out).toBe(true);

    // Progress, not a verdict: pooled by design, recorded, nothing verified.
    expect(submit.status).toBe('open');
    expect(submit.verification).toBeNull();
    expect(await taskStatus(task)).toBe('open');
    const { rows: contribs } = await pool.query(
      `SELECT outcome::text AS outcome, summary FROM contributions WHERE task_id = $1`,
      [task],
    );
    expect(contribs).toHaveLength(1);
    expect(contribs[0].outcome).toBe('progress');
    expect(contribs[0].summary).toMatch(/timed out/);
    expect(await verificationsFor(task)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Canary — the real compiler in the real pinned image under the real sandbox
// flags. Skipped unless podman AND the pinned lean4 image are already present
// (CI never pulls the 407 MB image; run `podman pull <LEAN4_IMAGE>` locally,
// then this suite is the pre-release gate for the rail).
// ---------------------------------------------------------------------------

const havePodman = spawnSync('podman', ['--version'], { stdio: 'ignore' }).status === 0;
const haveLeanImage =
  havePodman &&
  spawnSync('podman', ['image', 'exists', LEAN4_IMAGE], { stdio: 'ignore' }).status === 0;

/** Real process runner for the canary: same contract as the executor's own
 * (resolve stdout on exit 0, throw '<cmd> timed out after Xms' on timeout). */
function realProc(cmd: string, args: string[], opts: ProcOpts = {}): Promise<string> {
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
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.stderr.on('data', (d) => {
      err += d;
    });
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} exited ${code}: ${err.slice(0, 300)}`));
    });
    child.stdin.on('error', () => {});
    if (opts.input !== undefined) child.stdin.write(opts.input);
    child.stdin.end();
  });
}

/** Executor that fakes only the git fetch (planting `files` as the checkout)
 * and runs podman for real — the image, flags, command, and interpretation
 * are all the production path. */
function canaryExecutor(files: Record<string, string>, timeoutMs?: number) {
  return new WorkUnitExecutor({
    allowedRepo: REPO,
    ...(timeoutMs ? { timeoutMs } : {}),
    run: async (cmd, args, opts) => {
      if (cmd === 'git') {
        if (args[0] === 'checkout' && opts?.cwd) {
          for (const [rel, content] of Object.entries(files)) {
            const p = path.join(opts.cwd, rel);
            await mkdir(path.dirname(p), { recursive: true });
            await writeFile(p, content);
          }
        }
        return '';
      }
      return realProc(cmd, args, opts);
    },
  });
}

const MANIFEST = JSON.stringify({ runtime: 'lean4' });

describe.skipIf(!haveLeanImage)('lean4 canary (real podman, real pinned image)', () => {
  it('a genuine core-Lean theorem compiles green and verifies passed end to end', {
    timeout: 120_000,
  }, async () => {
    const target = await createConjecture('canary-green');
    const task = await leanChunkTask(target);
    const dev = await fundedDev('canary-green-dev');

    const executor = canaryExecutor({
      [ENTRYPOINT]: CANARY_LEAN,
      'lean/canary/manifest.json': MANIFEST,
    });
    const { exec, submit } = await executeAndSubmit(dev, task, executor);
    expect(exec.result).toMatchObject({
      proof_checker: 'lean4',
      proof_checked: true,
      exit_code: 0,
    });
    expect(submit.status).toBe('accepted');
    expect(submit.verification).toEqual({ verdict: 'passed', target_status: null });
    expect((await targetRow(target)).status).toBe('open'); // admin-gated
  });

  it('a false theorem fails red with the real diagnostic preserved, task pooled', {
    timeout: 120_000,
  }, async () => {
    const target = await createConjecture('canary-red');
    const entrypoint = 'lean/canary/Broken.lean';
    const task = await leanChunkTask(target, entrypoint);
    const dev = await fundedDev('canary-red-dev');

    const executor = canaryExecutor({
      [entrypoint]: BROKEN_LEAN,
      'lean/canary/manifest.json': MANIFEST,
    });
    const { exec, submit } = await executeAndSubmit(dev, task, executor);
    expect(exec.result).toMatchObject({ proof_checker: 'lean4', proof_checked: false });
    expect((exec.result as { compiler_output: string }).compiler_output).toContain(
      "tactic 'decide' proved",
    );
    expect(submit.status).toBe('open');
    expect(submit.verification).toMatchObject({ verdict: 'failed' });
  });

  it('a real timeout is salvaged, and the container is reaped', { timeout: 120_000 }, async () => {
    // 300ms: podman + qemu startup alone exceeds it, so the kill always fires.
    const executor = canaryExecutor(
      { [ENTRYPOINT]: CANARY_LEAN, 'lean/canary/manifest.json': MANIFEST },
      300,
    );
    const res = await executor.execute({
      task_id: 'canary-timeout',
      title: 'wu',
      model: 'unused',
      max_cost_cents: 10,
      spec: { code: { repo: REPO, sha: SHA, entrypoint: ENTRYPOINT, input: {} } },
    });
    expect(res.timed_out).toBe(true);
    expect(res.outcome).toBe('progress');
    expect(res.summary).toMatch(/timed out/);
  });
});
