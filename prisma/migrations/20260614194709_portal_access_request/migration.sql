-- CreateTable
CREATE TABLE "PortalAccessRequest" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "matchCount" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "resolvedByUserId" UUID,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PortalAccessRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PortalAccessRequest_tenantId_status_createdAt_idx" ON "PortalAccessRequest"("tenantId", "status", "createdAt");

-- AddForeignKey
ALTER TABLE "PortalAccessRequest" ADD CONSTRAINT "PortalAccessRequest_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
