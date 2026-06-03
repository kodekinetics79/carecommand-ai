-- CreateTable
CREATE TABLE "RevenueLeak" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "patientId" UUID,
    "ownerUserId" UUID,
    "category" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "evidence" TEXT NOT NULL,
    "estimatedValue" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "confidence" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "workflowStatus" TEXT NOT NULL,
    "suggestedAction" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RevenueLeak_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Opportunity" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "patientId" UUID,
    "ownerUserId" UUID,
    "title" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "automationSteps" JSONB NOT NULL,
    "expectedRevenue" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "actualRevenue" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "roi" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "confidence" INTEGER NOT NULL,
    "effortLevel" TEXT NOT NULL,
    "urgency" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "ownerApprovalRequired" BOOLEAN NOT NULL DEFAULT false,
    "recommendedAction" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Opportunity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RevenueLeak_tenantId_branchId_createdAt_idx" ON "RevenueLeak"("tenantId", "branchId", "createdAt");

-- CreateIndex
CREATE INDEX "RevenueLeak_tenantId_status_confidence_idx" ON "RevenueLeak"("tenantId", "status", "confidence");

-- CreateIndex
CREATE INDEX "Opportunity_tenantId_branchId_createdAt_idx" ON "Opportunity"("tenantId", "branchId", "createdAt");

-- CreateIndex
CREATE INDEX "Opportunity_tenantId_status_urgency_idx" ON "Opportunity"("tenantId", "status", "urgency");

-- AddForeignKey
ALTER TABLE "RevenueLeak" ADD CONSTRAINT "RevenueLeak_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RevenueLeak" ADD CONSTRAINT "RevenueLeak_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RevenueLeak" ADD CONSTRAINT "RevenueLeak_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RevenueLeak" ADD CONSTRAINT "RevenueLeak_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
