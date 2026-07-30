import { createInterface } from 'node:readline';
import type { ExecTask, Executor } from '../executor.js';
import { getExecutor } from '../executor.js';
import { ONBOARDING_MAX_CENTS } from '../goldbach.js';
import { getDecomposer } from '../intake/decompose.js';
import { HttpBackend, runLoop, stubExecutorRemoteRefusal, withLease } from '../run-loop.js';
import { ApiError, apiRequest } from './api.js';
import { apiUrl, loadConfig, requireAdminToken, requireToken, saveConfig } from './config.js';
import { login } from './login.js';
import { captureCliEvent, telemetryEnabled } from './telemetry.js';

// getExecutor() dispatches: a code work-unit task (spec.code) goes to the
// sandboxed WorkUnitExecutor; everything else to the LLM path — the deterministic
// stub by default, `claude -p` when EXECUTOR=claude. It is SDK-free (no
// @anthropic-ai/sdk), so bundling it keeps the CLI small. Using it here is what
// lets a volunteer's runner actually handle work units (podman sandbox, or a
// graceful skip when podman isn't installed) instead of running claude -p on them.
const cliExecutor = getExecutor;

// Implementations of the CLI verbs. Each takes the post-command argv slice. Pure
// HTTP + the shared run-loop; no server-only imports so the bundle stays small.

/** Pull `--name value` from an args array (undefined if absent). */
export function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}
const has = (args: string[], name: string) => args.includes(name);

// ---------------------------------------------------------------------------
// Flag allowlists — every flag each subcommand actually reads, so the router
// can reject anything else instead of silently ignoring it. Production
// incident: `givework run --help` fell through to a full pool run because
// unknown flags were dropped on the floor. The spec value records whether the
// flag consumes the following token as its value.
// ---------------------------------------------------------------------------

/** Flags a subcommand accepts: flag -> whether it consumes the next token as a value. */
export type FlagSpec = Record<string, boolean>;

const RUN_FLAGS: FlagSpec = {
  '--target': true,
  '--task': true,
  '--watch': false,
  '--once': false,
  '--max': true,
  '--interval': true,
  '--stop-on-error': false,
  '--no-update-check': false,
};

/** Top-level commands. `start` forwards its args to `onboard` and `run`, so it accepts both sets. */
export const COMMAND_FLAGS: Record<string, FlagSpec> = {
  start: { ...RUN_FLAGS, '--budget': true },
  onboard: { '--budget': true },
  login: {},
  whoami: {},
  budget: {},
  tasks: { '--max': true, '--sensitivity': true, '--limit': true, '--target': true },
  stats: {},
  history: { '--limit': true, '--before': true },
  run: RUN_FLAGS,
  version: {},
  status: {},
};

export const ADMIN_FLAGS: Record<string, FlagSpec> = {
  login: {},
  funnel: {},
  verify: {},
  review: {},
  accept: {},
  decompose: { '--watch': false, '--interval': true },
  budget: {},
  task: { '--json': true },
};

const TARGET_EDIT_FLAGS: FlagSpec = { '--name': true, '--email': true, '--ein': true };

/** `admin target <sub>`: `--verified`/`--listed` are bare on create but take true|false on set. */
export const ADMIN_TARGET_FLAGS: Record<string, FlagSpec> = {
  list: {},
  show: {},
  create: { ...TARGET_EDIT_FLAGS, '--verified': false, '--listed': false },
  set: { ...TARGET_EDIT_FLAGS, '--verified': true, '--listed': true },
  allow: {},
  deny: {},
  'rm-id': {},
};

export interface FlagCheck {
  /** `--help`/`-h` was present — print usage and exit 0, never run the command. */
  help: boolean;
  /** Flags the invoked subcommand does not recognize, in argv order. */
  unknown: string[];
}

/**
 * Scan an args slice against one subcommand's flag spec. Positional tokens
 * pass through untouched; a value-taking flag consumes its following token so
 * a value is never mistaken for a flag.
 */
export function checkFlags(args: string[], spec: FlagSpec): FlagCheck {
  const unknown: string[] = [];
  let help = false;
  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    if (tok === '--help' || tok === '-h') {
      help = true;
      continue;
    }
    if (!tok.startsWith('-')) continue;
    if (Object.hasOwn(spec, tok)) {
      if (spec[tok]) i++; // skip the flag's value
      continue;
    }
    unknown.push(tok);
  }
  return { help, unknown };
}

/**
 * Resolve the spec for the invoked (sub)command and run the scan. Returns null
 * when the command (or admin subcommand) itself is unknown — the routers
 * already report those with their own usage text and nonzero exit.
 */
export function flagCheckFor(cmd: string | undefined, args: string[]): FlagCheck | null {
  if (cmd === undefined) return null;
  if (cmd === 'admin') {
    const sub = args[0];
    if (sub === '--help' || sub === '-h') return { help: true, unknown: [] };
    if (sub === 'target') {
      const tsub = args[1];
      if (tsub === '--help' || tsub === '-h') return { help: true, unknown: [] };
      const spec = tsub !== undefined ? ADMIN_TARGET_FLAGS[tsub] : undefined;
      return spec ? checkFlags(args.slice(2), spec) : null;
    }
    const spec = sub !== undefined ? ADMIN_FLAGS[sub] : undefined;
    return spec ? checkFlags(args.slice(1), spec) : null;
  }
  const spec = COMMAND_FLAGS[cmd];
  return spec ? checkFlags(args, spec) : null;
}

/** Read a single line from stdin (for pasting a token). */
function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(question, (a) => {
      rl.close();
      resolve(a.trim());
    }),
  );
}

// --- dev commands ---

export async function whoami(): Promise<void> {
  const token = requireToken();
  const me = await apiRequest<any>(apiUrl(), { path: '/devs/me', token });
  const b = me.budget;
  console.log(
    `@${me.github_handle}  (${me.verified ? 'verified' : 'unverified — public tasks only'})`,
  );
  if (b) {
    console.log(
      `budget: ${b.available_cents}¢ available of ${b.budget_cents}¢  (reserved ${b.reserved_cents}¢, spent ${b.spent_cents}¢)`,
    );
  } else {
    console.log('budget: none set for this period — run:  givework budget set <cents>');
  }
}

