-- 007: Generic targets.
--
-- Pivot the beneficiary entity from `nonprofits` to a generic, kind-tagged
-- `targets` — a math conjecture today, a research question or a vetted
-- organization later. This migration is a structural rename + additive columns
-- only: no behaviour changes. Defaults are chosen so every existing code path
-- keeps working unchanged.
--
-- The nonprofit vetting surface (targets.verified / contact_email / ein / listed
-- and the identifier allowlist) is KEPT but dormant — it is re-activated when the
-- platform grows back into vetted-organization work. See PIVOT.md.

-- New enums ------------------------------------------------------------------
CREATE TYPE target_kind AS ENUM ('conjecture', 'research_question', 'org_request');
CREATE TYPE target_status AS ENUM
  ('open', 'partially_resolved', 'resolved', 'disproven', 'closed');
CREATE TYPE task_kind AS ENUM
  ('computational', 'counterexample_search', 'formalization', 'lemma', 'exploration');
CREATE TYPE verification_method AS ENUM
  ('auto_rerun', 'proof_checker', 'replication', 'human_review');

-- The beneficiary entity: nonprofits -> targets ------------------------------
ALTER TABLE nonprofits RENAME TO targets;

ALTER TABLE targets
  ADD COLUMN kind             target_kind   NOT NULL DEFAULT 'conjecture',
  ADD COLUMN status           target_status NOT NULL DEFAULT 'open',
  ADD COLUMN statement_plain  TEXT,                       -- plain-language statement
  ADD COLUMN statement_formal TEXT,                       -- optional LaTeX / Lean signature
  ADD COLUMN source_ref       TEXT,                       -- OEIS id, arXiv, "Erdos #N", DOI…
  ADD COLUMN state            JSONB NOT NULL DEFAULT '{}'::jsonb,  -- compacted working set
  ADD COLUMN resolved_by      BIGINT;                     -- winning contribution id (Phase 3 table)

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

-- Correctness axis on tasks. This will eventually drive verification; the old
-- PII `sensitivity` column stays for now (dormant). The defaults reproduce
-- today's behaviour exactly — unclassified work is 'exploration' judged by
-- 'human_review', i.e. the current subjective admin accept/reject.
ALTER TABLE tasks
  ADD COLUMN kind       task_kind           NOT NULL DEFAULT 'exploration',
  ADD COLUMN verify_via verification_method NOT NULL DEFAULT 'human_review';
