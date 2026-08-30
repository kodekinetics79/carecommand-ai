-- C4 "Front desk loop".
--
--  1. StaffTask gains durable links (patient, source call) and the human-closed
--     outcome (acknowledged*, completedAt, outcomeCode/Note). Every FK is a
--     composite tenant-scoped RESTRICT: SET NULL on a composite FK would null
--     tenantId, and patients/call logs are never hard-deleted anyway.
--  2. ReceptionistCallLog gains the caller identity link (patientId).
--  3. ReceptionistClinic gains the front-desk SLA policy JSON.
--  4. AppointmentNote: append-only note history for appointments (RLS +
--     SELECT/INSERT only; listed in TENANT_APPEND_ONLY_TABLES).
--  5. The dead ReceptionistAppointmentRequest model (no production writer) is
--     dropped; the core AppointmentRequest is the only request table.
--
-- Lead already carries UNIQUE ("tenantId","id") (20260730230000), so no ALTER
-- there. No expression index on metadata: the existing
-- (tenantId, status, dueAt) index plus the JSON predicate is enough for a pilot.

-- ---------------------------------------------------------------------------
-- 1. StaffTask: receptionist contract
-- ---------------------------------------------------------------------------
ALTER TABLE "StaffTask"
  ADD COLUMN "patientId" UUID,
  ADD COLUMN "callLogId" UUID,
  ADD COLUMN "acknowledgedAt" TIMESTAMP(3),
  ADD COLUMN "acknowledgedById" UUID,
  ADD COLUMN "completedAt" TIMESTAMP(3),
  ADD COLUMN "outcomeCode" TEXT,
  ADD COLUMN "outcomeNote" TEXT;

