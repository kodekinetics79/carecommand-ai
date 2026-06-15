-- CreateTable
CREATE TABLE "InsuranceProvider" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "providerKey" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'INSURANCE',
    "mode" TEXT NOT NULL DEFAULT 'sandbox',
    "status" TEXT NOT NULL DEFAULT 'NOT_CONFIGURED',
    "encryptedConfig" TEXT,
    "lastHealthCheckAt" TIMESTAMP(3),
    "lastHealthStatus" TEXT,
    "healthMessage" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InsuranceProvider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceProvider" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "providerKey" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'sandbox',
    "status" TEXT NOT NULL DEFAULT 'NOT_CONFIGURED',
    "encryptedConfig" TEXT,
    "webhookConfigured" BOOLEAN NOT NULL DEFAULT false,
    "lastHealthCheckAt" TIMESTAMP(3),
    "lastHealthStatus" TEXT,
    "healthMessage" TEXT,
    "lastSyncAt" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeviceProvider_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InsuranceProvider_tenantId_status_idx" ON "InsuranceProvider"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "InsuranceProvider_tenantId_providerKey_key" ON "InsuranceProvider"("tenantId", "providerKey");

-- CreateIndex
CREATE INDEX "DeviceProvider_tenantId_status_idx" ON "DeviceProvider"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceProvider_tenantId_providerKey_key" ON "DeviceProvider"("tenantId", "providerKey");

-- AddForeignKey
ALTER TABLE "InsuranceProvider" ADD CONSTRAINT "InsuranceProvider_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceProvider" ADD CONSTRAINT "DeviceProvider_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
