-- Stage 4: intake & decomposition. The top of the funnel — a nonprofit emails a
-- plain-language need; the platform decomposes it into structured tasks. Intake
-- sits upstream of the ledger core and ultimately produces normal `tasks` rows.

-- One inbound request (an "email" to intake@givework.dev). The decomposer's draft
-- of proposed tasks lives in `proposed` until an admin reviews and publishes.
CREATE TABLE intake_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_email TEXT NOT NULL,
  subject TEXT,
  raw_body TEXT NOT NULL,
  nonprofit_id UUID REFERENCES nonprofits(id),   -- provisional org, find-or-created on receive
  status TEXT NOT NULL DEFAULT 'received',        -- received -> decomposed -> published -> closed/rejected
  proposed JSONB,                                 -- ProposedTask[] drafted by the decomposer
  triaged_by TEXT,                                -- provenance of the decomposition ('ai', later a dev/ops id)
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_intake_status ON intake_requests (status, created_at);

CREATE TABLE intake_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  intake_request_id UUID NOT NULL REFERENCES intake_requests(id),
  uri TEXT NOT NULL,
  filename TEXT,
  content_type TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Provenance: which intake request and decomposer produced a published task.
ALTER TABLE tasks
  ADD COLUMN intake_request_id UUID REFERENCES intake_requests(id),
  ADD COLUMN authored_by TEXT;
