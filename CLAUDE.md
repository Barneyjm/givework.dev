# CLAUDE.md

Guidance for Claude Code working in this repo. Keep it short; prefer the README,
`BUILD.md`, and the code itself for depth.

## What this is

Givework — "agentic volunteering." Nonprofits email plain-language needs to
`intake@givework.dev`; the platform decomposes them into budgeted tasks; volunteer
developers' runners execute each via their own `claude -p` and submit results. A
row-level lock plus a database `CHECK` invariant guarantees no volunteer overspends.
See the README for the full flow and architecture.

TypeScript on Node, HTTP via Hono, Postgres via `pg`, MCP via the official SDK.
Money is integer cents everywhere (`BIGINT`), never floats.

## Commands

```bash
npm test            # vitest, full suite (needs a Postgres — see gotcha below)
npm run typecheck   # tsc --noEmit
npm run lint        # Biome (lint + format check); lint:fix to apply, format to format only
npm run migrate     # apply pending migrations/*.sql
npm run seed        # seed fixtures + print dev/admin tokens for curl
npm run dev         # Hono server on :3000 (local control plane)
npm run mcp         # MCP server over stdio (the rail the runner rides)
npm run cf:dev      # wrangler dev — full Worker runtime on :8787
```

Before declaring work done, run `lint`, `typecheck`, and `test` — CI enforces all three.

## Critical gotchas

- **Tests TRUNCATE every table.** Run the suite against the local podman Postgres on
  `localhost:5433`, NOT the remote Neon URL in `.env`. `test/helpers.ts` guards against
  non-local URLs unless `TEST_DB_ALLOW_REMOTE=1`. Typical:
  `DATABASE_URL='postgres://postgres:postgres@localhost:5433/givework' npm test`.
- **Don't burn paid LLM credit.** Never trigger real paid model calls (decomposer or
  executor) without explicit OK. Use `StubDecomposer` (the default, deterministic) and
  the stub executor for tests.
- **Execution shells out to `claude -p` — never an API key.** Donated capacity is each
  volunteer's Claude Code CLI credit. No `ANTHROPIC_API_KEY` anywhere in the executor.
- **Public repo.** Never commit infrastructure IDs or secrets (Cloudflare account IDs,
  Neon project IDs, tokens). CI injects them as secrets.
- **Two planes.** Control plane (Hono API + intake + ledger) deploys to Cloudflare
  Workers; execution plane (runner + `claude -p`) runs on volunteer machines and is
  never deployed. The model-backed decomposers only run on Node — in the deployed
  Worker `getDecomposer()` falls back to the stub (no subprocess, no local endpoint).

## Conventions

- `src/operations.ts` and `src/intake/operations.ts` are HTTP-free and auth-free; the
  HTTP server (`src/server.ts`) and the MCP server (`src/mcp.ts`) both wrap the same
  functions. Keep new core logic there, not in route handlers.
- Identity comes from the JWT, never the request body — a dev token can only act as its
  own dev. See `src/auth.ts` (`requireDev` / `requireAdmin`).
- Every state change locks the `dev_budgets` row `FOR UPDATE`; the invariant
  `reserved_cents + spent_cents <= budget_cents` is also a DB `CHECK`. Don't bypass it.
- Match the surrounding style; Biome formats automatically (2-space, 100-col, single
  quotes, trailing commas). A pre-commit hook and a PostToolUse hook both run Biome.
- Commit messages end with the Co-Authored-By trailer; branch off `main`, never commit
  to it directly.
