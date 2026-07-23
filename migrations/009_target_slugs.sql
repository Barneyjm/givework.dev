-- 009: Human-readable slugs for public target pages.
--
-- Conjectures carry no PII, so a conjecture's progress page is keyed by a
-- readable, shareable slug (e.g. "collatz") — not the unguessable UUID the
-- nonprofit request-status page uses. Also relax contact_email: it is
-- org-specific (dormant during the math phase) and a conjecture has none.

ALTER TABLE targets ADD COLUMN slug TEXT;

-- Slugs are unique when present; NULL slugs (org targets, unslugged rows) don't collide.
CREATE UNIQUE INDEX targets_slug_key ON targets (slug) WHERE slug IS NOT NULL;

ALTER TABLE targets ALTER COLUMN contact_email DROP NOT NULL;
