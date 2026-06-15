-- AlterTable
ALTER TABLE "AIRecommendation" ADD COLUMN     "aiModel" TEXT,
ADD COLUMN     "aiProvider" TEXT,
ADD COLUMN     "aiUsageLogId" UUID,
ADD COLUMN     "evidence" JSONB,
ADD COLUMN     "promptVersion" TEXT;

-- CreateTable
CREATE TABLE "AIUsageLog" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "mode" TEXT,
    "model" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "promptVersion" TEXT,
    "status" TEXT NOT NULL,
    "phiIncluded" BOOLEAN NOT NULL DEFAULT false,
    "promptTokens" INTEGER,
    "completionTokens" INTEGER,
    "totalTokens" INTEGER,
    "estimatedCostUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "latencyMs" INTEGER,
    "error" TEXT,
    "actorUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AIUsageLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AIEvaluation" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "usageLogId" UUID,
    "subjectType" TEXT NOT NULL,
    "subjectId" UUID,
    "evidenceCount" INTEGER NOT NULL DEFAULT 0,
    "grounded" BOOLEAN NOT NULL DEFAULT false,
    "phiSafe" BOOLEAN NOT NULL DEFAULT true,
    "withinBudget" BOOLEAN NOT NULL DEFAULT true,
    "score" INTEGER NOT NULL DEFAULT 0,
    "passed" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AIEvaluation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AIUsageLog_tenantId_createdAt_idx" ON "AIUsageLog"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "AIUsageLog_tenantId_operation_createdAt_idx" ON "AIUsageLog"("tenantId", "operation", "createdAt");

-- CreateIndex
CREATE INDEX "AIEvaluation_tenantId_createdAt_idx" ON "AIEvaluation"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "AIRecommendation_tenantId_createdBy_createdAt_idx" ON "AIRecommendation"("tenantId", "createdBy", "createdAt");

-- AddForeignKey
ALTER TABLE "AIUsageLog" ADD CONSTRAINT "AIUsageLog_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIEvaluation" ADD CONSTRAINT "AIEvaluation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
