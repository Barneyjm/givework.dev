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

export async function history(args: string[]): Promise<void> {
  const token = requireToken();
  const qs = new URLSearchParams();
  const limit = arg(args, '--limit');
  const before = arg(args, '--before');
  if (limit) qs.set('limit', limit);
  if (before) qs.set('before', before);
  const q = qs.toString();
  const page = await apiRequest<any>(apiUrl(), { path: `/devs/me/ledger${q ? `?${q}` : ''}`, token });
  if (!page.entries.length) {
    console.log('No contributions yet — run `givework run` to start.');
    return;
  }
  for (const e of page.entries) {
    const when = new Date(e.created_at).toISOString().slice(0, 16).replace('T', ' ');
    const amount = `${e.delta_cents > 0 ? '+' : ''}${e.delta_cents}¢`;
    const label = e.task_title ?? e.task_id;
    console.log(`${when}  ${e.event_type.padEnd(8)} ${amount.padStart(7)}  ${label}${e.nonprofit_name ? `  · ${e.nonprofit_name}` : ''}`);
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
  console.log(`nonprofits: ${s.nonprofits_helped} helped`);
  if (s.first_contribution_at) {
    console.log(`since:      ${new Date(s.first_contribution_at).toISOString().slice(0, 10)}`);
  }
  if (s.by_month?.length) {
    console.log('\nby month:');
    for (const m of s.by_month) {
      console.log(`  ${m.month}   ${String(m.donated_cents).padStart(7)}¢   ${m.tasks} task${m.tasks === 1 ? '' : 's'}`);
    }
  }
}

export async function version(): Promise<void> {
  const v = await apiRequest<any>(apiUrl(), { path: '/version' });
  console.log(`${v.service}  ${v.commit?.slice(0, 8)} (${v.ref})${v.deployed_at ? `  deployed ${v.deployed_at}` : ''}`);
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
    console.log(`    ${t.title}  ·  ${t.model}  ·  ~${t.est_cost_cents}¢ (cap ${t.max_cost_cents}¢)  ·  ${t.sensitivity}`);
  }
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
    case 'review': {
      // The residual manual queue: submitted work awaiting accept (verified devs
      // auto-accept, so this is mostly unverified-dev public tasks).
      const adminToken = requireAdminToken();
      const rows = await apiRequest<any[]>(apiUrl(), { path: '/admin/tasks?status=submitted', token: adminToken });
      if (!rows.length) { console.log('Nothing awaiting review.'); return; }
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
      if (!rest[0]) { console.error('Usage: givework admin accept <taskId>'); process.exit(1); }
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
    case 'nonprofit': return adminNonprofit(rest);
    default:
      console.error('Admin commands: login | verify <devId> | review | accept <taskId> | budget <devId> <cents> | task create --json \'{…}\' | nonprofit …');
      process.exit(1);
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
async function adminNonprofit(args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);
  const usage =
    'givework admin nonprofit list\n' +
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
      const rows = await apiRequest<any[]>(base, { path: '/admin/nonprofits', token });
      if (!rows.length) { console.log('No nonprofits yet.'); return; }
      for (const n of rows) {
        const flags = `${n.verified ? 'verified' : 'unverified'}, ${n.listed ? 'listed' : 'unlisted'}`;
        console.log(`${n.id}  ${n.name}  <${n.contact_email}>  [${flags}]  ${n.identifier_count} ids · ${n.tasks_accepted}/${n.tasks_total} tasks`);
      }
      return;
    }
    case 'show': {
      if (!rest[0]) { console.error('Usage: givework admin nonprofit show <id>'); process.exit(1); }
      const n = await apiRequest<any>(base, { path: `/admin/nonprofits/${encodeURIComponent(rest[0])}`, token });
      console.log(`${n.name}  <${n.contact_email}>${n.ein ? `  EIN ${n.ein}` : ''}`);
      console.log(`  ${n.verified ? 'verified' : 'unverified'} · ${n.listed ? 'listed (public)' : 'unlisted'}`);
      if (n.identifiers?.length) {
        console.log('  identifiers:');
        for (const i of n.identifiers) console.log(`    ${i.id}  ${String(i.kind).padEnd(11)} ${i.value}`);
      } else {
        console.log('  identifiers: none (contact_email + its domain only)');
      }
      return;
    }
    case 'create': {
      const name = arg(rest, '--name');
      const email = arg(rest, '--email');
      if (!name || !email) { console.error('Usage: givework admin nonprofit create --name <name> --email <contact> [--ein <ein>] [--verified] [--listed]'); process.exit(1); }
      const body: any = { name, contact_email: email };
      const ein = arg(rest, '--ein');
      if (ein) body.ein = ein;
      if (has(rest, '--verified')) body.verified = true;
      const n = await apiRequest<any>(base, { method: 'POST', path: '/admin/nonprofits', token, body });
      console.log(`✓ created ${n.id} — ${n.name}`);
      // `listed` isn't on the create route; opt in with a follow-up update.
      if (has(rest, '--listed')) {
        await apiRequest<any>(base, { method: 'POST', path: `/admin/nonprofits/${n.id}`, token, body: { listed: true } });
        console.log('  listed = true');
      }
      return;
    }
    case 'set': {
      if (!rest[0]) { console.error('Usage: givework admin nonprofit set <id> [--name <>] [--email <>] [--ein <>] [--verified true|false] [--listed true|false]'); process.exit(1); }
      const body: any = {};
      const name = arg(rest, '--name'); if (name) body.name = name;
      const email = arg(rest, '--email'); if (email) body.contact_email = email;
      const ein = arg(rest, '--ein'); if (ein) body.ein = ein;
      const v = boolArg(rest, '--verified'); if (v !== undefined) body.verified = v;
      const l = boolArg(rest, '--listed'); if (l !== undefined) body.listed = l;
      if (Object.keys(body).length === 0) {
        console.error('Nothing to set — provide at least one of --name/--email/--ein/--verified/--listed.');
        process.exit(1);
      }
      const n = await apiRequest<any>(base, { method: 'POST', path: `/admin/nonprofits/${encodeURIComponent(rest[0])}`, token, body });
      console.log(`✓ ${n.name}: ${n.verified ? 'verified' : 'unverified'}, ${n.listed ? 'listed' : 'unlisted'}`);
      return;
    }
    case 'allow':
    case 'deny': {
      if (!rest[0] || !rest[1]) { console.error(`Usage: givework admin nonprofit ${sub} <id> <email-or-domain>`); process.exit(1); }
      const isEmail = rest[1].includes('@');
      const kind = sub === 'allow' ? (isEmail ? 'email' : 'domain') : (isEmail ? 'email_deny' : 'domain_deny');
      const r = await apiRequest<any>(base, {
        method: 'POST',
        path: `/admin/nonprofits/${encodeURIComponent(rest[0])}/identifiers`,
        token,
        body: { kind, value: rest[1] },
      });
      console.log(`✓ ${r.kind}: ${r.value}  (id ${r.id})`);
      return;
    }
    case 'rm-id': {
      if (!rest[0] || !rest[1]) { console.error('Usage: givework admin nonprofit rm-id <nonprofitId> <identifierId>'); process.exit(1); }
      await apiRequest<any>(base, {
        method: 'DELETE',
        path: `/admin/nonprofits/${encodeURIComponent(rest[0])}/identifiers/${encodeURIComponent(rest[1])}`,
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
