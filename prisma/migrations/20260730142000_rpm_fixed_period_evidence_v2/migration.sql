-- RPM evidence v2 uses immutable UTC calendar-month billing periods and derives
-- review totals from append-only evidence. Any v1 signoff must be reviewed
-- again against its canonical fixed-period snapshot.
UPDATE "RPMBillingReadiness"
SET
  "providerSignoffUserId" = NULL,
  "providerSignoffAt" = NULL,
  "providerSignoffEvidenceVersion" = NULL,
  "providerSignoffEvidenceHash" = NULL,
  "status" = CASE
    WHEN "status" = 'READY' THEN 'NEEDS_REVIEW'
    ELSE "status"
  END,
  "missingRequirements" = CASE
    WHEN "status" = 'READY' THEN '["Provider signoff"]'::jsonb
    ELSE "missingRequirements"
  END
WHERE "providerSignoffAt" IS NOT NULL
   OR "status" = 'READY';
