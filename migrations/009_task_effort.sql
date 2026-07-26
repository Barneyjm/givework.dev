-- Tasks declare how much *thinking* they need, not which model to use.
--
-- Naming a concrete model in the task row was wrong three ways: it promises a
-- model the volunteer's plan may not include, it goes stale every time a new
-- model ships, and it presumes Claude — the same task should be workable by any
-- harness a volunteer runs (claude -p, codex, a local model). What the platform
-- actually knows is whether a task needs careful reasoning or is mechanical.
-- Resolving that to a concrete model is the runner's business, on the runner's
-- machine, against the runner's own plan.
CREATE TYPE task_effort AS ENUM ('low', 'medium', 'high');

ALTER TABLE tasks ADD COLUMN effort task_effort NOT NULL DEFAULT 'medium';

-- Backfill from the model string we used to hard-code.
UPDATE tasks SET effort = 'high'   WHERE model LIKE '%opus%';
UPDATE tasks SET effort = 'medium' WHERE model LIKE '%sonnet%';
UPDATE tasks SET effort = 'low'    WHERE model LIKE '%haiku%';

-- `model` stays for now: it is still the honest record of what a *completed*
-- task actually ran on, and existing rows/tests read it. New tasks may leave it
-- at the sentinel below; the runner overrides it with whatever it really used.
ALTER TABLE tasks ALTER COLUMN model SET DEFAULT 'by-effort';

-- Work units execute sandboxed code and never call a model at all.
UPDATE tasks SET effort = 'low' WHERE spec ? 'code';
