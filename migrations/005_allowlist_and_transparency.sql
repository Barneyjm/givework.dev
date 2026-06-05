-- Stage: admin-managed allowlist + public transparency.
--
-- nonprofit_identifiers — many authorized senders per org, beyond the single
-- contact_email. An admin adds emails and whole domains; deny entries override
-- (block one address even when its domain is allowed). The allowlist gate in
-- src/intake/operations.ts unions these with the legacy contact_email match.
--   kind:  email | domain | email_deny | domain_deny
--   value: the address or bare domain, matched case-insensitively
CREATE TABLE nonprofit_identifiers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nonprofit_id UUID NOT NULL REFERENCES nonprofits(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('email', 'domain', 'email_deny', 'domain_deny')),
  value TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Allow identifiers (email/domain) are GLOBALLY unique per kind: two orgs must
-- not both claim the same address/domain, or a sender would match ambiguously.
CREATE UNIQUE INDEX nonprofit_identifiers_allow_kind_value
  ON nonprofit_identifiers (kind, lower(value))
  WHERE kind IN ('email', 'domain');

-- Deny identifiers are scoped to the owning org (the gate applies a deny only to
-- that org), so uniqueness is PER-ORG: different orgs may each block the same
-- address/domain for themselves, but one org can't list the same deny twice.
CREATE UNIQUE INDEX nonprofit_identifiers_deny_np_kind_value
  ON nonprofit_identifiers (nonprofit_id, kind, lower(value))
  WHERE kind IN ('email_deny', 'domain_deny');

CREATE INDEX nonprofit_identifiers_np ON nonprofit_identifiers (nonprofit_id);

-- Opt-in public listing. Only orgs explicitly marked `listed` appear on the
-- public /transparency endpoint — verification alone does not publish a partner.
ALTER TABLE nonprofits ADD COLUMN listed BOOLEAN NOT NULL DEFAULT false;
