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

-- One (kind, value) maps to at most one org, case-insensitively: two orgs can't
-- both claim the same domain, and re-adding the same identifier is a no-op.
CREATE UNIQUE INDEX nonprofit_identifiers_kind_value
  ON nonprofit_identifiers (kind, lower(value));
CREATE INDEX nonprofit_identifiers_np ON nonprofit_identifiers (nonprofit_id);

-- Opt-in public listing. Only orgs explicitly marked `listed` appear on the
-- public /transparency endpoint — verification alone does not publish a partner.
ALTER TABLE nonprofits ADD COLUMN listed BOOLEAN NOT NULL DEFAULT false;
