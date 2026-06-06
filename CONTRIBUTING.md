# Contributing to Givework

Thanks for pitching in. This is a public repo — keep infrastructure IDs
(Cloudflare account IDs, Neon project IDs, real secrets) out of committed files;
CI injects them as secrets.

## Setup

You need Node 22+ and a Postgres 14+ to talk to. See the README's
[Prerequisites](README.md#prerequisites-a-postgres-to-talk-to) for a one-line
podman/docker container.

```bash
npm install            # also wires the git pre-commit hook (see below)
npm run migrate        # apply pending migrations against $DATABASE_URL
npm test               # full suite against a throwaway DB — never point at prod
```

The test suite truncates between tests, so it must run against a local/throwaway
database, not a shared or production one.

## Lint & format

We use [Biome](https://biomejs.dev/) for both linting and formatting — a single
fast tool (config in `biome.json`). Run it directly:

```bash
npm run lint        # check only (this is what CI enforces)
npm run lint:fix    # lint + format, applying safe fixes
npm run format      # format only
```

Style is 2-space indent, 100-column width, single quotes, trailing commas — all
applied automatically, so don't hand-format. Two style rules (`noExplicitAny`,
`noNonNullAssertion`) are intentionally relaxed to keep the baseline clean; if
you want to tighten them, do it in a focused PR with the cleanup included.

## Hooks

Two automated guards keep the tree consistent. Neither replaces running
`npm run lint` yourself — they're backstops.

### Git pre-commit (everyone)

`npm install` runs `prepare`, which sets `git config core.hooksPath .githooks`.
After that, `.githooks/pre-commit` lints **staged** files on every commit via
`biome check --staged` and blocks the commit if anything fails. To resolve:

```bash
npm run lint:fix      # fix issues
git add -p            # re-stage
git commit            # try again
```

Emergency bypass: `git commit --no-verify` (CI will still catch it).

If hooks aren't firing, confirm the path is set:

```bash
git config core.hooksPath   # should print: .githooks
```

### Claude Code auto-format (optional)

If you use [Claude Code](https://claude.com/claude-code), `.claude/settings.json`
defines a `PostToolUse` hook that runs Biome on any `.ts`/`.tsx`/`.js`/`.json`
file the moment it's edited. It activates when Claude Code loads the project
settings — open `/hooks` once (or restart) after first checkout so the settings
watcher picks it up.

## CI

Every push and PR runs three jobs (`.github/workflows/ci.yml`): `test`
(Postgres service container), `typecheck` (`tsc --noEmit`), and `lint`
(`npm run lint`). All three must be green to merge.

## Commits & PRs

- Branch off `main`; don't commit directly to it.
- Keep mechanical changes (formatting reflows, renames) in their own commit,
  separate from behavior changes, so reviewers can use "Hide whitespace".
- Open a PR against `main`. Make sure `npm run lint`, `npm run typecheck`, and
  `npm test` all pass locally first.
