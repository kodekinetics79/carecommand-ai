-- Reading idempotency key (billing integrity): webhook redeliveries of the same
-- measurement collapse to one row. Nullable so manual/keyless readings are
-- unaffected — Postgres treats NULLs as distinct, so the unique index below
-- never blocks legitimate manual entries.
ALTER TABLE "DeviceReading" ADD COLUMN "dedupeKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "DeviceReading_tenantId_dedupeKey_key" ON "DeviceReading"("tenantId", "dedupeKey");
