-- CreateTable
CREATE TABLE "UserClinicAccess" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserClinicAccess_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserClinicAccess_tenantId_userId_branchId_key" ON "UserClinicAccess"("tenantId", "userId", "branchId");

-- CreateIndex
CREATE INDEX "UserClinicAccess_tenantId_userId_isPrimary_idx" ON "UserClinicAccess"("tenantId", "userId", "isPrimary");

-- CreateIndex
CREATE INDEX "UserClinicAccess_tenantId_branchId_idx" ON "UserClinicAccess"("tenantId", "branchId");

-- AddForeignKey
ALTER TABLE "UserClinicAccess" ADD CONSTRAINT "UserClinicAccess_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserClinicAccess" ADD CONSTRAINT "UserClinicAccess_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserClinicAccess" ADD CONSTRAINT "UserClinicAccess_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
