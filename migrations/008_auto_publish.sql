-- Per-org fast track. An admin marks an established partner auto_publish=true
-- and its clean requests skip the manual review queue: receive → decompose →
-- publish in one motion. The automated screens still run on every request —
-- PII is redacted regardless, and a PHI-flagged request always stops for a
-- human no matter what this flag says. The gate in receiveIntake also requires
-- verified=true, so flipping this on a provisional org does nothing.
ALTER TABLE nonprofits ADD COLUMN auto_publish BOOLEAN NOT NULL DEFAULT false;
