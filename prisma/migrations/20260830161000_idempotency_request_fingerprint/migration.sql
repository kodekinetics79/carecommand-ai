-- Bind an idempotency key to the request it first served.
--
-- Replaying a stored response is only safe while the request is the same one.
-- A key reused with a different payload is a client bug - a changed CSV sent
-- under the previous key, say - and answering it with the earlier receipt would
-- hide that, reporting an import that did not happen for the rows now being
-- sent. Such a request is refused as a conflict instead.
ALTER TABLE "IdempotencyKey"
  ADD COLUMN IF NOT EXISTS "fingerprint" TEXT;
