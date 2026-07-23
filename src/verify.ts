import { query } from './db.js';
import type { VerificationMethod } from './intake/decompose.js';
import type { SendEmailBinding } from './mailer.js';
import {
  type ContributeOptions,
  isDevVerified,
  OpError,
  rejectTask,
  type SubmitResult,
  submitResult,
} from './operations.js';
import { acceptTaskAndNotify } from './review.js';

// Verification core. Replaces the subjective accept/reject with a recorded
// verification step. Phase 5 wires the two methods that need no external
// toolchain:
//   - auto_rerun    — re-evaluate a claimed counterexample with a built-in,
//                     safe, deterministic checker. A pass flips the target to
//                     'disproven'. (Sandboxed/arbitrary checkers are Phase 6.)
//   - human_review  — deferred to the existing admin accept/reject, which now
//                     records a verification row.
// proof_checker and replication record a 'pending' verification and wait for
// Phase 6 (the trusted sandbox + K-of-N replication).

export type Verdict = 'passed' | 'failed' | 'inconclusive' | 'pending';

/** Kinds whose status a verification may flip. org_request work is never touched. */
const RESOLVABLE_KINDS = ['conjecture', 'research_question'];

// ---------------------------------------------------------------------------
// Built-in witness checkers (auto_rerun). Pure, deterministic, no code eval.
// A target names one via targets.checker; the witness is the task's result.
// ---------------------------------------------------------------------------

export interface CheckerResult {
  /** True iff the witness genuinely disproves the conjecture. */
  disproves: boolean;
  /** True iff the witness can't be decided here (e.g. beyond a safe range). */
  inconclusive?: boolean;
  detail?: unknown;
}
export type WitnessChecker = (witness: unknown) => CheckerResult;

function isPrime(n: number): boolean {
  if (n < 2) return false;
  if (n % 2 === 0) return n === 2;
  for (let i = 3; i * i <= n; i += 2) if (n % i === 0) return false;
  return true;
}

/**
 * Euler's sum-of-powers conjecture (k=5, four terms) — DISPROVEN. A witness
 * {bases:[a,b,c,d], target:e} disproves it iff a^5+b^5+c^5+d^5 = e^5 for positive
 * integers (the classic 27^5+84^5+110^5+133^5 = 144^5). Exact BigInt arithmetic,
 * bases bounded so the check is cheap.
 */
function eulerSumOfPowers(witness: any): CheckerResult {
  const bases = witness?.bases;
  const target = witness?.target;
  if (!Array.isArray(bases) || bases.length !== 4 || typeof target !== 'number') {
    return { disproves: false, detail: { reason: 'witness must be {bases:[4 ints], target:int}' } };
  }
  const all = [...bases, target];
  if (!all.every((n) => Number.isInteger(n) && n > 0 && n <= 10_000_000)) {
    return { disproves: false, detail: { reason: 'terms must be positive integers within range' } };
  }
  const lhs = (bases as number[]).reduce((s, b) => s + BigInt(b) ** 5n, 0n);
  const rhs = BigInt(target) ** 5n;
  return { disproves: lhs === rhs, detail: { lhs: lhs.toString(), rhs: rhs.toString() } };
}

/**
 * Goldbach's conjecture — OPEN. A witness {n} disproves it iff n is an even
 * integer > 2 with NO representation as a sum of two primes (none is known). This
 * checker mostly *rejects* bogus counterexample claims — it always finds a
 * decomposition for real n — which is exactly the point: it won't false-positive.
 */
const GOLDBACH_MAX = 5_000_000;
function goldbach(witness: any): CheckerResult {
  const n = witness?.n;
  if (!Number.isInteger(n) || n <= 2 || n % 2 !== 0) {
    return { disproves: false, detail: { reason: 'witness must be an even integer > 2' } };
  }
  if (n > GOLDBACH_MAX) {
    return { disproves: false, inconclusive: true, detail: { reason: 'beyond checkable range' } };
  }
  for (let p = 2; p <= n / 2; p++) {
    if (isPrime(p) && isPrime(n - p)) {
      return { disproves: false, detail: { decomposition: [p, n - p] } };
    }
  }
  return { disproves: true, detail: { reason: 'no two-prime decomposition exists' } };
}

