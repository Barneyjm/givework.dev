import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The publish workflow is the one piece of automation whose mistakes cannot be
// undone: npm refuses `npm unpublish` after 72 hours, so a bad `latest` is what
// `npx givework onboard` runs for everyone, forever. Nothing else in this repo
// exercises it before a release is being cut, which is far too late — so its
// load-bearing guarantees are pinned here instead.

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const workflow = read('../.github/workflows/publish-cli.yml');
const readme = read('../README.md');

/**
 * Where a step actually RUNS a command — `run: <cmd>` — as opposed to the file's
 * prose mentioning it. Asserts there is exactly such a step.
 */
function stepAt(cmd: string): number {
  const i = workflow.search(
    new RegExp(`^\\s*(- )?run: ${cmd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm'),
  );
  expect(i, `expected a step running \`${cmd}\``).toBeGreaterThanOrEqual(0);
  return i;
}

describe('publish-cli workflow', () => {
  it('runs the full CI trio before it publishes anything', () => {
    // CLAUDE.md and CONTRIBUTING.md name lint + typecheck + test as the gate for
    // every change. A release cut from a red commit would ship a broken
    // dist/givework.mjs as the permanent `latest`.
    const publish = stepAt('npm publish');
    for (const gate of ['npm run lint', 'npm run typecheck', 'npm test']) {
      expect(stepAt(gate)).toBeLessThan(publish);
    }
  });

  it('gives `npm test` a database to run against', () => {
    // The suite runs against a real Postgres, so a test step with no service
    // container would fail the release for the wrong reason (or, worse, be
    // deleted again to make the release go through).
    expect(workflow).toMatch(/services:/);
    expect(workflow).toMatch(/image:\s*postgres:/);
    expect(workflow).toMatch(/DATABASE_URL:\s*postgres:\/\/postgres:postgres@localhost/);
    expect(stepAt('npm run migrate')).toBeLessThan(stepAt('npm test'));
  });

  it('serializes runs, because two publishes racing for `latest` cannot be rerun', () => {
    expect(workflow).toMatch(/^concurrency:/m);
    expect(workflow).toMatch(/group:\s*publish-cli/);
    // Cancelling mid-flight could kill a run that has already published.
    expect(workflow).toMatch(/cancel-in-progress:\s*false/);
  });

  it('publishes a prerelease under a dist-tag that is not `latest`', () => {
    // `latest` is what `npx givework onboard` resolves to. A GitHub prerelease
    // must never land there.
    expect(workflow).toContain('github.event.release.prerelease');
    expect(workflow).toMatch(/tag=next/);
    expect(workflow).toMatch(/npm publish[^\n]*--tag/);
  });

  it('pins npm rather than floating it in an attested publish job', () => {
    expect(workflow).not.toMatch(/npm install -g npm@latest/);
    expect(workflow).toMatch(/npm install -g npm@\^11\.5\.1/);
  });

  it('builds the bundle exactly once, in the job', () => {
    // `npm ci` runs `prepare` -> `build:cli`. A standalone build step is the
    // second build; `npm pack` / `npm publish` re-running `prepare` is the third.
    expect(workflow).not.toMatch(/^\s*- run: npm run build:cli\s*$/m);
    expect(workflow).toMatch(/npm pack[^\n]*--ignore-scripts/);
    expect(workflow).toMatch(/npm publish[^\n]*--ignore-scripts/);
    // …and what is shipped still has to be produced here, not committed.
    expect(workflow).toContain('git ls-files --error-unmatch dist/givework.mjs');
  });
});

describe('README publishing instructions', () => {
  it('describes trusted publishing and never asks for a stored npm token', () => {
    // A standing NPM_TOKEN repo secret is exactly the credential trusted
    // publishing exists to eliminate. An owner following the README must not
    // create the thing the workflow was designed to do without.
    expect(readme).not.toMatch(/stored as a\s+repo secret \(`NPM_TOKEN`\)/);
    expect(readme).toMatch(/trusted publishing/i);
    expect(readme).toMatch(/OIDC/);
    expect(readme).toMatch(/there is no `NPM_TOKEN`/i);
  });

  it('records why the first publish was manual, and how to redo the setup', () => {
    // Written while the package was unpublished, this used to assert the README
    // WARNED that the first publish might need doing by hand. It since did have
    // to be: npm cannot bootstrap a new package over OIDC, because the
    // trusted-publisher settings live on the package page and the package must
    // already exist (npm/cli#8544). That is history now rather than a warning,
    // but it has to stay written down -- anyone republishing under a new name
    // hits the identical wall, and it is not obvious from npm's own docs.
    expect(readme).toMatch(/npm\/cli#8544|must already exist/i);
    expect(readme).toMatch(/claim the name/i);
    // The publisher config must be recoverable from the README alone: npm does
    // not validate it on save, so a typo only surfaces at the next release.
    expect(readme).toMatch(/publish-cli\.yml/);
    expect(readme).toMatch(/case-sensitive/i);
  });
});
