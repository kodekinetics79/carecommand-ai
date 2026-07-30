-- M09-F02: immutable, published Retell agent deployment binding.
-- Existing agents are deliberately backfilled UNVERIFIED. No legacy row is
-- silently promoted to production readiness.

CREATE TYPE "ReceptionistAgentProviderStatus" AS ENUM ('UNVERIFIED', 'VERIFIED', 'INVALID');
CREATE TYPE "ReceptionistAgentProbeStatus" AS ENUM ('NEVER', 'SUCCEEDED', 'FAILED');

ALTER TABLE "ReceptionistAgent"
  ADD COLUMN "providerAgentId" text,
  ADD COLUMN "providerVersionTag" text NOT NULL DEFAULT 'prod',
  ADD COLUMN "providerVersion" integer,
  ADD COLUMN "providerStatus" "ReceptionistAgentProviderStatus" NOT NULL DEFAULT 'UNVERIFIED',
  ADD COLUMN "providerPublished" boolean,
  ADD COLUMN "providerAssignedTags" text[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN "providerVoiceId" text,
  ADD COLUMN "providerLanguage" text,
  ADD COLUMN "providerWebhookUrl" text,
  ADD COLUMN "providerWebhookEvents" text[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN "providerDataStorageSetting" text,
  ADD COLUMN "providerSignedUrl" boolean,
  ADD COLUMN "providerResponseEngineType" text,
  ADD COLUMN "providerResponseEngineId" text,
  ADD COLUMN "providerResponseEngineVersion" integer,
  ADD COLUMN "providerLastModifiedAt" timestamp(3),
  ADD COLUMN "providerFingerprint" text,
  ADD COLUMN "providerConfigRevision" integer NOT NULL DEFAULT 1,
  ADD COLUMN "providerVerifiedRevision" integer,
  ADD COLUMN "providerVerifiedAt" timestamp(3),
  ADD COLUMN "providerVerificationExpiresAt" timestamp(3),
  ADD COLUMN "providerLastAttemptAt" timestamp(3),
  ADD COLUMN "providerLastAttemptStatus" "ReceptionistAgentProbeStatus" NOT NULL DEFAULT 'NEVER',
  ADD COLUMN "providerLastErrorCode" text;

ALTER TABLE "ReceptionistAgent"
  ADD CONSTRAINT "ReceptionistAgent_provider_tag_check"
    CHECK (
      "providerVersionTag" ~ '^[a-z][a-z0-9_-]{0,19}$'
      AND "providerVersionTag" <> 'latest'
      AND "providerVersionTag" !~ '^v[0-9]+$'
    ),
  ADD CONSTRAINT "ReceptionistAgent_provider_id_check"
    CHECK ("providerAgentId" IS NULL OR "providerAgentId" ~ '^[A-Za-z0-9_-]{1,128}$'),
  ADD CONSTRAINT "ReceptionistAgent_provider_version_check"
    CHECK (
      ("providerVersion" IS NULL OR "providerVersion" >= 0)
      AND ("providerResponseEngineVersion" IS NULL OR "providerResponseEngineVersion" >= 0)
    ),
  ADD CONSTRAINT "ReceptionistAgent_provider_verified_shape_check"
    CHECK (
      "providerStatus" <> 'VERIFIED'
      OR (
        "providerAgentId" IS NOT NULL
        AND "providerVersion" IS NOT NULL
        AND "providerPublished" IS TRUE
        AND "providerAssignedTags" @> ARRAY["providerVersionTag"]
        AND "providerWebhookUrl" IS NOT NULL
        AND "providerWebhookEvents" @> ARRAY['call_started', 'call_ended', 'call_analyzed']::text[]
        AND "providerDataStorageSetting" = 'basic_attributes_only'
        AND "providerSignedUrl" IS TRUE
        AND NULLIF("providerResponseEngineType", '') IS NOT NULL
        AND NULLIF("providerResponseEngineId", '') IS NOT NULL
        AND "providerFingerprint" ~ '^[a-f0-9]{64}$'
        AND "providerVerifiedRevision" = "providerConfigRevision"
        AND "providerVerifiedAt" IS NOT NULL
        AND "providerVerificationExpiresAt" > "providerVerifiedAt"
      )
    );

CREATE UNIQUE INDEX "ReceptionistAgent_tenantId_clinicId_id_key"
  ON "ReceptionistAgent"("tenantId", "clinicId", id);

CREATE INDEX "ReceptionistAgent_provider_deployment_idx"
  ON "ReceptionistAgent"("providerAgentId", "providerVersion");

-- One active CareCommand configuration owns a provider deployment. Sharing a
-- live provider version across clinics or tenants would share its webhook and
-- response-engine blast radius.
CREATE UNIQUE INDEX "ReceptionistAgent_active_provider_deployment_unique"
  ON "ReceptionistAgent"("providerAgentId", "providerVersion")
  WHERE active AND "providerAgentId" IS NOT NULL AND "providerVersion" IS NOT NULL;

DO $preflight$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "ReceptionistCampaign" c
    JOIN "ReceptionistAgent" a ON a.id = c."agentId"
    WHERE c."agentId" IS NOT NULL
      AND (a."tenantId" <> c."tenantId" OR a."clinicId" <> c."clinicId")
  ) OR EXISTS (
    SELECT 1
    FROM "ReceptionistOutboundCampaign" c
    JOIN "ReceptionistAgent" a ON a.id = c."agentId"
    WHERE c."agentId" IS NOT NULL
      AND (a."tenantId" <> c."tenantId" OR a."clinicId" <> c."clinicId")
  ) THEN
    RAISE EXCEPTION 'receptionist_agent_scope_mismatch: reconcile campaign agent bindings before migration';
  END IF;
END
$preflight$;

ALTER TABLE "ReceptionistCampaign"
  DROP CONSTRAINT "ReceptionistCampaign_agentId_fkey";

ALTER TABLE "ReceptionistOutboundCampaign"
  DROP CONSTRAINT "ReceptionistOutboundCampaign_agentId_fkey";

ALTER TABLE "ReceptionistCampaign"
  ADD CONSTRAINT "ReceptionistCampaign_agent_scope_fkey"
  FOREIGN KEY ("tenantId", "clinicId", "agentId")
  REFERENCES "ReceptionistAgent"("tenantId", "clinicId", id)
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ReceptionistOutboundCampaign"
  ADD CONSTRAINT "ReceptionistOutboundCampaign_agent_scope_fkey"
  FOREIGN KEY ("tenantId", "clinicId", "agentId")
  REFERENCES "ReceptionistAgent"("tenantId", "clinicId", id)
  ON DELETE RESTRICT ON UPDATE CASCADE;
