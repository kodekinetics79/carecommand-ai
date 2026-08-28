-- RPM evidence v3 admits device-days only from signature-verified automated
-- provider ingestion linked to one exact tenant/patient/provider enrollment.
ALTER TABLE "PatientDeviceEnrollment"
  ADD CONSTRAINT "PatientDeviceEnrollment_tenantId_id_key" UNIQUE ("tenantId", "id");

ALTER TABLE "DeviceReading"
  ADD COLUMN "sourceProviderKey" TEXT,
  ADD COLUMN "sourceEnrollmentId" UUID;

CREATE INDEX "DeviceReading_tenantId_sourceEnrollmentId_capturedAt_idx"
  ON "DeviceReading"("tenantId", "sourceEnrollmentId", "capturedAt");

ALTER TABLE "DeviceReading"
  ADD CONSTRAINT "DeviceReading_source_enrollment_scope_fkey"
  FOREIGN KEY ("tenantId", "sourceEnrollmentId")
  REFERENCES "PatientDeviceEnrollment"("tenantId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "DeviceReading"
  ADD CONSTRAINT "DeviceReading_automated_provenance_shape_check"
  CHECK (
    ("sourceEnrollmentId" IS NULL AND "sourceProviderKey" IS NULL)
    OR (
      "source" = 'webhook'
      AND "dedupeKey" IS NOT NULL
      AND "deviceId" IS NOT NULL
      AND "sourceEnrollmentId" IS NOT NULL
      AND length(btrim("sourceProviderKey")) > 0
    )
  );

ALTER TABLE "DeviceReading"
  ADD CONSTRAINT "DeviceReading_validation_status_check"
  CHECK ("validationStatus" IN ('valid', 'suspect', 'invalid'));

CREATE OR REPLACE FUNCTION "reject_device_reading_provenance_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
     OR NEW."patientId" IS DISTINCT FROM OLD."patientId"
     OR NEW."deviceId" IS DISTINCT FROM OLD."deviceId"
     OR NEW."branchId" IS DISTINCT FROM OLD."branchId"
     OR NEW."capturedAt" IS DISTINCT FROM OLD."capturedAt"
     OR NEW."receivedAt" IS DISTINCT FROM OLD."receivedAt"
     OR NEW."source" IS DISTINCT FROM OLD."source"
     OR NEW."dedupeKey" IS DISTINCT FROM OLD."dedupeKey"
     OR NEW."sourceProviderKey" IS DISTINCT FROM OLD."sourceProviderKey"
     OR NEW."sourceEnrollmentId" IS DISTINCT FROM OLD."sourceEnrollmentId"
  THEN
    RAISE EXCEPTION 'DeviceReading provenance is immutable after insert'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "DeviceReading_provenance_immutable"
BEFORE UPDATE ON "DeviceReading"
FOR EACH ROW EXECUTE FUNCTION "reject_device_reading_provenance_mutation"();

-- There is no governed runtime correction workflow yet. Preserve readings as
-- append-only clinical/billing evidence; replacement or correction must be a
-- new reading until an audited invalidation workflow is introduced.
REVOKE UPDATE, DELETE ON TABLE "DeviceReading" FROM app_rls;

DO $drop_device_reading_runtime_mutation_policies$
DECLARE policy_row record;
BEGIN
  FOR policy_row IN
    SELECT policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'DeviceReading'
      AND cmd IN ('UPDATE', 'DELETE')
      AND 'app_rls'::name = ANY(roles)
  LOOP
    EXECUTE format('DROP POLICY %I ON public.%I', policy_row.policyname, 'DeviceReading');
  END LOOP;
END
$drop_device_reading_runtime_mutation_policies$;

ALTER TABLE "RPMBillingReadiness"
  ADD COLUMN "providerSignoffAttestationRevision" TEXT;

-- v2 did not distinguish automated, enrollment-linked readings from manual,
-- imported, or ambiguous evidence. No existing signoff is grandfathered.
UPDATE "RPMBillingReadiness"
SET
  "providerSignoffUserId" = NULL,
  "providerSignoffAt" = NULL,
  "providerSignoffEvidenceVersion" = NULL,
  "providerSignoffEvidenceHash" = NULL,
  "providerSignoffAttestationRevision" = NULL,
  "status" = 'MISSING_REQUIREMENTS',
  "missingRequirements" = '["Evidence must be recomputed under RPM v3 automated-device provenance rules"]'::jsonb
WHERE "providerSignoffAt" IS NOT NULL
   OR "status" IN ('READY', 'NEEDS_REVIEW');
