-- CRM Campaign / Reactivation engine (Phase A). All RLS-ready, RLS not enabled.
ALTER TYPE "CampaignStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';

ALTER TABLE "Campaign" ADD COLUMN "campaignType" TEXT;
ALTER TABLE "Campaign" ADD COLUMN "audienceType" TEXT;
ALTER TABLE "Campaign" ADD COLUMN "campaignChannel" TEXT;
ALTER TABLE "Campaign" ADD COLUMN "messageSubject" TEXT;
ALTER TABLE "Campaign" ADD COLUMN "messageTemplate" TEXT;
ALTER TABLE "Campaign" ADD COLUMN "draftSource" TEXT DEFAULT 'rule_based';
ALTER TABLE "Campaign" ADD COLUMN "requiresApproval" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Campaign" ADD COLUMN "approvedByUserId" UUID;
ALTER TABLE "Campaign" ADD COLUMN "approvedAt" TIMESTAMP(3);
ALTER TABLE "Campaign" ADD COLUMN "scheduledAt" TIMESTAMP(3);
ALTER TABLE "Campaign" ADD COLUMN "quietHours" JSONB;
ALTER TABLE "Campaign" ADD COLUMN "createdByUserId" UUID;

CREATE TABLE "CommunicationConsent" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "patientId" UUID,
  "leadId" UUID,
  "channel" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'unknown',
  "source" TEXT NOT NULL DEFAULT 'staff',
  "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt" TIMESTAMP(3),
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CommunicationConsent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CommunicationConsent_tenantId_patientId_leadId_channel_key" ON "CommunicationConsent"("tenantId","patientId","leadId","channel");
CREATE INDEX "CommunicationConsent_tenantId_channel_status_idx" ON "CommunicationConsent"("tenantId","channel","status");

CREATE TABLE "CampaignSuppression" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "patientId" UUID,
  "leadId" UUID,
  "channel" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CampaignSuppression_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "CampaignSuppression_tenantId_channel_active_idx" ON "CampaignSuppression"("tenantId","channel","active");

CREATE TABLE "CampaignDelivery" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "campaignId" UUID NOT NULL,
  "patientId" UUID,
  "leadId" UUID,
  "channel" TEXT NOT NULL,
  "destinationMasked" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "provider" TEXT,
  "providerMessageId" TEXT,
  "idempotencyKey" TEXT,
  "failureReason" TEXT,
  "sentAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CampaignDelivery_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CampaignDelivery_campaignId_patientId_leadId_channel_key" ON "CampaignDelivery"("campaignId","patientId","leadId","channel");
CREATE INDEX "CampaignDelivery_tenantId_status_createdAt_idx" ON "CampaignDelivery"("tenantId","status","createdAt");

ALTER TABLE "CommunicationConsent" ADD CONSTRAINT "CommunicationConsent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CommunicationConsent" ADD CONSTRAINT "CommunicationConsent_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CampaignSuppression" ADD CONSTRAINT "CampaignSuppression_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CampaignSuppression" ADD CONSTRAINT "CampaignSuppression_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CampaignDelivery" ADD CONSTRAINT "CampaignDelivery_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CampaignDelivery" ADD CONSTRAINT "CampaignDelivery_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
