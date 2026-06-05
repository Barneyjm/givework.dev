-- Stage: completion-notification idempotency.
--
-- When accepting a task completes a whole intake request, the admin route emails
-- the nonprofit once. Two near-simultaneous accepts of the final tasks could both
-- observe "all accepted" and double-send, so we claim the notification atomically:
-- completedRequestForTask flips this column from NULL in a single UPDATE, and only
-- the winner returns a row to email.
ALTER TABLE intake_requests ADD COLUMN completed_notified_at TIMESTAMPTZ;
