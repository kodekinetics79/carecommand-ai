-- CreateEnum
CREATE TYPE "OutboundCampaignStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'RUNNING', 'PAUSED', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "CallTargetStatus" AS ENUM ('PENDING', 'CALLING', 'COMPLETED', 'FAILED', 'OPTED_OUT');

-- CreateEnum
CREATE TYPE "OutboundBookingMode" AS ENUM ('APPOINTMENT_REQUEST_ONLY', 'DIRECT_BOOKING_IF_SLOT_AVAILABLE');

-- CreateEnum
CREATE TYPE "AppointmentRequestStatus" AS ENUM ('PENDING_REVIEW', 'BOOKED', 'REJECTED', 'MISSING_INFO', 'DUPLICATE');

-- AlterTable
ALTER TABLE "ReceptionistCallLog" ADD COLUMN     "outboundCampaignId" UUID,
ADD COLUMN     "targetId" UUID;

-- CreateTable
CREATE TABLE "ReceptionistOutboundCampaign" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "clinicId" UUID NOT NULL,
    "agentId" UUID,
    "name" TEXT NOT NULL,
    "script" TEXT NOT NULL,
    "requiredFields" TEXT[],
    "customQuestions" JSONB,
    "consentText" TEXT,
    "humanHandoffInstruction" TEXT,
    "bookingMode" "OutboundBookingMode" NOT NULL DEFAULT 'APPOINTMENT_REQUEST_ONLY',
    "defaultBranchId" UUID,
    "defaultService" TEXT,
    "quietHoursStart" TEXT,
    "quietHoursEnd" TEXT,
    "maxRetryAttempts" INTEGER NOT NULL DEFAULT 1,
    "status" "OutboundCampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReceptionistOutboundCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReceptionistCallTarget" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "campaignId" UUID NOT NULL,
    "patientId" UUID,
    "leadId" UUID,
    "firstName" TEXT,
    "lastName" TEXT,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "status" "CallTargetStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastCallLogId" UUID,
    "lastOutcome" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReceptionistCallTarget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppointmentRequest" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "branchId" UUID,
    "patientId" UUID,
    "leadId" UUID,
    "campaignId" UUID,
    "callLogId" UUID,
    "requestedService" TEXT,
    "requestedDateTime" TIMESTAMP(3),
    "collectedName" TEXT,
    "collectedPhone" TEXT,
    "collectedEmail" TEXT,
    "status" "AppointmentRequestStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "source" TEXT NOT NULL DEFAULT 'ai_receptionist',
    "rawCollectedFields" JSONB,
    "missingFields" TEXT[],
    "outcomeReason" TEXT,
    "bookedAppointmentId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppointmentRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReceptionistOutboundCampaign_tenantId_status_idx" ON "ReceptionistOutboundCampaign"("tenantId", "status");

-- CreateIndex
CREATE INDEX "ReceptionistOutboundCampaign_tenantId_clinicId_idx" ON "ReceptionistOutboundCampaign"("tenantId", "clinicId");

-- CreateIndex
CREATE INDEX "ReceptionistCallTarget_tenantId_campaignId_status_idx" ON "ReceptionistCallTarget"("tenantId", "campaignId", "status");

-- CreateIndex
CREATE INDEX "AppointmentRequest_tenantId_status_createdAt_idx" ON "AppointmentRequest"("tenantId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "AppointmentRequest_tenantId_callLogId_idx" ON "AppointmentRequest"("tenantId", "callLogId");

-- CreateIndex
CREATE INDEX "ReceptionistCallLog_outboundCampaignId_idx" ON "ReceptionistCallLog"("outboundCampaignId");

-- AddForeignKey
ALTER TABLE "ReceptionistCallLog" ADD CONSTRAINT "ReceptionistCallLog_outboundCampaignId_fkey" FOREIGN KEY ("outboundCampaignId") REFERENCES "ReceptionistOutboundCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceptionistOutboundCampaign" ADD CONSTRAINT "ReceptionistOutboundCampaign_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceptionistOutboundCampaign" ADD CONSTRAINT "ReceptionistOutboundCampaign_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "ReceptionistClinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceptionistOutboundCampaign" ADD CONSTRAINT "ReceptionistOutboundCampaign_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "ReceptionistAgent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceptionistCallTarget" ADD CONSTRAINT "ReceptionistCallTarget_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceptionistCallTarget" ADD CONSTRAINT "ReceptionistCallTarget_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "ReceptionistOutboundCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentRequest" ADD CONSTRAINT "AppointmentRequest_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentRequest" ADD CONSTRAINT "AppointmentRequest_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentRequest" ADD CONSTRAINT "AppointmentRequest_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentRequest" ADD CONSTRAINT "AppointmentRequest_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;
