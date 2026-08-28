-- RLS PHI wave: extends the established tenant_isolation pattern (see
-- 20260612170000_enable_rls_pilot and 20260612180000_enable_rls_wave_b3) to the
-- PHI / payment / audit tables. Applied by the owner (DATABASE_MIGRATION_URL);
-- enforcement bites only the restricted runtime role `app_rls`
-- (NOSUPERUSER NOBYPASSRLS). The owner is superuser/BYPASSRLS, so migrations
-- and seeds are unaffected. app_rls already holds DML on all tables via the
-- default privileges granted in 20260612170000 — no new grants needed.
--
-- Policy semantics (identical to the pilot): rows are visible/writable only
-- when "tenantId" equals the transaction-local GUC app.current_tenant_id set
-- by server/lib/tenantContext.ts. When the GUC is unset the policy evaluates
-- to NULL -> fail closed (zero rows, writes rejected).
--
-- Enrolled this wave (non-null "tenantId" uuid verified in prisma/schema.prisma):
--   Clinical core .... Patient, Appointment, ConsentEvent
--   Payments ......... PaymentRequest, PaymentTransaction, DepositRequirement
--   Insurance PHI .... PatientInsurancePolicy, EligibilityVerification,
--                      BenefitSnapshot, PriorAuthorization,
--                      PatientResponsibilityEstimate
--   Remote monitoring  DeviceEvent, DeviceReading, ReadingAlert,
--                      NotificationEvent, PatientDeviceEnrollment,
--                      PatientConsent, RPMBillingReadiness
--   Audit ............ AuditEvent (special-cased below)
--
-- Deliberately NOT enrolled this wave:
--   PlatformAuditEvent — nullable tenantId by design; platform-scope rows
--     (tenantId IS NULL) are written by the platform admin console outside any
--     tenant context. Enrolling it would break platform-admin audit writes.
--   PatientIntakePacket / PatientIntakeSection / PatientIntakeDocument /
--   PatientConsentRecord — the public hashed-token intake flow resolves the
--     tenant FROM the packet row (lookup by publicTokenHash happens before any
--     tenant context exists). Enrolling would fail-close the public intake
--     surface. Needs a token-scoped lookup design first.
--   PatientPortalAccount / PatientPortalToken / PortalAccessRequest — portal
--     auth resolves the tenant FROM the token/account row pre-context (and the
--     portal module is under active change elsewhere).
--   ReceptionistCallLog / AppointmentRequest / Receptionist* — the Retell
--     webhook resolves the tenant from clinic/agent rows pre-context.
--   IdempotencyKey — nullable tenantId; webhook idempotency claims occur
--     before the tenant is known.
--
-- AuditEvent is enrolled with a deliberately split policy instead of the
-- uniform ALL policy:
--   * SELECT is tenant-scoped and fail-closed like every other table.
--   * INSERT is allowed when no tenant GUC is set (platform-admin provisioning
--     in server/lib/platform.ts / tenantProvisioning.ts and verified public
--     webhooks stamp tenantId explicitly before any tenant transaction
--     exists); inside a tenant transaction the stamped tenantId must match the
--     GUC, so a tenant-scoped code path can never forge another tenant's
--     audit row.
--   * No UPDATE/DELETE policy exists, so both are denied for app_rls:
--     the audit trail is append-only at the database level for the runtime
--     role. Retention jobs run as the owner and are unaffected.

-- ── Clinical core ──────────────────────────────────────────────────────────

