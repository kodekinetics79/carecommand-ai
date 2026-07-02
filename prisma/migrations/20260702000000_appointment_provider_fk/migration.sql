-- Canonical provider link on Appointment so conflict detection reconciles across
-- all booking paths (scheduling, portal self-book, staff). Additive + nullable.
--
-- Backfill: existing appointments created by the scheduling/portal flow stored
-- the ProviderProfile id in the free-text providerRef. Copy that into the new FK
-- ONLY where providerRef exactly matches a real ProviderProfile in the same
-- tenant — arbitrary/legacy providerRef strings are left NULL.
--
-- Rollback:
--   ALTER TABLE "Appointment" DROP CONSTRAINT "Appointment_providerProfileId_fkey";
--   DROP INDEX "Appointment_tenantId_providerProfileId_startsAt_idx";
--   ALTER TABLE "Appointment" DROP COLUMN "providerProfileId";

ALTER TABLE "Appointment" ADD COLUMN "providerProfileId" UUID;

CREATE INDEX "Appointment_tenantId_providerProfileId_startsAt_idx" ON "Appointment"("tenantId", "providerProfileId", "startsAt");

ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_providerProfileId_fkey" FOREIGN KEY ("providerProfileId") REFERENCES "ProviderProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

UPDATE "Appointment" a
SET "providerProfileId" = p."id"
FROM "ProviderProfile" p
WHERE a."providerRef" = p."id"::text
  AND a."tenantId" = p."tenantId"
  AND a."providerProfileId" IS NULL;
