-- 010: Verification core.
--
-- Replaces the subjective accept/reject with a recorded verification step. Every
-- verification attempt (machine or human) writes a row here; the winning one can
-- flip a target to 'resolved'/'disproven'. Phase 5 wires the two methods that
-- need no external toolchain: `auto_rerun` (re-evaluate a counterexample witness
-- with a built-in checker) and `human_review` (an admin's accept/reject).
-- `proof_checker` and `replication` land in Phase 6.

CREATE TABLE verifications (
  id              BIGSERIAL PRIMARY KEY,
  task_id         UUID NOT NULL REFERENCES tasks(id),
  contribution_id BIGINT REFERENCES contributions(id),
  target_id       UUID REFERENCES targets(id),
  method          verification_method NOT NULL,
  verdict         TEXT NOT NULL,          -- 'passed' | 'failed' | 'inconclusive' | 'pending'
  detail          JSONB,                  -- checker output, witness, reviewer note
  verifier        TEXT,                   -- 'platform' | 'admin' | a dev_id
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_verifications_task ON verifications (task_id, id DESC);

-- Named built-in checker for auto_rerun (e.g. 'euler_sum_of_powers'); NULL means
-- the target has no automatic checker, so a candidate falls to human review.
ALTER TABLE targets ADD COLUMN checker TEXT;
