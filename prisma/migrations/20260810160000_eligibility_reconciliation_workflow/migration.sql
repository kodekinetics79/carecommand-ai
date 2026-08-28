ALTER TYPE "EligibilityExecutionStatus" ADD VALUE 'MANUAL_EVIDENCE_PENDING';
ALTER TYPE "EligibilityExecutionStatus" ADD VALUE 'MANUALLY_RECONCILED';

ALTER TABLE "EligibilityExecution"
  ADD COLUMN "reconciliationLeaseOwner" TEXT,
  ADD COLUMN "reconciliationLeaseExpiresAt" TIMESTAMP(3),
  ADD COLUMN "reconciliationGeneration" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "reconciliationTaskId" UUID,
  ADD COLUMN "manualEvidenceOutcome" TEXT,
  ADD COLUMN "manualEvidenceSource" TEXT,
  ADD COLUMN "manualEvidenceReference" TEXT,
  ADD COLUMN "manualEvidenceVerifiedAt" TIMESTAMP(3),
  ADD COLUMN "manualEvidenceVerifiedByUserId" UUID,
  ADD COLUMN "manualCoverageEffectiveFrom" TIMESTAMP(3),
  ADD COLUMN "manualCoverageExpiresAt" TIMESTAMP(3),
  ADD COLUMN "manualCopay" DECIMAL(12,2),
  ADD COLUMN "manualDeductibleRemaining" DECIMAL(12,2),
  ADD COLUMN "manualCoinsurance" DECIMAL(12,4),
  ADD COLUMN "manualEvidenceNotes" TEXT,
  ADD CONSTRAINT "EligibilityExecution_manualEvidenceOutcome_check"
    CHECK ("manualEvidenceOutcome" IS NULL OR "manualEvidenceOutcome" IN ('ACTIVE', 'INACTIVE', 'UNCERTAIN')),
  ADD CONSTRAINT "EligibilityExecution_manualEvidenceSource_check"
    CHECK ("manualEvidenceSource" IS NULL OR "manualEvidenceSource" IN ('PAYER_PORTAL', 'PAYER_PHONE', 'PAYER_DOCUMENT')),
  ADD CONSTRAINT "EligibilityExecution_manualEvidenceDates_check"
    CHECK ("manualCoverageEffectiveFrom" IS NULL OR "manualCoverageExpiresAt" IS NULL OR "manualCoverageExpiresAt" > "manualCoverageEffectiveFrom"),
  ADD CONSTRAINT "EligibilityExecution_manualBenefits_check"
    CHECK (("manualCopay" IS NULL OR "manualCopay" >= 0) AND ("manualDeductibleRemaining" IS NULL OR "manualDeductibleRemaining" >= 0) AND ("manualCoinsurance" IS NULL OR ("manualCoinsurance" >= 0 AND "manualCoinsurance" <= 1)));

CREATE UNIQUE INDEX "StaffTask_tenantId_id_key" ON "StaffTask"("tenantId", "id");
CREATE UNIQUE INDEX "EligibilityExecution_tenantId_reconciliationTaskId_key" ON "EligibilityExecution"("tenantId", "reconciliationTaskId");
CREATE INDEX "EligibilityExecution_status_reconciliationLeaseExpiresAt_up_idx" ON "EligibilityExecution"("status", "reconciliationLeaseExpiresAt", "updatedAt");
CREATE INDEX "EligibilityExecution_tenantId_status_reconciliationLeaseExp_idx" ON "EligibilityExecution"("tenantId", "status", "reconciliationLeaseExpiresAt");

ALTER TABLE "EligibilityExecution" ADD CONSTRAINT "EligibilityExecution_tenantId_reconciliationTaskId_fkey"
  FOREIGN KEY ("tenantId", "reconciliationTaskId") REFERENCES "StaffTask"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EligibilityExecution" ADD CONSTRAINT "EligibilityExecution_tenantId_manualEvidenceVerifiedByUser_fkey"
  FOREIGN KEY ("tenantId", "manualEvidenceVerifiedByUserId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION eligibility_execution_integrity_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'EligibilityExecution rows are durable and cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND ROW(NEW."tenantId", NEW."branchId", NEW."patientId", NEW."appointmentId", NEW."payerId", NEW."policyId", NEW."actorUserId",
         NEW."idempotencyKeyHash", NEW."hmacKeyVersion", NEW."requestFingerprint", NEW."requestContract", NEW."providerKey", NEW."providerMode",
         NEW."providerExecutionKey", NEW."claimedAt", NEW."createdAt")
     IS DISTINCT FROM
     ROW(OLD."tenantId", OLD."branchId", OLD."patientId", OLD."appointmentId", OLD."payerId", OLD."policyId", OLD."actorUserId",
         OLD."idempotencyKeyHash", OLD."hmacKeyVersion", OLD."requestFingerprint", OLD."requestContract", OLD."providerKey", OLD."providerMode",
         OLD."providerExecutionKey", OLD."claimedAt", OLD."createdAt") THEN
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
