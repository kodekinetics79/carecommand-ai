-- Make a platform entitlement override durable.
--
-- recomputeEntitlements() rewrote every feature row from the plan on every
-- plan change, add-on edit, suspend, reactivate and archive - including rows an
-- operator had explicitly overridden. The Control Tower told the operator the
-- opposite ("changing the plan re-derives any non-overridden features"), so a
-- granted pilot feature disappeared silently at the next commercial action.
--
-- `enabled` stays the resolved answer that guards read. `overrideEnabled` is
-- the operator's standing decision: null means no override.
ALTER TABLE "TenantFeatureEntitlement"
  ADD COLUMN IF NOT EXISTS "overrideEnabled" BOOLEAN;

-- Backfill: rows already marked as an override keep their current state as the
-- standing decision, so existing overrides survive the first recompute.
UPDATE "TenantFeatureEntitlement"
   SET "overrideEnabled" = "enabled"
 WHERE "source" = 'platform_override' AND "overrideEnabled" IS NULL;
