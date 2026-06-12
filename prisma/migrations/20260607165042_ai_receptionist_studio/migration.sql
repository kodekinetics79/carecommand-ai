-- CreateEnum
CREATE TYPE "ReceptionistFieldType" AS ENUM ('FIRST_NAME', 'LAST_NAME', 'PHONE', 'EMAIL', 'PREFERRED_DATE', 'PREFERRED_TIME', 'PREFERRED_LOCATION', 'PATIENT_STATUS', 'INSURANCE_PROVIDER', 'REASON_FOR_VISIT', 'PREFERRED_PROVIDER', 'LANGUAGE_PREFERENCE', 'CONSENT', 'CUSTOM_TEXT', 'CUSTOM_DROPDOWN', 'CUSTOM_YES_NO');

-- CreateEnum
CREATE TYPE "ReceptionistCampaignStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ReceptionistCallOutcome" AS ENUM ('IN_PROGRESS', 'BOOKED', 'NOT_INTERESTED', 'NO_ANSWER', 'VOICEMAIL', 'ESCALATED', 'OPTED_OUT', 'FAILED');

-- CreateEnum
CREATE TYPE "ReceptionistRequestStatus" AS ENUM ('PENDING', 'CONFIRMED', 'CANCELED', 'COMPLETED', 'NO_SLOTS');

-- CreateEnum
CREATE TYPE "ReceptionistOptOutChannel" AS ENUM ('VOICE', 'SMS', 'EMAIL', 'ALL');

-- CreateTable
CREATE TABLE "ReceptionistClinic" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "logoUrl" TEXT,
    "phone" TEXT NOT NULL,
    "website" TEXT,
    "addressLine" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'America/New_York',
    "defaultLanguage" TEXT NOT NULL DEFAULT 'en-US',
    "complianceDisclosure" TEXT NOT NULL DEFAULT 'Hi, this is your AI assistant calling on behalf of the clinic.',
    "humanFallbackNumber" TEXT,
    "doNotContactPolicy" TEXT NOT NULL DEFAULT 'If the person asks not to be contacted again, confirm politely and mark them do-not-contact.',
    "workingHours" JSONB,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReceptionistClinic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReceptionistLocation" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "clinicId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "phone" TEXT,
    "timezone" TEXT,
    "workingHours" JSONB,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReceptionistLocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReceptionistAgent" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "clinicId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "voice" TEXT NOT NULL DEFAULT '11labs-Adrian',
    "tone" TEXT NOT NULL DEFAULT 'Warm and professional',
    "language" TEXT NOT NULL DEFAULT 'en-US',
    "persona" TEXT,
    "greetingOverride" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReceptionistAgent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReceptionistCampaign" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "clinicId" UUID NOT NULL,
    "agentId" UUID,
    "name" TEXT NOT NULL,
    "campaignType" TEXT NOT NULL DEFAULT 'Reactivation',
    "status" "ReceptionistCampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "offerTitle" TEXT NOT NULL,
    "offerDescription" TEXT NOT NULL,
    "offerScript" TEXT NOT NULL,
    "appointmentType" TEXT NOT NULL,
    "bookingRules" JSONB,
    "eligibleLocationIds" UUID[],
    "smsConfirmation" BOOLEAN NOT NULL DEFAULT true,
    "emailConfirmation" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReceptionistCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReceptionistIntakeField" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "campaignId" UUID NOT NULL,
    "fieldType" "ReceptionistFieldType" NOT NULL,
    "label" TEXT NOT NULL,
    "aiQuestion" TEXT NOT NULL,
    "validationRule" TEXT,
    "placeholder" TEXT,
    "options" TEXT[],
    "required" BOOLEAN NOT NULL DEFAULT true,
    "confirmationRequired" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReceptionistIntakeField_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReceptionistAppointmentRequest" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "clinicId" UUID,
    "campaignId" UUID,
    "locationId" UUID,
    "contactName" TEXT,
    "contactPhone" TEXT,
    "contactEmail" TEXT,
    "appointmentType" TEXT,
    "requestedDate" TEXT,
    "requestedTime" TEXT,
    "bookedSlot" TEXT,
    "status" "ReceptionistRequestStatus" NOT NULL DEFAULT 'PENDING',
    "collectedData" JSONB,
    "notes" TEXT,
    "source" TEXT NOT NULL DEFAULT 'retell',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReceptionistAppointmentRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReceptionistCallLog" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "clinicId" UUID,
    "campaignId" UUID,
    "retellCallId" TEXT,
    "callerName" TEXT,
    "callerPhone" TEXT,
    "direction" TEXT NOT NULL DEFAULT 'outbound',
    "outcome" "ReceptionistCallOutcome" NOT NULL DEFAULT 'IN_PROGRESS',
    "durationSeconds" INTEGER NOT NULL DEFAULT 0,
    "recordingUrl" TEXT,
    "transcriptSummary" TEXT,
    "sentiment" TEXT,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReceptionistCallLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReceptionistOptOut" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "clinicId" UUID,
    "contactPhone" TEXT,
    "contactEmail" TEXT,
    "channel" "ReceptionistOptOutChannel" NOT NULL DEFAULT 'ALL',
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReceptionistOptOut_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReceptionistClinic_tenantId_active_idx" ON "ReceptionistClinic"("tenantId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "ReceptionistClinic_tenantId_name_key" ON "ReceptionistClinic"("tenantId", "name");

