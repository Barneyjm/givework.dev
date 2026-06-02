-- Givework Stage 1 — initial schema.
-- All money is integer cents (BIGINT). Never floats.
-- The dev_budgets row is the serialization point for budget accounting; every
-- state-changing operation locks it FOR UPDATE before touching budget.

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
