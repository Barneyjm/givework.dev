# Givework — Stage 1 Build Spec

A build target for Claude Code. This is the **backend ledger core only** — no MCP server, no real Claude calls, no auth, no UI. The goal is a working budget-and-task state machine you can drive with `curl`, with the atomic transactions correct and tested. Everything else is later stages.

## Context (for the agent)

Givework is a marketplace where developers donate AI inference capacity to nonprofits ("Agentic Volunteering"). Nonprofits post verifiable tasks; a developer's local runner checks out a task, executes it against the developer's Anthropic Agent SDK credit, and submits the result. The platform tracks budgets and maintains an append-only ledger that gives each developer a verifiable record of what they contributed.

Stage 1 builds the part everything else depends on: the budget accounting and task state machine. If the atomic checkout/submit/expire transactions aren't bulletproof, nothing built on top will be. So this stage is small on purpose and heavy on correctness.

## Scope

### In scope
- Postgres schema (Neon-targeted, standard Postgres — no Nile-specific features)
- Three core operations as HTTP endpoints: `checkout`, `submit`, `release`
- One background sweep: `expire` (lock timeout → return task to pool, release reserved budget)
- Read endpoints: `list_open_tasks`, `get_budget`
- Seed/admin helpers to create devs, nonprofits, tasks, and budgets for testing
- Integration tests covering the concurrency and invariant cases below

### Explicitly out of scope (do NOT build in Stage 1)
- MCP server wrapper
- Real Anthropic / Agent SDK calls
- OAuth or any auth (endpoints are unauthenticated; assume trusted caller)
- The Go runner (a stub that prints "would call Claude here" is fine if needed for an end-to-end smoke test, but is not required)
- Receipt PDF generation
- EIN verification
- Web UI / dashboards
- Rate limiting, strike system, gifting, rollover, leaky-bucket fairness
- Multi-provider support

If a decision tempts you toward any out-of-scope item, stop and leave a `// STAGE 2:` comment instead of building it.

## Stack

- **Runtime**: TypeScript on Node (plain Node + a thin HTTP layer, e.g. Hono or Express). Do NOT target Cloudflare Workers in Stage 1 — local Node is faster to iterate and test. Workers is a Stage 2 port.
- **DB**: Postgres via `pg` (node-postgres). Connection string from `DATABASE_URL` env var (a Neon URL in practice; a local Postgres for tests).
- **Migrations**: a single `migrations/001_init.sql` applied by a small script. No migration framework needed yet.
- **Tests**: `vitest` or `node:test`. Tests must run against a real Postgres (local or a Neon test branch), not a mock — the whole point is transaction correctness.
- **Money**: integer cents everywhere (`BIGINT` in DB, `number` or `bigint` in TS). Never floats.

## Data model

Implement this schema in `migrations/001_init.sql`.

