import { createInterface } from 'node:readline';
import { apiRequest } from './api.js';
import { apiUrl, loadConfig, saveConfig, requireToken, requireAdminToken } from './config.js';
import { HttpBackend, runLoop } from '../run-loop.js';
import { StubExecutor, ClaudeCliExecutor, type Executor } from '../executor.js';

// The CLI supports the two executors a volunteer actually uses: the deterministic
// stub (default) and the production `claude -p` path (EXECUTOR=claude). It does
// NOT wire the reference Anthropic-SDK executor — importing getExecutor() would
// drag @anthropic-ai/sdk into the bundle via its lazy import.
function cliExecutor(): Executor {
  return process.env.EXECUTOR === 'claude' ? new ClaudeCliExecutor() : new StubExecutor();
}

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
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim()); }));
}

// --- dev commands ---

export async function whoami(): Promise<void> {
  const token = requireToken();
  const me = await apiRequest<any>(apiUrl(), { path: '/devs/me', token });
  const b = me.budget;
  console.log(`@${me.github_handle}  (${me.verified ? 'verified' : 'unverified — public tasks only'})`);
  if (b) {
    console.log(`budget: ${b.available_cents}¢ available of ${b.budget_cents}¢  (reserved ${b.reserved_cents}¢, spent ${b.spent_cents}¢)`);
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

export async function version(): Promise<void> {
  const v = await apiRequest<any>(apiUrl(), { path: '/version' });
  console.log(`${v.service}  ${v.commit?.slice(0, 8)} (${v.ref})${v.deployed_at ? `  deployed ${v.deployed_at}` : ''}`);
}

export async function run(args: string[]): Promise<void> {
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

// --- admin commands ---

export async function admin(args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case 'login': {
      const token = await prompt('Paste admin token: ');
      if (!token) { console.error('No token entered.'); process.exit(1); }
      saveConfig({ apiUrl: apiUrl(), adminToken: token });
      console.log('✓ Admin token saved to ~/.givework/config.json');
      return;
    }
    case 'verify': {
      if (!rest[0]) { console.error('Usage: givework admin verify <devId>'); process.exit(1); }
      const adminToken = requireAdminToken();
      const r = await apiRequest<any>(apiUrl(), {
        method: 'POST',
        path: `/admin/devs/${encodeURIComponent(rest[0])}/verify`,
        token: adminToken,
      });
      console.log(`✓ verified @${r.github_handle} (${r.id})`);
      return;
    }
    case 'budget': {
      if (!rest[0] || !rest[1]) { console.error('Usage: givework admin budget <devId> <cents>'); process.exit(1); }
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
      if (rest[0] !== 'create') { console.error('Usage: givework admin task create --json \'{…}\''); process.exit(1); }
      const json = arg(rest, '--json');
      if (!json) { console.error('Provide the task as --json \'{"nonprofit_id":…,"title":…,"spec":…,"est_cost_cents":…,"max_cost_cents":…,"model":…}\''); process.exit(1); }
      let body: unknown;
      try { body = JSON.parse(json); } catch { console.error('--json is not valid JSON'); process.exit(1); }
      const adminToken = requireAdminToken();
      const r = await apiRequest<any>(apiUrl(), { method: 'POST', path: '/admin/tasks', token: adminToken, body });
      console.log(`✓ created task ${r.id} — "${r.title}" (${r.status})`);
      return;
    }
    default:
      console.error('Admin commands: login | verify <devId> | budget <devId> <cents> | task create --json \'{…}\'');
      process.exit(1);
  }
}

export function status(): void {
  const c = loadConfig();
  console.log(`api:   ${c.apiUrl}`);
  console.log(`dev:   ${c.token ? 'logged in' : 'not logged in'}`);
  console.log(`admin: ${c.adminToken ? 'token set' : 'none'}`);
}
