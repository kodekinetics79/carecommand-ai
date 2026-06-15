CREATE TABLE "PlatformIntegration" (
  "id" UUID NOT NULL,
  "key" TEXT NOT NULL,
  "configEnc" TEXT,
  "setFields" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "status" TEXT NOT NULL DEFAULT 'disconnected',
  "lastTestAt" TIMESTAMP(3),
  "lastTestStatus" TEXT,
  "lastTestDetail" TEXT,
  "updatedById" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PlatformIntegration_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PlatformIntegration_key_key" ON "PlatformIntegration"("key");
