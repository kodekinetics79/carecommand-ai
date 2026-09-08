-- Per-appointment communication plans. Existing appointments remain opted out:
-- no plan row is backfilled, and the schema default is NONE/PAUSED.

CREATE TYPE "AppointmentCommunicationMode" AS ENUM ('NONE', 'SMS', 'VOICE', 'BOTH');
CREATE TYPE "AppointmentCommunicationPlanStatus" AS ENUM ('ACTIVE', 'PAUSED', 'BLOCKED_SETUP', 'COMPLETED', 'CANCELLED');
CREATE TYPE "AppointmentCommunicationActionKind" AS ENUM ('REMINDER');
CREATE TYPE "AppointmentCommunicationActionChannel" AS ENUM ('SMS', 'VOICE');
CREATE TYPE "AppointmentCommunicationActionStatus" AS ENUM ('QUEUED', 'BLOCKED_SETUP', 'CANCELLED', 'SENT', 'FAILED');

ALTER TABLE "Appointment"
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "patientConfirmedAppointmentVersion" INTEGER;

-- Existing confirmation evidence names the only appointment version that
-- existed before this migration.
UPDATE "Appointment"
SET "patientConfirmedAppointmentVersion" = "version"
WHERE "patientConfirmedAt" IS NOT NULL;

ALTER TABLE "Appointment"
  ADD CONSTRAINT "Appointment_version_positive_check" CHECK ("version" > 0),
  ADD CONSTRAINT "Appointment_confirmation_current_version_check" CHECK (
    ("patientConfirmedAt" IS NULL AND "patientConfirmationSource" IS NULL AND "patientConfirmedAppointmentVersion" IS NULL)
    OR
    ("patientConfirmedAt" IS NOT NULL AND "patientConfirmationSource" IS NOT NULL AND "patientConfirmedAppointmentVersion" = "version")
  );

CREATE TABLE "AppointmentCommunicationPlan" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "appointmentId" UUID NOT NULL,
  "mode" "AppointmentCommunicationMode" NOT NULL DEFAULT 'NONE',
  "status" "AppointmentCommunicationPlanStatus" NOT NULL DEFAULT 'PAUSED',
  "reminderLeadMinutes" INTEGER NOT NULL DEFAULT 1440,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "appointmentVersion" INTEGER NOT NULL DEFAULT 1,
  "updatedByUserId" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AppointmentCommunicationPlan_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AppointmentCommunicationPlan_lead_range_check" CHECK ("reminderLeadMinutes" BETWEEN 15 AND 10080),
  CONSTRAINT "AppointmentCommunicationPlan_revision_positive_check" CHECK ("revision" > 0),
  CONSTRAINT "AppointmentCommunicationPlan_appointment_version_positive_check" CHECK ("appointmentVersion" > 0),
  CONSTRAINT "AppointmentCommunicationPlan_mode_status_check" CHECK (
    "status" IN ('COMPLETED', 'CANCELLED')
    OR ("mode" = 'NONE' AND "status" = 'PAUSED')
    OR ("mode" IN ('SMS', 'VOICE', 'BOTH') AND "status" = 'BLOCKED_SETUP')
  )
);

CREATE TABLE "AppointmentCommunicationAction" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "appointmentId" UUID NOT NULL,
  "planId" UUID NOT NULL,
  "appointmentVersion" INTEGER NOT NULL,
  "planRevision" INTEGER NOT NULL,
  "kind" "AppointmentCommunicationActionKind" NOT NULL DEFAULT 'REMINDER',
  "channel" "AppointmentCommunicationActionChannel" NOT NULL,
  "sequence" INTEGER NOT NULL DEFAULT 1,
  "status" "AppointmentCommunicationActionStatus" NOT NULL,
  "dueAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AppointmentCommunicationAction_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AppointmentCommunicationAction_versions_positive_check" CHECK (
    "appointmentVersion" > 0 AND "planRevision" > 0 AND "sequence" > 0
  ),
  -- Delivery dispatch is intentionally not wired in this tranche. The database
  -- itself refuses an action that pretends it is queued, sent, or failed.
  CONSTRAINT "AppointmentCommunicationAction_dispatch_setup_check" CHECK (
    "status" IN ('BLOCKED_SETUP', 'CANCELLED')
  )
);

CREATE INDEX "AppointmentCommunicationPlan_tenantId_status_updatedAt_idx"
  ON "AppointmentCommunicationPlan"("tenantId", "status", "updatedAt");
CREATE INDEX "AppointmentCommunicationPlan_tenantId_updatedByUserId_idx"
  ON "AppointmentCommunicationPlan"("tenantId", "updatedByUserId");
