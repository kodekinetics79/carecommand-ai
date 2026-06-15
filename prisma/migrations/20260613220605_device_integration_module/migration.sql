-- AlterTable
ALTER TABLE "AIRecommendation" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "AutomationRule" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "BusinessEvent" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "CampaignDelivery" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "CampaignSuppression" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "CommunicationConsent" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "OperationalSignal" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "PatientConsentRecord" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "PatientIntakeDocument" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "PatientIntakePacket" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "PatientIntakeSection" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "PatientPortalAccount" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "PlatformAnnouncement" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "PlatformAuditEvent" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "PlatformConfig" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "PlatformIntegration" ALTER COLUMN "setFields" DROP DEFAULT,
ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "PlatformUser" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "ServiceCatalogItem" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "TenantAiUsage" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "TenantBilling" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "TenantUsageLimit" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- CreateTable
CREATE TABLE "Device" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "branchId" UUID,
    "name" TEXT NOT NULL,
    "deviceType" TEXT NOT NULL,
    "vendor" TEXT,
    "model" TEXT,
    "serialNumber" TEXT,
    "connectionType" TEXT NOT NULL DEFAULT 'network',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "location" TEXT,
    "firmwareVersion" TEXT,
    "notes" TEXT,
    "lastSeenAt" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Device_tenantId_active_idx" ON "Device"("tenantId", "active");

-- CreateIndex
CREATE INDEX "Device_tenantId_branchId_idx" ON "Device"("tenantId", "branchId");

-- CreateIndex
CREATE INDEX "Device_tenantId_status_idx" ON "Device"("tenantId", "status");

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
