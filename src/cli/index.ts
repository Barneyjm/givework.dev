import { ApiError } from './api.js';
import {
  admin,
  budget,
  flagCheckFor,
  history,
  onboard,
  run,
  start,
  stats,
  status,
  tasks,
  version,
  whoami,
} from './commands.js';
import { CONFIG_PATH } from './config.js';
import { login } from './login.js';
import { captureCliEvent, errorCode, flushTelemetry } from './telemetry.js';

// The `givework` CLI entrypoint. A flat arg router — argv[2] is the command, the
// rest is passed to the handler. Kept dependency-light (no commander/yargs) so the
// esbuild bundle is small and `npx github:…` start-up stays quick.

const USAGE = `givework — volunteer your AI agent to open mathematics

Usage: givework <command> [options]

Start here — this is the only command you need:
  start [--budget <cents>]   pick up wherever you are: sign in if you're not, ask for a
                             monthly cap if you haven't set one, do one real task on a
                             live open problem if you never have, then tell you how to
                             begin. Safe to re-run; skips whatever is already done.
  start --watch              ...and go straight into the work loop when setup is done
                             (add --target <slug> to work one conjecture in particular).

The steps 'start' performs, if you'd rather drive them yourself:
  login                      sign in with GitHub (opens your browser)
  budget set <cents>         set how much of your own Claude credit to donate this month
  onboard [--budget <cents>] do one guided real task, end to end — about a minute
  run [--once|--watch]       the work loop: poll → checkout → claude -p → submit
                             [--interval <s>] [--max <n>] [--stop-on-error]
                             By default it chips away wherever work is needed. Care about
                             one problem in particular? Narrow it:
                             [--target <slug>]  only that conjecture's tasks
                             [--task <id>]      claim exactly that one task, then stop

Dev:
  whoami                     show your handle, verification, and budget
  tasks                      browse the open task pool [--max <cents>] [--sensitivity <s>]
                             [--limit <n>] [--target <slug>]
  stats                      your all-time donated total and per-month breakdown
  history [--limit <n>]      your ledger entries, newest first [--before <id>]
  version                    show the control-plane build
  status                     show local config (api url, login state)

Admin (needs an admin token — see 'admin login'):
  admin login                paste an admin token
  admin funnel               signup funnel: who sets a budget, who ever submits
  admin verify <devId>       mark a dev verified (unlocks sensitive tasks)
  admin review               list submitted work awaiting accept
  admin accept <taskId>      accept a submitted contribution
  admin decompose [--watch]  run a local model on stub-drafted intake, post drafts back
                             (DECOMPOSER=cli|local; [--interval <s>])
  admin budget <devId> <cents>
  admin task create --json '{…}'
  admin target list                          list targets + their allowlist/task counts
  admin target show <id>                     one target + its allowlist identifiers
  admin target set <id> [--verified true|false] [--listed true|false] [--name/--email/--ein]
  admin target allow|deny <id> <email|domain>      authorize / block a sender
  admin target rm-id <id> <identifierId>     remove an identifier

Config: ${CONFIG_PATH}  (env overrides: GIVEWORK_API_URL, GIVEWORK_TOKEN, GIVEWORK_ADMIN_TOKEN)
Usage stats: anonymous command name / success / duration only, to find where setup
breaks. No arguments, paths, or task content. Turn off with GIVEWORK_TELEMETRY=0.
Tip: 'start --watch' uses your own claude -p by default; set EXECUTOR to override.
Tip: podman/docker are optional — they add CPU work units and Lean proof checking.
     Auto-detected (podman, then docker); force one with GIVEWORK_CONTAINER_ENGINE.`;

async function main(argv: string[]): Promise<void> {
  const [cmd, ...args] = argv;
  // Validate flags BEFORE dispatch: an unknown flag errors out with usage
  // instead of being silently ignored, and `--help`/`-h` on any subcommand
  // prints usage and exits 0. (Incident: `givework run --help` fell through to
  // a full pool run.) A null check means the command itself is unknown — the
  // switch default (or the admin router) reports that.
  const check = flagCheckFor(cmd, args);
  if (check) {
    if (check.help) {
      console.log(USAGE);
      return;
    }
    if (check.unknown.length > 0) {
      console.error(
        `Unknown flag${check.unknown.length === 1 ? '' : 's'} for 'givework ${cmd}': ${check.unknown.join(', ')}\n`,
      );
      console.log(USAGE);
      process.exit(1);
    }
  }
  switch (cmd) {
    case 'start':
      return start(args);
    case 'onboard':
      return onboard(args);
    case 'login':
      return login();
    case 'whoami':
      return whoami();
    case 'budget':
      return budget(args);
    case 'tasks':
      return tasks(args);
    case 'stats':
      return stats();
    case 'history':
      return history(args);
    case 'run':
      return run(args);
    case 'version':
      return version();
    case 'status':
      return status();
    case 'admin':
      return admin(args);
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      console.log(USAGE);
      return;
    default:
      console.error(`Unknown command: ${cmd}\n`);
      console.log(USAGE);
      process.exit(1);
  }
}

// One capture site for the whole CLI: the command that ran, whether it worked,
// and how long it took. Wrapping main() rather than sprinkling calls through
// commands.ts keeps the payload auditable in one place — and guarantees the
// failure path is instrumented too, which is the half the control plane can
// never see (a volunteer whose `claude -p` is missing never reaches the API).
//
// `command` is the bare verb from argv, matched against the known set, so an
// unrecognised command reports as 'unknown' and never leaks a typo'd argument.
const KNOWN_COMMANDS = new Set([
  'start',
  'onboard',
  'login',
  'whoami',
  'budget',
  'tasks',
  'stats',
  'history',
  'run',
  'version',
  'status',
  'admin',
  'help',
]);

function commandLabel(cmd: string | undefined): string {
  if (cmd === undefined || cmd === '-h' || cmd === '--help') return 'help';
  return KNOWN_COMMANDS.has(cmd) ? cmd : 'unknown';
}

const argv = process.argv.slice(2);
const label = commandLabel(argv[0]);
const startedAt = Date.now();

main(argv)
  .then(async () => {
    captureCliEvent('cli_command_run', {
      command: label,
      ok: true,
      duration_ms: Date.now() - startedAt,
    });
    await flushTelemetry();
  })
  .catch(async (err) => {
    captureCliEvent('cli_command_run', {
      command: label,
      ok: false,
      duration_ms: Date.now() - startedAt,
      // An ApiError's `code` is our own machine-readable OpError code, safe to
      // send. Anything else degrades to a generic code — never the message,
      // which can contain a path or a task's contents.
      error_code: err instanceof ApiError ? err.code : errorCode(err),
      error_status: err instanceof ApiError ? err.status : undefined,
    });
    await flushTelemetry();

    if (err instanceof ApiError) {
      console.error(`Error (${err.code}): ${err.message}`);
    } else {
      console.error(err?.message ?? err);
    }
    process.exit(1);
  });
