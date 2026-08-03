-- 016: Indexes for the reads the state-governor work added.
--
-- Both back queries that now run on hot paths — one on every conjecture page
-- view, one inside the checkout transaction on the money path — and neither had
-- an index behind it.

-- deriveNextSteps scans every task on a target on every page view, and
-- getTargetProgress's metrics block does four more counts keyed the same way.
-- Without this they are sequential scans of `tasks`, which grows without bound.
CREATE INDEX IF NOT EXISTS idx_tasks_target_status ON tasks (target_id, status);

-- pendingDecompositionSql resolves a review task from the proposal contribution
-- it reviews, and `review_of` lives inside the spec JSONB. Unindexed, each
-- decomposition contribution on the task costs a full scan of `tasks` — and
-- firstproof-c4 alone has eight. Partial + expression index so it stays small:
-- only review tasks carry the key at all.
--
-- (The honest fix is a real `review_of_contribution_id` column with a foreign
-- key, which would make this an indexable join instead of a JSONB probe. That
-- is a larger migration touching the eight sites that read spec.review_of, and
-- is deliberately left for its own change.)
CREATE INDEX IF NOT EXISTS idx_tasks_review_of
  ON tasks (((spec->>'review_of')::bigint))
  WHERE spec ? 'review_of';
