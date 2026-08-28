-- Additive privacy lifecycle foundation for AI receptionist call artifacts.
-- Consent and lifecycle evidence are append-only at the database boundary.

DO $$ BEGIN
  CREATE TYPE "ReceptionistRecordingConsentStatus" AS ENUM ('UNDETERMINED', 'GRANTED', 'REFUSED', 'WITHDRAWN');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "ReceptionistCallArtifactType" AS ENUM ('RECORDING', 'TRANSCRIPT');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "ReceptionistArtifactLifecycleAction" AS ENUM ('RETENTION_SCHEDULED', 'PURGE_REQUESTED', 'PURGED', 'VENDOR_DELETE_REQUESTED', 'VENDOR_DELETE_CONFIRMED', 'VENDOR_DELETE_FAILED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "ReceptionistLegalHoldStatus" AS ENUM ('ACTIVE', 'RELEASED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "ReceptionistCallLog"
  ADD COLUMN IF NOT EXISTS "recordingConsentStatus" "ReceptionistRecordingConsentStatus" NOT NULL DEFAULT 'UNDETERMINED',
  ADD COLUMN IF NOT EXISTS "recordingConsentAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "recordingRetentionExpiresAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "transcriptRetentionExpiresAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "recordingPurgedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "transcriptPurgedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "vendorDeletionConfirmedAt" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "ReceptionistRecordingConsentEvent" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "callLogId" UUID NOT NULL,
  "decision" "ReceptionistRecordingConsentStatus" NOT NULL,
  "source" TEXT NOT NULL,
  "policyVersion" TEXT NOT NULL,
  "disclosureTextHash" TEXT NOT NULL,
  "jurisdiction" TEXT,
  "providerStorageSetting" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReceptionistRecordingConsentEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ReceptionistArtifactLifecycleEvent" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "callLogId" UUID NOT NULL,
  "artifactType" "ReceptionistCallArtifactType" NOT NULL,
  "action" "ReceptionistArtifactLifecycleAction" NOT NULL,
  "provider" TEXT,
  "providerRequestId" TEXT,
  "errorCode" TEXT,
  "metadata" JSONB,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReceptionistArtifactLifecycleEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ReceptionistCallLegalHold" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "callLogId" UUID NOT NULL,
  "scope" "ReceptionistCallArtifactType",
  "reason" TEXT NOT NULL,
  "authority" TEXT NOT NULL,
  "status" "ReceptionistLegalHoldStatus" NOT NULL DEFAULT 'ACTIVE',
  "placedByUserId" UUID,
  "placedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "releasedByUserId" UUID,
  "releasedAt" TIMESTAMP(3),
  "releaseReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ReceptionistCallLegalHold_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ReceptionistRecordingConsentEvent_tenantId_idempotencyKey_key"
  ON "ReceptionistRecordingConsentEvent"("tenantId", "idempotencyKey");
CREATE INDEX IF NOT EXISTS "ReceptionistRecordingConsentEvent_tenantId_callLogId_occurredAt_idx"
  ON "ReceptionistRecordingConsentEvent"("tenantId", "callLogId", "occurredAt");
CREATE INDEX IF NOT EXISTS "ReceptionistArtifactLifecycleEvent_tenantId_callLogId_occurredAt_idx"
  ON "ReceptionistArtifactLifecycleEvent"("tenantId", "callLogId", "occurredAt");
CREATE INDEX IF NOT EXISTS "ReceptionistArtifactLifecycleEvent_tenantId_action_occurredAt_idx"
  ON "ReceptionistArtifactLifecycleEvent"("tenantId", "action", "occurredAt");
CREATE INDEX IF NOT EXISTS "ReceptionistCallLegalHold_tenantId_callLogId_status_idx"
  ON "ReceptionistCallLegalHold"("tenantId", "callLogId", "status");
CREATE INDEX IF NOT EXISTS "ReceptionistCallLegalHold_tenantId_status_placedAt_idx"
  ON "ReceptionistCallLegalHold"("tenantId", "status", "placedAt");
CREATE UNIQUE INDEX IF NOT EXISTS "ReceptionistCallLegalHold_one_active_all_key"
  ON "ReceptionistCallLegalHold"("tenantId", "callLogId")
  WHERE "status" = 'ACTIVE' AND "scope" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "ReceptionistCallLegalHold_one_active_scoped_key"
  ON "ReceptionistCallLegalHold"("tenantId", "callLogId", "scope")
  WHERE "status" = 'ACTIVE' AND "scope" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "ReceptionistCallLog_tenantId_recordingRetentionExpiresAt_idx"
  ON "ReceptionistCallLog"("tenantId", "recordingRetentionExpiresAt");
CREATE INDEX IF NOT EXISTS "ReceptionistCallLog_tenantId_transcriptRetentionExpiresAt_idx"
  ON "ReceptionistCallLog"("tenantId", "transcriptRetentionExpiresAt");

DO $$ BEGIN
  ALTER TABLE "ReceptionistRecordingConsentEvent"
    ADD CONSTRAINT "ReceptionistRecordingConsentEvent_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE OR REPLACE FUNCTION "enforce_receptionist_call_tenant_match"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "ReceptionistCallLog"
    WHERE "id" = NEW."callLogId" AND "tenantId" = NEW."tenantId"
  ) THEN
    RAISE EXCEPTION 'callLogId does not belong to tenantId'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "ReceptionistRecordingConsentEvent_tenant_match" ON "ReceptionistRecordingConsentEvent";