-- CreateIndex
CREATE INDEX "ReceptionistLocation_tenantId_clinicId_active_idx" ON "ReceptionistLocation"("tenantId", "clinicId", "active");

-- CreateIndex
CREATE INDEX "ReceptionistAgent_tenantId_clinicId_active_idx" ON "ReceptionistAgent"("tenantId", "clinicId", "active");

-- CreateIndex
CREATE INDEX "ReceptionistCampaign_tenantId_clinicId_status_idx" ON "ReceptionistCampaign"("tenantId", "clinicId", "status");

-- CreateIndex
CREATE INDEX "ReceptionistIntakeField_campaignId_sortOrder_idx" ON "ReceptionistIntakeField"("campaignId", "sortOrder");

-- CreateIndex
CREATE INDEX "ReceptionistAppointmentRequest_tenantId_status_createdAt_idx" ON "ReceptionistAppointmentRequest"("tenantId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "ReceptionistCallLog_tenantId_outcome_createdAt_idx" ON "ReceptionistCallLog"("tenantId", "outcome", "createdAt");

-- CreateIndex
CREATE INDEX "ReceptionistOptOut_tenantId_createdAt_idx" ON "ReceptionistOptOut"("tenantId", "createdAt");

-- AddForeignKey
ALTER TABLE "ReceptionistClinic" ADD CONSTRAINT "ReceptionistClinic_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceptionistLocation" ADD CONSTRAINT "ReceptionistLocation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceptionistLocation" ADD CONSTRAINT "ReceptionistLocation_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "ReceptionistClinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceptionistAgent" ADD CONSTRAINT "ReceptionistAgent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceptionistAgent" ADD CONSTRAINT "ReceptionistAgent_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "ReceptionistClinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceptionistCampaign" ADD CONSTRAINT "ReceptionistCampaign_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceptionistCampaign" ADD CONSTRAINT "ReceptionistCampaign_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "ReceptionistClinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceptionistCampaign" ADD CONSTRAINT "ReceptionistCampaign_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "ReceptionistAgent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceptionistIntakeField" ADD CONSTRAINT "ReceptionistIntakeField_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceptionistIntakeField" ADD CONSTRAINT "ReceptionistIntakeField_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "ReceptionistCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceptionistAppointmentRequest" ADD CONSTRAINT "ReceptionistAppointmentRequest_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceptionistAppointmentRequest" ADD CONSTRAINT "ReceptionistAppointmentRequest_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "ReceptionistClinic"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceptionistAppointmentRequest" ADD CONSTRAINT "ReceptionistAppointmentRequest_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "ReceptionistCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceptionistCallLog" ADD CONSTRAINT "ReceptionistCallLog_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceptionistCallLog" ADD CONSTRAINT "ReceptionistCallLog_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "ReceptionistClinic"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceptionistCallLog" ADD CONSTRAINT "ReceptionistCallLog_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "ReceptionistCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceptionistOptOut" ADD CONSTRAINT "ReceptionistOptOut_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceptionistOptOut" ADD CONSTRAINT "ReceptionistOptOut_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "ReceptionistClinic"("id") ON DELETE SET NULL ON UPDATE CASCADE;
