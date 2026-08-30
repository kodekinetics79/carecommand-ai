-- Operator account self-service.
--
-- Two gaps this closes. A platform operator had no way to change their own
-- password from the console - the only path was a database write - so a
-- credential that had been shared or exposed could not be rotated by the person
-- who owned it. And MFA on the Control Tower was unconditional: correct as a
-- default, but it was hardcoded rather than owned by the platform owner, so
-- there was no way to run without it and no record of that decision.
--
-- requireOperatorMfa keeps the safe default (true) and makes it a policy the
-- owner can see and change, with the change audited like any other.
ALTER TABLE "PlatformUser"
  ADD COLUMN IF NOT EXISTS "sessionsRevokedAt" TIMESTAMP(3);

ALTER TABLE "PlatformConfig"
  ADD COLUMN IF NOT EXISTS "requireOperatorMfa" BOOLEAN NOT NULL DEFAULT true;
