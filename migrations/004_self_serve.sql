-- Stage: self-serve developer onboarding (GitHub OAuth).
-- A dev can now sign in with GitHub and get a token without an admin. Two new
-- columns on devs support that:
--   github_id — the OAuth subject. Stable across handle renames, so it's the key
--               we upsert on. Nullable: admin-seeded / test devs predate it.
--   verified  — the trust gate. A self-registered dev starts unverified and may
--               only claim sensitivity='public' tasks; an admin flips this true
--               to unlock internal/sensitive work (enforced in operations.ts).

ALTER TABLE devs ADD COLUMN github_id BIGINT UNIQUE;
ALTER TABLE devs ADD COLUMN verified BOOLEAN NOT NULL DEFAULT false;