CREATE TRIGGER "ReceptionistRecordingConsentEvent_tenant_match"
  BEFORE INSERT OR UPDATE ON "ReceptionistRecordingConsentEvent"
  FOR EACH ROW EXECUTE FUNCTION "enforce_receptionist_call_tenant_match"();

DROP TRIGGER IF EXISTS "ReceptionistArtifactLifecycleEvent_tenant_match" ON "ReceptionistArtifactLifecycleEvent";
CREATE TRIGGER "ReceptionistArtifactLifecycleEvent_tenant_match"
  BEFORE INSERT OR UPDATE ON "ReceptionistArtifactLifecycleEvent"
  FOR EACH ROW EXECUTE FUNCTION "enforce_receptionist_call_tenant_match"();

DROP TRIGGER IF EXISTS "ReceptionistCallLegalHold_tenant_match" ON "ReceptionistCallLegalHold";
CREATE TRIGGER "ReceptionistCallLegalHold_tenant_match"
  BEFORE INSERT OR UPDATE ON "ReceptionistCallLegalHold"
  FOR EACH ROW EXECUTE FUNCTION "enforce_receptionist_call_tenant_match"();
DO $$ BEGIN
  ALTER TABLE "ReceptionistRecordingConsentEvent"
    ADD CONSTRAINT "ReceptionistRecordingConsentEvent_callLogId_fkey"
    FOREIGN KEY ("callLogId") REFERENCES "ReceptionistCallLog"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "ReceptionistArtifactLifecycleEvent"
    ADD CONSTRAINT "ReceptionistArtifactLifecycleEvent_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "ReceptionistArtifactLifecycleEvent"
    ADD CONSTRAINT "ReceptionistArtifactLifecycleEvent_callLogId_fkey"
    FOREIGN KEY ("callLogId") REFERENCES "ReceptionistCallLog"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "ReceptionistCallLegalHold"
    ADD CONSTRAINT "ReceptionistCallLegalHold_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "ReceptionistCallLegalHold"
    ADD CONSTRAINT "ReceptionistCallLegalHold_callLogId_fkey"
    FOREIGN KEY ("callLogId") REFERENCES "ReceptionistCallLog"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE OR REPLACE FUNCTION "prevent_receptionist_privacy_evidence_mutation"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS "ReceptionistRecordingConsentEvent_append_only" ON "ReceptionistRecordingConsentEvent";
CREATE TRIGGER "ReceptionistRecordingConsentEvent_append_only"
  BEFORE UPDATE OR DELETE ON "ReceptionistRecordingConsentEvent"
  FOR EACH ROW EXECUTE FUNCTION "prevent_receptionist_privacy_evidence_mutation"();

DROP TRIGGER IF EXISTS "ReceptionistArtifactLifecycleEvent_append_only" ON "ReceptionistArtifactLifecycleEvent";
CREATE TRIGGER "ReceptionistArtifactLifecycleEvent_append_only"
  BEFORE UPDATE OR DELETE ON "ReceptionistArtifactLifecycleEvent"
  FOR EACH ROW EXECUTE FUNCTION "prevent_receptionist_privacy_evidence_mutation"();