export async function budget(args: string[]): Promise<void> {
  if (args[0] !== 'set' || !args[1]) {
    console.error('Usage: givework budget set <cents>');
    process.exit(1);
  }
  const cents = Number(args[1]);
  if (!Number.isInteger(cents) || cents < 0) {
    console.error('budget must be a non-negative integer (cents)');
    process.exit(1);
  }
  const token = requireToken();
  const b = await apiRequest<any>(apiUrl(), {
    method: 'POST',
    path: '/devs/budget',
    token,
    body: { budget_cents: cents },
  });
  console.log(`✓ budget set: ${b.budget_cents}¢ this period (${b.available_cents}¢ available)`);
}

export async function history(args: string[]): Promise<void> {
  const token = requireToken();
  const qs = new URLSearchParams();
  const limit = arg(args, '--limit');
  const before = arg(args, '--before');
  if (limit) qs.set('limit', limit);
  if (before) qs.set('before', before);
  const q = qs.toString();
  const page = await apiRequest<any>(apiUrl(), {
    path: `/devs/me/ledger${q ? `?${q}` : ''}`,
    token,
  });
  if (!page.entries.length) {
    console.log('No contributions yet — run `givework run` to start.');
    return;
  }
  for (const e of page.entries) {
    const when = new Date(e.created_at).toISOString().slice(0, 16).replace('T', ' ');
    const amount = `${e.delta_cents > 0 ? '+' : ''}${e.delta_cents}¢`;
    const label = e.task_title ?? e.task_id;
    console.log(
      `${when}  ${e.event_type.padEnd(8)} ${amount.padStart(7)}  ${label}${e.target_name ? `  · ${e.target_name}` : ''}`,
    );
  }
  if (page.next_before) {
    console.log(`\n… older entries:  givework history --before ${page.next_before}`);
  }
}

export async function stats(): Promise<void> {
  const token = requireToken();
  const s = await apiRequest<any>(apiUrl(), { path: '/devs/me/stats', token });
  console.log(`donated:    ${s.total_donated_cents}¢ all time`);
  console.log(`tasks:      ${s.tasks_completed} completed · ${s.tasks_accepted} accepted`);
  console.log(`conjectures: ${s.targets_helped} advanced`);
  if (s.first_contribution_at) {
    console.log(`since:      ${new Date(s.first_contribution_at).toISOString().slice(0, 10)}`);
  }
  if (s.by_month?.length) {
    console.log('\nby month:');
    for (const m of s.by_month) {
      console.log(
        `  ${m.month}   ${String(m.donated_cents).padStart(7)}¢   ${m.tasks} task${m.tasks === 1 ? '' : 's'}`,
      );
    }
  }
}

export async function version(): Promise<void> {
  const v = await apiRequest<any>(apiUrl(), { path: '/version' });
  console.log(
    `${v.service}  ${v.commit?.slice(0, 8)} (${v.ref})${v.deployed_at ? `  deployed ${v.deployed_at}` : ''}`,
  );
}

// Browse the open task pool — what `run` would pick from, without claiming any.
// The API pins unverified devs to public tasks, so the listing reflects what you
// can actually check out. Default page is small; use --limit to see more.
// --target <slug> narrows to one conjecture (what `run --target` would pick from).
export async function tasks(args: string[]): Promise<void> {
  const token = requireToken();
  const qs = new URLSearchParams();
  const max = arg(args, '--max');
  const sensitivity = arg(args, '--sensitivity');
  const limit = arg(args, '--limit');
  const target = arg(args, '--target');
  if (max) qs.set('max_cost_cents', max);
  if (sensitivity) qs.set('sensitivity', sensitivity);
  if (limit) qs.set('limit', limit);
  if (target) qs.set('target', target);
  const q = qs.toString();
  const rows = await apiRequest<any[]>(apiUrl(), { path: `/tasks/open${q ? `?${q}` : ''}`, token });
  if (!rows.length) {
    console.log(
      target
        ? `No open tasks for ${target} right now. Drop --target to browse the whole pool.`
        : 'No open tasks right now. Try again later, or run:  givework start --watch',
    );
    return;
  }
  console.log(`${rows.length} open task${rows.length === 1 ? '' : 's'}:`);
  for (const t of rows) {
    console.log(`  ${t.id}`);
    console.log(
      `    ${t.title}  ·  ${t.model}  ·  ~${t.est_cost_cents}¢ (cap ${t.max_cost_cents}¢)  ·  ${t.sensitivity}`,
    );
  }
}

// Build commit stamped in by scripts/build-cli.mjs; 'dev' from source (tsx) or a
// tarball install without git, which disables the staleness check.
const BUILD_SHA = process.env.GIVEWORK_BUILD_SHA ?? 'dev';

/**
 * Warn loudly if this runner is behind the latest `main`. `npx github:…` caches
 * installs, so a volunteer can unknowingly run a stale build for weeks (which is
 * exactly how a runner ends up mishandling a task). Best-effort and
 * non-blocking: any network/rate-limit error is swallowed. Skipped with
 * --no-update-check or when the build SHA is unknown.
 */
