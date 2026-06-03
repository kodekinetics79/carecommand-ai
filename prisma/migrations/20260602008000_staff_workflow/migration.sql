-- CreateTable
CREATE TABLE "StaffProfile" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "roleTitle" TEXT NOT NULL,
    "responseTime" DECIMAL(4,1) NOT NULL DEFAULT 0,
    "missedCalls" INTEGER NOT NULL DEFAULT 0,
    "followUpRate" INTEGER NOT NULL DEFAULT 0,
    "bookingConversionRate" INTEGER NOT NULL DEFAULT 0,
    "tasksCompleted" INTEGER NOT NULL DEFAULT 0,
    "tasksPending" INTEGER NOT NULL DEFAULT 0,
    "patientFeedbackScore" DECIMAL(3,1) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StaffProfile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StaffProfile_userId_key" ON "StaffProfile"("userId");

-- CreateIndex
CREATE INDEX "StaffProfile_tenantId_branchId_bookingConversionRate_idx" ON "StaffProfile"("tenantId", "branchId", "bookingConversionRate");

-- CreateIndex
CREATE INDEX "StaffProfile_tenantId_responseTime_idx" ON "StaffProfile"("tenantId", "responseTime");

-- AddForeignKey
ALTER TABLE "StaffProfile" ADD CONSTRAINT "StaffProfile_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffProfile" ADD CONSTRAINT "StaffProfile_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffProfile" ADD CONSTRAINT "StaffProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
