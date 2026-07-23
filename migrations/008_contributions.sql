-- 008: Contributions — resumable, accumulating tasks.
--
-- A bounded per-checkout budget only buys a small chunk of work, so a hard task
-- must be chipped by many volunteers over time. This migration makes a task
-- long-lived: each checkout appends a `contributions` row (the append-only log of
-- what has been tried — progress AND dead ends), and a 'progress'/'dead_end'
-- contribution returns the task to the pool for the next agent instead of
-- finishing it. The compacted working set lives in targets.state (added in 007)
-- and is refreshed by each contribution's optional state_update. See PIVOT.md.

CREATE TYPE contribution_outcome AS ENUM ('progress', 'dead_end', 'candidate_solution');

CREATE TABLE contributions (
  id           BIGSERIAL PRIMARY KEY,
  task_id      UUID NOT NULL REFERENCES tasks(id),
  target_id    UUID REFERENCES targets(id),
  dev_id       UUID REFERENCES devs(id),
  outcome      contribution_outcome NOT NULL,
  summary      TEXT NOT NULL DEFAULT '',   -- the agent's handoff note for the next one
  artifact_uri TEXT,                        -- large output (code, Lean file) in blob storage
  artifact     JSONB,                       -- small inline output (a lemma, an extended range)
  cost_cents   BIGINT NOT NULL DEFAULT 0,   -- donated compute booked for this chunk
  raw_usage    JSONB,
  created_at   TIMESTAMPTZ DEFAULT now()
);

-- Newest-first lookup per task, for hydrating an incoming agent's context.
CREATE INDEX idx_contributions_task ON contributions (task_id, id DESC);

-- The winning contribution that resolved a target (set at verification, Phase 5).
-- targets.resolved_by was added as a bare BIGINT in 007; wire the FK now that the
-- contributions table exists.
ALTER TABLE targets
  ADD CONSTRAINT targets_resolved_by_fkey
  FOREIGN KEY (resolved_by) REFERENCES contributions(id);
