-- Let an idempotent request replay what the caller was actually told.
--
-- IdempotencyKey could record that a key had been used and point at a resulting
-- row, which is not enough to answer a repeat: by the time the repeat arrives
-- the row may have changed, and re-reading it returns something the caller was
-- never given. Storing the first completed response makes a replay honest.
--
-- Additive and nullable: existing rows replay nothing and behave exactly as
-- before.
ALTER TABLE "IdempotencyKey"
  ADD COLUMN IF NOT EXISTS "response" JSONB;
