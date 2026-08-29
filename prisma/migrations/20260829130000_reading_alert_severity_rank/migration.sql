-- Alert queue acuity ordering.
--
-- The alert queue fetched the N most RECENT alerts and then sorted them by
-- severity in application code — i.e. AFTER the row limit had already been
-- applied. A tenant with a burst of recent low-severity alerts could therefore
-- push genuinely open critical alerts outside the fetched window, and the UI
-- rendered "no open alerts": a false all-clear in a patient-monitoring queue.
--
-- Ordering must happen in the database, before the limit. `severity` is a text
-- column whose alphabetical order is not its clinical order, so this adds a
-- numeric mirror and backfills every existing row.

ALTER TABLE "ReadingAlert" ADD COLUMN IF NOT EXISTS "severityRank" INTEGER NOT NULL DEFAULT 0;

UPDATE "ReadingAlert" SET "severityRank" = CASE "severity"
  WHEN 'critical' THEN 3
  WHEN 'high'     THEN 2
  WHEN 'warning'  THEN 1
  ELSE 0
END;

-- Serves the queue's exact access path: tenant + open statuses, most acute first.
CREATE INDEX IF NOT EXISTS "ReadingAlert_tenantId_status_severityRank_createdAt_idx"
  ON "ReadingAlert" ("tenantId", "status", "severityRank", "createdAt");
