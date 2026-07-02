-- Pilot readiness: saved CSV mapping presets and customer-facing share links.

CREATE TABLE "PilotImportPreset" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "entityType" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  "mapping" JSONB NOT NULL,
  "createdById" UUID,
  "updatedById" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PilotImportPreset_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PilotImportPreset_tenantId_entityType_name_key" ON "PilotImportPreset"("tenantId", "entityType", "name");
CREATE INDEX "PilotImportPreset_tenantId_entityType_idx" ON "PilotImportPreset"("tenantId", "entityType");

CREATE TABLE "PilotStatusShare" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "label" TEXT,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdById" UUID,
  "lastViewedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PilotStatusShare_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PilotStatusShare_tokenHash_key" ON "PilotStatusShare"("tokenHash");
CREATE INDEX "PilotStatusShare_tenantId_expiresAt_idx" ON "PilotStatusShare"("tenantId", "expiresAt");

ALTER TABLE "PilotImportPreset" ADD CONSTRAINT "PilotImportPreset_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PilotStatusShare" ADD CONSTRAINT "PilotStatusShare_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
