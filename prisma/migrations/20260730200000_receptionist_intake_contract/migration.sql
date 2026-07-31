-- M09-F10 Slice A: immutable, provider-attested typed intake contract.
-- Existing active Studio campaigns are atomically paused and attributed. No
-- legacy row is silently treated as provider-attested.
WITH paused AS (
  UPDATE "ReceptionistCampaign"
  SET status = 'PAUSED'
  WHERE status = 'ACTIVE'
  RETURNING id, "tenantId"
)
INSERT INTO "AuditEvent" (id, "tenantId", action, resource, "resourceId", "userAgent", metadata)
SELECT
  gen_random_uuid(),
  "tenantId",
  'receptionistCampaign.intakeAttestationMigrationPaused',
  'receptionistCampaign',
  id,
  'migration:20260730200000_receptionist_intake_contract',
  jsonb_build_object('reason', 'legacy_active_campaign_requires_provider_attestation')
FROM paused;

ALTER TABLE "ReceptionistAgent"
  ADD COLUMN "providerResponseEngineGraphFingerprint" text,
  ADD COLUMN "providerBookToolSchema" jsonb,
  ADD COLUMN "providerBookToolFingerprint" text,
  ADD COLUMN "providerToolCallStrictMode" boolean;

ALTER TABLE "ReceptionistAgent"
  ADD CONSTRAINT "ReceptionistAgent_provider_book_tool_shape_check"
  CHECK (
    (
      "providerBookToolSchema" IS NULL
      AND "providerBookToolFingerprint" IS NULL
      AND "providerToolCallStrictMode" IS NULL
      AND (
        "providerResponseEngineGraphFingerprint" IS NULL
        OR (
          "providerResponseEngineGraphFingerprint" IS NOT NULL
          AND "providerResponseEngineGraphFingerprint" ~ '^[a-f0-9]{64}$'
        )
      )
    )
    OR (
      "providerBookToolSchema" IS NOT NULL
      AND jsonb_typeof("providerBookToolSchema") = 'object'
      AND "providerBookToolFingerprint" IS NOT NULL
      AND "providerBookToolFingerprint" ~ '^[a-f0-9]{64}$'
      AND "providerToolCallStrictMode" IS NOT NULL
      AND "providerResponseEngineType" IS NOT NULL
      AND "providerResponseEngineType" IN ('retell-llm', 'conversation-flow')
      AND "providerResponseEngineId" IS NOT NULL
      AND NULLIF(btrim("providerResponseEngineId"), '') IS NOT NULL
      AND "providerResponseEngineVersion" IS NOT NULL
      AND "providerResponseEngineVersion" >= 0
      AND "providerResponseEngineGraphFingerprint" IS NOT NULL
      AND "providerResponseEngineGraphFingerprint" ~ '^[a-f0-9]{64}$'
    )
  );

ALTER TABLE "ReceptionistAgent"
  DROP CONSTRAINT "ReceptionistAgent_provider_tag_check",
  ADD CONSTRAINT "ReceptionistAgent_provider_tag_check"
    CHECK (
      "providerVersionTag" ~ '^[a-z][a-z0-9_-]{0,19}$'
      AND "providerVersionTag" NOT IN ('latest', 'latest_published')
      AND "providerVersionTag" !~ '^v[0-9]+$'
    );

ALTER TABLE "ReceptionistCampaign"
  ADD COLUMN "intakeSchemaRevision" integer NOT NULL DEFAULT 1,
  ADD COLUMN "intakeSchemaSnapshot" jsonb,
  ADD COLUMN "intakeSchemaFingerprint" text,
  ADD COLUMN "intakeToolFingerprint" text,
  ADD COLUMN "intakeSchemaAttestedRevision" integer,
  ADD COLUMN "intakeSchemaAttestedAt" timestamp(3),
  ADD COLUMN "intakeSchemaProviderAgentId" text,
  ADD COLUMN "intakeSchemaProviderVersion" integer,
  ADD COLUMN "intakeSchemaResponseEngineId" text,
  ADD COLUMN "intakeSchemaResponseEngineVersion" integer;

