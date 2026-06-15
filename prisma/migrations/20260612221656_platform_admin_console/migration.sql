-- Platform Admin Console (Phase B): platform identity + audit + tenant status.
ALTER TABLE "Tenant" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'active';

CREATE TABLE "PlatformUser" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "email" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "passwordHash" TEXT NOT NULL,
  "role" TEXT NOT NULL DEFAULT 'PLATFORM_SUPPORT',
  "status" TEXT NOT NULL DEFAULT 'active',
  "mfaEnabled" BOOLEAN NOT NULL DEFAULT false,
  "mfaSecretEnc" TEXT,
  "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
  "lockedUntil" TIMESTAMP(3),
  "passwordChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastLoginAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PlatformUser_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PlatformUser_email_key" ON "PlatformUser"("email");
CREATE INDEX "PlatformUser_status_idx" ON "PlatformUser"("status");

CREATE TABLE "PlatformAuditEvent" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "platformUserId" UUID,
  "action" TEXT NOT NULL,
  "targetType" TEXT NOT NULL,
  "targetId" TEXT,
  "tenantId" UUID,
  "metadata" JSONB,
  "ipHash" TEXT,
  "userAgentHash" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PlatformAuditEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PlatformAuditEvent_action_createdAt_idx" ON "PlatformAuditEvent"("action","createdAt");
CREATE INDEX "PlatformAuditEvent_tenantId_createdAt_idx" ON "PlatformAuditEvent"("tenantId","createdAt");
