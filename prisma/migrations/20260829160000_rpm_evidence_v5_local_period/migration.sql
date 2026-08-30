-- RPM evidence v5 — the billing period is reckoned in the clinic's timezone.
--
-- Two changes alter what a canonical evidence snapshot contains, and therefore
-- every snapshot hash:
--
--   1. The period is now the clinic's LOCAL calendar month rather than a UTC
--      one. Under UTC months a clinic west of Greenwich lost the final hours of
--      its local month (a clinician's evening review was rejected as "outside
--      the current period"), and a clinic east of it had the first local hours
--      counted against the previous month.
--   2. Device-days are bucketed by LOCAL calendar date. Bucketing by UTC date
--      split a single local day that straddled UTC midnight into two device-
--      days, so eight local days of transmission could satisfy a sixteen-day
--      CMS threshold.
--
-- The second change can REDUCE a previously recorded device-day count, which
-- means a standing attestation may cover a period that no longer meets its own
-- threshold. A signoff is bound to an exact (version, hash) pair and neither
-- side of that pair survives this change, so no existing signoff can be
-- reproduced or verified under v5. Every uncertain one is cleared and returned
-- to the queue for a fresh human review, as the v3 and v4 migrations did.

UPDATE "RPMBillingReadiness"
SET
  "providerSignoffUserId" = NULL,
  "providerSignoffAt" = NULL,
  "providerSignoffEvidenceVersion" = NULL,
  "providerSignoffEvidenceHash" = NULL,
  "providerSignoffAttestationRevision" = NULL,
  "status" = 'MISSING_REQUIREMENTS',
  "missingRequirements" = '["Evidence definition changed (v5, local billing period) — re-review required"]'::jsonb
WHERE
  "providerSignoffEvidenceVersion" IS DISTINCT FROM 'rpm-readiness-evidence-v5'
  OR "status" IN ('READY', 'NEEDS_REVIEW');
