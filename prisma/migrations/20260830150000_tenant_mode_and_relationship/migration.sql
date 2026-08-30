-- Tenant mode, and the relationship facts the console could not show.
--
-- mode is the switch a voice product needs above every dial path. Until now
-- nothing distinguished a sales demo workspace from a live clinic, so the only
-- thing standing between a demo and a real patient's phone ringing was whoever
-- was clicking. 'demo' refuses live calling outright; 'pilot' and 'production'
-- both allow it and differ in whether operation is attended.
--
-- Default 'pilot' rather than 'demo': every workspace that exists today belongs
-- to a real clinic, and defaulting to 'demo' would silently stop their calls.
ALTER TABLE "Tenant"
  ADD COLUMN IF NOT EXISTS "mode" TEXT NOT NULL DEFAULT 'pilot',
  ADD COLUMN IF NOT EXISTS "contractStartedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "accountManager" TEXT,
  ADD COLUMN IF NOT EXISTS "baaSignedAt" TIMESTAMP(3);

ALTER TABLE "Tenant"
  DROP CONSTRAINT IF EXISTS "Tenant_mode_check";
ALTER TABLE "Tenant"
  ADD CONSTRAINT "Tenant_mode_check" CHECK ("mode" IN ('demo', 'pilot', 'production'));