ALTER TABLE "Patient" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Patient" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "Patient";
CREATE POLICY tenant_isolation ON "Patient"
  USING      ("tenantId" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE "Appointment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Appointment" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "Appointment";
CREATE POLICY tenant_isolation ON "Appointment"
  USING      ("tenantId" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE "ConsentEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ConsentEvent" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "ConsentEvent";
CREATE POLICY tenant_isolation ON "ConsentEvent"
  USING      ("tenantId" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- ── Payments ───────────────────────────────────────────────────────────────

ALTER TABLE "PaymentRequest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PaymentRequest" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "PaymentRequest";
CREATE POLICY tenant_isolation ON "PaymentRequest"
  USING      ("tenantId" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE "PaymentTransaction" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PaymentTransaction" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "PaymentTransaction";
CREATE POLICY tenant_isolation ON "PaymentTransaction"
  USING      ("tenantId" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE "DepositRequirement" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DepositRequirement" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "DepositRequirement";
CREATE POLICY tenant_isolation ON "DepositRequirement"
  USING      ("tenantId" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- ── Insurance PHI ──────────────────────────────────────────────────────────

ALTER TABLE "PatientInsurancePolicy" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PatientInsurancePolicy" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "PatientInsurancePolicy";
CREATE POLICY tenant_isolation ON "PatientInsurancePolicy"
  USING      ("tenantId" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE "EligibilityVerification" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EligibilityVerification" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "EligibilityVerification";
CREATE POLICY tenant_isolation ON "EligibilityVerification"
  USING      ("tenantId" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE "BenefitSnapshot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BenefitSnapshot" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "BenefitSnapshot";
CREATE POLICY tenant_isolation ON "BenefitSnapshot"
  USING      ("tenantId" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE "PriorAuthorization" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PriorAuthorization" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "PriorAuthorization";
CREATE POLICY tenant_isolation ON "PriorAuthorization"
  USING      ("tenantId" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE "PatientResponsibilityEstimate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PatientResponsibilityEstimate" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "PatientResponsibilityEstimate";
CREATE POLICY tenant_isolation ON "PatientResponsibilityEstimate"
  USING      ("tenantId" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- ── Remote monitoring / RPM ────────────────────────────────────────────────

ALTER TABLE "DeviceEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DeviceEvent" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "DeviceEvent";
CREATE POLICY tenant_isolation ON "DeviceEvent"
  USING      ("tenantId" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE "DeviceReading" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DeviceReading" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "DeviceReading";
CREATE POLICY tenant_isolation ON "DeviceReading"
  USING      ("tenantId" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE "ReadingAlert" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReadingAlert" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "ReadingAlert";
CREATE POLICY tenant_isolation ON "ReadingAlert"
  USING      ("tenantId" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE "NotificationEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "NotificationEvent" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "NotificationEvent";
CREATE POLICY tenant_isolation ON "NotificationEvent"
  USING      ("tenantId" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE "PatientDeviceEnrollment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PatientDeviceEnrollment" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "PatientDeviceEnrollment";
CREATE POLICY tenant_isolation ON "PatientDeviceEnrollment"
  USING      ("tenantId" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE "PatientConsent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PatientConsent" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "PatientConsent";
CREATE POLICY tenant_isolation ON "PatientConsent"
  USING      ("tenantId" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE "RPMBillingReadiness" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RPMBillingReadiness" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "RPMBillingReadiness";
CREATE POLICY tenant_isolation ON "RPMBillingReadiness"
  USING      ("tenantId" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- ── Audit trail (split policy — see header) ────────────────────────────────

ALTER TABLE "AuditEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditEvent" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "AuditEvent";
DROP POLICY IF EXISTS tenant_isolation_select ON "AuditEvent";
DROP POLICY IF EXISTS audit_append ON "AuditEvent";

-- Reads: tenant-scoped, fail-closed (identical semantics to tenant_isolation).
CREATE POLICY tenant_isolation_select ON "AuditEvent"
  FOR SELECT
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- Appends: allowed without a tenant GUC (platform provisioning + verified
-- webhooks stamp tenantId explicitly pre-context); with a GUC the stamp must
-- match, so tenant-scoped paths cannot write another tenant's audit row.
-- tenantId itself is NOT NULL, so every row still belongs to a tenant.
CREATE POLICY audit_append ON "AuditEvent"
  FOR INSERT
  WITH CHECK (
    NULLIF(current_setting('app.current_tenant_id', true), '') IS NULL
    OR "tenantId" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
  );

-- Intentionally no UPDATE or DELETE policy: with RLS enabled and no matching
-- policy those commands see/affect zero rows for app_rls — the audit trail is
-- append-only at the DB level for the runtime role.