async function warnIfStale(args: string[]): Promise<void> {
  if (BUILD_SHA === 'dev' || has(args, '--no-update-check')) return;
  try {
    const res = await fetch('https://api.github.com/repos/Barneyjm/givework.dev/commits/main', {
      headers: { Accept: 'application/vnd.github.sha', 'User-Agent': 'givework-runner' },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return;
    const latest = (await res.text()).trim();
    if (!latest || latest.startsWith(BUILD_SHA)) return; // current
    console.warn(
      '\n  ┌─ A newer Givework runner is available ───────────────────────\n' +
        `  │  you're on ${BUILD_SHA}, latest is ${latest.slice(0, 7)}\n` +
        '  │  update:  rm -rf ~/.npm/_npx   then re-run the same command\n' +
        '  └───────────────────────────────────────────────────────────────\n',
    );
  } catch {
    // offline or GitHub rate-limited — never block donated work on a version check
  }
}

export async function run(args: string[]): Promise<void> {
  const base = apiUrl();
  // FIRST, before any network call: a stub executor (EXECUTOR unset or not
  // 'claude') pointed at a remote control plane would submit fabricated
  // results and book fake spend — see stubExecutorRemoteRefusal.
  const refusal = stubExecutorRemoteRefusal(base);
  if (refusal) {
    console.error(refusal);
    process.exit(1);
  }
  await warnIfStale(args);
  const token = requireToken();

  // Where to point the donated credit. The default is deliberately the whole
  // pool — general chipping away, wherever work is needed — and both flags are
  // strictly opt-in narrowing. They only change which task gets *selected*;
  // checkout enforces the budget gate identically either way.
  const targetSlug = arg(args, '--target');
  const taskId = arg(args, '--task');
  if (targetSlug && taskId) {
    console.error('--task already names one task; it cannot be combined with --target');
    process.exit(1);
  }
  if (taskId && has(args, '--watch')) {
    console.error('--task claims one specific task and stops; it cannot be combined with --watch');
    process.exit(1);
  }
  if (targetSlug) {
    // Fail fast on a slug that doesn't exist (or isn't public): the open-task
    // listing treats an unknown slug as an empty pool by design, so without
    // this check a typo under --watch would just wait forever, silently.
    try {
      await apiRequest(base, { path: `/conjectures/${encodeURIComponent(targetSlug)}` });
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        console.error(
          `No conjecture called '${targetSlug}'. Browse the board at ${siteUrlFor(base)}/conjectures`,
        );
        process.exit(1);
      }
      throw err;
    }
  }

  const backend = new HttpBackend(base, token);
  console.log(`Givework runner → ${base}`);
  if (targetSlug) console.log(`Working on ${targetSlug} only (drop --target for the whole pool)`);
  try {
    const v = await backend.version().catch(() => null);
    if (v) console.log(`Control plane: ${v.commit.slice(0, 8)} (${v.ref})`);
  } catch {
    /* ignore */
  }
  // Validate numeric flags: an unparsed value (e.g. `--interval 5s` → NaN) would
  // make setTimeout default to ~1ms and, with --watch, hammer the API. Fail fast.
  const maxArg = arg(args, '--max');
  // --task is a single attempt by definition.
  const maxTasks = taskId ? 1 : maxArg ? Number(maxArg) : has(args, '--once') ? 1 : Infinity;
  if (maxArg && (!Number.isInteger(maxTasks) || maxTasks <= 0)) {
    console.error('--max must be a positive integer');
    process.exit(1);
  }
  const intervalArg = arg(args, '--interval');
  const intervalSec = intervalArg ? Number(intervalArg) : 15;
  if (!Number.isFinite(intervalSec) || intervalSec <= 0) {
    console.error('--interval must be a positive number of seconds');
    process.exit(1);
  }
  const intervalMs = intervalSec * 1000;
  try {
    await runLoop(backend, cliExecutor(), {
      maxTasks,
      watch: has(args, '--watch'),
      intervalMs,
      stopOnError: has(args, '--stop-on-error'),
      targetSlug,
      taskId,
      // A local execution failure never reaches the control plane as anything
      // more informative than a release. The code is one of our own ToolError
      // codes or the generic 'execution_error' — never the message.
      onExecutionFailure: ({ code, consecutiveFailures }) =>
        captureCliEvent('cli_execution_failed', {
          code,
          consecutive_failures: consecutiveFailures,
        }),
    });
  } finally {
    await backend.close();
  }
}

// --- onboarding ---

/**
 * The site origin that goes with an API origin, for the links we print. The
 * control plane lives on api.givework.dev and the pages on givework.dev; for a
 * local/dev API (no `api.` prefix) the two are the same host.
 */
export function siteUrlFor(api: string): string {
  try {
    const u = new URL(api);
    if (u.hostname.startsWith('api.')) u.hostname = u.hostname.slice(4);
    return u.origin;
  } catch {
    return api.replace(/\/$/, '');
  }
}

/** Default monthly cap offered to a newcomer, in cents. A cap, not a spend. */
const DEFAULT_ONBOARD_BUDGET_CENTS = 500;

/** The budget shape `/devs/me` returns, or nothing when no cap is set this period. */
interface DevBudget {
  budget_cents?: number;
  available_cents?: number;
}

/**
 * Whether the guided flow has to set a cap before it can mint the first task.
 *
 * The threshold is ONBOARDING_MAX_CENTS, not 0. `mintOnboardingTask` refuses
 * anything below its own reservation, so a dev sitting on 1–4¢ available sails
 * past an `available > 0` check and then dead-ends on a raw `insufficient_budget`
 * from the API — and re-running reproduces it exactly, which breaks the one
 * promise this command makes: that it is always safe to run again.
 */
export function needsCapBeforeOnboarding(budget: DevBudget | null | undefined): boolean {
  return !budget || (budget.available_cents ?? 0) < ONBOARDING_MAX_CENTS;
}

/**
 * The cap to offer when we have to ask. Accepting the offer must actually leave
 * room for the task, so a dev who has already spent most of an existing cap is
 * offered enough to cover the shortfall rather than the flat default they
 * already have.
 */
export function suggestedCap(budget: DevBudget | null | undefined): number {
  const cap = budget?.budget_cents ?? 0;
  const shortfall = ONBOARDING_MAX_CENTS - (budget?.available_cents ?? 0);
  return Math.max(DEFAULT_ONBOARD_BUDGET_CENTS, shortfall > 0 ? cap + shortfall : cap);
}

/** What `ensureCap` settled on, plus whether it had to write anything. */
export interface CapResult {
  budget_cents: number;
  available_cents: number;
  /** False when the existing cap was already good enough and we left it alone. */
  changed: boolean;
}

/**
 * Make sure this period's cap leaves room to claim work, and report what is
 * available afterwards.
 *
 * `--budget <cents>` is always honoured. Otherwise the cap is only touched when
 * there isn't enough headroom to check anything out — and then we ask, unless
 * there is no human at the keyboard (no TTY: CI, a pipe), where we take the
 * suggestion so a scripted `givework start` still works.
 *
 * Shared by `onboard` and `start` so exactly one place decides what to offer and
 * exactly one place writes the cap. Budgets are per period, so a returning
 * contributor hits this again in a new month even though everything else about
 * their setup is done.
 */
export async function ensureCap(
  base: string,
  token: string,
  budget: DevBudget | null | undefined,
  args: string[],
): Promise<CapResult> {
  const budgetArg = arg(args, '--budget');
  let wanted = budgetArg !== undefined ? Number(budgetArg) : null;
  if (wanted !== null && (!Number.isInteger(wanted) || wanted < 0)) {
    console.error('--budget must be a non-negative integer (cents)');
    process.exit(1);
  }
  if (wanted === null && needsCapBeforeOnboarding(budget)) {
    const suggested = suggestedCap(budget);
    if (process.stdin.isTTY) {
      const answer = await prompt(
        `          How many cents of your own Claude credit will you donate this month? [${suggested}] `,
      );
      wanted = answer ? Number(answer) : suggested;
      if (!Number.isInteger(wanted) || wanted < 0) {
        console.error('          Budget must be a non-negative whole number of cents.');
        process.exit(1);
      }
    } else {
      wanted = suggested;
    }
  }
  if (wanted === null) {
    return {
      budget_cents: budget?.budget_cents ?? 0,
      available_cents: budget?.available_cents ?? 0,
      changed: false,
    };
  }
  const b = await apiRequest<any>(base, {
    method: 'POST',
    path: '/devs/budget',
    token,
    body: { budget_cents: wanted },
  });
  return { budget_cents: b.budget_cents, available_cents: b.available_cents, changed: true };
}

export interface OnboardingSummary {
  range_start: number;
  range_end: number;
  candidates: number;
  target_name: string;
  target_slug: string;
}

/**
 * What the contributor is told they did. Framed around the real outcome of a
 * sweep — territory ruled out — because "no counterexample found" is the
 * expected, correct result, not a null result and not a failure. Pure, so the
 * wording is testable.
 *
 * The verdict changes only ONE thing: whether the claim was accepted. It never
 * changes whether the run happened. `submitResult` books the spend, writes the
 * ledger row and inserts the contribution BEFORE verification runs, so "this run
 * was not recorded" is false for every verdict — and it is a costly kind of false,
 * because it sends someone back to `givework onboard` to spend their own credit a
 * second time on a range that is already booked.
 */
export function contributionLines(
  s: OnboardingSummary,
  outcome: { counterexamples: number[]; spentCents?: number; verdict?: string },
): string[] {
  const n = s.candidates.toLocaleString('en-US');
  const range = `[${s.range_start.toLocaleString('en-US')}, ${s.range_end.toLocaleString('en-US')})`;
  const lines: string[] = [];

  if (outcome.verdict === 'failed') {
    lines.push(`  The control plane re-swept ${range} itself and did not get`);
    lines.push('  what your agent reported, so the claim was not accepted.');
    lines.push('');
    lines.push('  Your run is still on the record: the compute you donated is booked to');
    lines.push('  your name, the ledger entry is written, and the contribution is stored.');
    lines.push('  The range goes back on the board for someone else.');
    lines.push('');
    lines.push('  There is nothing to redo here — running onboard again would spend your');
    lines.push('  credit on the same range a second time.');
  } else if (outcome.counterexamples.length > 0) {
    lines.push(`  !! Your run reports a counterexample: ${outcome.counterexamples.join(', ')}`);
    lines.push(`     If it survives verification, that disproves ${s.target_name}.`);
  } else if (outcome.verdict === 'inconclusive' || outcome.verdict === 'pending') {
    lines.push(`  You swept ${n} candidates for ${s.target_name} — the range ${range}.`);
    lines.push('  The compute you donated is booked and the contribution is stored.');
    lines.push('');
    lines.push('  The automatic checker could not settle this one either way, so it is');
    lines.push('  queued for a person to look at rather than accepted on the spot.');
    lines.push('  Nothing for you to do; nothing to re-run.');
  } else {
    lines.push(`  You ruled out ${n} candidates for ${s.target_name}.`);
    lines.push(`  Every even number in ${range} is a sum of two primes.`);
    lines.push('  No counterexample — which is the expected result, and the whole point:');
    lines.push('  that range is now checked, and the check is recorded under your name.');
  }

  lines.push('');
  // Omitted rather than reported as 0 when we're re-printing an earlier run: the
  // compute was donated, we just aren't the ones who measured it this time.
  if (outcome.spentCents !== undefined) {
    lines.push(`  Donated compute: ${outcome.spentCents}¢ (booked)`);
  }
  if (outcome.verdict) lines.push(`  Verification:    ${outcome.verdict} (machine-checked)`);
  return lines;
}

/** Read the counterexample list out of whatever shape the agent returned. */
function counterexamplesOf(result: unknown): number[] {
  const raw = (result as { counterexamples?: unknown } | null)?.counterexamples;
  return Array.isArray(raw) ? raw.filter((v) => Number.isInteger(v)) : [];
}

/**
 * `givework onboard` — the whole first run in one command: sign in, set a cap,
 * get a real task on a live open problem, run it on your own `claude -p`, submit
 * it, and see what you contributed.
 *
 * Every step checks the current state before acting, so re-running after a crash
 * (or a Ctrl-C, or a dead network) resumes instead of starting over: login is
 * skipped if a token exists, the budget is skipped if it's already sufficient,
 * the mint is idempotent server-side, and a task left locked by a previous run is
 * released and re-checked-out rather than double-minted.
 *
 * `opts.footer` is off when `start` is driving: `start` owns the closing "here
 * is how to begin the work loop" advice, and printing it twice in one run reads
 * as two different instructions.
 */
export async function onboard(args: string[], opts: { footer?: boolean } = {}): Promise<void> {
  const footer = opts.footer ?? true;
  const base = apiUrl();

  // 1. Identity.
  if (!loadConfig().token) {
    console.log('Step 1/5  Sign in with GitHub\n');
    await login();
  } else {
    console.log('Step 1/5  Already signed in ✓');
  }
  const token = requireToken();
  const me = await apiRequest<any>(base, { path: '/devs/me', token });
  console.log(`          @${me.github_handle}\n`);

  // 2. Budget — a cap on your own donated Claude credit, not a charge.
  console.log('Step 2/5  Set your monthly cap');
  const cap = await ensureCap(base, token, me.budget, args);
  console.log(
    cap.changed
      ? `          cap ${cap.budget_cents}¢ this month · ${cap.available_cents}¢ available\n`
      : `          already set · ${cap.available_cents}¢ available\n`,
  );

  // 3. A real task on a live open problem, on a range nobody else has.
  console.log('Step 3/5  Claim your first task');
  const task = await apiRequest<any>(base, { method: 'POST', path: '/devs/onboarding', token });
  const summary: OnboardingSummary = {
    range_start: task.range_start,
    range_end: task.range_end,
    candidates: task.candidates,
    target_name: task.target_name,
    target_slug: task.target_slug,
  };
  console.log(`          ${task.title}  (cap ${task.max_cost_cents}¢)`);
  console.log(
    `          ${task.candidates.toLocaleString('en-US')} even numbers, allocated to you alone\n`,
  );

  const backend = new HttpBackend(base, token);
  try {
    if (task.status === 'submitted' || task.status === 'accepted') {
      console.log('Step 4/5  Already run — nothing left to do ✓\n');
      console.log('Step 5/5  Your contribution\n');
      for (const line of contributionLines(summary, { counterexamples: [] })) {
        console.log(line);
      }
      console.log('  Already recorded — the totals are on your contributor page.');
      printLinks(base, me.github_handle, summary.target_slug);
      if (footer) printKeepGoing();
      return;
    }
    if (task.status === 'locked') {
      // A previous run died holding the lease. Hand it back so we can re-claim it
      // (and get the spec) rather than minting anything new.
      console.log('          (resuming a previous run — releasing the stale lock)');
      await backend.release(task.task_id).catch(() => {});
    }

    // 4. Run it on the volunteer's own credit. This step is why onboarding costs
    //    a few cents rather than nothing: it proves their `claude` CLI works.
    if (!process.env.EXECUTOR) process.env.EXECUTOR = 'claude';
    const usingClaude = process.env.EXECUTOR === 'claude';
    console.log(
      `Step 4/5  Run it on your own capacity${usingClaude ? ' (claude -p)' : ` (EXECUTOR=${process.env.EXECUTOR})`}`,
    );
    const checkout = await backend.checkout(task.task_id);
    let exec: Awaited<ReturnType<Executor['execute']>>;
    try {
      // Same lease renewal the run loop uses. Checkout leases expire after ten
      // minutes; a slow machine, a long CLI startup or one retried call can
      // exceed that, and then the submit below throws `not_locked` — the
      // volunteer's real Claude credit spent and nothing booked. That is exactly
      // the failure onboarding exists to rule out, so it heartbeats too.
      exec = await withLease(backend, task.task_id, () =>
        cliExecutor().execute(checkout as ExecTask),
      );
    } catch (err) {
      await backend.release(task.task_id).catch(() => {});
      console.error(`\n  ✗ Could not run the task: ${(err as Error).message}`);
      console.error('\n  The task is still yours — nothing was spent, nothing was lost.');
      console.error('  Most often this means the Claude CLI is not installed or not logged in:');
      console.error('    npm install -g @anthropic-ai/claude-code   then   claude   (sign in)');
      console.error('  Then re-run:  givework start');
      process.exit(1);
    }
    console.log(`          ran in ${exec.actual_cost_cents}¢ of your credit\n`);

    // 5. Submit. The control plane re-runs the whole range itself and verifies.
    const submit = await backend.submit({
      task_id: task.task_id,
      result: exec.result,
      actual_cost_cents: exec.actual_cost_cents,
      raw_usage: exec.raw_usage,
      summary: exec.summary,
    });
    console.log('Step 5/5  Your contribution\n');
    // One renderer for every verdict. The accounting is identical in all of them
    // — booked before verification ran — so the only thing that varies is what we
    // say about the claim.
    for (const line of contributionLines(summary, {
      counterexamples: counterexamplesOf(exec.result),
      spentCents: submit.spent_applied,
      verdict: submit.verification?.verdict,
    })) {
      console.log(line);
    }
    printLinks(base, me.github_handle, summary.target_slug);
    if (footer) printKeepGoing();
  } finally {
    await backend.close();
  }
}

function printLinks(base: string, handle: string, slug: string): void {
  const site = siteUrlFor(base);
  console.log('');
  console.log(`  Your contributor page:  ${site}/contributors/${handle}`);
  console.log(`  The conjecture:         ${site}/conjectures/${slug}`);
}

function printKeepGoing(): void {
  console.log('');
  console.log('  Next: keep going. This picks up open tasks as they appear —');
  console.log('');
  console.log('      givework start --watch');
  console.log('');
}

// --- the front door ---

/** The slice of GET /devs/me/stats that answers "have they ever finished a task?". */
export interface ContributionTally {
  tasks_completed?: number;
}

/**
 * Has this contributor ever completed a task?
 *
 * The signal is `tasks_completed` from GET /devs/me/stats — COUNT(DISTINCT
 * task_id) over the caller's own `submit` rows in `ledger`, scoped to the JWT.
 *
 * Chosen over the funnel's `submit` event deliberately. Funnel writes are
 * swallowed on failure by design (analytics must never be able to fail a
 * donation — see src/funnel.ts), so a dropped analytics insert would make a real
 * contributor look like a newcomer and march them back through onboarding. The
 * ledger row is written inside submitResult's transaction and is the durable
 * record of the same moment. It is also a read that already exists and is
 * already rendered by `givework stats`, so `start` invents no new state.
 */
export function hasContributed(stats: ContributionTally | null | undefined): boolean {
  return (stats?.tasks_completed ?? 0) > 0;
}

/** How many tasks the pool is showing, and whether we hit the page cap. */
export interface OpenPool {
  count: number;
  capped: boolean;
}

/**
 * The closing report: what is true now, and the exact command that begins the
 * work loop. Pure, so the wording is testable — in particular that it *tells*
 * the user how to start rather than claiming to have started.
 */
export function readyLines(
  handle: string,
  budget: DevBudget | null | undefined,
  pool: OpenPool | null,
): string[] {
  const lines = [`You're set up, @${handle}.`];
  if (budget) {
    lines.push(
      `  cap ${budget.budget_cents ?? 0}¢ this month · ${budget.available_cents ?? 0}¢ available`,
    );
  }
  if (pool) {
    const n = `${pool.count}${pool.capped ? '+' : ''}`;
    lines.push(
      pool.count === 0
        ? '  No tasks open right now — the loop below waits and picks them up as they appear'
        : `  ${n} task${pool.count === 1 && !pool.capped ? '' : 's'} available to you right now`,
    );
  }
  lines.push('');
  lines.push('  To start working, run this. It claims tasks as they appear and runs');
  lines.push('  them on your own Claude credit until you stop it (Ctrl-C):');
  lines.push('');
  lines.push('      givework start --watch');
  lines.push('');
  lines.push('  Or one at a time:  EXECUTOR=claude givework run --once');
  return lines;
}

/**
 * `givework start` — the single front door. It reads the contributor's current
 * state and does only what is missing:
 *
 *   not signed in                  -> browser sign-in
 *   signed in, no cap this month   -> ask for a monthly cap (cents)
 *   cap set, never finished a task -> the guided first task (what `onboard` does)
 *   all of the above already done  -> nothing
 *
 * Every step is skipped silently when it is already satisfied, so re-running is
 * cheap and idempotent: sign-in is skipped when a token exists, the cap is
 * skipped when it already has headroom, and the onboarding mint is idempotent
 * server-side (one task per dev, enforced by a UNIQUE index on
 * `tasks.onboarding_dev_id`), so a second `start` resumes the same task rather
 * than minting — or paying for — a second one. Once a task has been completed,
 * `start` does not go near onboarding at all.
 *
 * WHY `start` DOES NOT ENTER THE WORK LOOP ON ITS OWN
 * ---------------------------------------------------
 * `run --watch` spends the volunteer's own Claude credit continuously and
 * unattended. A command called `start` that silently drops someone into that the
 * first time they type it is a genuinely unpleasant surprise: the budget cap
 * bounds how much it can cost, but it does not bound the surprise, and "I typed
 * one word and my agent has been burning my credit ever since" is the story that
 * gets somebody to uninstall — and to warn their friends off. Consent to donate
 * a capped amount is not consent to start donating it right now, unattended.
 *
 * So the default finishes by reporting the state and naming the command that
 * begins the loop, and `--watch` is the explicit opt-in that goes straight into
 * it. The verb someone types is the whole of their consent, so `start --watch`
 * has to be the only spelling that leaves a process running.
 */
export async function start(args: string[]): Promise<void> {
  const base = apiUrl();

  // 1. Identity. Silently skipped when a token is already on disk (or in env).
  if (!loadConfig().token) {
    console.log('Signing you in with GitHub — a browser window will open.\n');
    await login();
    console.log('');
  }
  const token = requireToken();

  const [me, stats] = await Promise.all([
    apiRequest<any>(base, { path: '/devs/me', token }),
    apiRequest<ContributionTally>(base, { path: '/devs/me/stats', token }),
  ]);

  let changed = false;
  if (!hasContributed(stats)) {
    // 2 + 3. The cap and the guided first task. `onboard` already does both,
    // checks each before acting, and is safe to re-run — so `start` delegates
    // instead of growing a second copy of that flow.
    await onboard(args, { footer: false });
    changed = true;
  } else if (needsCapBeforeOnboarding(me.budget)) {
    // 2 alone. A returning contributor in a new month: caps are per period, so
    // theirs is gone even though everything else about their setup is done.
    console.log(`Welcome back, @${me.github_handle}. Set this month's cap:\n`);
    const cap = await ensureCap(base, token, me.budget, args);
    if (cap.changed) {
      console.log(
        `          cap ${cap.budget_cents}¢ this month · ${cap.available_cents}¢ available`,
      );
    }
    changed = true;
  }

  // 4. Report where they stand and hand over. Both reads are best-effort: every
  //    state change above already succeeded, so a hiccup here must not turn a
  //    finished setup into a non-zero exit.
  const current = changed
    ? await apiRequest<any>(base, { path: '/devs/me', token }).catch(() => me)
    : me;
  const open = await apiRequest<any[]>(base, { path: '/tasks/open?limit=100', token }).catch(
    () => null,
  );
  console.log('');
  for (const line of readyLines(
    current.github_handle,
    current.budget,
    open ? { count: open.length, capped: open.length >= 100 } : null,
  )) {
    console.log(line);
  }

  if (!has(args, '--watch')) return;

  // The explicit opt-in. Default to the volunteer's own `claude -p` — the whole
  // point is donated capacity, and silently looping on the stub executor would
  // donate nothing while looking like it worked.
  if (!process.env.EXECUTOR) process.env.EXECUTOR = 'claude';
  console.log('\n--watch: starting the work loop. Ctrl-C to stop.\n');
  await run(args);
}

// --- admin commands ---

/**
 * Render one funnel conversion rate. `null` means the ratio is undefined — the
 * stage it is measured against has nobody in it — and must show as an em-dash,
 * never as 0.0%. Devs normally predate the funnel log, so `signed_up` is 0 while
 * later stages are not; printing "0.0% of signups" there tells the reader that
 * onboarding converts nobody when in fact it converted everybody it was given.
 */
export function pct(rate: number | null | undefined): string {
  return rate == null ? '—' : `${(rate * 100).toFixed(1)}%`;
}

export async function admin(args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case 'login': {
      const token = await prompt('Paste admin token: ');
      if (!token) {
        console.error('No token entered.');
        process.exit(1);
      }
      saveConfig({ apiUrl: apiUrl(), adminToken: token });
      console.log('✓ Admin token saved to ~/.givework/config.json');
      return;
    }
    case 'funnel': {
      const adminToken = requireAdminToken();
      const f = await apiRequest<any>(apiUrl(), { path: '/admin/funnel', token: adminToken });
      console.log(`devs in the database: ${f.devs_total}`);
      if (f.first_event_at) console.log(`tracked since:        ${f.first_event_at.slice(0, 10)}`);
      if (f.untracked_devs > 0) {
        console.log(
          `untracked:            ${f.untracked_devs} dev(s) predate this log — ` +
            'they emit no signup, so "of signups" is measured against the tracked ones only',
        );
      }
      console.log('');
      for (const s of f.stages) {
        console.log(
          `  ${s.stage.padEnd(18)} ${String(s.devs).padStart(6)}   ` +
            `${pct(s.conversion_from_previous).padStart(6)} of previous   ` +
            `${pct(s.conversion_from_signup).padStart(6)} of signups`,
        );
      }
      console.log(
        `\n  ${f.counts.submits_total} submit(s) total · ${f.counts.one_and_done} one-and-done · ${f.counts.submitted_again} came back`,
      );
      return;
    }
    case 'verify': {
      if (!rest[0]) {
        console.error('Usage: givework admin verify <devId>');
        process.exit(1);
      }
      const adminToken = requireAdminToken();
      const r = await apiRequest<any>(apiUrl(), {
        method: 'POST',
        path: `/admin/devs/${encodeURIComponent(rest[0])}/verify`,
        token: adminToken,
      });
      console.log(`✓ verified @${r.github_handle} (${r.id})`);
      return;
    }
    case 'review': {
      // The residual manual queue: submitted work awaiting accept (verified devs
      // auto-accept, so this is mostly unverified-dev public tasks).
      const adminToken = requireAdminToken();
      const rows = await apiRequest<any[]>(apiUrl(), {
        path: '/admin/tasks?status=submitted',
        token: adminToken,
      });
      if (!rows.length) {
        console.log('Nothing awaiting review.');
        return;
      }
      console.log(`${rows.length} task${rows.length === 1 ? '' : 's'} awaiting accept:`);
      for (const t of rows) {
        const preview = typeof t.result === 'string' ? t.result : JSON.stringify(t.result);
        console.log(`  ${t.id}  @${t.dev ?? '?'}  ${t.actual_cost_cents ?? '?'}¢`);
        console.log(`    ${t.title}`);
        console.log(`    → ${String(preview ?? '').slice(0, 160)}`);
      }
      console.log('\nAccept with:  givework admin accept <taskId>');
      return;
    }
    case 'accept': {
      if (!rest[0]) {
        console.error('Usage: givework admin accept <taskId>');
        process.exit(1);
      }
      const adminToken = requireAdminToken();
      const r = await apiRequest<any>(apiUrl(), {
        method: 'POST',
        path: `/admin/tasks/${encodeURIComponent(rest[0])}/accept`,
        token: adminToken,
      });
      console.log(`✓ accepted ${rest[0]} (${r.status})`);
      return;
    }
    case 'budget': {
      if (!rest[0] || !rest[1]) {
        console.error('Usage: givework admin budget <devId> <cents>');
        process.exit(1);
      }
      const adminToken = requireAdminToken();
      const r = await apiRequest<any>(apiUrl(), {
        method: 'POST',
        path: '/admin/budgets',
        token: adminToken,
        body: { dev_id: rest[0], budget_cents: Number(rest[1]) },
      });
      console.log(`✓ budget for ${r.dev_id}: ${r.budget_cents}¢`);
      return;
    }
    case 'task': {
      if (rest[0] !== 'create') {
        console.error("Usage: givework admin task create --json '{…}'");
        process.exit(1);
      }
      const json = arg(rest, '--json');
      if (!json) {
        console.error(
          'Provide the task as --json \'{"target_id":…,"title":…,"spec":…,"est_cost_cents":…,"max_cost_cents":…,"model":…}\'',
        );
        process.exit(1);
      }
      let body: unknown;
      try {
        body = JSON.parse(json);
      } catch {
        console.error('--json is not valid JSON');
        process.exit(1);
      }
      const adminToken = requireAdminToken();
      const r = await apiRequest<any>(apiUrl(), {
        method: 'POST',
        path: '/admin/tasks',
        token: adminToken,
        body,
      });
      console.log(`✓ created task ${r.id} — "${r.title}" (${r.status})`);
      return;
    }
    case 'target':
      return adminTarget(rest);
    case 'decompose':
      return adminDecompose(rest);
    default:
      console.error(
        "Admin commands: login | funnel | verify <devId> | review | accept <taskId> | decompose [--watch] | budget <devId> <cents> | task create --json '{…}' | nonprofit …",
      );
      process.exit(1);
  }
}