ALTER TABLE "ReceptionistCampaign"
  ADD CONSTRAINT "ReceptionistCampaign_intake_revision_check"
    CHECK ("intakeSchemaRevision" >= 1),
  ADD CONSTRAINT "ReceptionistCampaign_intake_attestation_shape_check"
    CHECK (
      (
        "intakeSchemaSnapshot" IS NULL
        AND "intakeSchemaFingerprint" IS NULL
        AND "intakeToolFingerprint" IS NULL
        AND "intakeSchemaAttestedRevision" IS NULL
        AND "intakeSchemaAttestedAt" IS NULL
        AND "intakeSchemaProviderAgentId" IS NULL
        AND "intakeSchemaProviderVersion" IS NULL
        AND "intakeSchemaResponseEngineId" IS NULL
        AND "intakeSchemaResponseEngineVersion" IS NULL
      )
      OR (
        "intakeSchemaSnapshot" IS NOT NULL
        AND jsonb_typeof("intakeSchemaSnapshot") = 'object'
        AND "intakeSchemaFingerprint" IS NOT NULL
        AND "intakeSchemaFingerprint" ~ '^[a-f0-9]{64}$'
        AND "intakeToolFingerprint" IS NOT NULL
        AND "intakeToolFingerprint" ~ '^[a-f0-9]{64}$'
        AND "intakeSchemaAttestedRevision" IS NOT NULL
        AND "intakeSchemaAttestedRevision" >= 1
        AND "intakeSchemaAttestedRevision" = "intakeSchemaRevision"
        AND "intakeSchemaAttestedAt" IS NOT NULL
        AND "intakeSchemaProviderAgentId" IS NOT NULL
        AND "intakeSchemaProviderAgentId" ~ '^[A-Za-z0-9_-]{1,128}$'
        AND "intakeSchemaProviderVersion" IS NOT NULL
        AND "intakeSchemaProviderVersion" >= 0
        AND "intakeSchemaResponseEngineId" IS NOT NULL
        AND NULLIF(btrim("intakeSchemaResponseEngineId"), '') IS NOT NULL
        AND "intakeSchemaResponseEngineVersion" IS NOT NULL
        AND "intakeSchemaResponseEngineVersion" >= 0
      )
    ),
  ADD CONSTRAINT "ReceptionistCampaign_active_intake_attestation_check"
    CHECK (
      status <> 'ACTIVE'
      OR (
        "intakeSchemaSnapshot" IS NOT NULL
        AND "intakeSchemaFingerprint" IS NOT NULL
        AND "intakeToolFingerprint" IS NOT NULL
        AND "intakeSchemaAttestedRevision" IS NOT NULL
        AND "intakeSchemaAttestedRevision" = "intakeSchemaRevision"
        AND "intakeSchemaAttestedAt" IS NOT NULL
        AND "intakeSchemaProviderAgentId" IS NOT NULL
        AND "intakeSchemaProviderVersion" IS NOT NULL
        AND "intakeSchemaResponseEngineId" IS NOT NULL
        AND "intakeSchemaResponseEngineVersion" IS NOT NULL
      )
    );

-- One tenant-scoped provider deployment can drive only one ACTIVE Studio
-- campaign. This removes ambiguous tool-first routing at the database boundary.
CREATE UNIQUE INDEX "ReceptionistCampaign_tenant_active_provider_deployment_unique"
  ON "ReceptionistCampaign"("tenantId", "intakeSchemaProviderAgentId", "intakeSchemaProviderVersion")
  WHERE status = 'ACTIVE'
    AND "intakeSchemaProviderAgentId" IS NOT NULL
    AND "intakeSchemaProviderVersion" IS NOT NULL;

CREATE OR REPLACE FUNCTION "invalidate_receptionist_campaign_intake_contract"()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
     OR NEW."clinicId" IS DISTINCT FROM OLD."clinicId"
     OR NEW."agentId" IS DISTINCT FROM OLD."agentId"
     OR NEW."appointmentType" IS DISTINCT FROM OLD."appointmentType"
     OR NEW."eligibleLocationIds" IS DISTINCT FROM OLD."eligibleLocationIds" THEN
    IF OLD.status = 'ACTIVE' AND NEW.status = 'ACTIVE' THEN
      RAISE EXCEPTION 'receptionist_active_intake_contract_immutable';
    END IF;
    NEW."intakeSchemaRevision" := OLD."intakeSchemaRevision" + 1;
    NEW."intakeSchemaSnapshot" := NULL;
    NEW."intakeSchemaFingerprint" := NULL;
    NEW."intakeToolFingerprint" := NULL;
    NEW."intakeSchemaAttestedRevision" := NULL;
    NEW."intakeSchemaAttestedAt" := NULL;
    NEW."intakeSchemaProviderAgentId" := NULL;
    NEW."intakeSchemaProviderVersion" := NULL;
    NEW."intakeSchemaResponseEngineId" := NULL;
    NEW."intakeSchemaResponseEngineVersion" := NULL;
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER "ReceptionistCampaign_intake_contract_invalidation"
BEFORE UPDATE OF "tenantId", "clinicId", "agentId", "appointmentType", "eligibleLocationIds"
ON "ReceptionistCampaign"
FOR EACH ROW
EXECUTE FUNCTION "invalidate_receptionist_campaign_intake_contract"();

