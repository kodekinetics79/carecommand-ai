CREATE TABLE "AutomationRule" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "templateKey" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "triggerType" TEXT NOT NULL,
  "actionType" TEXT NOT NULL,
  "config" JSONB,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "lastRunAt" TIMESTAMP(3),
  "lastMatchCount" INTEGER NOT NULL DEFAULT 0,
  "runCount" INTEGER NOT NULL DEFAULT 0,
  "createdById" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AutomationRule_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AutomationRule_tenantId_enabled_idx" ON "AutomationRule"("tenantId", "enabled");
