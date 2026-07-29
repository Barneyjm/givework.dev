-- 014: Decomposition depth bookkeeping.
--
-- Ordinary published subtasks may themselves submit decomposition proposals
-- (only review tasks are blocked — spec.review_of), so towers can form. There
-- is deliberately NO hard depth cap for now: every level has to pass its own
-- peer review, which is the damper. But depth must be visible in the data —
-- each published subtask records its parent's depth + 1, and the review task's
-- prompt tells the reviewer "this is a depth-N proposal" so deep towers get
-- extra scrutiny where the judgment happens.
ALTER TABLE tasks ADD COLUMN decomposition_depth INT NOT NULL DEFAULT 0;