/** Registry of named checkers a target can reference via targets.checker. */
export const CHECKERS: Record<string, WitnessChecker> = {
  euler_sum_of_powers: eulerSumOfPowers,
  goldbach,
};

// ---------------------------------------------------------------------------
// Verification records + target status flip
// ---------------------------------------------------------------------------

async function recordVerification(v: {
  taskId: string;
  contributionId: number | null;
  targetId: string | null;
  method: VerificationMethod;
  verdict: Verdict;
  verifier: string;
  detail?: unknown;
}): Promise<number> {
  const { rows } = await query<{ id: number }>(
    `INSERT INTO verifications
       (task_id, contribution_id, target_id, method, verdict, verifier, detail)
     VALUES ($1, $2, $3, $4::verification_method, $5, $6, $7)
     RETURNING id`,
    [
      v.taskId,
      v.contributionId,
      v.targetId,
      v.method,
      v.verdict,
      v.verifier,
      v.detail != null ? JSON.stringify(v.detail) : null,
    ],
  );
  return rows[0].id;
}

async function latestContributionId(taskId: string): Promise<number | null> {
  const { rows } = await query<{ id: number }>(
    `SELECT id FROM contributions WHERE task_id = $1 ORDER BY id DESC LIMIT 1`,
    [taskId],
  );
  return rows[0]?.id ?? null;
}

/**
 * Flip a target to 'resolved'/'disproven', crediting the winning contribution.
 * Guarded: only public (conjecture/research_question) targets that are still open
 * are touched, and an already-settled target is never overwritten. Returns the
 * new status, or null if nothing changed.
 */
async function flipTargetStatus(
  targetId: string,
  status: 'resolved' | 'disproven',
  contributionId: number | null,
): Promise<string | null> {
  const { rows } = await query<{ status: string }>(
    `UPDATE targets
        SET status = $2::target_status, resolved_by = $3
      WHERE id = $1
        AND kind::text = ANY($4::text[])
        AND status IN ('open', 'partially_resolved')
      RETURNING status::text AS status`,
    [targetId, status, contributionId, RESOLVABLE_KINDS],
  );
  return rows[0]?.status ?? null;
}

// ---------------------------------------------------------------------------
// The verification entry points
// ---------------------------------------------------------------------------

export interface VerifyOutcome {
  /**
   * True when this call decided the task's fate (or is intentionally holding it
   * for later verification). False ONLY for human_review, so the caller falls
   * back to the existing trust/admin accept flow.
   */
  handled: boolean;
  method?: VerificationMethod;
  verdict?: Verdict;
  /** The target's new status if a verification flipped it, else null. */
  target_status?: string | null;
  verification_id?: number;
}

interface TaskVerifyRow {
  status: string;
  verify_via: VerificationMethod;
  target_id: string;
  result: unknown;
  checker: string | null;
}

/**
 * Automated verification, run right after a terminal (candidate_solution) submit.
 * - human_review        -> not handled; caller keeps the trust/admin flow.
 * - auto_rerun          -> re-evaluate the witness with the target's checker.
 *     passed  -> accept the task + flip the target to 'disproven'.
 *     failed  -> reject the task back to the pool (the claim didn't check out).
 *     no checker / inconclusive -> record + leave 'submitted' for a human.
 * - proof_checker / replication -> record 'pending' (Phase 6), leave 'submitted'.
 */
