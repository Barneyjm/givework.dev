import { ApiError } from './api.js';
import {
  admin,
  budget,
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
  start --watch              ...and go straight into the work loop when setup is done.

The steps 'start' performs, if you'd rather drive them yourself:
  login                      sign in with GitHub (opens your browser)
  budget set <cents>         set how much of your own Claude credit to donate this month
  onboard [--budget <cents>] do one guided real task, end to end — about a minute
  run [--once|--watch]       the work loop: poll → checkout → claude -p → submit
                             [--interval <s>] [--max <n>] [--stop-on-error]

Dev:
  whoami                     show your handle, verification, and budget
  tasks                      browse the open task pool [--max <cents>] [--sensitivity <s>] [--limit <n>]
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
Tip: 'start --watch' uses your own claude -p by default; set EXECUTOR to override.`;

async function main(argv: string[]): Promise<void> {
  const [cmd, ...args] = argv;
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

main(process.argv.slice(2)).catch((err) => {
  if (err instanceof ApiError) {
    console.error(`Error (${err.code}): ${err.message}`);
  } else {
    console.error(err?.message ?? err);
  }
  process.exit(1);
});
