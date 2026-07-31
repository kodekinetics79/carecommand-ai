-- M09-F10 Slice B: one canonical booking/review lifecycle per trusted call.
-- This migration is intentionally non-destructive. Legacy NULL source calls
-- remain valid except where a legacy BOOKED request unambiguously identifies
-- its source call and appointment. Those links are backfilled; ambiguous or
-- unsafe legacy state fails with an explicit diagnostic instead of being
-- silently deleted or rewritten.

ALTER TABLE "Appointment" ADD COLUMN "receptionistCallLogId" UUID;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "AppointmentRequest"
    WHERE "callLogId" IS NOT NULL
    GROUP BY "tenantId", "callLogId"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'AppointmentRequest has duplicate non-null tenantId/callLogId values; resolve explicitly before deploying receptionist call atomicity';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "AppointmentRequest"
    WHERE "status" = 'BOOKED' AND "bookedAppointmentId" IS NULL
  ) THEN
    RAISE EXCEPTION 'AppointmentRequest has BOOKED rows without bookedAppointmentId; resolve explicitly before deploying receptionist call atomicity';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "AppointmentRequest"
    WHERE "status" = 'BOOKED'
      AND "source" = 'ai_receptionist'
      AND "callLogId" IS NULL
  ) THEN
    RAISE EXCEPTION 'A legacy AI receptionist BOOKED AppointmentRequest has no callLogId; the source call cannot be inferred safely, so reconcile it explicitly before deploying receptionist call atomicity';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "ReceptionistCallLog"
    WHERE "retellCallId" IS NOT NULL
    GROUP BY "retellCallId"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'ReceptionistCallLog has duplicate non-null retellCallId values; resolve explicitly before deploying receptionist call atomicity';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "AppointmentRequest"
    WHERE "bookedAppointmentId" IS NOT NULL
    GROUP BY "tenantId", "bookedAppointmentId"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'AppointmentRequest has duplicate non-null tenantId/bookedAppointmentId values; resolve explicitly before deploying receptionist call atomicity';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "AppointmentRequest" request
    LEFT JOIN "ReceptionistCallLog" call
      ON call."tenantId" = request."tenantId" AND call.id = request."callLogId"
    WHERE request."callLogId" IS NOT NULL AND call.id IS NULL
  ) THEN
    RAISE EXCEPTION 'AppointmentRequest contains an orphan or cross-tenant callLogId; resolve explicitly before deploying receptionist call atomicity';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "AppointmentRequest" request
    LEFT JOIN "Appointment" appointment
      ON appointment."tenantId" = request."tenantId" AND appointment.id = request."bookedAppointmentId"
    WHERE request."bookedAppointmentId" IS NOT NULL AND appointment.id IS NULL
  ) THEN
    RAISE EXCEPTION 'AppointmentRequest contains an orphan or cross-tenant bookedAppointmentId; resolve explicitly before deploying receptionist call atomicity';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "AppointmentRequest" request
    JOIN "Appointment" appointment
      ON appointment."tenantId" = request."tenantId"
     AND appointment.id = request."bookedAppointmentId"
    WHERE request."status" = 'BOOKED'
      AND request."callLogId" IS NOT NULL
      AND request."bookedAppointmentId" IS NOT NULL
      AND appointment."providerProfileId" IS NULL
  ) THEN
    RAISE EXCEPTION 'A legacy BOOKED AppointmentRequest identifies a source call but its booked Appointment has no providerProfileId; assign the canonical provider before deploying receptionist call atomicity';
  END IF;
END
$$;

-- The uniqueness/orphan preflights above make this ownership mapping
-- unambiguous: one request per call, one request per booked appointment, and
-- both referenced rows belong to the same tenant. A provider is required so
-- the backfill cannot turn an incomplete staff appointment into an autonomous
-- call booking.
UPDATE "Appointment" appointment
SET "receptionistCallLogId" = request."callLogId"
FROM "AppointmentRequest" request
WHERE request."status" = 'BOOKED'
  AND request."callLogId" IS NOT NULL
  AND request."bookedAppointmentId" = appointment.id
  AND request."tenantId" = appointment."tenantId"
  AND appointment."providerProfileId" IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "AppointmentRequest" request
    JOIN "Appointment" appointment
      ON appointment."tenantId" = request."tenantId"
     AND appointment.id = request."bookedAppointmentId"
    WHERE request."status" = 'BOOKED'
      AND request."callLogId" IS NOT NULL
      AND request."bookedAppointmentId" IS NOT NULL
      AND appointment."receptionistCallLogId" IS DISTINCT FROM request."callLogId"
  ) THEN
    RAISE EXCEPTION 'A legacy BOOKED AppointmentRequest could not be linked to exactly its source call; resolve the request/appointment ownership before deploying receptionist call atomicity';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "AppointmentRequest" request
    JOIN "Appointment" appointment
      ON appointment."tenantId" = request."tenantId"
     AND appointment.id = request."bookedAppointmentId"
    WHERE request."callLogId" IS NOT NULL
      AND request."bookedAppointmentId" IS NOT NULL
      AND appointment."receptionistCallLogId" IS DISTINCT FROM request."callLogId"
  ) THEN
    RAISE EXCEPTION 'AppointmentRequest.callLogId conflicts with the booked Appointment receptionistCallLogId; reconcile the source call before deploying receptionist call atomicity';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "Appointment"
    WHERE "receptionistCallLogId" IS NOT NULL
      AND "providerProfileId" IS NULL
  ) THEN
    RAISE EXCEPTION 'A call-sourced Appointment has no providerProfileId; assign the canonical provider before deploying receptionist call atomicity';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "Appointment"
    WHERE "receptionistCallLogId" IS NOT NULL
    GROUP BY "tenantId", "receptionistCallLogId"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Appointment has duplicate non-null tenantId/receptionistCallLogId values after legacy backfill; resolve explicitly before deploying receptionist call atomicity';
  END IF;
