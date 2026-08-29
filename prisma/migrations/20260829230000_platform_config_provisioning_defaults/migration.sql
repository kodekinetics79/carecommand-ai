-- Platform settings that actually do something.
--
-- Before this migration PlatformConfig carried four fields, two of which
-- (platformName, supportEmail) had no reader anywhere in the codebase and one
-- of which (defaultPlanKey) was unreachable because both provisioning forms
-- always sent an explicit planKey. The Control Tower's Platform Settings page
-- therefore saved successfully and changed nothing.
--
-- These columns are read at tenant provisioning. defaultTimezone /
-- defaultBranchName fill an omitted create-company field; defaultVoiceMinutes
-- seeds the tenant's voice quota; requireMfaFloor and sessionTimeoutMaxMinutes
-- seed TenantSecurityPolicy as a FLOOR the tenant may tighten but not loosen.
ALTER TABLE "PlatformConfig"
  ADD COLUMN IF NOT EXISTS "defaultTimezone" TEXT NOT NULL DEFAULT 'America/New_York',
  ADD COLUMN IF NOT EXISTS "defaultCountry" TEXT NOT NULL DEFAULT 'US',
  ADD COLUMN IF NOT EXISTS "defaultBranchName" TEXT NOT NULL DEFAULT 'Main Branch',
  ADD COLUMN IF NOT EXISTS "defaultVoiceMinutes" INTEGER NOT NULL DEFAULT 500,
  ADD COLUMN IF NOT EXISTS "requireMfaFloor" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "sessionTimeoutMaxMinutes" INTEGER NOT NULL DEFAULT 480,
  ADD COLUMN IF NOT EXISTS "presetKey" TEXT NOT NULL DEFAULT 'custom';
