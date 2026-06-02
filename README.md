# Givework — budget ledger core (Stages 1–4)

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
**Stage 3** — the dev runner: an MCP-client loop (checkout → work → submit).
**Stage 4** — intake & decomposition: plain-language need → structured tasks.

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

## Intake & decomposition

The top of the funnel. A nonprofit emails a plain-language need to
`intake@givework.dev`; the platform decomposes it into right-sized, structured
tasks that feed the same checkout/runner loop. Nonprofits never see cents or
model names — the decomposer and an admin reviewer set those.

```
received → decompose (AI-drafted) → admin review → published → normal tasks
```

`POST /intake` is unauthenticated (it stands in for an inbound-email webhook).
Decomposition runs automatically and the draft comes back in the response:

```bash
# 1. The "email" arrives (no auth). A quantity in the body gets sized into batches.
curl -s -X POST http://localhost:3000/intake -H 'content-type: application/json' -d '{
  "from_email":"director@hopehouse.org",
  "subject":"Overwhelmed with paperwork",
  "body":"We have 30 client intake forms and need each summarized into the family'\''s top needs."
}'
# -> { intake_id, status:"decomposed", proposed:[ 3 tasks, sensitivity "sensitive" ] }

# 2. Admin reviews and publishes (turns the draft into real, open tasks).
curl -s -H "authorization: Bearer $ADMIN" http://localhost:3000/admin/intake/$INTAKE_ID
curl -s -H "authorization: Bearer $ADMIN" -H 'content-type: application/json' \
  -X POST http://localhost:3000/admin/intake/$INTAKE_ID/publish -d '{}'
# -> { status:"published", task_ids:[...] }

# 3. From here it's the normal loop — a funded dev's runner checks them out.
```

Inbound requests default to `sensitive` and find-or-create a provisional
(unverified) nonprofit keyed by sender, so repeat emails map to one org.

### Decomposer (`src/intake/decompose.ts`)

Two implementations behind one `Decomposer` interface, chosen by env:

- **`StubDecomposer`** (default) — deterministic, no model. Splits a detected
  quantity into batches. Used by the test suite (hermetic, no model needed).
- **`LocalLLMDecomposer`** (`DECOMPOSER=local`) — a real LLM running **locally and
  free** via any OpenAI-compatible endpoint (Ollama by default). It reads the
  request and proposes tasks — and, unlike the stub, understands intent (e.g. it
  splits "summarize each form *and* give me one aggregate report" into the
  per-form batches **plus** a separate report task). The model is advisory: every
  task is re-normalized on our side so `max_cost >= est_cost > 0`, sensitivity and
  model are clamped to valid values, and cents are integers. **Falls back to the
  stub** on any failure (endpoint down, timeout, bad JSON), so intake never
  hard-fails.

```bash
# e.g. with Ollama
ollama pull glm-4.7-flash       # any small instruct model that does JSON
export DECOMPOSER=local
export DECOMPOSER_MODEL=glm-4.7-flash:latest   # default
# DECOMPOSER_BASE_URL=http://localhost:11434/v1 (default; point at LM Studio etc.)
```

Decomposition runs on the *platform*, so it's deliberately a small/free/local
model. Task *execution* is separate — it runs on the volunteer's donated Claude
credit (the task's `model` is the Claude model the runner will use). A local call
can take a minute; `// STAGE 6:` marks moving it off the request path (ack
`/intake` immediately, decompose async).

## HTTP surface

`Authorization: Bearer <token>` required on every route except `POST /intake`.
`D` = dev token, `A` = admin token, `—` = public.

```
—  POST /intake               { from_email, subject?, body, attachments? }
A  GET  /admin/intake?status=
A  GET  /admin/intake/:id
A  POST /admin/intake/:id/decompose
A  POST /admin/intake/:id/publish   { tasks? }   -- defaults to the AI draft
A  POST /admin/intake/:id/reject

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
migrations/003_intake.sql            intake_requests, intake_attachments, tasks provenance
src/db.ts                 pg pool + withTransaction() helper
src/operations.ts         checkout / submit / release / expire / reads — core logic, HTTP-free
src/auth.ts               JWT sign/verify + requireDev / requireAdmin middleware
src/server.ts             HTTP routes -> operations (dev_id from the token)
src/admin.ts              admin-only seed routes
src/mcp.ts                MCP server wrapping operations.ts (stdio)
src/runner.ts             dev runner — MCP client loop (checkout -> work -> submit)
src/intake/decompose.ts   Decomposer interface + deterministic StubDecomposer
src/intake/operations.ts  receive / decompose / publish — HTTP-free
src/intake/routes.ts      public POST /intake + admin review/publish routes
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
