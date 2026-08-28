-- Runtime safety jobs can overlap during retries or multi-worker operation.
-- Advisory locks prevent duplicate work in the normal path; these partial
-- unique indexes are the final database invariant for unresolved alerts.
CREATE UNIQUE INDEX IF NOT EXISTS "ReadingAlert_one_open_missed_per_patient"
  ON "ReadingAlert" ("tenantId", "patientId", "alertType")
  WHERE "patientId" IS NOT NULL
    AND "alertType" = 'missed_reading'
    AND "status" IN ('open', 'acknowledged', 'assigned');

CREATE UNIQUE INDEX IF NOT EXISTS "ReadingAlert_one_open_offline_per_device"
  ON "ReadingAlert" ("tenantId", "deviceId", "alertType")
  WHERE "deviceId" IS NOT NULL
    AND "alertType" = 'device_offline'
    AND "status" IN ('open', 'acknowledged', 'assigned');
