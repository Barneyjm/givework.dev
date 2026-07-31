import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  ADMIN_FLAGS,
  ADMIN_TARGET_FLAGS,
  COMMAND_FLAGS,
  checkFlags,
  flagCheckFor,
} from '../src/cli/commands.js';

// Incident: `givework run --help` fell through to a FULL POOL RUN — unknown
// flags were silently ignored. The router now validates every subcommand's
// flags against an allowlist before dispatch: unknown flags error out with
// usage (exit 1), and --help/-h prints usage (exit 0) instead of running.

describe('checkFlags()', () => {
  it('flags unknown options and detects --help/-h', () => {
    expect(checkFlags(['--bogus'], {})).toEqual({ help: false, unknown: ['--bogus'] });
    expect(checkFlags(['--help'], {}).help).toBe(true);
    expect(checkFlags(['-h'], {}).help).toBe(true);
    expect(checkFlags(['set', '2000'], {})).toEqual({ help: false, unknown: [] }); // positionals pass
  });

  it('a value-taking flag consumes its value, so a value is never "unknown"', () => {
    const spec = { '--budget': true, '--watch': false };
    expect(checkFlags(['--budget', '500', '--watch'], spec)).toEqual({ help: false, unknown: [] });
    // Even a value that starts with a dash is consumed, not misread as a flag.
    expect(checkFlags(['--budget', '-5'], spec)).toEqual({ help: false, unknown: [] });
  });
});

describe('flagCheckFor() — the per-subcommand allowlists', () => {
  it('every run flag passes; anything else is rejected', () => {
    const ok = ['--once', '--watch', '--max', '3', '--interval', '30', '--stop-on-error'];
    expect(flagCheckFor('run', ok)).toEqual({ help: false, unknown: [] });
    expect(flagCheckFor('run', ['--target', 'goldbach', '--no-update-check'])?.unknown).toEqual([]);
    expect(flagCheckFor('run', ['--budget', '500'])?.unknown).toEqual(['--budget']); // start's flag, not run's
    expect(flagCheckFor('run', ['--sensitivity', 'low'])?.unknown).toEqual(['--sensitivity']);
  });

  it('start accepts both its own flag and everything it forwards to run', () => {
    expect(flagCheckFor('start', ['--budget', '500', '--watch', '--target', 'x'])?.unknown).toEqual(
      [],
    );
    expect(flagCheckFor('start', ['--frobnicate'])?.unknown).toEqual(['--frobnicate']);
  });

  it('each subcommand accepts exactly its own flags', () => {
    expect(
      flagCheckFor('tasks', ['--max', '10', '--sensitivity', 's', '--limit', '5', '--target', 't'])
        ?.unknown,
    ).toEqual([]);
    expect(flagCheckFor('tasks', ['--before', 'x'])?.unknown).toEqual(['--before']);
    expect(flagCheckFor('history', ['--limit', '5', '--before', '9'])?.unknown).toEqual([]);
    expect(flagCheckFor('history', ['--watch'])?.unknown).toEqual(['--watch']);
    expect(flagCheckFor('onboard', ['--budget', '500'])?.unknown).toEqual([]);
    expect(flagCheckFor('onboard', ['--watch'])?.unknown).toEqual(['--watch']);
    for (const bare of ['login', 'whoami', 'stats', 'version', 'status', 'budget']) {
      expect(flagCheckFor(bare, ['--anything'])?.unknown).toEqual(['--anything']);
    }
  });

  it('admin subcommands are validated one level down', () => {
    expect(flagCheckFor('admin', ['decompose', '--watch', '--interval', '30'])?.unknown).toEqual(
      [],
    );
    expect(flagCheckFor('admin', ['decompose', '--json', 'x'])?.unknown).toEqual(['--json']);
    expect(flagCheckFor('admin', ['task', 'create', '--json', '{}'])?.unknown).toEqual([]);
    expect(flagCheckFor('admin', ['funnel', '--watch'])?.unknown).toEqual(['--watch']);
  });

  it('admin target: --verified is bare on create but takes a value on set', () => {
    expect(
      flagCheckFor('admin', [
        'target',
        'create',
        '--name',
        'n',
        '--email',
        'e',
        '--verified',
        '--listed',
      ])?.unknown,
    ).toEqual([]);
    expect(
      flagCheckFor('admin', ['target', 'set', 'id1', '--verified', 'true', '--listed', 'false'])
        ?.unknown,
    ).toEqual([]);
    expect(flagCheckFor('admin', ['target', 'list', '--json', 'x'])?.unknown).toEqual(['--json']);
  });

  it('--help reaches the help path at every level', () => {
    expect(flagCheckFor('run', ['--help'])?.help).toBe(true);
    expect(flagCheckFor('budget', ['set', '-h'])?.help).toBe(true);
    expect(flagCheckFor('admin', ['--help'])?.help).toBe(true);
    expect(flagCheckFor('admin', ['decompose', '-h'])?.help).toBe(true);
    expect(flagCheckFor('admin', ['target', '--help'])?.help).toBe(true);
    expect(flagCheckFor('admin', ['target', 'set', '--help'])?.help).toBe(true);
  });

  it('unknown commands return null — the router default reports those', () => {
    expect(flagCheckFor('frobnicate', [])).toBeNull();
    expect(flagCheckFor(undefined, [])).toBeNull();
    expect(flagCheckFor('admin', ['frobnicate', '--x'])).toBeNull();
    expect(flagCheckFor('admin', ['target', 'frobnicate'])).toBeNull();
  });

  it('the allowlists stay in lock-step with what the commands actually read', () => {
    // A drive-by check that the specs exist for every routed command; a new
    // subcommand without a spec would silently skip validation.
    for (const cmd of [
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
    ]) {
      expect(COMMAND_FLAGS[cmd], `COMMAND_FLAGS.${cmd}`).toBeDefined();
    }
    for (const sub of [
      'login',
      'funnel',
      'verify',
      'review',
      'accept',
      'decompose',
      'budget',
      'task',
    ]) {
      expect(ADMIN_FLAGS[sub], `ADMIN_FLAGS.${sub}`).toBeDefined();
    }
    for (const sub of ['list', 'show', 'create', 'set', 'allow', 'deny', 'rm-id']) {
      expect(ADMIN_TARGET_FLAGS[sub], `ADMIN_TARGET_FLAGS.${sub}`).toBeDefined();
    }
  });
});

