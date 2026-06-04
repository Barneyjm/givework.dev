import { signAdminToken, signDevToken } from '../src/auth.js';

// Bootstrap credentials. The first admin token can't come from a gated endpoint,
// so mint it here. Requires JWT_SECRET in the environment.
//
//   npm run mint-token -- --admin [--exp 365]
//   npm run mint-token -- --dev <dev_id> [--exp 90]

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main() {
  const expFlag = arg('--exp');
  const expDays = expFlag ? Number(expFlag) : undefined;

  if (process.argv.includes('--admin')) {
    console.log(await signAdminToken(expDays ?? 365));
    return;
  }

  const devId = arg('--dev');
  if (devId) {
    console.log(await signDevToken(devId, expDays ?? 90));
    return;
  }

  console.error('Usage: mint-token --admin [--exp DAYS] | --dev <dev_id> [--exp DAYS]');
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