END
$$;

DROP INDEX "AppointmentRequest_tenantId_callLogId_idx";

CREATE UNIQUE INDEX "ReceptionistCallLog_tenantId_id_key"
  ON "ReceptionistCallLog"("tenantId", "id");
CREATE UNIQUE INDEX "ReceptionistCallLog_retellCallId_key"
  ON "ReceptionistCallLog"("retellCallId");
CREATE UNIQUE INDEX "Appointment_tenantId_id_key"
  ON "Appointment"("tenantId", "id");
CREATE UNIQUE INDEX "rls_uq_beec6ee265c8ecd5aa57"
  ON "Appointment"("tenantId", "id", "receptionistCallLogId");
CREATE UNIQUE INDEX "Appointment_tenantId_receptionistCallLogId_key"
  ON "Appointment"("tenantId", "receptionistCallLogId");
CREATE UNIQUE INDEX "AppointmentRequest_tenantId_callLogId_key"
  ON "AppointmentRequest"("tenantId", "callLogId");
CREATE UNIQUE INDEX "AppointmentRequest_tenantId_bookedAppointmentId_key"
  ON "AppointmentRequest"("tenantId", "bookedAppointmentId");
CREATE INDEX "rls_ix_ca43caad7de3e7a421a3"
  ON "AppointmentRequest"("tenantId", "bookedAppointmentId", "callLogId");

ALTER TABLE "Appointment"
  ADD CONSTRAINT "Appointment_tenantId_receptionistCallLogId_fkey"
  FOREIGN KEY ("tenantId", "receptionistCallLogId")
  REFERENCES "ReceptionistCallLog"("tenantId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AppointmentRequest"
  ADD CONSTRAINT "AppointmentRequest_tenantId_callLogId_fkey"
  FOREIGN KEY ("tenantId", "callLogId")
  REFERENCES "ReceptionistCallLog"("tenantId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AppointmentRequest"
  ADD CONSTRAINT "AppointmentRequest_tenantId_bookedAppointmentId_fkey"
  FOREIGN KEY ("tenantId", "bookedAppointmentId")
  REFERENCES "Appointment"("tenantId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- This declarative pair invariant is concurrency-safe in PostgreSQL. Whenever
-- a request identifies both a booked appointment and a source call, that exact
-- tenant/appointment/call tuple must exist. It also prevents either side from
-- being changed later while the other row still references the tuple.
ALTER TABLE "AppointmentRequest"
  ADD CONSTRAINT "rls_fk_a0bd2f6d0531db1c91cb9"
  FOREIGN KEY ("tenantId", "bookedAppointmentId", "callLogId")
  REFERENCES "Appointment"("tenantId", "id", "receptionistCallLogId")
  MATCH SIMPLE
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "AppointmentRequest"
  ADD CONSTRAINT "AppointmentRequest_booked_requires_appointment_check"
  CHECK ("status" <> 'BOOKED' OR "bookedAppointmentId" IS NOT NULL);

ALTER TABLE "AppointmentRequest"
  ADD CONSTRAINT "AppointmentRequest_ai_booked_requires_call_check"
  CHECK ("status" <> 'BOOKED' OR "source" <> 'ai_receptionist' OR "callLogId" IS NOT NULL);

ALTER TABLE "Appointment"
  ADD CONSTRAINT "Appointment_call_source_requires_provider_check"
  CHECK ("receptionistCallLogId" IS NULL OR "providerProfileId" IS NOT NULL);

-- Appointment history retains its provider. The former SET NULL action would
-- now violate the call-source/provider CHECK and made deletion behavior depend
-- on trigger ordering; explicit RESTRICT is deterministic for all appointments.
ALTER TABLE "Appointment"
  DROP CONSTRAINT "Appointment_providerProfileId_fkey";
ALTER TABLE "Appointment"
  ADD CONSTRAINT "Appointment_providerProfileId_fkey"
  FOREIGN KEY ("providerProfileId") REFERENCES "ProviderProfile"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION "enforce_appointment_request_terminal_status"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."status" IN ('BOOKED', 'REJECTED', 'DUPLICATE')
     AND NEW."status" <> OLD."status" THEN
    RAISE EXCEPTION 'AppointmentRequest terminal status is immutable (% -> %)', OLD."status", NEW."status";
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "AppointmentRequest_terminal_status_trg"
  BEFORE UPDATE OF "status" ON "AppointmentRequest"
  FOR EACH ROW
  EXECUTE FUNCTION "enforce_appointment_request_terminal_status"();

CREATE OR REPLACE FUNCTION "enforce_receptionist_call_first_terminal_outcome"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."outcome" <> 'IN_PROGRESS' AND NEW."outcome" <> OLD."outcome" THEN
    RAISE EXCEPTION 'ReceptionistCallLog terminal outcome is immutable (% -> %)', OLD."outcome", NEW."outcome";
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ReceptionistCallLog_first_terminal_outcome_trg"
  BEFORE UPDATE OF "outcome" ON "ReceptionistCallLog"
  FOR EACH ROW
  EXECUTE FUNCTION "enforce_receptionist_call_first_terminal_outcome"();