export async function runAutoVerification(
  taskId: string,
  binding?: SendEmailBinding,
): Promise<VerifyOutcome> {
  const { rows } = await query<TaskVerifyRow>(
    `SELECT t.status, t.verify_via::text AS verify_via, t.target_id, t.result, tg.checker
       FROM tasks t
       JOIN targets tg ON tg.id = t.target_id
      WHERE t.id = $1`,
    [taskId],
  );
  const row = rows[0];
  if (row?.status !== 'submitted') return { handled: false };

  const method = row.verify_via;
  if (method === 'human_review') return { handled: false, method };

  const contributionId = await latestContributionId(taskId);

  if (method === 'auto_rerun') {
    const checker = row.checker ? CHECKERS[row.checker] : undefined;
    if (!checker) {
      const id = await recordVerification({
        taskId,
        contributionId,
        targetId: row.target_id,
        method,
        verdict: 'pending',
        verifier: 'platform',
        detail: { reason: 'no checker registered for this target' },
      });
      return {
        handled: true,
        method,
        verdict: 'pending',
        target_status: null,
        verification_id: id,
      };
    }
    const check = checker(row.result);
    if (check.inconclusive) {
      const id = await recordVerification({
        taskId,
        contributionId,
        targetId: row.target_id,
        method,
        verdict: 'inconclusive',
        verifier: 'platform',
        detail: check.detail,
      });
      return {
        handled: true,
        method,
        verdict: 'inconclusive',
        target_status: null,
        verification_id: id,
      };
    }
    if (check.disproves) {
      const id = await recordVerification({
        taskId,
        contributionId,
        targetId: row.target_id,
        method,
        verdict: 'passed',
        verifier: 'platform',
        detail: check.detail,
      });
      // The counterexample checks out: accept the deliverable and disprove the target.
      await acceptTaskAndNotify(taskId, binding);
      const target_status = await flipTargetStatus(row.target_id, 'disproven', contributionId);
      return { handled: true, method, verdict: 'passed', target_status, verification_id: id };
    }
    // The claimed counterexample does not hold — reject back to the pool.
    const id = await recordVerification({
      taskId,
      contributionId,
      targetId: row.target_id,
      method,
      verdict: 'failed',
      verifier: 'platform',
      detail: check.detail,
    });
    await rejectTask(taskId);
    return { handled: true, method, verdict: 'failed', target_status: null, verification_id: id };
  }

  // proof_checker / replication — not automatable yet (Phase 6). Hold for a human.
  const id = await recordVerification({
    taskId,
    contributionId,
    targetId: row.target_id,
    method,
    verdict: 'pending',
    verifier: 'platform',
    detail: { reason: `${method} verification is not yet automated` },
  });
  return { handled: true, method, verdict: 'pending', target_status: null, verification_id: id };
}

export interface SubmitVerification {
  verdict: Verdict;
  target_status: string | null;
}

export interface VerifiedSubmitResult extends Omit<SubmitResult, 'status'> {
  /**
   * The task's state AFTER verification, not just after the submit: a failed
   * check has already reopened it ('open'), a passed check or trust auto-accept
   * has already accepted it ('accepted').
   */
  status: 'submitted' | 'open' | 'accepted';
  verification: SubmitVerification | null;
}

/**
 * The one submit entrypoint both rails share (HTTP /submit and the MCP
 * submit_result tool): book the contribution, then verify a terminal
 * (candidate_solution) submission. A progress/dead-end contribution returned
 * the task to the pool, so there's nothing to verify. Machine verification
 * decides auto_rerun (holding proof_checker/replication for Phase 6);
 * human_review is NOT handled here — fall back to the trust auto-accept, where
 * a verified volunteer's work flows straight through and an unverified one
 * waits for admin review. Verification failures are non-fatal: the submit
 * (and its booked spend) already succeeded.
 */
export async function submitAndVerify(
  devId: string,
  taskId: string,
  result: unknown,
  actualCostCents: number,
  rawUsage: unknown,
  opts: ContributeOptions = {},
  binding?: SendEmailBinding,
): Promise<VerifiedSubmitResult> {
  const submitted = await submitResult(devId, taskId, result, actualCostCents, rawUsage, opts);
  let status: VerifiedSubmitResult['status'] = submitted.status;
  let verification: SubmitVerification | null = null;
  try {
    if (submitted.status === 'submitted') {
      const v = await runAutoVerification(taskId, binding);
      if (v.handled) {
        verification = { verdict: v.verdict ?? 'pending', target_status: v.target_status ?? null };
        if (v.verdict === 'failed') status = 'open';
        else if (v.verdict === 'passed') status = 'accepted';
      } else if (await isDevVerified(devId)) {
        await acceptTaskAndNotify(taskId, binding);
        status = 'accepted';
      }
    }
  } catch (err) {
    console.error('verification on submit failed', err);
  }
  return { ...submitted, status, verification };
}

