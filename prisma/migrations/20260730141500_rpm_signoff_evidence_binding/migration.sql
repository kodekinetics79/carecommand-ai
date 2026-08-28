-- Provider signoff must be bound to the exact canonical RPM evidence snapshot.
-- Existing unbound signoffs intentionally become invalid and require re-review.
ALTER TABLE "RPMBillingReadiness"
  ADD COLUMN "providerSignoffEvidenceVersion" TEXT,
  ADD COLUMN "providerSignoffEvidenceHash" TEXT;

UPDATE "RPMBillingReadiness"
SET
  "providerSignoffUserId" = NULL,
  "providerSignoffAt" = NULL,
  "status" = CASE
    WHEN "status" = 'READY' THEN 'NEEDS_REVIEW'
    ELSE "status"
  END,
  "missingRequirements" = CASE
    WHEN "status" = 'READY' THEN '["Provider signoff"]'::jsonb
    ELSE "missingRequirements"
  END
WHERE "providerSignoffAt" IS NOT NULL;