```sql
CREATE TABLE devs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  github_handle TEXT UNIQUE NOT NULL,
  email TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE nonprofits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  ein TEXT,
  contact_email TEXT NOT NULL,
  verified BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- One row per dev per month. The wallet.
-- Invariant: reserved_cents + spent_cents <= budget_cents (enforced by CHECK + app logic)
CREATE TABLE dev_budgets (
  dev_id UUID REFERENCES devs(id),
  period DATE NOT NULL,                 -- first day of the month (date_trunc('month', ...))
  budget_cents BIGINT NOT NULL,
  reserved_cents BIGINT NOT NULL DEFAULT 0,
  spent_cents BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (dev_id, period),
  CHECK (reserved_cents >= 0),
  CHECK (spent_cents >= 0),
  CHECK (reserved_cents + spent_cents <= budget_cents)
);

-- Nonprofits cap their own consumption so one project can't drain the pool.
CREATE TABLE nonprofit_budgets (
  nonprofit_id UUID REFERENCES nonprofits(id),
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  budget_cents BIGINT NOT NULL,
  spent_cents BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (nonprofit_id, period_start),
  CHECK (spent_cents >= 0),
  CHECK (spent_cents <= budget_cents)
);

CREATE TYPE task_status AS ENUM (
  'open','locked','submitted','accepted','rejected','expired'
);
CREATE TYPE data_sensitivity AS ENUM ('public','internal','sensitive');

CREATE TABLE tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nonprofit_id UUID REFERENCES nonprofits(id),
  title TEXT NOT NULL,
  spec JSONB NOT NULL,                  -- prompt template, input refs, output schema, acceptance criteria
  est_cost_cents BIGINT NOT NULL,
  max_cost_cents BIGINT NOT NULL,       -- hard cap reserved at checkout
  model TEXT NOT NULL,
  sensitivity data_sensitivity NOT NULL DEFAULT 'public',
  status task_status NOT NULL DEFAULT 'open',
  assigned_dev_id UUID REFERENCES devs(id),
  lock_expires_at TIMESTAMPTZ,
  actual_cost_cents BIGINT,
  result JSONB,
  created_at TIMESTAMPTZ DEFAULT now(),
  submitted_at TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ,
  CHECK (max_cost_cents >= est_cost_cents),
  CHECK (max_cost_cents > 0)
);

CREATE INDEX idx_tasks_open ON tasks (est_cost_cents) WHERE status = 'open';
CREATE INDEX idx_tasks_expiry ON tasks (lock_expires_at) WHERE status = 'locked';

-- Append-only audit trail. Source of truth for receipts. Never UPDATE or DELETE rows here.
CREATE TABLE ledger (
  id BIGSERIAL PRIMARY KEY,
  task_id UUID REFERENCES tasks(id),
  dev_id UUID REFERENCES devs(id),
  nonprofit_id UUID REFERENCES nonprofits(id),
  event_type TEXT NOT NULL,             -- checkout|submit|accept|reject|expire|release
  delta_cents BIGINT NOT NULL,          -- signed: + reserves/spends, - releases
  raw_usage JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

## Operations

All money is integer cents. The current period is `date_trunc('month', now())::date`. Every state-changing operation runs in a single transaction. The `dev_budgets` row is the serialization point — lock it `FOR UPDATE` before reading/writing budget so concurrent checkouts by the same dev can't both pass the budget check.

### `checkout_task(dev_id, task_id)`
Atomically: verify the task is `open`, verify the dev has `budget - reserved - spent >= task.max_cost_cents`, lock the task to the dev with a 10-minute expiry, reserve `max_cost_cents`, write a `checkout` ledger row.

Order inside the transaction:
1. `SELECT ... FOR UPDATE` the dev's current-period `dev_budgets` row.
2. Compute `available = budget_cents - reserved_cents - spent_cents`. If `available < task.max_cost_cents` → ROLLBACK, return **402**.
3. `UPDATE tasks SET status='locked', assigned_dev_id=$dev, lock_expires_at=now()+interval '10 minutes' WHERE id=$task AND status='open'`. If 0 rows affected → someone else claimed it → ROLLBACK, return **409**.
4. `UPDATE dev_budgets SET reserved_cents = reserved_cents + $max_cost`.
5. `INSERT INTO ledger (... 'checkout', +$max_cost)`.
6. COMMIT. Return the task spec + `lock_expires_at`.

If no `dev_budgets` row exists for the current period → return **402** (no budget configured). Do not auto-create budget rows.

### `submit_result(dev_id, task_id, result, actual_cost_cents, raw_usage)`
Atomically: verify the task is `locked` and assigned to this dev, record the result and actual cost, move the reservation to spend, write a `submit` ledger row.

1. `SELECT ... FOR UPDATE` the dev's current-period `dev_budgets` row.
2. `UPDATE tasks SET status='submitted', actual_cost_cents=$actual, result=$result, submitted_at=now() WHERE id=$task AND assigned_dev_id=$dev AND status='locked'`. If 0 rows → ROLLBACK, return **409** (not locked to you / already moved on).
3. Release the reservation and add the actual spend:
   `UPDATE dev_budgets SET reserved_cents = reserved_cents - $reserved_amount, spent_cents = spent_cents + $actual`
   where `$reserved_amount` is the `max_cost_cents` that was reserved at checkout (read it from the task row).
4. `INSERT INTO ledger (... 'submit', delta = $actual - $reserved_amount, raw_usage=$usage)`.
5. COMMIT.

**Edge case to get right**: `actual_cost_cents` should normally be `<= max_cost_cents` (the runner aborts if it would exceed). But guard anyway: if `actual > reserved`, the net delta is positive and the CHECK constraint must still hold. If honoring the actual would violate `reserved + spent <= budget`, clamp `spent` increment to `max_cost_cents` and log the overage in `raw_usage` with a flag — never let the transaction fail the CHECK. Document this decision in a comment.

### `release_task(dev_id, task_id)`
Voluntarily abandon a locked task without submitting. Returns the task to the pool and frees the reservation.

1. `SELECT ... FOR UPDATE` the dev's budget row.
2. `UPDATE tasks SET status='open', assigned_dev_id=NULL, lock_expires_at=NULL WHERE id=$task AND assigned_dev_id=$dev AND status='locked'`. If 0 rows → ROLLBACK, return **409**.
3. `UPDATE dev_budgets SET reserved_cents = reserved_cents - $max_cost`.
4. `INSERT INTO ledger (... 'release', -$max_cost)`.
5. COMMIT.

### `expire()` — background sweep
Run on a timer (every 60s in prod; in Stage 1 expose it as a callable endpoint `POST /admin/expire` so tests can trigger it deterministically). Returns all expired locked tasks to the pool and frees their reservations in one transaction.

```sql
WITH expired AS (
  UPDATE tasks
    SET status='open', assigned_dev_id=NULL, lock_expires_at=NULL
    WHERE status='locked' AND lock_expires_at < now()
    RETURNING id, assigned_dev_id, max_cost_cents
)
UPDATE dev_budgets db
  SET reserved_cents = reserved_cents - e.max_cost_cents
  FROM expired e
  WHERE db.dev_id = e.assigned_dev_id
    AND db.period = date_trunc('month', now())::date;
