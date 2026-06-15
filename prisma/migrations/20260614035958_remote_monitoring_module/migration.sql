-- CreateTable
CREATE TABLE "MonitoringRule" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'organization',
    "branchId" UUID,
    "patientId" UUID,
    "deviceType" TEXT,
    "readingType" TEXT NOT NULL,
    "minValue" DOUBLE PRECISION,
    "maxValue" DOUBLE PRECISION,
    "criticalMin" DOUBLE PRECISION,
    "criticalMax" DOUBLE PRECISION,
    "missedAfterHours" INTEGER,
    "quietHoursStart" INTEGER,
    "quietHoursEnd" INTEGER,
    "escalationMinutes" INTEGER,
    "assignedRole" TEXT,
    "assignedToUserId" UUID,
    "notifyChannels" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MonitoringRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceReading" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "patientId" UUID,
    "deviceId" UUID,
    "branchId" UUID,
    "readingType" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "numericValue" DOUBLE PRECISION,
    "valueSecondary" DOUBLE PRECISION,
    "unit" TEXT,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL DEFAULT 'device',
    "validationStatus" TEXT NOT NULL DEFAULT 'valid',
    "rawPayload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceReading_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReadingAlert" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "patientId" UUID,
    "deviceId" UUID,
    "readingId" UUID,
    "branchId" UUID,
    "severity" TEXT NOT NULL,
    "alertType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "assignedToUserId" UUID,
    "generatedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "ReadingAlert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationEvent" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "alertId" UUID,
    "patientId" UUID,
    "recipientType" TEXT NOT NULL,
    "recipientUserId" UUID,
    "recipientLabel" TEXT,
    "channel" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "failureReason" TEXT,
    "consentChecked" BOOLEAN NOT NULL DEFAULT false,
    "consentResult" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "NotificationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MorningBriefingSignal" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "branchId" UUID,
    "signalType" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT,
    "severity" TEXT NOT NULL DEFAULT 'info',
    "metricValue" INTEGER,
    "patientId" UUID,
    "forDate" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MorningBriefingSignal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MonitoringRule_tenantId_readingType_active_idx" ON "MonitoringRule"("tenantId", "readingType", "active");

-- CreateIndex
CREATE INDEX "DeviceReading_tenantId_capturedAt_idx" ON "DeviceReading"("tenantId", "capturedAt");

-- CreateIndex
CREATE INDEX "DeviceReading_tenantId_patientId_readingType_capturedAt_idx" ON "DeviceReading"("tenantId", "patientId", "readingType", "capturedAt");

-- CreateIndex
CREATE INDEX "ReadingAlert_tenantId_status_severity_idx" ON "ReadingAlert"("tenantId", "status", "severity");

-- CreateIndex
CREATE INDEX "ReadingAlert_tenantId_patientId_idx" ON "ReadingAlert"("tenantId", "patientId");

-- CreateIndex
CREATE INDEX "NotificationEvent_tenantId_createdAt_idx" ON "NotificationEvent"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "NotificationEvent_tenantId_alertId_idx" ON "NotificationEvent"("tenantId", "alertId");

-- CreateIndex
CREATE INDEX "MorningBriefingSignal_tenantId_forDate_idx" ON "MorningBriefingSignal"("tenantId", "forDate");

-- AddForeignKey
ALTER TABLE "MonitoringRule" ADD CONSTRAINT "MonitoringRule_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceReading" ADD CONSTRAINT "DeviceReading_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReadingAlert" ADD CONSTRAINT "ReadingAlert_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationEvent" ADD CONSTRAINT "NotificationEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MorningBriefingSignal" ADD CONSTRAINT "MorningBriefingSignal_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