CREATE OR REPLACE FUNCTION "invalidate_receptionist_intake_field_contract"()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  campaign_id uuid;
  campaign_status "ReceptionistCampaignStatus";
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
    OR NEW."campaignId" IS DISTINCT FROM OLD."campaignId"
  ) THEN
    RAISE EXCEPTION 'receptionist_intake_field_parent_immutable';
  END IF;
  campaign_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."campaignId" ELSE NEW."campaignId" END;
  SELECT status INTO campaign_status FROM "ReceptionistCampaign" WHERE id = campaign_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF campaign_status = 'ACTIVE' THEN
    RAISE EXCEPTION 'receptionist_active_intake_contract_immutable';
  END IF;
  UPDATE "ReceptionistCampaign"
  SET
    "intakeSchemaRevision" = "intakeSchemaRevision" + 1,
    "intakeSchemaSnapshot" = NULL,
    "intakeSchemaFingerprint" = NULL,
    "intakeToolFingerprint" = NULL,
    "intakeSchemaAttestedRevision" = NULL,
    "intakeSchemaAttestedAt" = NULL,
    "intakeSchemaProviderAgentId" = NULL,
    "intakeSchemaProviderVersion" = NULL,
    "intakeSchemaResponseEngineId" = NULL,
    "intakeSchemaResponseEngineVersion" = NULL
  WHERE id = campaign_id;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$fn$;

CREATE TRIGGER "ReceptionistIntakeField_contract_invalidation"
AFTER INSERT OR UPDATE OR DELETE
ON "ReceptionistIntakeField"
FOR EACH ROW
EXECUTE FUNCTION "invalidate_receptionist_intake_field_contract"();

-- Location names and active branch mappings are rendered into the intake
-- prompt/schema. Protect active snapshots and invalidate every affected paused
-- or draft campaign, including campaigns whose empty location array means
-- "all active mapped locations for this clinic".
CREATE OR REPLACE FUNCTION "invalidate_receptionist_location_intake_contract"()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  campaign_row record;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."tenantId" IS NOT DISTINCT FROM OLD."tenantId"
     AND NEW."clinicId" IS NOT DISTINCT FROM OLD."clinicId"
     AND NEW.id IS NOT DISTINCT FROM OLD.id
     AND NEW.name IS NOT DISTINCT FROM OLD.name
     AND NEW.active IS NOT DISTINCT FROM OLD.active
     AND NEW."branchId" IS NOT DISTINCT FROM OLD."branchId" THEN
    RETURN NEW;
  END IF;

  FOR campaign_row IN
    SELECT c.id, c.status
    FROM "ReceptionistCampaign" c
    WHERE
      (
        TG_OP <> 'INSERT'
        AND OLD.active
        AND OLD."branchId" IS NOT NULL
        AND c."tenantId" = OLD."tenantId"
        AND c."clinicId" = OLD."clinicId"
        AND (cardinality(c."eligibleLocationIds") = 0 OR OLD.id = ANY(c."eligibleLocationIds"))
      )
      OR
      (
        TG_OP <> 'DELETE'
        AND NEW.active
        AND NEW."branchId" IS NOT NULL
        AND c."tenantId" = NEW."tenantId"
        AND c."clinicId" = NEW."clinicId"
        AND (cardinality(c."eligibleLocationIds") = 0 OR NEW.id = ANY(c."eligibleLocationIds"))
      )
    ORDER BY c.id
    FOR UPDATE
  LOOP
    IF campaign_row.status = 'ACTIVE' THEN
      RAISE EXCEPTION 'receptionist_active_intake_contract_immutable';
    END IF;
    UPDATE "ReceptionistCampaign"
    SET
      "intakeSchemaRevision" = "intakeSchemaRevision" + 1,
      "intakeSchemaSnapshot" = NULL,
      "intakeSchemaFingerprint" = NULL,
      "intakeToolFingerprint" = NULL,
      "intakeSchemaAttestedRevision" = NULL,
      "intakeSchemaAttestedAt" = NULL,
      "intakeSchemaProviderAgentId" = NULL,
      "intakeSchemaProviderVersion" = NULL,
      "intakeSchemaResponseEngineId" = NULL,
      "intakeSchemaResponseEngineVersion" = NULL
    WHERE id = campaign_row.id;
  END LOOP;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$fn$;

CREATE TRIGGER "ReceptionistLocation_intake_contract_invalidation"
AFTER INSERT OR UPDATE OR DELETE
ON "ReceptionistLocation"
FOR EACH ROW
EXECUTE FUNCTION "invalidate_receptionist_location_intake_contract"();