/**
 * The human_review path: an admin accepts or rejects a submitted task, and we
 * record the verification. Accepting notifies (via acceptTaskAndNotify) and marks
 * the deliverable good; it does NOT auto-resolve the whole conjecture — an admin
 * sets a target's status explicitly (POST /admin/targets/:id) so a single accept
 * never over-claims a famous problem "resolved".
 */
export async function recordHumanReview(
  taskId: string,
  verdict: 'passed' | 'failed',
  verifier: string,
  binding?: SendEmailBinding,
): Promise<{ task_id: string; verdict: Verdict; verification_id: number }> {
  const { rows } = await query<{ target_id: string | null }>(
    `SELECT target_id FROM tasks WHERE id = $1`,
    [taskId],
  );
  const targetId = rows[0]?.target_id ?? null;
  const contributionId = await latestContributionId(taskId);

  if (verdict === 'passed') {
    // Accept first: acceptTask guards on status='submitted' and throws otherwise,
    // so we only record a verification for a real accept.
    await acceptTaskAndNotify(taskId, binding);
  } else {
    await rejectTask(taskId);
  }
  const id = await recordVerification({
    taskId,
    contributionId,
    targetId,
    method: 'human_review',
    verdict,
    verifier,
  });
  return { task_id: taskId, verdict, verification_id: id };
}

type Resolution = 'resolved' | 'disproven';

/**
 * The status flip a passing verification implies from the task's kind: a verified
 * counterexample disproves; a checked proof resolves. Other kinds (a confirmed
 * computational range, a lemma, exploration) advance the work but don't settle the
 * whole conjecture, so they don't flip on their own — an admin can still force one
 * via `resolve`.
 */
function resolutionForKind(kind: string): Resolution | null {
  if (kind === 'counterexample_search') return 'disproven';
  if (kind === 'formalization') return 'resolved';
  return null;
}

/**
 * Admin-run local checker (Phase 6, scoped): an admin runs the real check on their
 * own machine — compile the Lean proof, re-run the search range, evaluate the
 * witness — and posts an authoritative verdict. Unlike the lightweight
 * accept/reject, this records the task's *actual* method and, on a pass, flips the
 * target when the kind implies a resolution (or when the admin sets `resolve`
 * explicitly). The admin standing in for the sandbox until Phase 6 proper.
 */
export async function adminVerify(
  taskId: string,
  verdict: 'passed' | 'failed' | 'inconclusive',
  opts: {
    verifier?: string;
    detail?: unknown;
    resolve?: Resolution;
    binding?: SendEmailBinding;
  } = {},
): Promise<{
  task_id: string;
  method: VerificationMethod;
  verdict: Verdict;
  target_status: string | null;
  verification_id: number;
}> {
  const { rows } = await query<{
    status: string;
    verify_via: VerificationMethod;
    kind: string;
    target_id: string | null;
  }>(
    `SELECT status, verify_via::text AS verify_via, kind::text AS kind, target_id
       FROM tasks WHERE id = $1`,
    [taskId],
  );
  const t = rows[0];
  if (!t) throw new OpError(404, 'task_not_found', 'Unknown task');
  if (t.status !== 'submitted') {
    throw new OpError(409, 'not_submitted', 'Task is not awaiting verification');
  }
  const contributionId = await latestContributionId(taskId);

  let target_status: string | null = null;
  if (verdict === 'passed') {
    await acceptTaskAndNotify(taskId, opts.binding);
    const resolution = opts.resolve ?? resolutionForKind(t.kind);
    if (resolution && t.target_id) {
      target_status = await flipTargetStatus(t.target_id, resolution, contributionId);
    }
  } else if (verdict === 'failed') {
    await rejectTask(taskId);
  }
  // 'inconclusive' records the attempt only, leaving the task submitted.
  const id = await recordVerification({
    taskId,
    contributionId,
    targetId: t.target_id,
    method: t.verify_via,
    verdict,
    verifier: opts.verifier ?? 'admin',
    detail: opts.detail,
  });
  return { task_id: taskId, method: t.verify_via, verdict, target_status, verification_id: id };
}
