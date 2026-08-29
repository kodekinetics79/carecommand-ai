-- RPM evidence v4.
--
-- Two changes alter what a canonical evidence snapshot contains, and therefore
-- every snapshot hash:
--   1. Total review minutes are now summed in milliseconds and floored ONCE.
--      Flooring each session first discarded up to 59s per session, failing the
--      20-minute gate on work that was actually performed.
--   2. A reading from a DEACTIVATED device no longer qualifies as a CMS
--      device-day (new `device_deactivated` exception).
--
-- A provider signoff is bound to an exact (version, hash) pair. Because both
-- sides of that pair change here, NO existing signoff can be reproduced or
-- verified under v4. Grandfathering one would leave a signed attestation
-- standing over evidence the system can no longer reconstruct — exactly the
-- failure the hash binding exists to prevent. Every uncertain signoff is
-- cleared and returned to the queue for a fresh human review, as the v2->v3
-- provenance migration did.

UPDATE "RPMBillingReadiness"
SET
  "providerSignoffUserId" = NULL,
  "providerSignoffAt" = NULL,
  "providerSignoffEvidenceVersion" = NULL,
  "providerSignoffEvidenceHash" = NULL,
  "providerSignoffAttestationRevision" = NULL,
  "status" = 'MISSING_REQUIREMENTS',
  "missingRequirements" = '["Evidence definition changed (v4) — re-review required"]'::jsonb
WHERE
  "providerSignoffEvidenceVersion" IS DISTINCT FROM 'rpm-readiness-evidence-v4'
  OR "status" IN ('READY', 'NEEDS_REVIEW');
