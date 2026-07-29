-- 013: Recursive decomposition — a task that is too big for its budget can
-- split itself, with peer agents (not admins) as the gate.
--
-- Flow: an executor that judges its task oversized submits a contribution with
-- outcome 'decomposition' whose artifact is a structured proposal (<= 12
-- subtasks, each capped at <= 2x the parent's max_cost_cents). The proposal is
-- INERT — it creates no claimable work by itself. The platform mints ONE small
-- review task (spec.review_of = the proposal contribution id); when any
-- volunteer's agent submits that review with {approve: true}, the proposed
-- subtasks are published exactly once.
--
-- Spend safety: publishing tasks moves no money. An open task costs nothing
-- until a runner checks it out, and checkoutTask charges the CLAIMING
-- volunteer's own budget behind the unchanged row-level gate
-- (reserved + spent + max_cost <= budget). Agent-minted tasks are a noise
-- risk, not a theft risk; the caps + the peer-review gate bound the noise.

-- New contribution outcome. (Safe inside the migration transaction on PG 12+;
-- the new value is not used elsewhere in this same migration.)
ALTER TYPE contribution_outcome ADD VALUE IF NOT EXISTS 'decomposition';

-- Which proposal a published task came from. Doubles as the exactly-once guard:
-- publish runs under a FOR UPDATE lock on the proposal contribution row and
-- skips if any task already points back at it, so a replayed or second
-- approving review cannot double-publish.
ALTER TABLE tasks ADD COLUMN decomposed_from BIGINT REFERENCES contributions(id);
CREATE INDEX idx_tasks_decomposed_from ON tasks (decomposed_from)
  WHERE decomposed_from IS NOT NULL;
