-- ===========================================================================
-- A reminder call must be about THIS patient's appointment.
--
-- `ReceptionistCallTarget.appointmentId` shipped with a tenant-scoped FK, which
-- refuses another tenant's appointment and nothing else. Inside one tenant a
-- writer could still bind Margaret's target to Peter's appointment, and the
-- call would then read Peter's clinician, day and time down the phone to
-- Margaret. That is the same class of defect the column was added to fix — a
-- reminder stating an appointment that is not the listener's — so it is closed
-- here rather than left to every future writer to remember.
--
-- Two objects do it:
--
--   1. the FK gains "patientId", so the appointment must belong to the same
--      tenant AND the same patient as the target;
--   2. a CHECK refuses an appointmentId with no patientId. Postgres FKs are
--      MATCH SIMPLE: with patientId NULL the three-column FK is not checked at
--      all, so a lead target could otherwise carry any appointment id in the
--      tenant with nothing verifying it. The CHECK is what makes (1) total.
--
-- Neither needs a DEFAULT. The guarded state is "no appointment bound", which
-- is already the column default (NULL), so every existing row and every writer
-- that ignores the column satisfies both objects without changing.
-- ===========================================================================

-- Parent key for the widened FK. Prisma declares the same @@unique, so this is
-- not a migration-only index the next migration would silently delete.
CREATE UNIQUE INDEX IF NOT EXISTS "Appointment_tenantId_patientId_id_key"
  ON "Appointment" ("tenantId", "patientId", "id");

ALTER TABLE "ReceptionistCallTarget"
  DROP CONSTRAINT IF EXISTS "ReceptionistCallTarget_appointment_scope_fkey";
ALTER TABLE "ReceptionistCallTarget"
  ADD CONSTRAINT "ReceptionistCallTarget_appointment_scope_fkey"
    FOREIGN KEY ("tenantId", "patientId", "appointmentId")
    REFERENCES "Appointment" ("tenantId", "patientId", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ReceptionistCallTarget"
  DROP CONSTRAINT IF EXISTS "ReceptionistCallTarget_appointment_needs_patient_check";
ALTER TABLE "ReceptionistCallTarget"
  ADD CONSTRAINT "ReceptionistCallTarget_appointment_needs_patient_check"
    CHECK ("appointmentId" IS NULL OR "patientId" IS NOT NULL);
