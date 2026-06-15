CREATE TABLE "PatientPortalAccount" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "patientId" UUID NOT NULL,
  "email" TEXT,
  "phone" TEXT,
  "status" TEXT NOT NULL DEFAULT 'invited',
  "lastLoginAt" TIMESTAMP(3),
  "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
  "lockedUntil" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PatientPortalAccount_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PatientPortalAccount_tenantId_patientId_key" ON "PatientPortalAccount"("tenantId", "patientId");
CREATE INDEX "PatientPortalAccount_tenantId_status_idx" ON "PatientPortalAccount"("tenantId", "status");

CREATE TABLE "PatientPortalToken" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "accountId" UUID NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "type" TEXT NOT NULL DEFAULT 'magic_login',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "usedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PatientPortalToken_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PatientPortalToken_tokenHash_key" ON "PatientPortalToken"("tokenHash");
CREATE INDEX "PatientPortalToken_accountId_type_createdAt_idx" ON "PatientPortalToken"("accountId", "type", "createdAt");