// Exit codes are wired in src/cli/index.ts, which runs main() on import — so
// they are pinned by spawning the real entrypoint. tsx startup dominates the
// runtime; both invocations exit before any command logic (or network) runs.
describe('givework CLI exit codes', () => {
  const execFileP = promisify(execFile);
  // `node --import tsx` mirrors the package scripts and resolves tsx through
  // normal module lookup (worktrees may not have their own node_modules/.bin).
  const node = process.execPath;
  const entry = join(process.cwd(), 'src', 'cli', 'index.ts');
  const env = {
    ...process.env,
    GIVEWORK_TELEMETRY: '0',
    GIVEWORK_API_URL: 'https://api.givework.dev', // never contacted on these paths
  };

  it('`run --help` prints usage and exits 0 — never a pool run', async () => {
    const { stdout } = await execFileP(node, ['--import', 'tsx', entry, 'run', '--help'], {
      env,
      timeout: 60_000,
    });
    expect(stdout).toContain('Usage: givework');
  }, 60_000);

  it('an unknown flag errors out with usage text and exit 1', async () => {
    const err: any = await execFileP(node, ['--import', 'tsx', entry, 'run', '--hlep'], {
      env,
      timeout: 60_000,
    }).catch((e) => e);
    expect(err.code).toBe(1);
    expect(String(err.stderr)).toContain("Unknown flag for 'givework run': --hlep");
    expect(String(err.stdout)).toContain('Usage: givework');
  }, 60_000);
});
