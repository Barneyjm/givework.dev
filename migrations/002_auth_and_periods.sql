-- Stage 2: track which accounting period a checkout reserved budget against, so
-- submit / release / expire free the reservation from the *original* period even
-- when the lock straddles a month boundary (checked out in May, expires in June).
-- NULL means "treat as the current period" — preserves Stage 1 behaviour for any
-- rows created before this column existed.

ALTER TABLE tasks ADD COLUMN reserved_period DATE;

-- Auth is stateless (HS256 JWTs signed with JWT_SECRET) — no token table needed.
