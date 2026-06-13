-- CreateEnum
CREATE TYPE "SubscriptionRequestType" AS ENUM ('UPGRADE', 'DOWNGRADE', 'ADDON_CHANGE', 'CANCEL');

-- CreateEnum
CREATE TYPE "SubscriptionRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateTable
CREATE TABLE "TenantSubscriptionRequest" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "requestedPlanId" UUID,
    "requestedAddonKeys" TEXT[],
    "requestType" "SubscriptionRequestType" NOT NULL,
    "status" "SubscriptionRequestStatus" NOT NULL DEFAULT 'PENDING',
    "requestedByUserId" UUID,
    "reviewedByUserId" UUID,
    "notes" TEXT,
    "reviewerNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantSubscriptionRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TenantSubscriptionRequest_tenantId_status_idx" ON "TenantSubscriptionRequest"("tenantId", "status");

-- CreateIndex
CREATE INDEX "TenantSubscriptionRequest_status_createdAt_idx" ON "TenantSubscriptionRequest"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "TenantSubscriptionRequest" ADD CONSTRAINT "TenantSubscriptionRequest_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantSubscriptionRequest" ADD CONSTRAINT "TenantSubscriptionRequest_requestedPlanId_fkey" FOREIGN KEY ("requestedPlanId") REFERENCES "SubscriptionPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;