/**
 * Run the decomposer locally (a real model via DECOMPOSER=cli|local) against the
 * platform's stub-drafted intake, posting the better drafts back. This is how the
 * "admin reviewer runs on Ollama locally" — the Worker drafts with the stub on
 * receipt; this upgrades those drafts off-Worker. --watch polls on an interval.
 */
async function adminDecompose(args: string[]): Promise<void> {
  const engine = process.env.DECOMPOSER;
  if (engine !== 'cli' && engine !== 'local') {
    console.error(
      'Set DECOMPOSER=cli (or local) to run a real model, e.g.:\n  DECOMPOSER=cli DECOMPOSER_CMD=ollama givework admin decompose --watch',
    );
    process.exit(1);
  }
  const token = requireAdminToken();
  const base = apiUrl();
  const decomposer = getDecomposer();
  const intervalArg = arg(args, '--interval');
  const intervalSec = intervalArg ? Number(intervalArg) : 30;
  if (!Number.isFinite(intervalSec) || intervalSec <= 0) {
    console.error('--interval must be a positive number of seconds');
    process.exit(1);
  }
  console.log(`admin decompose → ${base}  (engine: ${engine})`);

  // IDs the model couldn't upgrade this run. Re-running them every tick would
  // re-invoke a minute-long model on intake it will keep failing, so we skip
  // them for the life of the process (a restart re-attempts — the failure may
  // be transient, e.g. the model was briefly down).
  const skip = new Set<string>();

  async function pass(): Promise<number> {
    const list = await apiRequest<any[]>(base, { path: '/admin/intake?status=decomposed', token });
    const pending = list.filter((r) => r.triaged_by === 'stub' && !skip.has(r.id)); // not yet upgraded off-Worker
    let done = 0;
    for (const r of pending) {
      const full = await apiRequest<any>(base, {
        path: `/admin/intake/${encodeURIComponent(r.id)}`,
        token,
      });
      const { triagedBy, tasks } = await decomposer.decompose({
        from_email: full.from_email,
        subject: full.subject ?? undefined,
        body: full.raw_body,
        attachment_count: Array.isArray(full.attachments) ? full.attachments.length : 0,
      });
      if (triagedBy !== 'local') {
        skip.add(r.id);
        console.log(`  · ${r.id}  model unavailable (fell back to stub) — skipping this run`);
        continue;
      }
      await apiRequest(base, {
        method: 'POST',
        path: `/admin/intake/${encodeURIComponent(r.id)}/draft`,
        token,
        body: { proposed: tasks, triaged_by: triagedBy },
      });
      console.log(
        `  ✓ ${r.id}  ${tasks.length} task${tasks.length === 1 ? '' : 's'}  (${full.subject ?? full.from_email})`,
      );
      done++;
    }
    return done;
  }

  if (!has(args, '--watch')) {
    const n = await pass();
    console.log(n ? `decomposed ${n} request(s)` : 'nothing to decompose');
    return;
  }
  console.log(`watching every ${intervalSec}s (Ctrl-C to stop)…`);
  for (;;) {
    try {
      await pass();
    } catch (err: any) {
      console.error('pass failed:', err?.message ?? err);
    }
    await new Promise((res) => setTimeout(res, intervalSec * 1000));
  }
}

