-- ===========================================================================
-- A patient's confirmation is evidence, and evidence needs somewhere to live.
--
-- The pilot's first real outbound call asked the patient to CONFIRM or CANCEL
-- their appointment. Cancel had somewhere to go: `cancel_appointment` moves the
-- row to CANCELED. Confirm had nowhere at all — no tool, and no column. The
-- patient's answer survived only as a sentence inside an LLM call summary, so a
-- clinic running reminders would finish the day with a pile of transcripts and
-- still not know which appointments were confirmed.
--
-- WHY THIS IS NOT AppointmentStatus
--
-- `status` defaults to CONFIRMED the moment an appointment row is created. It
-- already means "the clinic booked this". Writing CONFIRMED again when a
-- patient says yes would be a no-op, and would destroy the one distinction a
-- reminder campaign exists to produce: an appointment the CLINIC believes in
-- versus one the PATIENT has agreed to attend. They are different facts and
-- they get different columns.
--
-- Absence means "not confirmed", never "declined". A patient who declines
-- cancels, and that is a status change on the existing path.
-- ===========================================================================

ALTER TABLE "Appointment"
  ADD COLUMN IF NOT EXISTS "patientConfirmedAt" timestamp(3) without time zone,
  ADD COLUMN IF NOT EXISTS "patientConfirmationSource" text,
  ADD COLUMN IF NOT EXISTS "patientConfirmedCallLogId" uuid;

-- A confirmation that cannot say where it came from is not evidence. Both-or-
-- neither, enforced here rather than trusted to every future writer.
ALTER TABLE "Appointment"
  DROP CONSTRAINT IF EXISTS "Appointment_patient_confirmation_needs_source_check";
ALTER TABLE "Appointment"
  ADD CONSTRAINT "Appointment_patient_confirmation_needs_source_check"
    CHECK (
      ("patientConfirmedAt" IS NULL AND "patientConfirmationSource" IS NULL)
      OR ("patientConfirmedAt" IS NOT NULL AND "patientConfirmationSource" IS NOT NULL)
    );

-- Only the sources we actually implement. A new one is a deliberate migration,
-- not a free-text string nobody can aggregate on later.
ALTER TABLE "Appointment"
  DROP CONSTRAINT IF EXISTS "Appointment_patient_confirmation_source_known_check";
ALTER TABLE "Appointment"
  ADD CONSTRAINT "Appointment_patient_confirmation_source_known_check"
    CHECK (
      "patientConfirmationSource" IS NULL
      OR "patientConfirmationSource" IN ('receptionist_call', 'staff', 'patient_portal')
    );

CREATE INDEX IF NOT EXISTS "Appointment_tenantId_patientConfirmedAt_startsAt_idx"
  ON "Appointment" ("tenantId", "patientConfirmedAt", "startsAt");

-- ===========================================================================
-- Bind a call target to the appointment it is being called ABOUT.
--
-- Without this a reminder campaign can only read one script written for
-- everybody. The pilot proved that literally: every patient on the campaign
-- would have heard the same clinician, day and time, because the appointment
-- details were static text in the campaign script.
--
-- Nullable: reactivation and recall targets are legitimately about no
-- appointment. Tenant-scoped FK, matching how patientId and leadId are bound,
-- so an appointment from another tenant cannot be referenced.
-- ===========================================================================

ALTER TABLE "ReceptionistCallTarget"
  ADD COLUMN IF NOT EXISTS "appointmentId" uuid;

ALTER TABLE "ReceptionistCallTarget"
  DROP CONSTRAINT IF EXISTS "ReceptionistCallTarget_appointment_scope_fkey";
ALTER TABLE "ReceptionistCallTarget"
  ADD CONSTRAINT "ReceptionistCallTarget_appointment_scope_fkey"
    FOREIGN KEY ("tenantId", "appointmentId")
    REFERENCES "Appointment" ("tenantId", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "ReceptionistCallTarget_tenantId_appointmentId_idx"
  ON "ReceptionistCallTarget" ("tenantId", "appointmentId");
