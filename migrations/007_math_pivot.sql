-- 007: Math pivot — the whole domain shift in one migration.
--
-- Consolidates the pivot's schema changes (generic targets, resumable tasks +
-- contributions, public slugs, and the verification core). Migrations 001–006 are
-- the pre-pivot, already-deployed history and are left untouched; everything the
-- pivot adds lives here. See PIVOT.md for the design.
--
-- Summary:
--   * nonprofits -> generic, kind-tagged `targets` (a conjecture today; a research
--     question or vetted org later). Vetting columns kept but dormant.
--   * tasks gain a correctness axis (kind + verify_via) replacing the PII one.
--   * `contributions`: append-only per-chunk log for resumable, accumulating tasks.
--   * `verifications`: recorded accept/reject; auto_rerun can flip a target.
--   * public, shareable slugs for conjecture progress pages.

-- Enums ----------------------------------------------------------------------
CREATE TYPE target_kind AS ENUM ('conjecture', 'research_question', 'org_request');
CREATE TYPE target_status AS ENUM
  ('open', 'partially_resolved', 'resolved', 'disproven', 'closed');
CREATE TYPE task_kind AS ENUM
  ('computational', 'counterexample_search', 'formalization', 'lemma', 'exploration');
CREATE TYPE verification_method AS ENUM
  ('auto_rerun', 'proof_checker', 'replication', 'human_review');
CREATE TYPE contribution_outcome AS ENUM ('progress', 'dead_end', 'candidate_solution');

-- The beneficiary entity: nonprofits -> targets ------------------------------
ALTER TABLE nonprofits RENAME TO targets;

ALTER TABLE targets
  ADD COLUMN kind             target_kind   NOT NULL DEFAULT 'conjecture',
  ADD COLUMN status           target_status NOT NULL DEFAULT 'open',
  ADD COLUMN statement_plain  TEXT,                       -- plain-language statement
  ADD COLUMN statement_formal TEXT,                       -- optional LaTeX / Lean signature
  ADD COLUMN source_ref       TEXT,                       -- OEIS id, arXiv, "Erdos #N", DOI…
  ADD COLUMN state            JSONB NOT NULL DEFAULT '{}'::jsonb,  -- compacted working set
  ADD COLUMN resolved_by      BIGINT,                     -- winning contribution id (FK added below)
  ADD COLUMN slug             TEXT,                       -- public, shareable handle (e.g. "collatz")
  ADD COLUMN checker          TEXT;                       -- named built-in auto_rerun checker

-- contact_email is org-specific (dormant during the math phase); a conjecture has none.
ALTER TABLE targets ALTER COLUMN contact_email DROP NOT NULL;

-- Slugs are unique when present; NULL slugs (org targets, unreviewed submissions) don't collide.
CREATE UNIQUE INDEX targets_slug_key ON targets (slug) WHERE slug IS NOT NULL;

-- Per-target compute cap + allowlist follow the rename -----------------------
ALTER TABLE nonprofit_budgets RENAME TO target_budgets;
ALTER TABLE target_budgets RENAME COLUMN nonprofit_id TO target_id;

ALTER TABLE nonprofit_identifiers RENAME TO target_identifiers;
ALTER TABLE target_identifiers RENAME COLUMN nonprofit_id TO target_id;
ALTER INDEX nonprofit_identifiers_allow_kind_value RENAME TO target_identifiers_allow_kind_value;
ALTER INDEX nonprofit_identifiers_deny_np_kind_value RENAME TO target_identifiers_deny_kind_value;
ALTER INDEX nonprofit_identifiers_np RENAME TO target_identifiers_target;

-- FKs into the renamed entity, from tasks / ledger / intake ------------------
ALTER TABLE tasks RENAME COLUMN nonprofit_id TO target_id;
ALTER TABLE ledger RENAME COLUMN nonprofit_id TO target_id;
ALTER TABLE intake_requests RENAME COLUMN nonprofit_id TO target_id;

-- Correctness axis on tasks. The old PII `sensitivity` column stays (dormant).
-- Defaults reproduce today's behaviour: unclassified work is 'exploration' judged
-- by 'human_review' (the current subjective admin accept/reject).
ALTER TABLE tasks
  ADD COLUMN kind       task_kind           NOT NULL DEFAULT 'exploration',
  ADD COLUMN verify_via verification_method NOT NULL DEFAULT 'human_review';

-- Resumable, accumulating tasks: the append-only per-chunk log ----------------
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
CREATE INDEX idx_contributions_task ON contributions (task_id, id DESC);

-- Now that contributions exists, wire the winning-contribution FK.
ALTER TABLE targets
  ADD CONSTRAINT targets_resolved_by_fkey
  FOREIGN KEY (resolved_by) REFERENCES contributions(id);

-- Verification core: every accept/reject attempt is recorded here ------------
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