/** Parse `--flag true|false`; undefined if the flag is absent. Errors on a bad value. */
export function boolArg(args: string[], name: string): boolean | undefined {
  const v = arg(args, name);
  if (v === undefined) return undefined;
  if (v === 'true') return true;
  if (v === 'false') return false;
  console.error(`${name} must be true or false`);
  process.exit(1);
}

// Manage nonprofits and their allowlist: list/show, create, override fields, and
// add/remove authorized senders (emails & domains, allow or deny). The kind of an
// identifier is inferred from the value — an '@' means an email, otherwise a
// domain. All routes are admin-gated.
async function adminTarget(args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);
  const usage =
    'givework admin target list\n' +
    '                        show <id>\n' +
    '                        create --name <name> --email <contact> [--ein <ein>] [--verified] [--listed]\n' +
    '                        set <id> [--name <>] [--email <>] [--ein <>] [--verified true|false] [--listed true|false]\n' +
    '                        allow <id> <email|domain>      (authorize a sender)\n' +
    '                        deny  <id> <email|domain>      (block a sender, overrides allow)\n' +
    '                        rm-id <id> <identifierId>      (remove an identifier; see `show`)';
  const token = requireAdminToken();
  const base = apiUrl();

  switch (sub) {
    case 'list': {
      const rows = await apiRequest<any[]>(base, { path: '/admin/targets', token });
      if (!rows.length) {
        console.log('No targets yet.');
        return;
      }
      for (const n of rows) {
        const flags = `${n.verified ? 'verified' : 'unverified'}, ${n.listed ? 'listed' : 'unlisted'}`;
        console.log(
          `${n.id}  ${n.name}  <${n.contact_email}>  [${flags}]  ${n.identifier_count} ids · ${n.tasks_accepted}/${n.tasks_total} tasks`,
        );
      }
      return;
    }
    case 'show': {
      if (!rest[0]) {
        console.error('Usage: givework admin nonprofit show <id>');
        process.exit(1);
      }
      const n = await apiRequest<any>(base, {
        path: `/admin/targets/${encodeURIComponent(rest[0])}`,
        token,
      });
      console.log(`${n.name}  <${n.contact_email}>${n.ein ? `  EIN ${n.ein}` : ''}`);
      console.log(
        `  ${n.verified ? 'verified' : 'unverified'} · ${n.listed ? 'listed (public)' : 'unlisted'}`,
      );
      if (n.identifiers?.length) {
        console.log('  identifiers:');
        for (const i of n.identifiers)
          console.log(`    ${i.id}  ${String(i.kind).padEnd(11)} ${i.value}`);
      } else {
        console.log('  identifiers: none (contact_email + its domain only)');
      }
      return;
    }
    case 'create': {
      const name = arg(rest, '--name');
      const email = arg(rest, '--email');
      if (!name || !email) {
        console.error(
          'Usage: givework admin nonprofit create --name <name> --email <contact> [--ein <ein>] [--verified] [--listed]',
        );
        process.exit(1);
      }
      const body: any = { name, contact_email: email };
      const ein = arg(rest, '--ein');
      if (ein) body.ein = ein;
      if (has(rest, '--verified')) body.verified = true;
      const n = await apiRequest<any>(base, {
        method: 'POST',
        path: '/admin/targets',
        token,
        body,
      });
      console.log(`✓ created ${n.id} — ${n.name}`);
      // `listed` isn't on the create route; opt in with a follow-up update.
      if (has(rest, '--listed')) {
        await apiRequest<any>(base, {
          method: 'POST',
          path: `/admin/targets/${n.id}`,
          token,
          body: { listed: true },
        });
        console.log('  listed = true');
      }
      return;
    }
    case 'set': {
      if (!rest[0]) {
        console.error(
          'Usage: givework admin nonprofit set <id> [--name <>] [--email <>] [--ein <>] [--verified true|false] [--listed true|false]',
        );
        process.exit(1);
      }
      const body: any = {};
      const name = arg(rest, '--name');
      if (name) body.name = name;
      const email = arg(rest, '--email');
      if (email) body.contact_email = email;
      const ein = arg(rest, '--ein');
      if (ein) body.ein = ein;
      const v = boolArg(rest, '--verified');
      if (v !== undefined) body.verified = v;
      const l = boolArg(rest, '--listed');
      if (l !== undefined) body.listed = l;
      if (Object.keys(body).length === 0) {
        console.error(
          'Nothing to set — provide at least one of --name/--email/--ein/--verified/--listed.',
        );
        process.exit(1);
      }
      const n = await apiRequest<any>(base, {
        method: 'POST',
        path: `/admin/targets/${encodeURIComponent(rest[0])}`,
        token,
        body,
      });
      console.log(
        `✓ ${n.name}: ${n.verified ? 'verified' : 'unverified'}, ${n.listed ? 'listed' : 'unlisted'}`,
      );
      return;
    }
    case 'allow':
    case 'deny': {
      if (!rest[0] || !rest[1]) {
        console.error(`Usage: givework admin nonprofit ${sub} <id> <email-or-domain>`);
        process.exit(1);
      }
      const isEmail = rest[1].includes('@');
      const kind =
        sub === 'allow' ? (isEmail ? 'email' : 'domain') : isEmail ? 'email_deny' : 'domain_deny';
      const r = await apiRequest<any>(base, {
        method: 'POST',
        path: `/admin/targets/${encodeURIComponent(rest[0])}/identifiers`,
        token,
        body: { kind, value: rest[1] },
      });
      console.log(`✓ ${r.kind}: ${r.value}  (id ${r.id})`);
      return;
    }
    case 'rm-id': {
      if (!rest[0] || !rest[1]) {
        console.error('Usage: givework admin nonprofit rm-id <targetId> <identifierId>');
        process.exit(1);
      }
      await apiRequest<any>(base, {
        method: 'DELETE',
        path: `/admin/targets/${encodeURIComponent(rest[0])}/identifiers/${encodeURIComponent(rest[1])}`,
        token,
      });
      console.log('✓ removed identifier');
      return;
    }
    default:
      console.error(usage);
      process.exit(1);
  }
}

export function status(): void {
  const c = loadConfig();
  console.log(`api:   ${c.apiUrl}`);
  console.log(`dev:   ${c.token ? 'logged in' : 'not logged in'}`);
  console.log(`admin: ${c.adminToken ? 'token set' : 'none'}`);
  console.log(`usage stats: ${telemetryEnabled() ? 'on  (opt out: GIVEWORK_TELEMETRY=0)' : 'off'}`);
}