ALTER TABLE "StaffTask" ADD CONSTRAINT "StaffTask_patient_scope_fkey"
  FOREIGN KEY ("tenantId", "patientId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StaffTask" ADD CONSTRAINT "StaffTask_callLog_scope_fkey"
  FOREIGN KEY ("tenantId", "callLogId") REFERENCES "ReceptionistCallLog"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StaffTask" ADD CONSTRAINT "StaffTask_acknowledgedBy_scope_fkey"
  FOREIGN KEY ("tenantId", "acknowledgedById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "StaffTask_tenantId_callLogId_idx" ON "StaffTask"("tenantId", "callLogId");
CREATE INDEX "StaffTask_tenantId_patientId_status_idx" ON "StaffTask"("tenantId", "patientId", "status");

ALTER TABLE "StaffTask" ADD CONSTRAINT "StaffTask_outcomeCode_check" CHECK (
  "outcomeCode" IS NULL OR "outcomeCode" IN (
    'reached', 'left_voicemail', 'no_answer', 'wrong_number', 'booked',
    'resolved_elsewhere', 'duplicate', 'not_needed', 'transferred', 'cancelled_by_caller'
  )
);

-- Backfill: promote legacy metadata.callLogId where it names a same-tenant call.
UPDATE "StaffTask" t
SET "callLogId" = (t."metadata"->>'callLogId')::uuid
WHERE t."callLogId" IS NULL
  AND t."metadata"->>'callLogId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  AND EXISTS (
    SELECT 1 FROM "ReceptionistCallLog" c
    WHERE c."id" = (t."metadata"->>'callLogId')::uuid AND c."tenantId" = t."tenantId"
  );

-- Emergency mentions were filed as 'high'; they are critical.
UPDATE "StaffTask"
SET "priority" = 'critical'
WHERE "metadata"->>'workflow' = 'receptionist_safety' AND "metadata"->>'kind' = 'emergency';

-- ---------------------------------------------------------------------------
-- 2. ReceptionistCallLog: caller identity + queue indexes
-- ---------------------------------------------------------------------------
ALTER TABLE "ReceptionistCallLog" ADD COLUMN "patientId" UUID;
ALTER TABLE "ReceptionistCallLog" ADD CONSTRAINT "ReceptionistCallLog_patient_scope_fkey"
  FOREIGN KEY ("tenantId", "patientId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "ReceptionistCallLog_tenantId_patientId_createdAt_idx" ON "ReceptionistCallLog"("tenantId", "patientId", "createdAt");
CREATE INDEX "ReceptionistCallLog_tenantId_clinicId_createdAt_idx" ON "ReceptionistCallLog"("tenantId", "clinicId", "createdAt");
CREATE INDEX "ReceptionistCallLog_tenantId_clinicId_direction_createdAt_idx" ON "ReceptionistCallLog"("tenantId", "clinicId", "direction", "createdAt");

-- ---------------------------------------------------------------------------
-- 3. Clinic front-desk policy (SLA per task kind)
-- ---------------------------------------------------------------------------
ALTER TABLE "ReceptionistClinic" ADD COLUMN "frontDeskPolicy" JSONB;

-- ---------------------------------------------------------------------------
-- 4. AppointmentNote: append-only notes
-- ---------------------------------------------------------------------------
CREATE TABLE "AppointmentNote" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "appointmentId" UUID NOT NULL,
  "text" TEXT NOT NULL,
  "actorType" TEXT NOT NULL,
  "actorUserId" UUID,
  "callLogId" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AppointmentNote_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AppointmentNote_actorType_check" CHECK ("actorType" IN ('staff', 'voice_agent', 'system')),
  CONSTRAINT "AppointmentNote_text_len_check" CHECK (char_length("text") BETWEEN 1 AND 1000)
);
ALTER TABLE "AppointmentNote" ADD CONSTRAINT "AppointmentNote_tenant_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AppointmentNote" ADD CONSTRAINT "AppointmentNote_appointment_scope_fkey"
  FOREIGN KEY ("tenantId", "appointmentId") REFERENCES "Appointment"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AppointmentNote" ADD CONSTRAINT "AppointmentNote_actor_scope_fkey"
  FOREIGN KEY ("tenantId", "actorUserId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AppointmentNote" ADD CONSTRAINT "AppointmentNote_callLog_scope_fkey"
  FOREIGN KEY ("tenantId", "callLogId") REFERENCES "ReceptionistCallLog"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "AppointmentNote_tenantId_appointmentId_createdAt_idx" ON "AppointmentNote"("tenantId", "appointmentId", "createdAt");
CREATE INDEX "AppointmentNote_tenantId_callLogId_idx" ON "AppointmentNote"("tenantId", "callLogId");

-- RLS: 20260730120000 FORCEs RLS, so a new table with no policies is invisible
-- to app_rls until these run. Append-only: SELECT + INSERT policies only, and
-- the REVOKE precedes the GRANT so no inherited privilege survives.
ALTER TABLE "AppointmentNote" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AppointmentNote" FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_appointment_note_select ON "AppointmentNote" FOR SELECT TO app_rls USING (app_rls_tenant_allowed("tenantId"));
CREATE POLICY rls_appointment_note_insert ON "AppointmentNote" FOR INSERT TO app_rls WITH CHECK (app_rls_tenant_allowed("tenantId"));
REVOKE ALL ON TABLE "AppointmentNote" FROM app_rls;
GRANT SELECT, INSERT ON TABLE "AppointmentNote" TO app_rls;

-- Legacy free-text Appointment.notes becomes the first note (the column is kept
-- for old readers; the note row is the durable history going forward).
INSERT INTO "AppointmentNote" ("tenantId", "appointmentId", "text", "actorType", "createdAt")
SELECT "tenantId", "id", left("notes", 1000), 'system', "createdAt"
FROM "Appointment"
WHERE "notes" IS NOT NULL AND btrim("notes") <> '';

-- ---------------------------------------------------------------------------
-- 5. Dead model. DROP TABLE removes its policies, indexes and FKs with it.
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS "ReceptionistAppointmentRequest";
DROP TYPE IF EXISTS "ReceptionistRequestStatus";
