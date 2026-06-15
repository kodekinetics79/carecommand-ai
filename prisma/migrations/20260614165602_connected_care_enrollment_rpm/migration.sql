-- CreateTable
CREATE TABLE "PatientDeviceEnrollment" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "branchId" UUID,
    "providerKey" TEXT NOT NULL,
    "deviceId" UUID,
    "programType" TEXT NOT NULL DEFAULT 'rpm',
    "status" TEXT NOT NULL DEFAULT 'active',
    "externalRef" TEXT,
    "consentId" UUID,
    "enrolledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PatientDeviceEnrollment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceProviderSyncLog" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "providerKind" TEXT NOT NULL,
    "providerKey" TEXT NOT NULL,
    "direction" TEXT NOT NULL DEFAULT 'inbound',
    "event" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "httpStatus" INTEGER,
    "signatureValid" BOOLEAN,
    "readingsIngested" INTEGER NOT NULL DEFAULT 0,
    "alertsCreated" INTEGER NOT NULL DEFAULT 0,
    "message" TEXT,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceProviderSyncLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PatientConsent" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "consentType" TEXT NOT NULL DEFAULT 'rpm',
    "granted" BOOLEAN NOT NULL DEFAULT false,
    "method" TEXT,
    "grantedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PatientConsent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RPMBillingReadiness" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "readingDays" INTEGER NOT NULL DEFAULT 0,
    "reviewMinutes" INTEGER NOT NULL DEFAULT 0,
    "communicationFlag" BOOLEAN NOT NULL DEFAULT false,
    "providerSignoffUserId" UUID,
    "providerSignoffAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'MISSING_REQUIREMENTS',
    "missingRequirements" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RPMBillingReadiness_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PatientDeviceEnrollment_tenantId_status_idx" ON "PatientDeviceEnrollment"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PatientDeviceEnrollment_tenantId_patientId_providerKey_key" ON "PatientDeviceEnrollment"("tenantId", "patientId", "providerKey");

-- CreateIndex
CREATE INDEX "DeviceProviderSyncLog_tenantId_createdAt_idx" ON "DeviceProviderSyncLog"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "DeviceProviderSyncLog_tenantId_providerKey_createdAt_idx" ON "DeviceProviderSyncLog"("tenantId", "providerKey", "createdAt");

-- CreateIndex
CREATE INDEX "PatientConsent_tenantId_consentType_granted_idx" ON "PatientConsent"("tenantId", "consentType", "granted");

-- CreateIndex
CREATE UNIQUE INDEX "PatientConsent_tenantId_patientId_consentType_key" ON "PatientConsent"("tenantId", "patientId", "consentType");

-- CreateIndex
CREATE INDEX "RPMBillingReadiness_tenantId_status_idx" ON "RPMBillingReadiness"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "RPMBillingReadiness_tenantId_patientId_periodStart_key" ON "RPMBillingReadiness"("tenantId", "patientId", "periodStart");

-- AddForeignKey
ALTER TABLE "PatientDeviceEnrollment" ADD CONSTRAINT "PatientDeviceEnrollment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceProviderSyncLog" ADD CONSTRAINT "DeviceProviderSyncLog_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientConsent" ADD CONSTRAINT "PatientConsent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RPMBillingReadiness" ADD CONSTRAINT "RPMBillingReadiness_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
