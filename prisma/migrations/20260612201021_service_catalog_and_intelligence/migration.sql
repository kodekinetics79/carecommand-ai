-- Service Catalog (minimal, RLS-ready) + intelligence foundation (RLS-ready).
ALTER TABLE "Appointment" ADD COLUMN "serviceCatalogItemId" UUID;

CREATE TABLE "ServiceCatalogItem" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "category" TEXT NOT NULL DEFAULT 'general',
  "defaultDurationMinutes" INTEGER NOT NULL DEFAULT 30,
  "defaultAppointmentValue" DECIMAL(12,2),
  "depositRuleId" UUID,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ServiceCatalogItem_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ServiceCatalogItem_tenantId_name_key" ON "ServiceCatalogItem"("tenantId","name");
CREATE INDEX "ServiceCatalogItem_tenantId_active_idx" ON "ServiceCatalogItem"("tenantId","active");

CREATE TABLE "BusinessEvent" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "eventType" TEXT NOT NULL,
  "entityType" TEXT NOT NULL,
  "entityId" TEXT,
  "sourceModule" TEXT NOT NULL,
  "payload" JSONB,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BusinessEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "BusinessEvent_tenantId_eventType_occurredAt_idx" ON "BusinessEvent"("tenantId","eventType","occurredAt");
CREATE INDEX "BusinessEvent_tenantId_entityType_entityId_idx" ON "BusinessEvent"("tenantId","entityType","entityId");

CREATE TABLE "OperationalSignal" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "signalType" TEXT NOT NULL,
  "entityType" TEXT NOT NULL,
  "entityId" TEXT,
  "severity" TEXT NOT NULL DEFAULT 'medium',
  "score" INTEGER NOT NULL DEFAULT 0,
  "reason" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'open',
  "sourceEventId" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OperationalSignal_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OperationalSignal_tenantId_signalType_entityType_entityId_key" ON "OperationalSignal"("tenantId","signalType","entityType","entityId");
CREATE INDEX "OperationalSignal_tenantId_status_severity_idx" ON "OperationalSignal"("tenantId","status","severity");

CREATE TABLE "AIRecommendation" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "signalId" UUID,
  "title" TEXT NOT NULL,
  "recommendationType" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "expectedImpact" TEXT,
  "confidence" INTEGER NOT NULL DEFAULT 50,
  "requiresHumanReview" BOOLEAN NOT NULL DEFAULT true,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "allowedActionType" TEXT NOT NULL,
  "createdBy" TEXT NOT NULL DEFAULT 'system',
  "sourceData" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AIRecommendation_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AIRecommendation_tenantId_status_recommendationType_idx" ON "AIRecommendation"("tenantId","status","recommendationType");

ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_serviceCatalogItemId_fkey" FOREIGN KEY ("serviceCatalogItemId") REFERENCES "ServiceCatalogItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ServiceCatalogItem" ADD CONSTRAINT "ServiceCatalogItem_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ServiceCatalogItem" ADD CONSTRAINT "ServiceCatalogItem_depositRuleId_fkey" FOREIGN KEY ("depositRuleId") REFERENCES "DepositRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "BusinessEvent" ADD CONSTRAINT "BusinessEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OperationalSignal" ADD CONSTRAINT "OperationalSignal_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AIRecommendation" ADD CONSTRAINT "AIRecommendation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AIRecommendation" ADD CONSTRAINT "AIRecommendation_signalId_fkey" FOREIGN KEY ("signalId") REFERENCES "OperationalSignal"("id") ON DELETE SET NULL ON UPDATE CASCADE;
