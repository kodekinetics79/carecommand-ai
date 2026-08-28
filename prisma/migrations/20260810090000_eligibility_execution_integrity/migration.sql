-- Durable, tenant-scoped eligibility execution boundary shared by both
-- eligibility POST surfaces. No provider request or member identifier is
-- persisted here; only application-HMACed identities are retained.

CREATE TYPE "EligibilityExecutionStatus" AS ENUM (
  'READY',
  'PROVIDER_IN_FLIGHT',
  'SUCCEEDED',
  'FAILED_DEFINITIVE',
  'RECONCILIATION_REQUIRED'
);

-- A payer may omit benefit amounts. Unknown is materially different from zero.
ALTER TABLE "EligibilityVerification" ALTER COLUMN "copay" DROP DEFAULT;
ALTER TABLE "EligibilityVerification" ALTER COLUMN "copay" DROP NOT NULL;
ALTER TABLE "EligibilityVerification" ALTER COLUMN "deductibleRemaining" DROP DEFAULT;
ALTER TABLE "EligibilityVerification" ALTER COLUMN "deductibleRemaining" DROP NOT NULL;
ALTER TABLE "EligibilityVerification" ALTER COLUMN "coinsurance" DROP DEFAULT;
ALTER TABLE "EligibilityVerification" ALTER COLUMN "coinsurance" DROP NOT NULL;
-- Historical rows include simulator/mock responses whose provenance cannot be
-- reconstructed safely. Never backfill them as payer-verified.
ALTER TABLE "EligibilityVerification" ADD COLUMN "decisionSource" TEXT NOT NULL DEFAULT 'LEGACY_UNVERIFIED';
ALTER TABLE "EligibilityVerification" ADD COLUMN "effectiveFrom" TIMESTAMP(3);
ALTER TABLE "EligibilityVerification" ADD COLUMN "expiresAt" TIMESTAMP(3);

-- The existing migration-owned rls_uq_* indexes already provide the unique
-- (tenantId, id) parent keys represented by the Prisma @@unique declarations.

