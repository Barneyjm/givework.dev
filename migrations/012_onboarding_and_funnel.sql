-- 012: Guided onboarding + funnel instrumentation.
--
-- Two additions that answer one question: does a new contributor ever actually
-- submit anything? Today we cannot say, because nothing between "signed in" and
-- "donated compute" is recorded.
--
--   * funnel_events — an append-only log of the handful of moments that make up
--     the signup funnel (dev created, budget set, checkout, submit, onboarding
--     minted). Deliberately separate from `ledger`: the ledger is money and is
--     load-bearing for accounting, so it must never carry rows whose only job is
--     analytics, and an analytics write must never be able to fail a payment
--     path. Writes here are swallowed on failure (see src/funnel.ts).
--
--   * targets.sweep_cursor — the allocation cursor for range-sweep work. Each
--     onboarding mint advances it by one block under a row lock, so two
--     newcomers can never be handed the same ground. It is a dedicated column
--     rather than a key inside targets.state on purpose: `state` is the agent-
--     writable compacted working set and submitResult replaces it wholesale, so
--     a cursor living there would be silently clobbered by an ordinary submit.
--
--   * tasks.onboarding_dev_id — the task belongs to exactly one dev. A pooled
--     onboarding task would be claimed once and then be unavailable to every
--     other newcomer, so onboarding work is minted per-dev and hidden from the
--     shared pool. The UNIQUE index is what makes minting idempotent: asking
--     twice can never produce two tasks (and never two ranges).

CREATE TABLE funnel_events (
  id         BIGSERIAL PRIMARY KEY,
  dev_id     UUID REFERENCES devs(id),
  event      TEXT NOT NULL,   -- dev_created | budget_set | checkout | submit | onboarding_minted
  detail     JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The report counts distinct devs per event and "how many events did this dev
-- have" (one-and-done vs repeat), so (event, dev_id) is the useful order.
CREATE INDEX idx_funnel_events_event_dev ON funnel_events (event, dev_id);
CREATE INDEX idx_funnel_events_created ON funnel_events (created_at);

ALTER TABLE targets ADD COLUMN sweep_cursor BIGINT;

-- Goldbach is the onboarding target: it already has a deterministic checker, a
-- sweep needs no prior context, and a clean sweep is a real (and expected)
-- result rather than a failure. Start the cursor at the first even number the
-- conjecture speaks about. COALESCEd in code too, so an unseeded row still works.
UPDATE targets SET sweep_cursor = 4 WHERE slug = 'goldbach' AND sweep_cursor IS NULL;

ALTER TABLE tasks ADD COLUMN onboarding_dev_id UUID REFERENCES devs(id);

-- One onboarding task per dev, ever. This is the idempotency guarantee, enforced
-- by the database rather than by a read-then-write race in application code.
CREATE UNIQUE INDEX tasks_onboarding_dev_key ON tasks (onboarding_dev_id)
  WHERE onboarding_dev_id IS NOT NULL;
