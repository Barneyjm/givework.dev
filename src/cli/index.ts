import { login } from './login.js';
import { whoami, budget, version, run, admin, status } from './commands.js';
import { ApiError } from './api.js';
import { CONFIG_PATH } from './config.js';

// The `givework` CLI entrypoint. A flat arg router — argv[2] is the command, the
// rest is passed to the handler. Kept dependency-light (no commander/yargs) so the
// esbuild bundle is small and `npx github:…` start-up stays quick.

const USAGE = `givework — volunteer your AI agent to nonprofits

Usage: givework <command> [options]

Dev:
  login                      sign in with GitHub (opens your browser)
  whoami                     show your handle, verification, and budget
  budget set <cents>         set how much of your own Claude credit to donate this month
  run [--once|--watch]       do work: poll → checkout → claude -p → submit
                             [--interval <s>] [--max <n>] [--stop-on-error]
  version                    show the control-plane build
  status                     show local config (api url, login state)

Admin (needs an admin token — see 'admin login'):
  admin login                paste an admin token
  admin verify <devId>       mark a dev verified (unlocks sensitive tasks)
  admin budget <devId> <cents>
  admin task create --json '{…}'

Config: ${CONFIG_PATH}  (env overrides: GIVEWORK_API_URL, GIVEWORK_TOKEN, GIVEWORK_ADMIN_TOKEN)
Tip: run tasks on your donated capacity with:  EXECUTOR=claude givework run`;

async function main(argv: string[]): Promise<void> {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case 'login': return login();
    case 'whoami': return whoami();
    case 'budget': return budget(args);
    case 'run': return run(args);
    case 'version': return version();
    case 'status': return status();
    case 'admin': return admin(args);
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
