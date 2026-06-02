-- CreateTable
CREATE TABLE "Competitor" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "distanceKm" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "googleRating" DECIMAL(3,2) NOT NULL DEFAULT 0,
    "reviewVolume" INTEGER NOT NULL DEFAULT 0,
    "complaintThemes" TEXT[] NOT NULL,
    "activeOffers" TEXT[] NOT NULL,
    "localRankTrend" TEXT NOT NULL,
    "weaknessSummary" TEXT NOT NULL,
    "opportunityAlert" TEXT NOT NULL,
    "marketOpeningRecommendation" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Competitor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompetitorReviewInsight" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "competitorId" UUID NOT NULL,
    "theme" TEXT NOT NULL,
    "complaintCount" INTEGER NOT NULL,
    "summary" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompetitorReviewInsight_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReputationCase" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "patientId" UUID,
    "reviewId" UUID,
    "badReviewRisk" INTEGER NOT NULL,
    "complaintCategory" TEXT NOT NULL,
    "unresolvedComplaint" TEXT NOT NULL,
    "workflowStatus" TEXT NOT NULL,
    "recoveryWorkflow" TEXT NOT NULL,
    "suggestedReply" TEXT NOT NULL,
    "npsScore" INTEGER NOT NULL,
    "publicTrend" TEXT NOT NULL,
    "staffComplaintDetected" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReputationCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewRequest" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "patientId" UUID,
    "reviewId" UUID,
    "channel" "Channel" NOT NULL,
    "requestType" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3),
    "respondedAt" TIMESTAMP(3),
    "ratingReceived" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Competitor_tenantId_branchId_createdAt_idx" ON "Competitor"("tenantId", "branchId", "createdAt");

-- CreateIndex
CREATE INDEX "Competitor_tenantId_googleRating_reviewVolume_idx" ON "Competitor"("tenantId", "googleRating", "reviewVolume");

-- CreateIndex
CREATE INDEX "CompetitorReviewInsight_tenantId_competitorId_complaintCount_idx" ON "CompetitorReviewInsight"("tenantId", "competitorId", "complaintCount");

-- CreateIndex
CREATE INDEX "ReputationCase_tenantId_branchId_badReviewRisk_idx" ON "ReputationCase"("tenantId", "branchId", "badReviewRisk");

-- CreateIndex
CREATE INDEX "ReputationCase_tenantId_workflowStatus_publicTrend_idx" ON "ReputationCase"("tenantId", "workflowStatus", "publicTrend");

-- CreateIndex
CREATE INDEX "ReviewRequest_tenantId_branchId_status_idx" ON "ReviewRequest"("tenantId", "branchId", "status");

-- CreateIndex
CREATE INDEX "ReviewRequest_tenantId_channel_createdAt_idx" ON "ReviewRequest"("tenantId", "channel", "createdAt");

-- AddForeignKey
ALTER TABLE "Competitor" ADD CONSTRAINT "Competitor_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Competitor" ADD CONSTRAINT "Competitor_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompetitorReviewInsight" ADD CONSTRAINT "CompetitorReviewInsight_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompetitorReviewInsight" ADD CONSTRAINT "CompetitorReviewInsight_competitorId_fkey" FOREIGN KEY ("competitorId") REFERENCES "Competitor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReputationCase" ADD CONSTRAINT "ReputationCase_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReputationCase" ADD CONSTRAINT "ReputationCase_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReputationCase" ADD CONSTRAINT "ReputationCase_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewRequest" ADD CONSTRAINT "ReviewRequest_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewRequest" ADD CONSTRAINT "ReviewRequest_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewRequest" ADD CONSTRAINT "ReviewRequest_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE SET NULL ON UPDATE CASCADE;
