-- Platform Control Tower (Phase 2): commercial + governance tables.

ALTER TABLE "TenantSecurityPolicy" ADD COLUMN IF NOT EXISTS "sessionsRevokedAt" TIMESTAMP(3);

CREATE TABLE "TenantBilling" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "cycle" TEXT NOT NULL DEFAULT 'monthly',
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "mrr" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "paymentStatus" TEXT NOT NULL DEFAULT 'ok',
  "renewalDate" TIMESTAMP(3),
  "gracePeriodDays" INTEGER NOT NULL DEFAULT 0,
  "provider" TEXT,
  "externalRef" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TenantBilling_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TenantBilling_tenantId_key" ON "TenantBilling"("tenantId");
CREATE INDEX "TenantBilling_paymentStatus_idx" ON "TenantBilling"("paymentStatus");

CREATE TABLE "TenantUsageLimit" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "key" TEXT NOT NULL,
  "limitValue" INTEGER,
  "used" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TenantUsageLimit_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TenantUsageLimit_tenantId_key_key" ON "TenantUsageLimit"("tenantId", "key");
CREATE INDEX "TenantUsageLimit_tenantId_idx" ON "TenantUsageLimit"("tenantId");

CREATE TABLE "TenantAiUsage" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "aiCreditsUsed" INTEGER NOT NULL DEFAULT 0,
  "aiCreditsLimit" INTEGER,
  "receptionistMinutes" INTEGER NOT NULL DEFAULT 0,
  "campaignGenerations" INTEGER NOT NULL DEFAULT 0,
  "reportGenerations" INTEGER NOT NULL DEFAULT 0,
  "modelTier" TEXT NOT NULL DEFAULT 'standard',
  "overageAllowed" BOOLEAN NOT NULL DEFAULT false,
  "killSwitch" BOOLEAN NOT NULL DEFAULT false,
  "killSwitchReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TenantAiUsage_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TenantAiUsage_tenantId_key" ON "TenantAiUsage"("tenantId");

CREATE TABLE "SupportAccessSession" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "platformUserId" UUID,
  "operatorEmail" TEXT,
  "reason" TEXT NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "endedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SupportAccessSession_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SupportAccessSession_tenantId_endedAt_idx" ON "SupportAccessSession"("tenantId", "endedAt");
CREATE INDEX "SupportAccessSession_expiresAt_idx" ON "SupportAccessSession"("expiresAt");

CREATE TABLE "PlatformAnnouncement" (
  "id" UUID NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "severity" TEXT NOT NULL DEFAULT 'info',
  "audience" TEXT NOT NULL DEFAULT 'all',
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdById" UUID,
  "createdByName" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PlatformAnnouncement_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PlatformAnnouncement_active_createdAt_idx" ON "PlatformAnnouncement"("active", "createdAt");
