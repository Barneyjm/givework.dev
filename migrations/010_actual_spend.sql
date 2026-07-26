-- Record what a contribution actually cost, instead of what we wished it cost.
--
-- The old invariant, reserved + spent <= budget, was enforced as a CHECK across
-- BOTH columns. But those columns answer different questions:
--
--   reserved  -- authorization: work a volunteer has committed to. Forward
--                looking, and genuinely preventable at checkout.
--   spent     -- accounting: money already gone from the volunteer's own
--                subscription by the time the runner reports it.
--
-- A constraint cannot veto the past. When a task came in slightly over its cap,
-- booking the true number would fail the CHECK and abort the whole submit --
-- destroying completed work -- so submitResult clamped the spend instead. That
-- never refunded anyone a cent; it just made the ledger, the contributor
-- leaderboard, and every "compute donated" total understate what volunteers
-- actually gave.
--
-- The real guard is unchanged and lives where it can still act: checkoutTask
-- takes a row lock and refuses to hand out a task unless
-- reserved + spent + max_cost <= budget. Nothing can be STARTED beyond budget.
-- If a finished task overshoots, spent may now exceed budget by that overage,
-- available goes negative, and the next checkout is refused -- self-correcting,
-- and honest about what was donated.
ALTER TABLE dev_budgets DROP CONSTRAINT IF EXISTS dev_budgets_check2;
ALTER TABLE dev_budgets DROP CONSTRAINT IF EXISTS dev_budgets_check1;
ALTER TABLE dev_budgets DROP CONSTRAINT IF EXISTS dev_budgets_check;

-- Keep the parts that are still true at all times.
ALTER TABLE dev_budgets ADD CONSTRAINT dev_budgets_reserved_nonneg CHECK (reserved_cents >= 0);
ALTER TABLE dev_budgets ADD CONSTRAINT dev_budgets_spent_nonneg CHECK (spent_cents >= 0);
