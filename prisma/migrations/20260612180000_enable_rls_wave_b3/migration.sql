-- RLS Phase B-3: low-risk expansion to DepositRule, RevenueProtectionAlert,
-- RevenueLeak. Applied by the owner (DATABASE_MIGRATION_URL). Enforcement is on
-- the restricted app_rls runtime role; the owner/superuser still bypasses RLS,
-- so migrations and seed are unaffected. app_rls already holds DML on all
-- tables (granted in 20260612170000_enable_rls_pilot) — no new grants needed.

ALTER TABLE "DepositRule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DepositRule" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "DepositRule";
CREATE POLICY tenant_isolation ON "DepositRule"
  USING      ("tenantId" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE "RevenueProtectionAlert" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RevenueProtectionAlert" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "RevenueProtectionAlert";
CREATE POLICY tenant_isolation ON "RevenueProtectionAlert"
  USING      ("tenantId" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE "RevenueLeak" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RevenueLeak" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "RevenueLeak";
CREATE POLICY tenant_isolation ON "RevenueLeak"
  USING      ("tenantId" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