CREATE UNIQUE INDEX "AppointmentCommunicationPlan_tenantId_appointmentId_key"
  ON "AppointmentCommunicationPlan"("tenantId", "appointmentId");
CREATE UNIQUE INDEX "AppointmentCommunicationPlan_tenantId_appointmentId_id_key"
  ON "AppointmentCommunicationPlan"("tenantId", "appointmentId", "id");

CREATE INDEX "AppointmentCommunicationAction_tenantId_status_dueAt_idx"
  ON "AppointmentCommunicationAction"("tenantId", "status", "dueAt");
CREATE INDEX "AppointmentCommunicationAction_tenantId_appointmentId_appoi_idx"
  ON "AppointmentCommunicationAction"("tenantId", "appointmentId", "appointmentVersion");
CREATE INDEX "AppointmentCommunicationAction_tenantId_appointmentId_planI_idx"
  ON "AppointmentCommunicationAction"("tenantId", "appointmentId", "planId");
CREATE UNIQUE INDEX "AppointmentCommunicationAction_tenantId_appointmentId_planR_key"
  ON "AppointmentCommunicationAction"("tenantId", "appointmentId", "planRevision", "kind", "channel", "sequence");

ALTER TABLE "AppointmentCommunicationPlan" ADD CONSTRAINT "AppointmentCommunicationPlan_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AppointmentCommunicationPlan" ADD CONSTRAINT "AppointmentCommunicationPlan_appointment_scope_fkey"
  FOREIGN KEY ("tenantId", "appointmentId") REFERENCES "Appointment"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AppointmentCommunicationPlan" ADD CONSTRAINT "AppointmentCommunicationPlan_updatedBy_scope_fkey"
  FOREIGN KEY ("tenantId", "updatedByUserId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AppointmentCommunicationAction" ADD CONSTRAINT "AppointmentCommunicationAction_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AppointmentCommunicationAction" ADD CONSTRAINT "AppointmentCommunicationAction_appointment_scope_fkey"
  FOREIGN KEY ("tenantId", "appointmentId") REFERENCES "Appointment"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AppointmentCommunicationAction" ADD CONSTRAINT "AppointmentCommunicationAction_plan_scope_fkey"
  FOREIGN KEY ("tenantId", "appointmentId", "planId") REFERENCES "AppointmentCommunicationPlan"("tenantId", "appointmentId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- New tenant tables are invisible until they have explicit forced RLS policies
-- and least-privilege grants for the runtime role.
ALTER TABLE "AppointmentCommunicationPlan" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AppointmentCommunicationPlan" FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_appointment_communication_plan_select ON "AppointmentCommunicationPlan" FOR SELECT TO app_rls USING (app_rls_tenant_allowed("tenantId"));
CREATE POLICY rls_appointment_communication_plan_insert ON "AppointmentCommunicationPlan" FOR INSERT TO app_rls WITH CHECK (app_rls_tenant_allowed("tenantId"));
CREATE POLICY rls_appointment_communication_plan_update ON "AppointmentCommunicationPlan" FOR UPDATE TO app_rls USING (app_rls_tenant_allowed("tenantId")) WITH CHECK (app_rls_tenant_allowed("tenantId"));
CREATE POLICY rls_appointment_communication_plan_delete ON "AppointmentCommunicationPlan" FOR DELETE TO app_rls USING (app_rls_tenant_allowed("tenantId"));
REVOKE ALL ON TABLE "AppointmentCommunicationPlan" FROM app_rls;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AppointmentCommunicationPlan" TO app_rls;

ALTER TABLE "AppointmentCommunicationAction" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AppointmentCommunicationAction" FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_appointment_communication_action_select ON "AppointmentCommunicationAction" FOR SELECT TO app_rls USING (app_rls_tenant_allowed("tenantId"));
CREATE POLICY rls_appointment_communication_action_insert ON "AppointmentCommunicationAction" FOR INSERT TO app_rls WITH CHECK (app_rls_tenant_allowed("tenantId"));
CREATE POLICY rls_appointment_communication_action_update ON "AppointmentCommunicationAction" FOR UPDATE TO app_rls USING (app_rls_tenant_allowed("tenantId")) WITH CHECK (app_rls_tenant_allowed("tenantId"));
CREATE POLICY rls_appointment_communication_action_delete ON "AppointmentCommunicationAction" FOR DELETE TO app_rls USING (app_rls_tenant_allowed("tenantId"));
REVOKE ALL ON TABLE "AppointmentCommunicationAction" FROM app_rls;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AppointmentCommunicationAction" TO app_rls;
