import { createInterface } from 'node:readline';
import type { ExecTask, Executor } from '../executor.js';
import { getExecutor } from '../executor.js';
import { getDecomposer } from '../intake/decompose.js';
import { HttpBackend, runLoop } from '../run-loop.js';
import { apiRequest } from './api.js';
import { apiUrl, loadConfig, requireAdminToken, requireToken, saveConfig } from './config.js';
import { login } from './login.js';

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
export async function tasks(args: string[]): Promise<void> {
  const token = requireToken();
  const qs = new URLSearchParams();
  const max = arg(args, '--max');
  const sensitivity = arg(args, '--sensitivity');
  const limit = arg(args, '--limit');
  if (max) qs.set('max_cost_cents', max);
  if (sensitivity) qs.set('sensitivity', sensitivity);
  if (limit) qs.set('limit', limit);
  const q = qs.toString();
  const rows = await apiRequest<any[]>(apiUrl(), { path: `/tasks/open${q ? `?${q}` : ''}`, token });
  if (!rows.length) {
    console.log('No open tasks right now. Try again later, or run:  givework run --watch');
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
  await warnIfStale(args);
  const token = requireToken();
  const base = apiUrl();
  const backend = new HttpBackend(base, token);
  console.log(`Givework runner → ${base}`);
  try {
    const v = await backend.version().catch(() => null);
    if (v) console.log(`Control plane: ${v.commit.slice(0, 8)} (${v.ref})`);
  } catch {
    /* ignore */
  }
  // Validate numeric flags: an unparsed value (e.g. `--interval 5s` → NaN) would
  // make setTimeout default to ~1ms and, with --watch, hammer the API. Fail fast.
  const maxArg = arg(args, '--max');
  const maxTasks = maxArg ? Number(maxArg) : has(args, '--once') ? 1 : Infinity;
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
 */
export function contributionLines(
  s: OnboardingSummary,
  outcome: { counterexamples: number[]; spentCents?: number; verdict?: string },
): string[] {
  const n = s.candidates.toLocaleString('en-US');
  const lines: string[] = [];
  if (outcome.counterexamples.length > 0) {
    lines.push(`  !! Your run reports a counterexample: ${outcome.counterexamples.join(', ')}`);
    lines.push(`     If it survives verification, that disproves ${s.target_name}.`);
  } else {
    lines.push(`  You ruled out ${n} candidates for ${s.target_name}.`);
    lines.push(
      `  Every even number in [${s.range_start.toLocaleString('en-US')}, ${s.range_end.toLocaleString('en-US')}) is a sum of two primes.`,
    );
    lines.push('  No counterexample — which is the expected result, and the whole point:');
    lines.push('  that range is now checked, and the check is recorded under your name.');
  }
  lines.push('');
  // Omitted rather than reported as 0 when we're re-printing an earlier run: the
  // compute was donated, we just aren't the ones who measured it this time.
  if (outcome.spentCents !== undefined) {
    lines.push(`  Donated compute: ${outcome.spentCents}¢`);
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
 */
export async function onboard(args: string[]): Promise<void> {
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
  const budgetArg = arg(args, '--budget');
  let available = me.budget?.available_cents ?? 0;
  let wanted = budgetArg !== undefined ? Number(budgetArg) : null;
  if (wanted !== null && (!Number.isInteger(wanted) || wanted < 0)) {
    console.error('--budget must be a non-negative integer (cents)');
    process.exit(1);
  }
  if (wanted === null && (!me.budget || available <= 0)) {
    // No usable cap yet. Ask when there's a human at the keyboard; otherwise take
    // the default so `npx … onboard` in a script still works.
    if (process.stdin.isTTY) {
      const answer = await prompt(
        `          How many cents of your own Claude credit will you donate this month? [${DEFAULT_ONBOARD_BUDGET_CENTS}] `,
      );
      wanted = answer ? Number(answer) : DEFAULT_ONBOARD_BUDGET_CENTS;
      if (!Number.isInteger(wanted) || wanted < 0) {
        console.error('          Budget must be a non-negative whole number of cents.');
        process.exit(1);
      }
    } else {
      wanted = DEFAULT_ONBOARD_BUDGET_CENTS;
    }
  }
  if (wanted !== null) {
    const b = await apiRequest<any>(base, {
      method: 'POST',
      path: '/devs/budget',
      token,
      body: { budget_cents: wanted },
    });
    available = b.available_cents;
    console.log(`          cap ${b.budget_cents}¢ this month · ${available}¢ available\n`);
  } else {
    console.log(`          already set · ${available}¢ available\n`);
  }

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
      printNextSteps(base, me.github_handle, summary.target_slug);
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
      exec = await cliExecutor().execute(checkout as ExecTask);
    } catch (err) {
      await backend.release(task.task_id).catch(() => {});
      console.error(`\n  ✗ Could not run the task: ${(err as Error).message}`);
      console.error('\n  The task is still yours — nothing was spent, nothing was lost.');
      console.error('  Most often this means the Claude CLI is not installed or not logged in:');
      console.error('    npm install -g @anthropic-ai/claude-code   then   claude   (sign in)');
      console.error('  Then re-run:  givework onboard');
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
    if (submit.verification?.verdict === 'failed') {
      console.log('  Verification did not confirm what your agent reported, so this run was');
      console.log('  not recorded. The task is back and still yours — try:  givework onboard');
      console.log(`\n  Donated compute: ${submit.spent_applied}¢`);
      return;
    }
    for (const line of contributionLines(summary, {
      counterexamples: counterexamplesOf(exec.result),
      spentCents: submit.spent_applied,
      verdict: submit.verification?.verdict,
    })) {
      console.log(line);
    }
    printNextSteps(base, me.github_handle, summary.target_slug);
  } finally {
    await backend.close();
  }
}

function printNextSteps(base: string, handle: string, slug: string): void {
  const site = siteUrlFor(base);
  console.log('');
  console.log(`  Your contributor page:  ${site}/contributors/${handle}`);
  console.log(`  The conjecture:         ${site}/conjectures/${slug}`);
  console.log('');
  console.log('  Next: keep going. This picks up open tasks as they appear —');
  console.log('');
  console.log('      EXECUTOR=claude givework run --watch');
  console.log('');
}

// --- admin commands ---

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
      const pct = (r: number) => `${(r * 100).toFixed(1)}%`;
      console.log(`devs in the database: ${f.devs_total}`);
      if (f.first_event_at) console.log(`tracked since:        ${f.first_event_at.slice(0, 10)}`);
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
}
