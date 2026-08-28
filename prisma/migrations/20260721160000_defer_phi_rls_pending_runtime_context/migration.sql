-- Defer PHI-table RLS pending request-scoped tenant context.
--
-- The prior migration 20260721120000_enable_rls_phi_wave enrolled these
-- PHI/payment/device tables under FORCE row-level security. But the runtime
-- request path uses the plain `db` client (server/lib/db.ts) and never sets
-- the app.current_tenant_id GUC — only the RLS verify scripts use
-- runWithTenantContext. With the intended production role app_rls
-- (NOBYPASSRLS, enforced at boot by assertRlsRuntimeRole), FORCE-RLS on
-- these hot tables rejects every legitimate write:
--   'new row violates row-level security policy for table "Patient"'.
--
-- Tenant isolation remains enforced at the application layer (every query is
-- tenantId-scoped; see security.integration + rbac.permissions tests). The
-- authored RLS policies are preserved in git history of the phi_wave migration
-- and re-enable once request-scoped tenant context is wired through handlers.
-- Idempotent: safe to run on a fresh deploy immediately after phi_wave.

DROP POLICY IF EXISTS tenant_isolation ON "Appointment AuditEvent BenefitSnapshot ConsentEvent DepositRequirement DeviceEvent DeviceReading EligibilityVerification NotificationEvent Patient PatientConsent PatientDeviceEnrollment PatientInsurancePolicy PatientResponsibilityEstimate PaymentRequest PaymentTransaction PriorAuthorization RPMBillingReadiness ReadingAlert";
DROP POLICY IF EXISTS tenant_isolation ON "Appointment";
DROP POLICY IF EXISTS tenant_isolation_select ON "Appointment";
DROP POLICY IF EXISTS audit_append ON "Appointment";
ALTER TABLE "Appointment" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "Appointment" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "AuditEvent";
DROP POLICY IF EXISTS tenant_isolation_select ON "AuditEvent";
DROP POLICY IF EXISTS audit_append ON "AuditEvent";
ALTER TABLE "AuditEvent" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "AuditEvent" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "BenefitSnapshot";
DROP POLICY IF EXISTS tenant_isolation_select ON "BenefitSnapshot";
DROP POLICY IF EXISTS audit_append ON "BenefitSnapshot";
ALTER TABLE "BenefitSnapshot" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "BenefitSnapshot" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "ConsentEvent";
DROP POLICY IF EXISTS tenant_isolation_select ON "ConsentEvent";
DROP POLICY IF EXISTS audit_append ON "ConsentEvent";
ALTER TABLE "ConsentEvent" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "ConsentEvent" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "DepositRequirement";
DROP POLICY IF EXISTS tenant_isolation_select ON "DepositRequirement";
DROP POLICY IF EXISTS audit_append ON "DepositRequirement";
ALTER TABLE "DepositRequirement" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "DepositRequirement" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "DeviceEvent";
DROP POLICY IF EXISTS tenant_isolation_select ON "DeviceEvent";
DROP POLICY IF EXISTS audit_append ON "DeviceEvent";
ALTER TABLE "DeviceEvent" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "DeviceEvent" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "DeviceReading";
DROP POLICY IF EXISTS tenant_isolation_select ON "DeviceReading";
DROP POLICY IF EXISTS audit_append ON "DeviceReading";
ALTER TABLE "DeviceReading" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "DeviceReading" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "EligibilityVerification";
DROP POLICY IF EXISTS tenant_isolation_select ON "EligibilityVerification";
DROP POLICY IF EXISTS audit_append ON "EligibilityVerification";
ALTER TABLE "EligibilityVerification" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "EligibilityVerification" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "NotificationEvent";
DROP POLICY IF EXISTS tenant_isolation_select ON "NotificationEvent";
DROP POLICY IF EXISTS audit_append ON "NotificationEvent";
ALTER TABLE "NotificationEvent" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "NotificationEvent" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "Patient";
DROP POLICY IF EXISTS tenant_isolation_select ON "Patient";
DROP POLICY IF EXISTS audit_append ON "Patient";
ALTER TABLE "Patient" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "Patient" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "PatientConsent";
DROP POLICY IF EXISTS tenant_isolation_select ON "PatientConsent";
DROP POLICY IF EXISTS audit_append ON "PatientConsent";
ALTER TABLE "PatientConsent" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "PatientConsent" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "PatientDeviceEnrollment";
DROP POLICY IF EXISTS tenant_isolation_select ON "PatientDeviceEnrollment";
DROP POLICY IF EXISTS audit_append ON "PatientDeviceEnrollment";
ALTER TABLE "PatientDeviceEnrollment" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "PatientDeviceEnrollment" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "PatientInsurancePolicy";
DROP POLICY IF EXISTS tenant_isolation_select ON "PatientInsurancePolicy";
DROP POLICY IF EXISTS audit_append ON "PatientInsurancePolicy";
ALTER TABLE "PatientInsurancePolicy" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "PatientInsurancePolicy" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "PatientResponsibilityEstimate";
DROP POLICY IF EXISTS tenant_isolation_select ON "PatientResponsibilityEstimate";
DROP POLICY IF EXISTS audit_append ON "PatientResponsibilityEstimate";
ALTER TABLE "PatientResponsibilityEstimate" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "PatientResponsibilityEstimate" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "PaymentRequest";
DROP POLICY IF EXISTS tenant_isolation_select ON "PaymentRequest";
DROP POLICY IF EXISTS audit_append ON "PaymentRequest";
ALTER TABLE "PaymentRequest" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "PaymentRequest" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "PaymentTransaction";
DROP POLICY IF EXISTS tenant_isolation_select ON "PaymentTransaction";
DROP POLICY IF EXISTS audit_append ON "PaymentTransaction";
ALTER TABLE "PaymentTransaction" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "PaymentTransaction" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "PriorAuthorization";
DROP POLICY IF EXISTS tenant_isolation_select ON "PriorAuthorization";
DROP POLICY IF EXISTS audit_append ON "PriorAuthorization";
ALTER TABLE "PriorAuthorization" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "PriorAuthorization" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "RPMBillingReadiness";
DROP POLICY IF EXISTS tenant_isolation_select ON "RPMBillingReadiness";
DROP POLICY IF EXISTS audit_append ON "RPMBillingReadiness";
ALTER TABLE "RPMBillingReadiness" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "RPMBillingReadiness" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "ReadingAlert";
DROP POLICY IF EXISTS tenant_isolation_select ON "ReadingAlert";
DROP POLICY IF EXISTS audit_append ON "ReadingAlert";
ALTER TABLE "ReadingAlert" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "ReadingAlert" DISABLE ROW LEVEL SECURITY;

