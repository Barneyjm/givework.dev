# Givework — budget ledger core (Stages 1–2)

A budget-and-task state machine you can drive with `curl` or over MCP. See
`BUILD.md` for the original Stage 1 spec.

The core invariant is `reserved_cents + spent_cents <= budget_cents`, enforced by
both a DB `CHECK` constraint and the `dev_budgets` row being locked `FOR UPDATE`
at the start of every state change. The append-only `ledger` is the source of
truth for receipts: the sum of a dev's ledger deltas always equals their live
`reserved + spent`.

**Stage 1** — the ledger core: atomic checkout / submit / release / expire.
**Stage 2** — JWT auth (identity from the token, not the body), cross-month
reservation accounting, and an MCP server wrapping the same core for the runner.

## Stack

- TypeScript on Node, HTTP via [Hono](https://hono.dev/)
- Postgres via `pg` (node-postgres); connection from `DATABASE_URL`
- Auth: HS256 JWTs via [`jose`](https://github.com/panva/jose) — stateless, secret from `JWT_SECRET`
- MCP via [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) (stdio)
- Money is integer cents everywhere (`BIGINT` in DB) — never floats
- Tests run against a **real Postgres** (`vitest`), not a mock

## Prerequisites: a Postgres to talk to

`DATABASE_URL` must point at a Postgres 14+ (`gen_random_uuid()` is built in on
16). A Neon URL works in production; for local dev/tests a container is easiest:

```bash
# Using podman (or swap `podman` for `docker`)
podman run -d --name givework-pg \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=givework \
  -p 5433:5432 docker.io/library/postgres:16-alpine

export DATABASE_URL='postgres://postgres:postgres@localhost:5433/givework'
export JWT_SECRET='change-me'   # any non-empty secret for local dev
```

Copy `.env.example` to `.env` to keep these in one place (scripts read from the
environment).

## Install, migrate, test

```bash
npm install
npm run migrate     # applies any pending migrations/*.sql (tracked in schema_migrations)
npm test            # full suite against $DATABASE_URL (sets its own JWT_SECRET)
```

The migration runner records applied files in a `schema_migrations` table and
only runs what's pending, so re-running is a no-op. The test suite shares one
database and truncates between tests — point it at a throwaway DB, never prod.

## Auth model

Stateless JWTs (HS256, signed with `JWT_SECRET`). Two roles:

- **dev token** — `{ sub: <dev_id>, role: "dev" }`. `checkout` / `submit` /
  `release` / `budget` derive the dev **from the token**; `dev_id` is never read
  from the request body, so a token can only ever act as its own dev.
- **admin token** — `{ role: "admin" }`. Required for all `/admin/*` routes.

Bootstrap the first admin token from the CLI (the gated endpoints can't mint it):

```bash
npm run mint-token -- --admin                 # admin token
npm run mint-token -- --dev <dev_id> --exp 90 # dev token (also returned by POST /admin/devs)
```

Pass tokens as `Authorization: Bearer <token>`.

## Demo: the criterion-1 curl walkthrough

```bash
npm run seed        # prints dev_id, task_ids, and a ready-to-use DEV_TOKEN / ADMIN_TOKEN
npm run dev         # serves on http://localhost:3000
```

Using the `DEV_TOKEN` and a `task_id` the seed printed:

```bash
TOK=<DEV_TOKEN>; TASK=<task_id>
auth=(-H "authorization: Bearer $TOK")

# 1. Budget starts at $20, nothing reserved. (dev comes from the token)
curl -s "${auth[@]}" http://localhost:3000/budget
# {"budget_cents":2000,"reserved_cents":0,"spent_cents":0,"available_cents":2000}

# 2. Check out a $5-max task -> reserves 500.
curl -s "${auth[@]}" -H 'content-type: application/json' \
  -X POST http://localhost:3000/checkout -d "{\"task_id\":\"$TASK\"}"

curl -s "${auth[@]}" http://localhost:3000/budget
# {"budget_cents":2000,"reserved_cents":500,"spent_cents":0,"available_cents":1500}

# 3. Submit with actual cost 380 -> reservation released, 380 spent.
curl -s "${auth[@]}" -H 'content-type: application/json' \
  -X POST http://localhost:3000/submit \
  -d "{\"task_id\":\"$TASK\",\"result\":{\"ok\":true},\"actual_cost_cents\":380,\"raw_usage\":{\"tokens\":1000}}"

curl -s "${auth[@]}" http://localhost:3000/budget
# {"budget_cents":2000,"reserved_cents":0,"spent_cents":380,"available_cents":1620}
```

The ledger now holds `checkout +500` then `submit -120` (380 spent − 500 reserved).

## Run the MCP server

The MCP server wraps the same `operations.ts` core and acts as a single dev (the
runner's identity). It speaks stdio — point an MCP client at it:

```bash
export GIVEWORK_TOKEN=$(npm run --silent mint-token -- --dev <dev_id>)
npm run mcp        # exposes: list_open_tasks, get_budget, checkout_task, submit_result, release_task
```

Tools take the dev from `GIVEWORK_TOKEN`; only `task_id` (and result/cost on
submit) are arguments. This is the rail the Stage 3 dev runner rides.

## HTTP surface

`Authorization: Bearer <token>` required on every route. `D` = dev token, `A` = admin token.

```
D  POST /checkout            { task_id }
D  POST /submit              { task_id, result, actual_cost_cents, raw_usage }
D  POST /release             { task_id }
D  GET  /budget                                         -- caller's own, current period
D  GET  /tasks/open?max_cost_cents=&sensitivity=&limit=
A  POST /admin/expire
A  POST /admin/devs          { github_handle, email? }  -- returns the dev row + a dev token
A  POST /admin/nonprofits    { name, ein?, contact_email, verified? }
A  POST /admin/tasks         { nonprofit_id, title, spec, est_cost_cents, max_cost_cents, model, sensitivity? }
A  POST /admin/budgets       { dev_id, budget_cents }   -- current period
A  POST /admin/tasks/:id/accept
A  POST /admin/tasks/:id/reject
```

Status codes: `401` missing/invalid token, `403` wrong role, `402`
insufficient/no budget, `409` task-state conflict, `404` unknown id, `400` bad input.

## Layout

```
migrations/001_init.sql              schema (devs, nonprofits, budgets, tasks, ledger)
migrations/002_auth_and_periods.sql  tasks.reserved_period (cross-month accounting)
src/db.ts                 pg pool + withTransaction() helper
src/operations.ts         checkout / submit / release / expire / reads — core logic, HTTP-free
src/auth.ts               JWT sign/verify + requireDev / requireAdmin middleware
src/server.ts             HTTP routes -> operations (dev_id from the token)
src/admin.ts              admin-only seed routes
src/mcp.ts                MCP server wrapping operations.ts (stdio)
test/operations.test.ts   happy path, budget gate, expiry, release, clamp, 404
test/concurrency.test.ts  double-checkout race + same-dev concurrent spend (the FOR UPDATE tests)
test/invariant.test.ts    100-op randomized fuzz: ledger vs budgets never disagree
test/auth.test.ts         401/403, impersonation closed, admin gating
test/period.test.ts       cross-month: reservations freed from the period they were made in
scripts/migrate.ts        applies pending migrations (tracked)
scripts/seed-demo.ts      seeds fixtures + prints tokens for manual curl-ing
scripts/mint-token.ts     CLI to mint admin/dev tokens
```

`operations.ts` stays free of HTTP and auth concerns — both the HTTP server and
the MCP server wrap the same functions. Out-of-scope work carries a `// STAGE 3:`
marker rather than being built (nonprofit-scoped tokens, token rotation/revocation,
remote MCP transport, and the intake/decomposition layer).
