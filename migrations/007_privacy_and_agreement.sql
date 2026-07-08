-- Stage: privacy guardrails + volunteer agreement.
--
-- intake_requests gains screening columns, written when a request is received:
--   phi_flagged — the health-context heuristic tripped (likely PHI). Publishing
--                 is blocked until an admin explicitly acknowledges the flag
--                 after review (acknowledge_phi on POST /admin/intake/:id/publish).
--   phi_signals — the matched terms, so the reviewer can see why it tripped.
--   redactions  — the PII redaction map [{token, kind, value}] built from the
--                 raw request. Tokens (never values) flow into task specs; the
--                 map stays on the control plane and is only re-applied when
--                 results are delivered back to the data owner (the nonprofit).
--
-- devs gains the volunteer-agreement record. Non-public checkout requires
-- verified AND a current signed agreement (enforced in operations.ts):
-- `verified` answers "is this a real, accountable person" (GitHub identity),
-- the agreement answers "have they committed to how donated data is handled".
-- They are independent preconditions — auto-verify (oauth.ts) can never skip
-- the agreement, and a new agreement version re-gates everyone until re-signed.
ALTER TABLE intake_requests ADD COLUMN phi_flagged BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE intake_requests ADD COLUMN phi_signals JSONB;
ALTER TABLE intake_requests ADD COLUMN redactions JSONB;

ALTER TABLE devs ADD COLUMN agreement_version TEXT;
ALTER TABLE devs ADD COLUMN agreement_signed_at TIMESTAMPTZ;