CREATE TABLE "EligibilityExecution" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "branchId" UUID NOT NULL,
  "patientId" UUID NOT NULL,
  "appointmentId" UUID,
  "payerId" UUID,
  "policyId" UUID,
  "actorUserId" UUID,
  "idempotencyKeyHash" TEXT NOT NULL,
  "hmacKeyVersion" TEXT NOT NULL,
  "requestFingerprint" TEXT NOT NULL,
  "requestContract" TEXT NOT NULL,
  "providerKey" TEXT NOT NULL,
  "providerMode" TEXT NOT NULL,
  "providerExecutionKey" UUID NOT NULL,
  "status" "EligibilityExecutionStatus" NOT NULL DEFAULT 'READY',
  "resultVerificationId" UUID,
  "failureCode" TEXT,
  "reconciliationReason" TEXT,
  "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "providerStartedAt" TIMESTAMP(3),
  "providerCompletedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EligibilityExecution_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EligibilityExecution_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "EligibilityExecution_tenantId_branchId_fkey" FOREIGN KEY ("tenantId", "branchId") REFERENCES "Branch"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "EligibilityExecution_tenantId_patientId_fkey" FOREIGN KEY ("tenantId", "patientId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "EligibilityExecution_tenantId_appointmentId_fkey" FOREIGN KEY ("tenantId", "appointmentId") REFERENCES "Appointment"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "EligibilityExecution_tenantId_payerId_fkey" FOREIGN KEY ("tenantId", "payerId") REFERENCES "InsurancePayer"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "EligibilityExecution_tenantId_policyId_fkey" FOREIGN KEY ("tenantId", "policyId") REFERENCES "PatientInsurancePolicy"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "EligibilityExecution_tenantId_actorUserId_fkey" FOREIGN KEY ("tenantId", "actorUserId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "EligibilityExecution_tenantId_resultVerificationId_fkey" FOREIGN KEY ("tenantId", "resultVerificationId") REFERENCES "EligibilityVerification"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "EligibilityExecution_tenantId_idempotencyKeyHash_key" ON "EligibilityExecution"("tenantId", "idempotencyKeyHash");
CREATE UNIQUE INDEX "EligibilityExecution_tenantId_resultVerificationId_key" ON "EligibilityExecution"("tenantId", "resultVerificationId");
CREATE INDEX "EligibilityExecution_tenantId_status_updatedAt_idx" ON "EligibilityExecution"("tenantId", "status", "updatedAt");
CREATE INDEX "EligibilityExecution_tenantId_patientId_createdAt_idx" ON "EligibilityExecution"("tenantId", "patientId", "createdAt");

ALTER TABLE "EligibilityExecution" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EligibilityExecution" FORCE ROW LEVEL SECURITY;

CREATE POLICY "rls_eligibility_execution_select" ON "EligibilityExecution"
  FOR SELECT TO app_rls USING (app_rls_tenant_allowed("tenantId"));
CREATE POLICY "rls_eligibility_execution_insert" ON "EligibilityExecution"
  FOR INSERT TO app_rls WITH CHECK (app_rls_tenant_allowed("tenantId"));
CREATE POLICY "rls_eligibility_execution_update" ON "EligibilityExecution"
  FOR UPDATE TO app_rls
  USING (app_rls_tenant_allowed("tenantId"))
  WITH CHECK (app_rls_tenant_allowed("tenantId"));
CREATE POLICY "rls_eligibility_execution_delete" ON "EligibilityExecution"
  FOR DELETE TO app_rls USING (app_rls_tenant_allowed("tenantId"));
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "EligibilityExecution" TO app_rls;

CREATE FUNCTION eligibility_execution_integrity_guard() RETURNS trigger
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
    (OLD.status = 'READY' AND NEW.status = 'PROVIDER_IN_FLIGHT') OR
    (OLD.status = 'PROVIDER_IN_FLIGHT' AND NEW.status IN ('SUCCEEDED', 'FAILED_DEFINITIVE', 'RECONCILIATION_REQUIRED')) OR
    (OLD.status = 'RECONCILIATION_REQUIRED' AND NEW.status IN ('READY', 'FAILED_DEFINITIVE'))
  ) THEN
    RAISE EXCEPTION 'Illegal EligibilityExecution state transition: % -> %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  IF (NEW.status = 'READY' AND (NEW."providerStartedAt" IS NOT NULL OR NEW."resultVerificationId" IS NOT NULL OR NEW."completedAt" IS NOT NULL OR NEW."failureCode" IS NOT NULL))
    OR (NEW.status = 'PROVIDER_IN_FLIGHT' AND (NEW."providerStartedAt" IS NULL OR NEW."resultVerificationId" IS NOT NULL OR NEW."completedAt" IS NOT NULL))
    OR (NEW.status = 'SUCCEEDED' AND (NEW."resultVerificationId" IS NULL OR NEW."providerStartedAt" IS NULL OR NEW."providerCompletedAt" IS NULL OR NEW."completedAt" IS NULL OR NEW."failureCode" IS NOT NULL))
    OR (NEW.status = 'FAILED_DEFINITIVE' AND (NEW."resultVerificationId" IS NOT NULL OR NEW."failureCode" IS NULL OR NEW."completedAt" IS NULL))
    OR (NEW.status = 'RECONCILIATION_REQUIRED' AND (NEW."resultVerificationId" IS NOT NULL OR NEW."reconciliationReason" IS NULL)) THEN
    RAISE EXCEPTION 'EligibilityExecution state fields are inconsistent with status %', NEW.status USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER eligibility_execution_integrity_guard
BEFORE INSERT OR UPDATE OR DELETE ON "EligibilityExecution"
FOR EACH ROW EXECUTE FUNCTION eligibility_execution_integrity_guard();