```
Also insert one `expire` ledger row per expired task (`-max_cost_cents`). Note the reservation was made in the checkout's period; in Stage 1 assume lock and expiry fall in the same month and free from the current period. Leave a `// STAGE 2:` comment for the cross-month edge case.

### Read endpoints
- `GET /budget?dev_id=` → `{ budget_cents, reserved_cents, spent_cents, available_cents }` for the current period.
- `GET /tasks/open?max_cost_cents=&sensitivity=&limit=` → open tasks the caller could afford, ordered oldest-first. `max_cost_cents` filters to tasks whose `max_cost_cents <= ` the value. Default `limit` 10.

### Admin/seed helpers
Minimal unauthenticated endpoints (or a seed script) to create test fixtures:
- `POST /admin/devs`, `POST /admin/nonprofits`
- `POST /admin/tasks`
- `POST /admin/budgets` (set/replace a dev's budget for the current period)
- `POST /admin/tasks/:id/accept` and `/reject` (nonprofit-side review: `accepted` sets `accepted_at`; `rejected` returns the task to `open` and — Stage 1 decision — does NOT refund, since the dev already spent the cost; log a `reject` ledger row with `delta=0`. Leave a `// STAGE 2:` note about whether rejection should ever refund.)

## HTTP surface summary

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
POST /admin/budgets       { dev_id, budget_cents }   -- current period
POST /admin/tasks/:id/accept
POST /admin/tasks/:id/reject
```

Errors: `402` insufficient/no budget, `409` task-state conflict, `404` unknown id, `400` bad input. JSON bodies, JSON responses.

## Acceptance criteria

The build is done when all of these pass as automated tests against a real Postgres:

1. **Happy path**: seed dev with $20 budget, nonprofit, one $5-max task. Checkout → budget shows reserved 500, available 1500. Submit with actual 380 → reserved 0, spent 380, available 1620. Task status `submitted`. Ledger has `checkout +500` then `submit -120`.
2. **Budget gate**: dev with $4 budget cannot checkout a $5-max task → 402, no task or budget mutation, no ledger row.
3. **No budget row**: checkout for a dev with no current-period budget → 402.
4. **Double-checkout race**: two concurrent `checkout` calls for the same open task → exactly one 200, one 409. Task locked once. Reserved reflects one reservation only. (Test with two real concurrent transactions, not serialized calls.)
5. **Same-dev concurrent spend**: dev with $5 budget, two $5-max tasks, two concurrent checkouts → exactly one succeeds, one 402. (This is the `FOR UPDATE` test — without the row lock both would pass.)
6. **Expiry**: checkout a task, force `lock_expires_at` into the past, call `/admin/expire` → task back to `open`, reservation freed, `expire` ledger row written.
7. **Release**: checkout then release → task `open`, reservation freed, `release` ledger row.
8. **Submit on unlocked task**: submit a task not locked to you → 409, no mutation.
9. **Actual exceeds reservation**: submit with `actual_cost_cents > max_cost_cents` → spend clamped, CHECK constraint never violated, overage flagged in ledger `raw_usage`.
10. **Invariant fuzz**: run 100 randomized checkout/submit/release/expire operations across a few devs and tasks; after every operation assert `reserved + spent <= budget` holds for every dev_budgets row and that the sum of ledger deltas per dev equals `reserved + spent`.

Criterion 10 is the one that matters most. If the ledger and the budget rows ever disagree, the receipts will be wrong, and wrong receipts are worse than no product.

## Project layout (suggested)

```
givework/
  migrations/001_init.sql
  src/
    db.ts            # pg pool, query helpers, withTransaction()
    operations.ts    # checkout / submit / release / expire / reads — the core logic
    server.ts        # HTTP routes -> operations
    admin.ts         # seed/admin routes
  test/
    operations.test.ts
    concurrency.test.ts
    invariant.test.ts
  scripts/
    migrate.ts
    seed-demo.ts     # creates a dev, a nonprofit, a few tasks for manual curl-ing
  .env.example       # DATABASE_URL=
  package.json
  README.md          # how to run migrate, test, and the demo curl sequence
```

## Notes for the agent
- Prefer one well-factored `withTransaction(async (client) => { ... })` helper over scattering BEGIN/COMMIT. Every state-changing operation uses it.
- Do not catch-and-swallow transaction errors. Let them roll back and surface as 5xx, except the expected 402/409 cases which you detect explicitly and return cleanly.
- Keep `operations.ts` free of HTTP concerns so the same functions can be wrapped by an MCP server in Stage 2 without refactoring.
- Write the README's manual `curl` walkthrough to mirror acceptance criterion 1 — it's the demo you'll actually run first.
- When in doubt about scope, build less and leave a `// STAGE 2:` marker.
