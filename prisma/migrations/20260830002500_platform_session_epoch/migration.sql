-- Exact session revocation for platform operators.
--
-- Revoking by timestamp cannot be exact: a JWT's `iat` has one-second
-- resolution, so a session minted in the same second as a password change is
-- indistinguishable from the replacement token issued by that same change. An
-- epoch counter has no such ambiguity - every token minted before the increment
-- stops verifying, and the one minted after it does not.
ALTER TABLE "PlatformUser"
  ADD COLUMN IF NOT EXISTS "sessionEpoch" INTEGER NOT NULL DEFAULT 0;
