-- Scheduling foundation: recurring provider availability + one-off time off.
-- Additive and backward compatible. FK to ProviderProfile cascades on delete, so
-- tenant teardown (which cascades to ProviderProfile) cleans these up too.
--
-- Rollback:
--   DROP TABLE "ProviderTimeOff";
--   DROP TABLE "ProviderAvailability";

CREATE TABLE "ProviderAvailability" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "providerProfileId" UUID NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "startMinute" INTEGER NOT NULL,
    "endMinute" INTEGER NOT NULL,
    "slotMinutes" INTEGER NOT NULL DEFAULT 30,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ProviderAvailability_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProviderTimeOff" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "providerProfileId" UUID NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProviderTimeOff_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProviderAvailability_providerProfileId_dayOfWeek_startMinute_key" ON "ProviderAvailability"("providerProfileId", "dayOfWeek", "startMinute");
CREATE INDEX "ProviderAvailability_tenantId_providerProfileId_dayOfWeek_idx" ON "ProviderAvailability"("tenantId", "providerProfileId", "dayOfWeek");
CREATE INDEX "ProviderTimeOff_tenantId_providerProfileId_startsAt_idx" ON "ProviderTimeOff"("tenantId", "providerProfileId", "startsAt");

ALTER TABLE "ProviderAvailability" ADD CONSTRAINT "ProviderAvailability_providerProfileId_fkey" FOREIGN KEY ("providerProfileId") REFERENCES "ProviderProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProviderTimeOff" ADD CONSTRAINT "ProviderTimeOff_providerProfileId_fkey" FOREIGN KEY ("providerProfileId") REFERENCES "ProviderProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
