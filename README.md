# Givework — Stage 1 (budget ledger core)

The backend ledger core only: a budget-and-task state machine you can drive with
`curl`. No MCP server, no real Claude calls, no auth, no UI — see `BUILD.md` for
the full Stage 1 spec and what's deliberately out of scope.

The whole point of this stage is **transaction correctness**: the atomic
checkout / submit / release / expire operations and the invariant
`reserved_cents + spent_cents <= budget_cents`, which is enforced by both a DB
`CHECK` constraint and the `dev_budgets` row being locked `FOR UPDATE` at the
start of every state change.

## Stack

- TypeScript on Node, HTTP via [Hono](https://hono.dev/)
- Postgres via `pg` (node-postgres); connection from `DATABASE_URL`
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
```

Copy `.env.example` to `.env` if you prefer to keep it there (the scripts read
`DATABASE_URL` from the environment).

## Install, migrate, test

```bash
npm install
npm run migrate     # applies migrations/001_init.sql
npm test            # runs the full suite against $DATABASE_URL
```

The test suite shares one database and truncates between tests, so point it at a
throwaway DB (the container above, or a Neon test branch) — never production.

## Demo: the criterion-1 curl walkthrough

Seed a dev with a $20 budget, a nonprofit, and a few open tasks, then run the
server:

```bash
npm run seed        # prints dev_id, nonprofit_id, task_ids
npm run dev         # serves on http://localhost:3000
```

The flow below mirrors acceptance criterion 1. Substitute the `dev_id` /
`task_id` the seed printed.

```bash
DEV=<dev_id>; TASK=<task_id>

# 1. Budget starts at $20, nothing reserved.
curl -s "http://localhost:3000/budget?dev_id=$DEV"
# {"budget_cents":2000,"reserved_cents":0,"spent_cents":0,"available_cents":2000}

# 2. Check out a $5-max task -> reserves 500.
curl -s -X POST http://localhost:3000/checkout \
  -H 'content-type: application/json' \
  -d "{\"dev_id\":\"$DEV\",\"task_id\":\"$TASK\"}"

curl -s "http://localhost:3000/budget?dev_id=$DEV"
# {"budget_cents":2000,"reserved_cents":500,"spent_cents":0,"available_cents":1500}

# 3. Submit with actual cost 380 -> reservation released, 380 spent.
curl -s -X POST http://localhost:3000/submit \
  -H 'content-type: application/json' \
  -d "{\"dev_id\":\"$DEV\",\"task_id\":\"$TASK\",\"result\":{\"ok\":true},\"actual_cost_cents\":380,\"raw_usage\":{\"tokens\":1000}}"

curl -s "http://localhost:3000/budget?dev_id=$DEV"
# {"budget_cents":2000,"reserved_cents":0,"spent_cents":380,"available_cents":1620}
```

The ledger now holds `checkout +500` then `submit -120` (380 spent − 500
reserved). The ledger is append-only and is the source of truth for receipts;
the sum of a dev's ledger deltas always equals their live `reserved + spent`.

## HTTP surface

```
POST /checkout            { dev_id, task_id }
POST /submit              { dev_id, task_id, result, actual_cost_cents, raw_usage }
POST /release             { dev_id, task_id }
GET  /budget?dev_id=
GET  /tasks/open?max_cost_cents=&sensitivity=&limit=
POST /admin/expire
POST /admin/devs          { github_handle, email? }
POST /admin/nonprofits    { name, ein?, contact_email, verified? }
POST /admin/tasks         { nonprofit_id, title, spec, est_cost_cents, max_cost_cents, model, sensitivity? }
POST /admin/budgets       { dev_id, budget_cents }      -- current period
POST /admin/tasks/:id/accept
POST /admin/tasks/:id/reject
```

Status codes: `402` insufficient/no budget, `409` task-state conflict, `404`
unknown id, `400` bad input.

## Layout

```
migrations/001_init.sql   schema (devs, nonprofits, budgets, tasks, ledger)
src/db.ts                 pg pool + withTransaction() helper
src/operations.ts         checkout / submit / release / expire / reads — core logic, HTTP-free
src/server.ts             HTTP routes -> operations
src/admin.ts              seed/admin routes
test/operations.test.ts   happy path, budget gate, expiry, release, clamp, 404
test/concurrency.test.ts   double-checkout race + same-dev concurrent spend (the FOR UPDATE tests)
test/invariant.test.ts     100-op randomized fuzz: ledger vs budgets never disagree
scripts/migrate.ts        applies the migration
scripts/seed-demo.ts      seeds a dev/nonprofit/tasks for manual curl-ing
```

`operations.ts` is kept free of HTTP concerns so a Stage 2 MCP server can wrap
the same functions without refactoring. Anything tempting that's out of Stage 1
scope is marked with a `// STAGE 2:` comment rather than built.
