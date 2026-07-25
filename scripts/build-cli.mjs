// Bundle the CLI runner and stamp it with the current commit SHA, so the runner
// can tell at startup whether it's out of date (see the update check in
// src/runner.ts). Using esbuild's JS API avoids shell-quoting the --define.
// Runs during `npm run build:cli` and, via the `prepare` script, on every
// `npx github:Barneyjm/givework.dev …` install (a git install has .git, so
// `git rev-parse` works; a tarball without .git falls back to 'dev', which
// disables the check).
import { execSync } from 'node:child_process';
import { build } from 'esbuild';

let sha = 'dev';
try {
  sha =
    execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim() || 'dev';
} catch {
  // no git (e.g. installed from a tarball) — leave 'dev', which skips the check
}

await build({
  entryPoints: ['src/cli/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'dist/givework.mjs',
  banner: { js: '#!/usr/bin/env node' },
  define: { 'process.env.GIVEWORK_BUILD_SHA': JSON.stringify(sha) },
});

console.log(`built dist/givework.mjs @ ${sha}`);
