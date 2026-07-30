<div align="center">

<img src="brand/givework-logo-512.png" alt="Givework" width="140" />

# Givework

**Agentic volunteering** — developers lend their AI agents to open mathematics.

[![CI](https://github.com/Barneyjm/givework.dev/actions/workflows/ci.yml/badge.svg)](https://github.com/Barneyjm/givework.dev/actions/workflows/ci.yml)
[![Deploy](https://github.com/Barneyjm/givework.dev/actions/workflows/deploy.yml/badge.svg)](https://github.com/Barneyjm/givework.dev/actions/workflows/deploy.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com)
[![Linted with Biome](https://img.shields.io/badge/lint-biome-60a5fa?logo=biome&logoColor=white)](https://biomejs.dev)

</div>

> Your Claude plan already includes a free, dedicated agent for headless work — and
> most of it sits idle. Point it at open mathematics: chip at unsolved conjectures
> on the subscription you already pay for. Public, verifiable, fully accounted for.

## Volunteer in one command

```bash
npx givework start
```

That is the whole thing, whether it is your first time or your fiftieth. `start`
looks at where you already are and does only what is missing: signs you in if you
aren't, asks what you're willing to donate this month if you haven't said, and —
if you've never done one — hands you a **real task on a live open problem**, runs
it on your own `claude -p`, submits it, and shows you what you contributed. About
a minute. Safe to re-run at any point; it resumes rather than starting over, and
never mints or pays for the same task twice.

You get a **Goldbach range sweep**: forty thousand even numbers, a range allocated
to you and nobody else, checked for a counterexample. Almost certainly you will
find nothing — and that is the point, not a failure. Ruling out territory is a
real contribution, machine-verified and recorded permanently under your name.

*Prerequisite:* the [Claude Code CLI](https://claude.com/claude-code) installed and
logged in. That logged-in session **is** the donated capacity — Givework never sees
an API key. Running the task costs a few cents of your own credit, and that is
deliberate: it is what proves your setup actually works end to end before you leave
a runner going.

Then keep going:

```bash
npx givework start --watch
```

`start` on its own finishes by telling you how to begin the work loop rather than
dropping you into it: the loop spends your own Claude credit continuously and
unattended, and that should be something you typed, not something that happened
to you. `--watch` is that opt-in. Underneath, `login`, `budget set`, `onboard`
and `run` are all still real commands if you'd rather drive the steps yourself.

By default your runner chips away wherever work is needed — the general pool is
the point, and it's how less-famous problems get attention too. If one problem
in particular is why you're here, narrow it: `--target <slug>` (e.g.
`npx givework run --watch --target goldbach`) works only that conjecture, and
`run --task <id>` claims exactly one specific task and stops.

## What is Givework?

Givework points volunteers' idle AI agents at **open mathematical conjectures**.
An open problem (curated, or proposed via `givework.dev`) is decomposed into small,
well-scoped **attack tasks** — verify a computational range, hunt a counterexample,
formalize a lemma in Lean, bash a case — and published to an open pool. A volunteer
developer's **runner** checks out a task, works it with their *own* Claude Code agent
(`claude -p` — donated capacity from a subscription they already pay for), and
submits a **contribution**. Hard problems are chipped across many contributors: each
picks up the accumulated state, adds a bounded chunk, and hands off to the next.

Results are **verified** — a counterexample is re-evaluated, a Lean proof is
compiled, a range is replicated — so "done" is objective, not a matter of trust.
Every task carries a budget; a row-level lock plus a database `CHECK` invariant
guarantees no volunteer ever overspends. All mathematics is public; volunteers never
expose an API key — work runs on their local Claude credit, never `ANTHROPIC_API_KEY`.

## How it works

```
 conjecture ─▶ decompose ─▶ admin review ─▶ published task pool
 (seeded or    (AI-drafted,                       │
  submitted)    attack tasks)                      ▼
                              volunteer runner:  checkout ─▶ claude -p ─▶ contribute
                                                                │
   target: open → disproven/resolved ◀── verify ◀── budget ledger accounts every cent
```

- **Conjectures in, attack tasks out.** Admins seed curated open problems, and anyone
  can propose one via the public submission form — no spend happens until a human
  reviews and publishes, so the pool is open without an allowlist. ([details](#intake--decomposition))
- **Decomposition** turns one open problem into right-sized attack tasks, each tagged
  with a *kind* (computational / counterexample_search / formalization / lemma /
  exploration) and how it will be *verified* — drafted by a small local model
  (schema-constrained), reviewed before publishing.
- **Resumable work.** A bounded budget only buys a small chunk, so a task accumulates:
  each contribution appends to an append-only log (progress *and* dead ends) and
  updates a compacted working state the next agent reads first.
- **Verification, not trust.** `auto_rerun` re-evaluates a counterexample witness and
  can flip a conjecture to `disproven`; `proof_checker`/`replication` are checked by
  an admin-run local checker for now; `human_review` is the subjective fallback.
- **Execution is donated, not billed.** The runner shells out to `claude -p`, so the
  capacity is the volunteer's existing Claude Code credit. No API keys, no platform
  spend per task.
- **Fully accounted for.** Checkout takes a `FOR UPDATE` row lock and refuses a task
  unless `reserved + spent + max_cost <= budget`, so nothing can be *started* beyond
  what a volunteer pledged. A finished task books what it actually cost — that money
  is already spent on their own subscription, and recording less would understate the
  donation — so an overrun can push `spent` past `budget`, and the next checkout is
  refused until they raise the cap. The `ledger` tracks every change: the sum of a
  dev's deltas always equals their live `reserved + spent`.

## Architecture

Two planes, deployed and operated separately:

- **Control plane** — the Hono API, intake/decomposition, and the budget ledger. Ships
  to **Cloudflare Workers** on every push to `main` (`.github/workflows/deploy.yml`),
  backed by **Neon Postgres**. The same HTTP-free core (`src/operations.ts`) is also
  wrapped by an **MCP** server for the runner to drive.
- **Execution plane** — the dev runner and `claude -p` executor. Runs on **volunteer
  machines**, never deployed; it polls the control plane over HTTP/MCP and executes on
  local Claude credit.

> Drive the whole thing with `curl` or over MCP. The repo was built in stages — ledger
> core → JWT auth + MCP → dev runner → intake & decomposition; see `BUILD.md` for the
> original Stage 1 spec and `git log` for the lineage.

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

## The local flow rig — the pre-release gate

Unit tests cover the pieces; the flow rig runs the **story**: a real local Hono
server, the real runner loop, and (in full mode) your own real `claude -p`,
end to end through checkout → proposal → decomposition validation/salvage →
review mint → rejection flow-back → corrected resubmit → approve → publish →
published-subtask checkout, asserting DB state *and the exact prompt the model
was shown* after every step. Run it before cutting a release — the bugs the
v0.3.1–v0.3.5 fire-drill fixed one-per-release in production all live on this
path.

```bash
podman start givework-pg   # the local test Postgres on :5433 (see above)
npm run flow:smoke         # deterministic scripted saga — no model, no spend (also in `npm test`)
npm run flow:local         # the real thing: your `claude -p`, your subscription credit
```

Full mode spends **your own Claude Code subscription credit** (typically well
under $1 for a whole saga; hard-capped at 8 model runs, `--max-runs N` to
change). No API key is used or accepted. The rig refuses non-local databases
(it TRUNCATEs), boots on a random port, and on any stage failure stops and
prints the failing stage, the DB evidence, and the path of the prompt/result
transcript (`GIVEWORK_PROMPT_LOG`, a JSONL of every prompt sent to the model
and every parsed result with its `parse_mode` and booked cost).

## Lint & format

[Biome](https://biomejs.dev/) handles both linting and formatting (one fast
tool, config in `biome.json`):

```bash
npm run lint        # check (what CI runs)
npm run lint:fix    # lint + format, applying safe fixes
npm run format      # format only
```

`npm install` also points git at the repo's hooks (`core.hooksPath` via the
`prepare` script), so a **pre-commit hook** lints staged files and blocks the
commit on any issue — run `npm run lint:fix` and re-stage, or `git commit
--no-verify` to bypass. See [CONTRIBUTING.md](CONTRIBUTING.md) for details,
including the Claude Code auto-format hook.

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

Inbound requests arrive **as email**, not over HTTP. Cloudflare Email Routing
delivers mail for `intake@givework.dev` to the Worker's `email` handler
(`src/intake/email.ts`), which parses it, checks the sender against the
allowlist, and calls `receiveIntake()` in-process. There is no public,
unauthenticated intake endpoint — nothing to spoof or spam, and nothing inbound
ever touches a volunteer machine. See `src/intake/email.ts` for the security
model and `wrangler.toml` for the one-time Email Routing setup.

Mail must clear two gates before anything happens. First, **DMARC must pass** —
the `From` header is forgeable, so we require `dmarc=pass` from the
Authentication-Results Cloudflare adds (it delivers unauthenticated mail too, it
doesn't drop it), which authenticates the `From` domain. Then the sender must be
on the **allowlist** of verified nonprofits — matched by exact `contact_email`
or org domain (consumer-mailbox domains match by exact address only). Everything
else is rejected at SMTP time, before the decomposer (and its token spend) is
ever reached. First contact / onboarding happens at
`hello@givework.dev`, which routes to a human inbox, not the Worker.

```bash
# Local: drive the same pipeline directly (no email infra needed). Admins can
# also submit/replay a request by hand via POST /admin/intake.
curl -s -H "authorization: Bearer $ADMIN" -H 'content-type: application/json' \
  -X POST http://localhost:3000/admin/intake -d '{
  "from_email":"director@hopehouse.org",
  "subject":"Overwhelmed with paperwork",
  "body":"We have 30 client intake forms and need each summarized into the family'\''s top needs."
}'
# -> { intake_id, status:"decomposed", proposed:[ 3 tasks, sensitivity "sensitive" ] }

# Admin reviews and publishes (turns the draft into real, open tasks).
curl -s -H "authorization: Bearer $ADMIN" http://localhost:3000/admin/intake/$INTAKE_ID
curl -s -H "authorization: Bearer $ADMIN" -H 'content-type: application/json' \
  -X POST http://localhost:3000/admin/intake/$INTAKE_ID/publish -d '{}'
# -> { status:"published", task_ids:[...] }

# From here it's the normal loop — a funded dev's runner checks them out.
```

#### Testing the email path locally

The whole inbound-email flow — parse → DMARC gate → allowlist → decompose — runs
without any email infrastructure. Two ways:

```bash
export DATABASE_URL='postgres://postgres:postgres@localhost:5433/givework'  # local DB only

# 1. Pipe a raw .eml through the exact code the Worker's email() handler uses.
#    --seed adds a verified nonprofit so the sender is allowlisted; --dmarc
#    simulates Cloudflare's verdict (default pass). The script refuses any
#    non-local DATABASE_URL since it writes rows.
npm run intake-email -- message.eml --seed director@helpful.org     # -> accepted
npm run intake-email -- message.eml --seed director@helpful.org --dmarc fail  # -> unauthenticated
npm run intake-email -- message.eml                                 # -> sender_not_approved
```

```bash
# 2. Full Worker runtime via wrangler dev, hitting the real email() binding.
#    Point Hyperdrive at the local DB, then POST a raw message to the email
#    handler endpoint (include an Authentication-Results line so DMARC passes).
export WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="$DATABASE_URL"
npm run cf:dev   # wrangler dev, serves on :8787
curl -X POST 'http://localhost:8787/cdn-cgi/handler/email' \
  --url-query 'from=director@helpful.org' --url-query 'to=intake@givework.dev' \
  --data-binary @message.eml
```

Inbound requests default to `sensitive`. Allowlisted email attaches to the
matched verified nonprofit; the manual admin path find-or-creates a provisional
org keyed by sender, so repeat requests map to one org.

### Allowlist management & transparency

A nonprofit's `contact_email` is just the seed. Admins attach more authorized
senders via `nonprofit_identifiers` — extra `email`s, whole `domain`s, plus
`email_deny`/`domain_deny` entries that override an allow (block one address even
when its domain is allowed). A sender is authorized if **any** allow identifier
matches and **no** deny does. Consumer-mailbox domains (gmail.com, …) still only
match by exact address, never by domain.

```bash
A=(-H "authorization: Bearer $ADMIN" -H 'content-type: application/json')
# Authorize a second domain for an org, then block one mailbox under it.
curl -s "${A[@]}" -X POST http://localhost:3000/admin/nonprofits/$NP/identifiers \
  -d '{"kind":"domain","value":"helpful-foundation.org"}'
curl -s "${A[@]}" -X POST http://localhost:3000/admin/nonprofits/$NP/identifiers \
  -d '{"kind":"email_deny","value":"intern@helpful.org"}'
# Verify + publish the org (opt-in to the public list).
curl -s "${A[@]}" -X POST http://localhost:3000/admin/nonprofits/$NP \
  -d '{"verified":true,"listed":true}'
```

`GET /transparency` is public and opt-in: only orgs an admin marked `listed`
appear, exposing just name + task counts (no contact info or task content) so the
marketing site can render a "who we work with" section.

```bash
curl -s http://localhost:3000/transparency
# { "totals": { "orgs": 4, "tasks_total": 120, "tasks_accepted": 98 },
#   "orgs": [ { "name": "Helpful Org", "tasks_total": 38, "tasks_accepted": 31 }, … ] }
```

### Decomposer (`src/intake/decompose.ts`)

Three implementations behind one `Decomposer` interface, chosen by env. Both
model-backed ones **fall back to the stub** on any failure so intake never
hard-fails, and every model-proposed task is re-normalized on our side
(`max_cost >= est_cost > 0`, model/sensitivity clamped, integer cents).

- **`StubDecomposer`** (default) — deterministic, no model. Splits a detected
  quantity into batches. Used by the test suite (hermetic, no model needed).
- **`LocalLLMDecomposer`** (`DECOMPOSER=local`) — a real LLM via any
  OpenAI-compatible **HTTP** endpoint (Ollama by default). Uses the
  **structured-output primitive**: the request carries `response_format:
  json_schema` with our exact draft schema, so the model's decoding is
  constrained to conforming JSON — no field drift, no parse-repair guessing.
  **This is the reliable path; prefer it.**
- **`CliDecomposer`** (`DECOMPOSER=cli`) — a real LLM via any **`-p` style CLI**
  (the same idea as the executor's `claude -p`): spawn a command, feed the prompt
  on stdin, read the reply. Ollama by default; `claude`, llamafile, etc. all work.
  A raw CLI can't constrain decoding, so this path relies on tolerant parsing
  (`extractTasks`: strips ANSI, unwraps fenced/`claude -p` JSON, runs `jsonrepair`
  on malformed output) — best-effort, use when an HTTP endpoint isn't available.

```bash
# HTTP (OpenAI-compatible, e.g. Ollama / LM Studio)
export DECOMPOSER=local  DECOMPOSER_MODEL=glm-4.7-flash:latest
# DECOMPOSER_BASE_URL=http://localhost:11434/v1 (default)

# CLI (any "-p style" tool)
export DECOMPOSER=cli  DECOMPOSER_CMD=ollama  DECOMPOSER_MODEL=glm-4.7-flash:latest
export DECOMPOSER=cli  DECOMPOSER_CMD=claude  DECOMPOSER_ARGS="-p"   # {model} is substituted in ARGS
```

**Where it runs.** Decomposition is deliberately a small/free/local model — but
the model-backed decomposers only run on **Node** (a local control plane): the
Worker has no subprocess and no reachable local endpoint, so in the deployed
Worker `getDecomposer()` uses the **stub**. Inbound email therefore lands as a
stub draft (`triaged_by = stub`); a real model upgrades it off-Worker.

**`admin decompose --watch`** is that bridge: run it locally with
`DECOMPOSER=local` (or `cli`) and it polls prod for stub-drafted intake,
re-decomposes each with your local model, and posts the result back via
`POST /admin/intake/:id/draft` (recording `triaged_by = local`). Only genuine
model output is uploaded — a fallback-to-stub run is left untouched for the next
pass. `--once` runs a single sweep; `--interval <s>` sets the poll cadence.
Local models are slow under schema-constrained decoding, so the HTTP request
timeout defaults to 240s (`DECOMPOSER_TIMEOUT_MS`). Task *execution* is separate
— it runs on the volunteer's donated Claude credit.

## Onboarding & the funnel

A new contributor's first task is **real work on a live open problem**, not a
self-test. Most people who set this up never come back, so the one task they
actually run should produce something. A range sweep is the right shape: it needs
zero prior context (exactly what a newcomer has), it auto-verifies with nobody in
the loop, distinct ranges mean newcomers never collide, and a bad run fails safe.

- **Per-dev, never pooled.** `tasks.onboarding_dev_id` owns the task. A pooled
  onboarding task would be claimed once and then be missing for everyone else, so
  these are hidden from `/tasks/open` and `/tasks/available`, and `checkoutTask`
  refuses them to anyone but their owner.
- **Distinct ranges.** `targets.sweep_cursor` is advanced one block per mint under
  `SELECT … FOR UPDATE`. Concurrent mints serialize on that row lock, so blocks
  tile the number line with no overlap and no gaps. Lock order is
  `dev_budgets` → `targets`, matching `submitResult`, so it cannot deadlock.
- **Idempotent.** Asking twice returns the same task — re-checked under the budget
  lock, and backstopped by a `UNIQUE` index on `onboarding_dev_id`. This is what
  makes `givework onboard` resumable rather than a source of duplicate work.
- **Auto-verified.** `kind=computational`, `verify_via=auto_rerun` against the
  target's built-in checker, which **re-runs the entire assigned range** in the
  control plane (`src/goldbach.ts`, a segmented sieve — ~6 ms per block) and
  compares. A fabricated claim, or a claim about a different range than the one
  assigned, fails verification and the task returns to its owner. The range being
  *assigned* is what makes an auto-pass possible at all: a witness that names its
  own range on a task that assigned none is `inconclusive` and waits for a human,
  never `confirmed`. No human review queue for the real thing: 200 signups in a
  week cost zero review minutes.
- **A clean sweep is a pass.** Finding nothing is the expected, correct outcome,
  so the checker reports `confirmed` and the contribution is accepted — without
  claiming the conjecture is settled. Treating "found nothing" as a rejection
  would throw real work away and hand newcomers a red X for doing the job.
- **Ordinary accounting.** Onboarding tasks count toward donated totals and the
  leaderboard like any other task, because the work and the money are both real.
  The budget guard is *not* special-cased: too small a cap is refused cleanly at
  mint time with a message saying what to do, and `checkoutTask` would refuse it
  again anyway.

`funnel_events` is a small append-only log — dev created, budget set, onboarding
minted, checkout, submit — kept deliberately separate from `ledger` (money must
never depend on analytics). Two rules make it free and safe on the donation path:

- **No extra connection.** Money operations hand `recordEvent` the connection
  they already hold, so a checkout is still one connect, not two. That matters on
  Workers, where every `query()` opens and closes its own `pg.Client` against a
  possibly-cold Neon compute.
- **Swallowed on failure, under a `SAVEPOINT`.** A missing analytics row is a
  reporting gap; a failed checkout is a lost donation. The savepoint is what stops
  a failed insert from aborting the transaction that carries the money.

Every checkout and submit is recorded, so first-vs-repeat is derived rather than
stored. `GET /admin/funnel` (or `givework admin funnel`) reports it as counts and
conversion rates — including how many contributors were one-and-done. A rate with
no denominator is reported as `null` and rendered `—`, never `0%`: devs who
predate the log emit no signup event, so `signed_up` can be 0 while later stages
are not, and a `0%` there would read as "onboarding converts nobody" when it
converted everybody. `untracked_devs` names that gap explicitly.

### PostHog (optional, and off unless configured)

`funnel_events` above is the source of truth. PostHog sits on top of it as the
exploratory layer, across three surfaces:

- **The site** loads `site/posthog-init.js`, which also owns *all* CTA click
  tracking in one delegated listener — pages capture only what the shared
  handler cannot know (a board's task count, a conjecture's status).
- **The control plane** mirrors the funnel stages — `dev_created`, `budget_set`,
  `onboarding_minted`, `checkout`, `submit`, plus `release` — from
  `src/posthog.ts`, the single server-side capture path. Every capture is
  fire-and-forget AFTER the operation's transaction commits, parked on the
  Worker's `waitUntil` — the same rule as `funnel.ts`: analytics is never in
  front of the money path, and a PostHog outage cannot fail a checkout. The
  `distinct_id` is the first 16 hex chars of SHA-256(dev id) — never the raw
  id, an email, or a GitHub handle — and the CLI and the post-sign-in page use
  the same hash, so all three surfaces resolve to one PostHog person.
- **The CLI** reports local command outcomes (see below).

Configured by two environment variables on the Worker,
`POSTHOG_PROJECT_TOKEN` and `POSTHOG_API_HOST` (see `wrangler.toml`). Both are
optional: with the token unset the site loads no snippet, the server-side
capture is a no-op and the CLI sends nothing. The token is a **public ingest
key** — `GET /analytics-config.js` serves it to every browser and
`GET /analytics-config.json` to every runner — so it is kept out of the repo for
configurability and to stop a fork reporting into someone else's project, not
for secrecy.

### CLI usage stats

`givework` reports anonymous local command outcomes, because the control plane
cannot see the failures that matter most: someone runs `givework start`, has no
`claude` on `PATH`, and gives up without ever making an HTTP request. That
volunteer is invisible in every server-side metric.

- **Collected:** command name (matched against the known set, so a typo is
  reported as `unknown`), success/failure, duration, an error *code*, CLI build
  sha, Node version, OS, and whether `CI` is set.
- **Never collected:** arguments, file paths, hostnames, task content, prompts,
  model output, or error messages.
- **Disclosed once**, on the first command that would send anything.
- **Opt out** with `GIVEWORK_TELEMETRY=0`, or the cross-tool `DO_NOT_TRACK=1`.
  Opting out sends nothing at all — not even the config lookup — and writes
  nothing to disk. `givework status` shows the current state.

`test/cli-telemetry.test.ts` holds each of those to a test.

## HTTP surface

`Authorization: Bearer <token>` required on every route below.
`D` = dev token, `A` = admin token, `—` = public. (Inbound intake is email, not
HTTP — see above; `POST /admin/intake` is the admin manual/replay path.)

```
A  POST /admin/intake          { from_email, subject?, body, attachments?, nonprofit_id? }
A  GET  /admin/intake?status=
A  GET  /admin/intake/:id
A  POST /admin/intake/:id/decompose
A  POST /admin/intake/:id/publish   { tasks? }   -- defaults to the AI draft
A  POST /admin/intake/:id/reject

—  GET  /analytics-config.js                             -- public: PostHog config as window globals (the site)
—  GET  /analytics-config.json                           -- public: the same config as JSON (the CLI)
—  GET  /transparency                                   -- public: listed orgs + task counts
—  GET  /requests/:id                                    -- public: plain-language status (id = the share-link token)

D  POST /checkout            { task_id }
D  POST /submit              { task_id, result, actual_cost_cents, raw_usage }
D  POST /release             { task_id }
D  GET  /budget                                         -- caller's own, current period
D  GET  /tasks/open?max_cost_cents=&sensitivity=&limit=  -- hides other devs' onboarding tasks
D  POST /devs/budget          { budget_cents }          -- caller's own cap
D  POST /devs/onboarding                                -- mint (or fetch) my onboarding task; idempotent
A  POST /admin/expire
A  GET  /admin/funnel                                   -- signup funnel: counts + conversion rates
A  POST /admin/devs          { github_handle, email? }  -- returns the dev row + a dev token
A  POST /admin/nonprofits    { name, ein?, contact_email, verified? }
A  GET  /admin/nonprofits                               -- all orgs + identifier/task counts
A  GET  /admin/nonprofits/:id                           -- one org + its allowlist identifiers
A  POST /admin/nonprofits/:id { name?, ein?, contact_email?, verified?, listed? }  -- override fields
A  POST /admin/nonprofits/:id/identifiers   { kind, value }  -- kind: email|domain|email_deny|domain_deny
A  DELETE /admin/nonprofits/:id/identifiers/:identifierId
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
src/intake/operations.ts  receive / decompose / publish + sender allowlist — HTTP-free
src/intake/email.ts       Cloudflare Email Worker — inbound mail → allowlist → intake
src/intake/routes.ts      admin intake routes (manual submit + review/publish)
src/goldbach.ts           segmented-sieve range sweep — the onboarding task AND its verifier
src/funnel.ts             append-only signup-funnel log + the admin report
src/cli/commands.ts       CLI verbs, including `start` (the front door) and `onboard`
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

## Contributing

Contributions welcome. The short version:

```bash
npm install          # also wires the git pre-commit hook
npm run migrate      # against a local/throwaway Postgres
npm run lint         # Biome
npm run typecheck    # tsc --noEmit
npm test             # full suite
```

All three of `lint`, `typecheck`, and `test` must pass — CI enforces them on every
PR. Branch off `main`, keep mechanical reformats in their own commit, and see
[CONTRIBUTING.md](CONTRIBUTING.md) for the full guide (hooks, style, conventions).

This is a **public** repo: never commit infrastructure IDs or secrets (Cloudflare
account IDs, Neon project IDs, tokens) — CI injects them as secrets.

### Publishing the CLI

`givework` is on npm, so the short form works:

```bash
npx givework start
```

`npx github:Barneyjm/givework.dev …` also works and needs no registry at all —
npm clones the repo, installs, runs `prepare` → `build:cli`, and links the
`givework` bin. Useful for running an unreleased branch; `npx givework` is the
one to hand to a stranger.

**Releases run from CI with no stored credential.** `.github/workflows/publish-cli.yml`
publishes on a GitHub Release using npm **trusted publishing**: the job mints a
short-lived OIDC token from GitHub, npm verifies it against the trusted publisher
configured on the package, and provenance attestations are generated
automatically. **There is no `NPM_TOKEN` in this repo, and there must not be one.**

To cut a release: bump `version`, then publish a GitHub Release tagged
`v<version>`. The workflow fails loudly if the tag and `package.json` disagree,
runs lint + typecheck + the full suite before publishing, and routes prereleases
to the `next` dist-tag so they never become `latest`.

Requires npm >= 11.5.1 and Node >= 22.14.0, which is why the job upgrades npm
explicitly — `actions/setup-node` pins an older one.

#### Configuring the trusted publisher (already done; recorded here for recovery)

npmjs.com → Packages → `givework` → Settings → Trusted publishing → GitHub Actions:

| Field | Value |
| --- | --- |
| Organization or user | `Barneyjm` |
| Repository | `givework.dev` |
| Workflow filename | `publish-cli.yml` (filename only, not a path) |
| Allowed actions | `npm publish` |
| Environment name | *(blank)* |

All fields are case-sensitive, `package.json`'s `repository.url` must match the
repo exactly, and **npm does not validate the configuration when you save it** —
a typo surfaces as a failed publish later, not an error at setup.

#### Why the first publish was manual

npm cannot bootstrap a new package over OIDC: the trusted-publisher settings live
on the package page, so the package must already exist ([npm/cli#8544](https://github.com/npm/cli/issues/8544)).
`0.1.0` was therefore published by hand to claim the name, and every release
since goes through the workflow.

That one manual publish is harder than it sounds if the account uses a passkey
rather than TOTP. Classic tokens were removed in November 2025, granular tokens
prompt for an OTP a security key cannot produce, and npm's browser handoff needs
a real TTY — Git Bash on Windows is not one, and PowerShell blocks the unsigned
`npm.ps1`, so `npm.cmd` is the way in. None of this recurs: the workflow is the
only publishing path now.

## License

[Apache License 2.0](LICENSE).
