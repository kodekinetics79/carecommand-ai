-- ===========================================================================
-- Receptionist agent deployment (C5).
--
-- Until now CareCommand could only VERIFY an agent an operator had built by
-- hand in the Retell console. This table records a deployment CareCommand
-- itself performed: the exact prompt, tools and provider version it published,
-- and the evidence verification compares the provider against afterwards.
--
-- It is also the mock provider's state. The mock probe answers from these
-- columns rather than from process memory, so the API process, the worker, the
-- demo seed and the test suites cannot hold different opinions about what the
-- provider is running.
-- ===========================================================================

CREATE TYPE "ReceptionistDeploymentStatus" AS ENUM ('PENDING', 'PUBLISHED', 'VERIFIED', 'FAILED', 'SUPERSEDED');
CREATE TYPE "ReceptionistAttemptSource" AS ENUM ('USER', 'SYSTEM', 'DEPLOY');

CREATE TABLE "ReceptionistAgentDeployment" (
  "id" uuid NOT NULL,
  "tenantId" uuid NOT NULL,
  "clinicId" uuid NOT NULL,
  "agentId" uuid NOT NULL,
  "campaignId" uuid NOT NULL,
  "status" "ReceptionistDeploymentStatus" NOT NULL DEFAULT 'PENDING',
  "mock" boolean NOT NULL DEFAULT false,
  "providerAgentId" text,
  "providerLlmId" text,
  "providerLlmVersion" integer,
  "providerAgentVersion" integer,
  "providerVersionTag" text NOT NULL DEFAULT 'prod',
  "promptHash" text NOT NULL,
  "beginMessageHash" text NOT NULL,
  "toolFingerprint" text NOT NULL,
  "intakeFingerprint" text NOT NULL,
  "intakeSchemaRevision" integer NOT NULL,
  "configFingerprint" text NOT NULL,
  "voiceId" text NOT NULL,
  "language" text NOT NULL,
  "promptText" text NOT NULL,
  "toolsJson" jsonb NOT NULL,
  "steps" jsonb,
  "providerErrorCode" text,
  "numberBound" boolean NOT NULL DEFAULT false,
  "boundPhoneNumber" text,
  "deployedById" uuid,
  "deployedBySource" "ReceptionistAttemptSource" NOT NULL DEFAULT 'USER',
  "startedAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "publishedAt" timestamp(3),
  "verifiedAt" timestamp(3),
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamp(3) NOT NULL,
  CONSTRAINT "ReceptionistAgentDeployment_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ReceptionistAgentDeployment"
  ADD CONSTRAINT "ReceptionistAgentDeployment_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  -- Tenant-composite throughout: a deployment can never point at another
  -- tenant's agent or campaign, even if an id is guessed.
  ADD CONSTRAINT "ReceptionistAgentDeployment_agent_scope_fkey"
    FOREIGN KEY ("tenantId", "clinicId", "agentId")
    REFERENCES "ReceptionistAgent"("tenantId", "clinicId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ReceptionistAgentDeployment_campaign_scope_fkey"
    FOREIGN KEY ("tenantId", "campaignId")
    REFERENCES "ReceptionistCampaign"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ReceptionistAgentDeployment"
  ADD CONSTRAINT "ReceptionistAgentDeployment_tag_check"
    CHECK (
      "providerVersionTag" ~ '^[a-z][a-z0-9_-]{0,19}$'
      AND "providerVersionTag" <> 'latest'
      AND "providerVersionTag" !~ '^v[0-9]+$'
    ),
  ADD CONSTRAINT "ReceptionistAgentDeployment_provider_id_check"
    CHECK (
      ("providerAgentId" IS NULL OR "providerAgentId" ~ '^[A-Za-z0-9_-]{1,128}$')
      AND ("providerLlmId" IS NULL OR "providerLlmId" ~ '^[A-Za-z0-9_-]{1,128}$')
      AND ("providerAgentVersion" IS NULL OR "providerAgentVersion" >= 0)
      AND ("providerLlmVersion" IS NULL OR "providerLlmVersion" >= 0)
    ),
  -- VERIFIED is a claim about a real, pinned, published provider version.
  ADD CONSTRAINT "ReceptionistAgentDeployment_verified_shape_check"
    CHECK (
      "status" <> 'VERIFIED'
      OR (
        "providerAgentId" IS NOT NULL
        AND "providerAgentVersion" IS NOT NULL
        AND "verifiedAt" IS NOT NULL
        AND "publishedAt" IS NOT NULL
      )
    ),
  ADD CONSTRAINT "ReceptionistAgentDeployment_published_shape_check"
    CHECK (
      "status" NOT IN ('PUBLISHED', 'VERIFIED')
      OR ("providerAgentId" IS NOT NULL AND "providerAgentVersion" IS NOT NULL AND "publishedAt" IS NOT NULL)
    ),
  -- A mock deployment can never be mistaken for live provider evidence, and a
  -- live one can never carry fixture hashes.
  ADD CONSTRAINT "ReceptionistAgentDeployment_mock_fingerprint_check"
    CHECK (
      ("mock" AND "promptHash" LIKE 'mock:%' AND "beginMessageHash" LIKE 'mock:%' AND "toolFingerprint" LIKE 'mock:%')
      OR (
        NOT "mock"
        AND "promptHash" ~ '^[a-f0-9]{64}$'
        AND "beginMessageHash" ~ '^[a-f0-9]{64}$'
        AND "toolFingerprint" ~ '^[a-f0-9]{64}$'
      )
    ),
  ADD CONSTRAINT "ReceptionistAgentDeployment_bound_number_check"
    CHECK (
      (NOT "numberBound" AND "boundPhoneNumber" IS NULL)
      OR ("numberBound" AND "boundPhoneNumber" ~ '^\+[1-9][0-9]{7,14}$')
    );

CREATE UNIQUE INDEX "ReceptionistAgentDeployment_tenantId_id_key"
  ON "ReceptionistAgentDeployment"("tenantId", "id");
CREATE INDEX "ReceptionistAgentDeployment_tenantId_agentId_createdAt_idx"
  ON "ReceptionistAgentDeployment"("tenantId", "agentId", "createdAt");
CREATE INDEX "ReceptionistAgentDeployment_tenantId_campaignId_status_idx"
  ON "ReceptionistAgentDeployment"("tenantId", "campaignId", "status");
CREATE INDEX "ReceptionistAgentDeployment_providerAgentId_providerAgentVersion_idx"
  ON "ReceptionistAgentDeployment"("providerAgentId", "providerAgentVersion");

-- ---------------------------------------------------------------------------
-- Row-level security. 20260730120000_complete_rls_isolation ran its policy loop
-- once, at that migration; a table created afterwards inherits nothing and must
-- declare its own or it would be readable across tenants.
-- ---------------------------------------------------------------------------
ALTER TABLE "ReceptionistAgentDeployment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReceptionistAgentDeployment" FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_receptionist_agent_deployment_select ON "ReceptionistAgentDeployment" FOR SELECT TO app_rls USING (app_rls_tenant_allowed("tenantId"));
CREATE POLICY rls_receptionist_agent_deployment_insert ON "ReceptionistAgentDeployment" FOR INSERT TO app_rls WITH CHECK (app_rls_tenant_allowed("tenantId"));
CREATE POLICY rls_receptionist_agent_deployment_update ON "ReceptionistAgentDeployment" FOR UPDATE TO app_rls USING (app_rls_tenant_allowed("tenantId")) WITH CHECK (app_rls_tenant_allowed("tenantId"));
CREATE POLICY rls_receptionist_agent_deployment_delete ON "ReceptionistAgentDeployment" FOR DELETE TO app_rls USING (app_rls_tenant_allowed("tenantId"));
REVOKE ALL ON TABLE "ReceptionistAgentDeployment" FROM app_rls;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ReceptionistAgentDeployment" TO app_rls;

-- ---------------------------------------------------------------------------
-- Agent columns: who last attempted verification, the prompt hash the provider
-- reported, and the deployment the agent currently runs.
--
-- `voice` stays NOT NULL. The provider requires a voice_id to create an agent
-- and the Studio type has always been a string; the legacy default value is
-- treated as a placeholder by readiness instead, which tells the operator to
-- choose a voice rather than silently deploying "Adrian".
-- ---------------------------------------------------------------------------
ALTER TABLE "ReceptionistAgent"
  ADD COLUMN "providerLastAttemptSource" "ReceptionistAttemptSource" NOT NULL DEFAULT 'USER',
  ADD COLUMN "providerPromptHash" text,
  ADD COLUMN "currentDeploymentId" uuid;

-- Deliberately NOT a foreign key with a cascade: a deployment row is deleted
-- only when its agent is, and the deployment→agent FK above already cascades in
-- that direction. Declaring the inverse as an enforced FK would create a
-- circular dependency between the two deletes. The id is resolved by an
-- explicit tenant-scoped read, and a dangling value reads as "no current
-- deployment", which fails closed.
CREATE INDEX "ReceptionistAgent_currentDeploymentId_idx"
  ON "ReceptionistAgent"("currentDeploymentId");
