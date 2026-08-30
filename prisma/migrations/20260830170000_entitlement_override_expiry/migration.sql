-- Give a platform entitlement override an end date and a reason.
--
-- An override granted for a pilot, a migration, or a goodwill gesture is almost
-- always meant to be temporary, and nothing expired it. A comp nobody revisits
-- becomes a permanent free feature - a pricing decision made by forgetting
-- rather than by anyone deciding.
--
-- Both nullable: existing overrides keep standing until an operator changes
-- them, which stays a legitimate choice. The point is that it becomes a choice.
ALTER TABLE "TenantFeatureEntitlement"
  ADD COLUMN IF NOT EXISTS "overrideExpiresAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "overrideReason" TEXT;
