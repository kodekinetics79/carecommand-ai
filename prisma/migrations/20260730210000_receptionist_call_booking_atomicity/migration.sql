-- M09-F10 Slice B: one canonical booking/review lifecycle per trusted call.
-- This migration is intentionally non-destructive. Legacy NULL source calls
-- remain valid; existing non-NULL duplicates or orphan references fail with an
-- explicit message instead of being silently deleted or rewritten.

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
END
$$;

DROP INDEX "AppointmentRequest_tenantId_callLogId_idx";

CREATE UNIQUE INDEX "ReceptionistCallLog_tenantId_id_key"
  ON "ReceptionistCallLog"("tenantId", "id");
CREATE UNIQUE INDEX "ReceptionistCallLog_retellCallId_key"
  ON "ReceptionistCallLog"("retellCallId");
CREATE UNIQUE INDEX "Appointment_tenantId_id_key"
  ON "Appointment"("tenantId", "id");
CREATE UNIQUE INDEX "Appointment_tenantId_receptionistCallLogId_key"
  ON "Appointment"("tenantId", "receptionistCallLogId");
CREATE UNIQUE INDEX "AppointmentRequest_tenantId_callLogId_key"
  ON "AppointmentRequest"("tenantId", "callLogId");
CREATE UNIQUE INDEX "AppointmentRequest_tenantId_bookedAppointmentId_key"
  ON "AppointmentRequest"("tenantId", "bookedAppointmentId");

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

ALTER TABLE "AppointmentRequest"
  ADD CONSTRAINT "AppointmentRequest_booked_requires_appointment_check"
  CHECK ("status" <> 'BOOKED' OR "bookedAppointmentId" IS NOT NULL);

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
