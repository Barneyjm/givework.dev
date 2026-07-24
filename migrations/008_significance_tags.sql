-- 008: Conjecture presentation fields.
--
--   * significance — a short plain-language blurb on why the problem matters,
--     shown on the public progress page under the statement.
--   * tags — coarse subject tags (e.g. number-theory, graph-theory) so the
--     public board can filter. A small controlled vocabulary maintained by the
--     seed scripts / admins, not free-form user input.

ALTER TABLE targets
  ADD COLUMN significance TEXT,
  ADD COLUMN tags TEXT[] NOT NULL DEFAULT '{}';

-- The board filters by tag; a GIN index keeps that cheap if the list grows.
CREATE INDEX idx_targets_tags ON targets USING gin (tags);
