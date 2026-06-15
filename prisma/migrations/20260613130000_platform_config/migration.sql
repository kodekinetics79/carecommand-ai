CREATE TABLE "PlatformConfig" (
  "id" TEXT NOT NULL DEFAULT 'singleton',
  "platformName" TEXT NOT NULL DEFAULT 'CareCommand',
  "supportEmail" TEXT,
  "defaultTrialDays" INTEGER NOT NULL DEFAULT 14,
  "defaultPlanKey" TEXT NOT NULL DEFAULT 'starter',
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedById" UUID,
  CONSTRAINT "PlatformConfig_pkey" PRIMARY KEY ("id")
);
