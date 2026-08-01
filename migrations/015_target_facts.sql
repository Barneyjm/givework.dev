-- 015: Established facts get their own append-only table.
--
-- WHY. `targets.state` is a single JSONB blob that submitResult REPLACED
-- wholesale (`UPDATE targets SET state = $2`). Three consequences, all of which
-- showed up on firstproof-c4:
--
--   1. An agent adding one fact had to reconstruct the entire working set or
--      clobber it, so what was already established could be lost by any submit.
--   2. Debris became sticky. A note about one attempt's formatting failure, and
--      an auto-written salvage from a timed-out run, were copied forward by
--      every later agent — because dropping a key it did not understand was
--      indistinguishable from destroying a real result.
--   3. The 64 KB cap truncated by keeping the TAIL, so the first thing dropped
--      as state grew was the accumulated head: the established facts.
--
-- Facts are the part that must never be lost or rewritten, so they move out of
-- the blob and into rows: append-only, provenance-carrying, and unbounded by
-- the blob cap. `state` keeps its job of holding the *mutable* working set
-- (cursors, current phase, scratch), which is now merged per key rather than
-- replaced (see mergeStateUpdate).
--
-- Append-only, with retraction rather than deletion: a fact recorded in error
-- is superseded on the record, never erased, so the history of what was
-- believed stays auditable. Same principle as the ledger.

CREATE TABLE target_facts (
  id BIGSERIAL PRIMARY KEY,
  target_id UUID NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  -- The claim, in the agent's own words. Prose on purpose: what counts as a
  -- fact about an open conjecture is not enumerable in advance.
  claim TEXT NOT NULL,
  -- The contribution that established it. Nullable because an admin may seed a
  -- fact when curating a target, before any volunteer has worked it.
  established_by BIGINT REFERENCES contributions(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Superseded, not deleted. Set when a later contribution shows the claim was
  -- wrong; the row stays and stops counting as current.
  retracted_at TIMESTAMPTZ,
  retracted_reason TEXT,
  CHECK (length(claim) > 0)
);

-- The feed reads one target's facts oldest-first; the id tiebreak keeps that
-- order total (created_at alone ties when several land in one transaction).
CREATE INDEX idx_target_facts_target ON target_facts (target_id, id);

-- Idempotence. A replayed submit, or two agents independently establishing the
-- same thing, must not stack duplicate rows. md5 rather than the raw claim so
-- the index stays small regardless of how long a claim runs.
CREATE UNIQUE INDEX uq_target_facts_claim ON target_facts (target_id, md5(claim));
