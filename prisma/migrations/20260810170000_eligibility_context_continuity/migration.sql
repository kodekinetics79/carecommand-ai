ALTER TABLE "EligibilityExecution"
  ADD COLUMN "requestedServiceType" TEXT,
  ADD COLUMN "requestedServiceAt" TIMESTAMP(3);

CREATE INDEX "EligibilityExecution_tenantId_requestFingerprint_completed_idx"
  ON "EligibilityExecution"("tenantId", "requestFingerprint", "completedAt");

-- Preserve the request context that staff must attest against. These fields are
-- part of the canonical execution identity and cannot be rewritten after a
-- provider request has been authorized.
CREATE OR REPLACE FUNCTION eligibility_execution_integrity_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'EligibilityExecution rows are durable and cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND ROW(NEW."tenantId", NEW."branchId", NEW."patientId", NEW."appointmentId", NEW."payerId", NEW."policyId", NEW."actorUserId",
         NEW."idempotencyKeyHash", NEW."hmacKeyVersion", NEW."requestFingerprint", NEW."requestContract", NEW."providerKey", NEW."providerMode",
         NEW."requestedServiceType", NEW."requestedServiceAt", NEW."providerExecutionKey", NEW."claimedAt", NEW."createdAt")
     IS DISTINCT FROM
     ROW(OLD."tenantId", OLD."branchId", OLD."patientId", OLD."appointmentId", OLD."payerId", OLD."policyId", OLD."actorUserId",
         OLD."idempotencyKeyHash", OLD."hmacKeyVersion", OLD."requestFingerprint", OLD."requestContract", OLD."providerKey", OLD."providerMode",
         OLD."requestedServiceType", OLD."requestedServiceAt", OLD."providerExecutionKey", OLD."claimedAt", OLD."createdAt") THEN
    RAISE EXCEPTION 'EligibilityExecution identity fields are immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'READY' AND NEW.status IN ('PROVIDER_IN_FLIGHT', 'MANUAL_EVIDENCE_PENDING')) OR
    (OLD.status = 'PROVIDER_IN_FLIGHT' AND NEW.status IN ('SUCCEEDED', 'FAILED_DEFINITIVE', 'RECONCILIATION_REQUIRED', 'MANUAL_EVIDENCE_PENDING')) OR
    (OLD.status = 'RECONCILIATION_REQUIRED' AND NEW.status IN ('READY', 'FAILED_DEFINITIVE', 'MANUAL_EVIDENCE_PENDING')) OR
    (OLD.status = 'MANUAL_EVIDENCE_PENDING' AND NEW.status IN ('READY', 'FAILED_DEFINITIVE', 'MANUALLY_RECONCILED'))
  ) THEN
    RAISE EXCEPTION 'Illegal EligibilityExecution state transition: % -> %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  IF (NEW.status = 'READY' AND (NEW."providerStartedAt" IS NOT NULL OR NEW."resultVerificationId" IS NOT NULL OR NEW."completedAt" IS NOT NULL OR NEW."failureCode" IS NOT NULL))
    OR (NEW.status = 'PROVIDER_IN_FLIGHT' AND (NEW."providerStartedAt" IS NULL OR NEW."resultVerificationId" IS NOT NULL OR NEW."completedAt" IS NOT NULL))
    OR (NEW.status = 'SUCCEEDED' AND (NEW."resultVerificationId" IS NULL OR NEW."providerStartedAt" IS NULL OR NEW."providerCompletedAt" IS NULL OR NEW."completedAt" IS NULL OR NEW."failureCode" IS NOT NULL))
    OR (NEW.status = 'FAILED_DEFINITIVE' AND (NEW."resultVerificationId" IS NOT NULL OR NEW."failureCode" IS NULL OR NEW."completedAt" IS NULL))
    OR (NEW.status = 'RECONCILIATION_REQUIRED' AND (NEW."resultVerificationId" IS NOT NULL OR NEW."reconciliationReason" IS NULL))
    OR (NEW.status = 'MANUAL_EVIDENCE_PENDING' AND (NEW."resultVerificationId" IS NOT NULL OR NEW."reconciliationReason" IS NULL OR NEW."reconciliationTaskId" IS NULL))
    OR (NEW.status = 'MANUALLY_RECONCILED' AND (NEW."resultVerificationId" IS NULL OR NEW."completedAt" IS NULL OR NEW."manualEvidenceOutcome" IS NULL OR NEW."manualEvidenceSource" IS NULL OR NEW."manualEvidenceReference" IS NULL OR NEW."manualEvidenceVerifiedAt" IS NULL OR NEW."manualEvidenceVerifiedByUserId" IS NULL OR NEW."reconciliationTaskId" IS NULL)) THEN
    RAISE EXCEPTION 'EligibilityExecution state fields are inconsistent with status %', NEW.status USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
