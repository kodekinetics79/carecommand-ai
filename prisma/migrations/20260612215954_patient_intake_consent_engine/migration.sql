-- Patient Intake + Consent Engine (Phase A). All RLS-ready, RLS not enabled.
CREATE TABLE "PatientIntakePacket" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "patientId" UUID,
  "leadId" UUID,
  "appointmentId" UUID,
  "appointmentRequestId" UUID,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "source" TEXT NOT NULL DEFAULT 'staff',
  "publicTokenHash" TEXT,
  "tokenExpiresAt" TIMESTAMP(3),
  "startedAt" TIMESTAMP(3),
  "submittedAt" TIMESTAMP(3),
  "reviewedAt" TIMESTAMP(3),
  "reviewedByUserId" UUID,
  "createdByUserId" UUID,
  "readinessScore" INTEGER NOT NULL DEFAULT 0,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PatientIntakePacket_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PatientIntakePacket_publicTokenHash_key" ON "PatientIntakePacket"("publicTokenHash");
CREATE INDEX "PatientIntakePacket_tenantId_status_createdAt_idx" ON "PatientIntakePacket"("tenantId","status","createdAt");
CREATE INDEX "PatientIntakePacket_tenantId_appointmentId_idx" ON "PatientIntakePacket"("tenantId","appointmentId");
CREATE INDEX "PatientIntakePacket_tenantId_appointmentRequestId_idx" ON "PatientIntakePacket"("tenantId","appointmentRequestId");

CREATE TABLE "PatientIntakeSection" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "packetId" UUID NOT NULL,
  "sectionType" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "data" JSONB,
  "completedAt" TIMESTAMP(3),
  "reviewedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PatientIntakeSection_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PatientIntakeSection_packetId_sectionType_key" ON "PatientIntakeSection"("packetId","sectionType");
CREATE INDEX "PatientIntakeSection_tenantId_status_idx" ON "PatientIntakeSection"("tenantId","status");

CREATE TABLE "PatientIntakeDocument" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "packetId" UUID NOT NULL,
  "sectionId" UUID,
  "documentType" TEXT NOT NULL,
  "fileName" TEXT,
  "mimeType" TEXT,
  "fileSize" INTEGER,
  "storageProvider" TEXT,
  "storageKey" TEXT,
  "fileHash" TEXT,
  "status" TEXT NOT NULL DEFAULT 'metadata_only',
  "uploadedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PatientIntakeDocument_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PatientIntakeDocument_tenantId_packetId_idx" ON "PatientIntakeDocument"("tenantId","packetId");

CREATE TABLE "PatientConsentRecord" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "packetId" UUID,
  "patientId" UUID,
  "leadId" UUID,
  "consentType" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'unknown',
  "version" TEXT NOT NULL DEFAULT 'v1',
  "consentTextSnapshot" TEXT,
  "source" TEXT NOT NULL DEFAULT 'intake',
  "acceptedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "ipAddressHash" TEXT,
  "userAgentHash" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PatientConsentRecord_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PatientConsentRecord_tenantId_consentType_status_idx" ON "PatientConsentRecord"("tenantId","consentType","status");
CREATE INDEX "PatientConsentRecord_tenantId_patientId_idx" ON "PatientConsentRecord"("tenantId","patientId");

ALTER TABLE "PatientIntakePacket" ADD CONSTRAINT "PatientIntakePacket_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PatientIntakePacket" ADD CONSTRAINT "PatientIntakePacket_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PatientIntakeSection" ADD CONSTRAINT "PatientIntakeSection_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PatientIntakeSection" ADD CONSTRAINT "PatientIntakeSection_packetId_fkey" FOREIGN KEY ("packetId") REFERENCES "PatientIntakePacket"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PatientIntakeDocument" ADD CONSTRAINT "PatientIntakeDocument_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PatientIntakeDocument" ADD CONSTRAINT "PatientIntakeDocument_packetId_fkey" FOREIGN KEY ("packetId") REFERENCES "PatientIntakePacket"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PatientConsentRecord" ADD CONSTRAINT "PatientConsentRecord_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PatientConsentRecord" ADD CONSTRAINT "PatientConsentRecord_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PatientConsentRecord" ADD CONSTRAINT "PatientConsentRecord_packetId_fkey" FOREIGN KEY ("packetId") REFERENCES "PatientIntakePacket"("id") ON DELETE SET NULL ON UPDATE CASCADE;
