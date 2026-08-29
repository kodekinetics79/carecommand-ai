-- Campaign dispatch fence + default-OFF live activation.
--
-- WHY
-- ---
-- Regulated campaign submission failed closed in commsProvider.sendMessage
-- because the consent/opt-out decision and the provider hand-off were not
-- linearized: an opt-out captured on an AI receptionist call could commit
-- between the last suppression check and the provider request.
--
-- The receptionist appointment-confirmation outbox already solved exactly this
-- with NotificationDeliveryAttempt phases + pg_advisory_xact_lock. These two
-- tables port that mechanism to per-recipient campaign sends.
--
--  * CampaignSubmissionClaim is the durable, append-only submission evidence.
--    PROVIDER_INTENT commits inside the SAME transaction that re-reads
--    suppression while holding the receptionist suppression advisory fences, so
--    an opt-out is either seen by that decision or lands strictly after it.
--    SUBMISSION_CLAIM is appended immediately before provider I/O; its unique
--    index is what turns a second concurrent worker into a no-op instead of a
--    duplicate message.
--
--  * CampaignLiveDispatchActivation is the per-tenant, per-channel switch for
--    live regulated outreach. It is DEFAULT OFF by construction: no column
--    default, no seed, and deliberately NO backfill below. Absence means off.
--    This migration activates nobody, and there is no statement here that could.
--
-- Both tables are ordinary tenant-owned tables (a real `tenantId UUID NOT NULL`
-- with a Tenant FK), so they take the same four RLS policies and CRUD grants as
-- every other MUTABLE table in server/lib/rlsTableAdapters.ts. Append-only-ness
-- of CampaignSubmissionClaim is enforced by the unique index and by the code
-- paths that write it, not by a grant.

SET lock_timeout = '5s';
SET statement_timeout = '5min';

-- CreateTable
CREATE TABLE "CampaignSubmissionClaim" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "campaignId" UUID NOT NULL,
    "campaignDeliveryId" UUID NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "phase" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "destinationHash" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "launchFingerprint" TEXT NOT NULL,
    "consentEvidence" TEXT NOT NULL,
    "submissionMode" TEXT NOT NULL,
    "dispatchActivationId" UUID,
    "provider" TEXT,
    "providerMessageId" TEXT,
    "failureCode" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "CampaignSubmissionClaim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignLiveDispatchActivation" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "channel" TEXT NOT NULL,
    "activatedByUserId" UUID NOT NULL,
    "activatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attestation" TEXT NOT NULL,
    "attestationHash" TEXT NOT NULL,
    "fenceVersion" TEXT NOT NULL,
    "providerSnapshot" JSONB NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedByUserId" UUID,
    "revocationReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignLiveDispatchActivation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CampaignDelivery_tenantId_id_key" ON "CampaignDelivery"("tenantId", "id");

-- CreateIndex
CREATE INDEX "CampaignSubmissionClaim_tenantId_phase_startedAt_idx" ON "CampaignSubmissionClaim"("tenantId", "phase", "startedAt");

-- CreateIndex
CREATE INDEX "CampaignSubmissionClaim_tenantId_campaignId_startedAt_idx" ON "CampaignSubmissionClaim"("tenantId", "campaignId", "startedAt");

-- CreateIndex
-- The exactly-once guarantee. Two workers that somehow both reach the provider
-- boundary for the same recipient attempt cannot both insert SUBMISSION_CLAIM.
CREATE UNIQUE INDEX "CampaignSubmissionClaim_tenantId_campaignDeliveryId_attempt_key" ON "CampaignSubmissionClaim"("tenantId", "campaignDeliveryId", "attemptNumber", "phase");

-- CreateIndex
CREATE INDEX "CampaignLiveDispatchActivation_tenantId_revokedAt_idx" ON "CampaignLiveDispatchActivation"("tenantId", "revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignLiveDispatchActivation_tenantId_channel_key" ON "CampaignLiveDispatchActivation"("tenantId", "channel");

-- AddForeignKey
ALTER TABLE "CampaignSubmissionClaim" ADD CONSTRAINT "CampaignSubmissionClaim_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- Tenant-scoped composite FK: a claim can never be attached to a delivery row
-- belonging to another tenant, even if an id is guessed.
ALTER TABLE "CampaignSubmissionClaim" ADD CONSTRAINT "CampaignSubmissionClaim_tenantId_campaignDeliveryId_fkey" FOREIGN KEY ("tenantId", "campaignDeliveryId") REFERENCES "CampaignDelivery"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignLiveDispatchActivation" ADD CONSTRAINT "CampaignLiveDispatchActivation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Row-level security. 20260730120000_complete_rls_isolation applied its policy
-- loop once, at that migration; tables created afterwards must declare their own
-- or they would be readable across tenants.
-- ---------------------------------------------------------------------------

ALTER TABLE "CampaignSubmissionClaim" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CampaignSubmissionClaim" FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_campaign_submission_claim_select ON "CampaignSubmissionClaim" FOR SELECT TO app_rls USING (app_rls_tenant_allowed("tenantId"));
CREATE POLICY rls_campaign_submission_claim_insert ON "CampaignSubmissionClaim" FOR INSERT TO app_rls WITH CHECK (app_rls_tenant_allowed("tenantId"));
CREATE POLICY rls_campaign_submission_claim_update ON "CampaignSubmissionClaim" FOR UPDATE TO app_rls USING (app_rls_tenant_allowed("tenantId")) WITH CHECK (app_rls_tenant_allowed("tenantId"));
CREATE POLICY rls_campaign_submission_claim_delete ON "CampaignSubmissionClaim" FOR DELETE TO app_rls USING (app_rls_tenant_allowed("tenantId"));
REVOKE ALL ON TABLE "CampaignSubmissionClaim" FROM app_rls;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "CampaignSubmissionClaim" TO app_rls;

ALTER TABLE "CampaignLiveDispatchActivation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CampaignLiveDispatchActivation" FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_campaign_live_dispatch_activation_select ON "CampaignLiveDispatchActivation" FOR SELECT TO app_rls USING (app_rls_tenant_allowed("tenantId"));
CREATE POLICY rls_campaign_live_dispatch_activation_insert ON "CampaignLiveDispatchActivation" FOR INSERT TO app_rls WITH CHECK (app_rls_tenant_allowed("tenantId"));
CREATE POLICY rls_campaign_live_dispatch_activation_update ON "CampaignLiveDispatchActivation" FOR UPDATE TO app_rls USING (app_rls_tenant_allowed("tenantId")) WITH CHECK (app_rls_tenant_allowed("tenantId"));
CREATE POLICY rls_campaign_live_dispatch_activation_delete ON "CampaignLiveDispatchActivation" FOR DELETE TO app_rls USING (app_rls_tenant_allowed("tenantId"));
REVOKE ALL ON TABLE "CampaignLiveDispatchActivation" FROM app_rls;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "CampaignLiveDispatchActivation" TO app_rls;

-- ---------------------------------------------------------------------------
-- DEFAULT OFF, on purpose.
--
-- There is intentionally no INSERT into "CampaignLiveDispatchActivation" in this
-- migration. No existing tenant is activated by deploying it, and no tenant can
-- become activated except through POST /v1/crm/live-dispatch-activation, which
-- requires an OWNER/ADMIN, a configured provider for the channel, and a typed
-- attestation. server/test/campaignDispatchFence.integration.test.ts asserts
-- that this file contains no such INSERT.
-- ---------------------------------------------------------------------------
