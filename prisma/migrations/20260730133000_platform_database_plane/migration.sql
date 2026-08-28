-- Dedicated, least-privilege platform/control-plane database principal.
-- Password/secret provisioning remains an infrastructure responsibility.
DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_platform') THEN
    CREATE ROLE app_platform LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'app_platform'
      AND (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolinherit)
  ) THEN
    RAISE EXCEPTION 'app_platform has an unsafe role posture';
  END IF;
END
$role$;

GRANT USAGE ON SCHEMA public TO app_platform;
REVOKE ALL ON TABLE "_prisma_migrations" FROM app_platform;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM app_platform;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM app_platform;

-- The tenant runtime must never administer platform identities, encrypted
-- provider credentials, global configuration, or the platform audit ledger.
REVOKE ALL ON TABLE
  "PlatformUser", "PlatformConfig", "PlatformIntegration", "PlatformAuditEvent"
FROM app_rls;

-- Global control-plane tables. Audit is append-only; users are disabled rather
-- than deleted. Announcements remain SELECT-only for the tenant application.
GRANT SELECT, INSERT, UPDATE ON TABLE "PlatformUser" TO app_platform;
GRANT SELECT, INSERT ON TABLE "PlatformAuditEvent" TO app_platform;
GRANT SELECT, INSERT, UPDATE ON TABLE "PlatformConfig" TO app_platform;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "PlatformIntegration" TO app_platform;
GRANT SELECT, INSERT, UPDATE ON TABLE "PlatformAnnouncement" TO app_platform;
GRANT SELECT ON TABLE "SubscriptionPlan", "SubscriptionPlanFeature", "SubscriptionAddon" TO app_platform;

CREATE OR REPLACE FUNCTION app_platform_actor_allowed(required_roles text[] DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  actor_text text := NULLIF(current_setting('app.current_platform_actor_id', true), '');
  role_text text := NULLIF(current_setting('app.current_platform_actor_role', true), '');
BEGIN
  IF actor_text IS NULL OR role_text IS NULL
     OR actor_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM public."PlatformUser" p
    WHERE p.id = actor_text::uuid AND p.status = 'active' AND p.role = role_text
      AND (required_roles IS NULL OR p.role = 'PLATFORM_OWNER' OR p.role = ANY(required_roles))
  );
EXCEPTION WHEN others THEN
  RETURN false;
END
$fn$;
REVOKE ALL ON FUNCTION app_platform_actor_allowed(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_platform_actor_allowed(text[]) TO app_platform;

-- Only non-clinical tenant control tables are exposed to app_platform. Patient,
-- appointment, clinical, conversation, call and payment-detail tables receive
-- neither grants nor platform policies.
GRANT SELECT, INSERT, UPDATE ON TABLE "Tenant" TO app_platform;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  "TenantSubscription", "TenantSubscriptionAddon", "TenantFeatureEntitlement",
  "TenantSubscriptionRequest", "TenantBilling", "TenantUsageLimit", "TenantAiUsage",
  "TenantSecurityPolicy", "SupportAccessSession", "ComplianceFramework",
  "ComplianceControl", "DataRetentionPolicy"
TO app_platform;

DO $policies$
DECLARE table_name text;
DECLARE table_ref regclass;
DECLARE prefix text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'TenantSubscription', 'TenantSubscriptionAddon', 'TenantFeatureEntitlement',
    'TenantSubscriptionRequest', 'TenantBilling', 'TenantUsageLimit', 'TenantAiUsage',
    'TenantSecurityPolicy', 'SupportAccessSession', 'ComplianceFramework',
    'ComplianceControl', 'DataRetentionPolicy'
  ]
  LOOP
    table_ref := format('public.%I', table_name)::regclass;
    prefix := 'platform_' || substr(md5(table_name), 1, 12);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %s', prefix || '_select', table_ref);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %s', prefix || '_insert', table_ref);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %s', prefix || '_update', table_ref);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %s', prefix || '_delete', table_ref);
    EXECUTE format('CREATE POLICY %I ON %s FOR SELECT TO app_platform USING (app_platform_actor_allowed(NULL))', prefix || '_select', table_ref);
    EXECUTE format('CREATE POLICY %I ON %s FOR INSERT TO app_platform WITH CHECK (app_platform_actor_allowed(ARRAY[''PLATFORM_ADMIN'', ''PLATFORM_BILLING'']))', prefix || '_insert', table_ref);
    EXECUTE format('CREATE POLICY %I ON %s FOR UPDATE TO app_platform USING (app_platform_actor_allowed(ARRAY[''PLATFORM_ADMIN'', ''PLATFORM_BILLING''])) WITH CHECK (app_platform_actor_allowed(ARRAY[''PLATFORM_ADMIN'', ''PLATFORM_BILLING'']))', prefix || '_update', table_ref);
    EXECUTE format('CREATE POLICY %I ON %s FOR DELETE TO app_platform USING (app_platform_actor_allowed(ARRAY[''PLATFORM_ADMIN'', ''PLATFORM_BILLING'']))', prefix || '_delete', table_ref);
  END LOOP;
END
$policies$;

DROP POLICY IF EXISTS platform_tenant_select ON "Tenant";
DROP POLICY IF EXISTS platform_tenant_insert ON "Tenant";
DROP POLICY IF EXISTS platform_tenant_update ON "Tenant";
CREATE POLICY platform_tenant_select ON "Tenant" FOR SELECT TO app_platform
  USING (app_platform_actor_allowed(NULL));
CREATE POLICY platform_tenant_insert ON "Tenant" FOR INSERT TO app_platform
  WITH CHECK (app_platform_actor_allowed(ARRAY['PLATFORM_ADMIN', 'PLATFORM_BILLING']));
CREATE POLICY platform_tenant_update ON "Tenant" FOR UPDATE TO app_platform
  USING (app_platform_actor_allowed(ARRAY['PLATFORM_ADMIN', 'PLATFORM_BILLING']))
  WITH CHECK (app_platform_actor_allowed(ARRAY['PLATFORM_ADMIN', 'PLATFORM_BILLING']));

-- Curated aggregate functions are the only platform visibility into User and
-- Branch. app_platform receives no table/column privileges on either table.
CREATE OR REPLACE FUNCTION app_platform_overview()
RETURNS TABLE(tenants bigint, active_tenants bigint, suspended_tenants bigint, pending_requests bigint, platform_users bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF NOT app_platform_actor_allowed(NULL) THEN RAISE EXCEPTION 'platform_actor_required' USING ERRCODE = '42501'; END IF;
  RETURN QUERY SELECT
    count(*)::bigint,
    count(*) FILTER (WHERE t.status = 'active')::bigint,
    count(*) FILTER (WHERE t.status = 'suspended')::bigint,
    (SELECT count(*)::bigint FROM public."TenantSubscriptionRequest" r WHERE r.status = 'PENDING'),
    (SELECT count(*)::bigint FROM public."PlatformUser" p WHERE p.status = 'active')
  FROM public."Tenant" t;
END
$fn$;
REVOKE ALL ON FUNCTION app_platform_overview() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_platform_overview() TO app_platform;

CREATE OR REPLACE FUNCTION app_platform_tenant_activity(target_tenant uuid)
RETURNS TABLE(active_users bigint, branches bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF NOT app_platform_actor_allowed(NULL) THEN RAISE EXCEPTION 'platform_actor_required' USING ERRCODE = '42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public."Tenant" t WHERE t.id = target_tenant) THEN RETURN; END IF;
  RETURN QUERY SELECT
    (SELECT count(*)::bigint FROM public."User" u WHERE u."tenantId" = target_tenant AND u.active),
    (SELECT count(*)::bigint FROM public."Branch" b WHERE b."tenantId" = target_tenant);
END
$fn$;
REVOKE ALL ON FUNCTION app_platform_tenant_activity(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_platform_tenant_activity(uuid) TO app_platform;

-- Narrow provisioning capability: it can create the initial tenant, branch,
-- owner and subscription but cannot query arbitrary identities or PHI.
CREATE OR REPLACE FUNCTION app_platform_provision_tenant(
  clinic_name text,
  clinic_slug text,
  owner_name text,
  owner_email_input text,
  owner_password_hash text,
  branch_name_input text,
  branch_timezone text,
  plan_key text,
  trial_days integer
)
RETURNS TABLE(
  tenant_id uuid, tenant_name text, tenant_slug text,
  owner_id uuid, owner_email text,
  branch_id uuid, branch_name text,
  subscription_status text, trial_ends_at timestamptz
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  resolved_plan_id uuid;
  created_tenant_id uuid := gen_random_uuid();
  created_branch_id uuid := gen_random_uuid();
  created_owner_id uuid := gen_random_uuid();
  trial_end timestamptz := statement_timestamp() + make_interval(days => trial_days);
BEGIN
  IF NOT app_platform_actor_allowed(ARRAY['PLATFORM_ADMIN']) THEN
    RAISE EXCEPTION 'platform_admin_required' USING ERRCODE = '42501';
  END IF;
  IF clinic_slug !~ '^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$' THEN RAISE EXCEPTION 'platform_invalid_slug'; END IF;
  IF trial_days < 1 OR trial_days > 365 THEN RAISE EXCEPTION 'platform_invalid_trial_days'; END IF;
  IF EXISTS (SELECT 1 FROM public."Tenant" t WHERE t.slug = clinic_slug) THEN RAISE EXCEPTION 'platform_slug_taken'; END IF;
  IF EXISTS (SELECT 1 FROM public."User" u WHERE lower(u.email) = lower(owner_email_input)) THEN RAISE EXCEPTION 'platform_email_taken'; END IF;
  SELECT p.id INTO resolved_plan_id FROM public."SubscriptionPlan" p WHERE p.key = plan_key AND p.active;
  IF resolved_plan_id IS NULL THEN RAISE EXCEPTION 'platform_plan_unavailable'; END IF;

  INSERT INTO public."Tenant" (id, name, slug, status, "createdAt", "updatedAt")
    VALUES (created_tenant_id, clinic_name, clinic_slug, 'active', statement_timestamp(), statement_timestamp());
  INSERT INTO public."Branch" (id, "tenantId", name, location, timezone, active, "createdAt", "updatedAt")
    VALUES (created_branch_id, created_tenant_id, branch_name_input, clinic_name, branch_timezone, true, statement_timestamp(), statement_timestamp());
  INSERT INTO public."User" (id, "tenantId", "branchId", email, "displayName", role, "passwordHash", "passwordChangedAt", active, "createdAt", "updatedAt")
    VALUES (created_owner_id, created_tenant_id, created_branch_id, lower(owner_email_input), owner_name, 'OWNER', owner_password_hash, statement_timestamp(), true, statement_timestamp(), statement_timestamp());
  INSERT INTO public."TenantSubscription" (id, "tenantId", "planId", status, "trialEndsAt", "currentPeriodEnd", "startedAt", "createdAt", "updatedAt")
    VALUES (gen_random_uuid(), created_tenant_id, resolved_plan_id, 'TRIAL', trial_end, trial_end, statement_timestamp(), statement_timestamp(), statement_timestamp());
  INSERT INTO public."TenantSecurityPolicy" (id, "tenantId", "requireMfa", "sessionTimeoutMinutes", "failedLoginLockout", "allowedIpRanges", "dataRetentionDays", "backupFrequency", "evidenceReviewFrequency", "createdAt", "updatedAt")
    VALUES (gen_random_uuid(), created_tenant_id, false, 15, false, ARRAY[]::text[], 2555, 'daily', 'quarterly', statement_timestamp(), statement_timestamp());
  INSERT INTO public."AuditEvent" (id, "tenantId", action, resource, "resourceId", "userAgent", metadata, "occurredAt") VALUES
    (gen_random_uuid(), created_tenant_id, 'tenant.created', 'tenant', created_tenant_id::text, 'platform-console', jsonb_build_object('slug', clinic_slug, 'plan', plan_key, 'status', 'TRIAL'), statement_timestamp()),
    (gen_random_uuid(), created_tenant_id, 'tenant.owner.created', 'user', created_owner_id::text, 'platform-console', jsonb_build_object('email', lower(owner_email_input)), statement_timestamp());

  RETURN QUERY SELECT created_tenant_id, clinic_name, clinic_slug, created_owner_id, lower(owner_email_input),
    created_branch_id, branch_name_input, 'TRIAL'::text, trial_end;
END
$fn$;
REVOKE ALL ON FUNCTION app_platform_provision_tenant(text,text,text,text,text,text,text,text,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_platform_provision_tenant(text,text,text,text,text,text,text,text,integer) TO app_platform;

-- First signed Retell inbound call: resolve the verified destination number to
-- exactly one active receptionist clinic under an active tenant. Duplicates
-- intentionally resolve to no row rather than picking an arbitrary tenant.
CREATE INDEX IF NOT EXISTS "ReceptionistClinic_active_phone_idx"
  ON "ReceptionistClinic" (phone) WHERE active;

CREATE OR REPLACE FUNCTION app_resolve_ingress_tenant(kind text, lookup_value text)
RETURNS TABLE(tenant_id uuid, resource_id uuid)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF lookup_value IS NULL OR length(lookup_value) < 3 THEN RETURN; END IF;
  IF kind = 'tenant_slug' THEN
    RETURN QUERY SELECT t.id, t.id FROM public."Tenant" t WHERE t.slug = lookup_value AND t.status = 'active' LIMIT 1;
  ELSIF kind = 'portal_token_hash' THEN
    RETURN QUERY SELECT p."tenantId", p.id FROM public."PatientPortalToken" p JOIN public."Tenant" t ON t.id=p."tenantId" AND t.status='active' WHERE p."tokenHash"=lookup_value AND p."usedAt" IS NULL AND p."expiresAt">statement_timestamp() LIMIT 1;
  ELSIF kind = 'refresh_token_hash' THEN
    RETURN QUERY SELECT u."tenantId", u.id FROM public."User" u JOIN public."Tenant" t ON t.id=u."tenantId" AND t.status='active' WHERE u."refreshTokenHash"=lookup_value AND u.active AND u."refreshTokenExpiresAt">statement_timestamp() LIMIT 1;
  ELSIF kind = 'password_reset_hash' THEN
    RETURN QUERY SELECT p."tenantId", p.id FROM public."PasswordResetToken" p JOIN public."Tenant" t ON t.id=p."tenantId" AND t.status='active' WHERE p."tokenHash"=lookup_value AND p."usedAt" IS NULL AND p."expiresAt">statement_timestamp() LIMIT 1;
  ELSIF kind = 'intake_token_hash' THEN
    RETURN QUERY SELECT p."tenantId", p.id FROM public."PatientIntakePacket" p JOIN public."Tenant" t ON t.id=p."tenantId" AND t.status='active' WHERE p."publicTokenHash"=lookup_value AND p."tokenExpiresAt">statement_timestamp() AND p.status NOT IN ('submitted','cancelled') LIMIT 1;
  ELSIF kind = 'payment_public_token' THEN
    RETURN QUERY SELECT p."tenantId", p.id FROM public."PaymentRequest" p JOIN public."Tenant" t ON t.id=p."tenantId" AND t.status='active' WHERE p."publicToken"::text=lookup_value AND (p."linkExpiresAt" IS NULL OR p."linkExpiresAt">statement_timestamp()) LIMIT 1;
  ELSIF kind = 'pilot_share_hash' THEN
    RETURN QUERY SELECT p."tenantId", p.id FROM public."PilotStatusShare" p JOIN public."Tenant" t ON t.id=p."tenantId" AND t.status='active' WHERE p."tokenHash"=lookup_value AND p."expiresAt">statement_timestamp() LIMIT 1;
  ELSIF kind = 'stripe_provider_reference' THEN
    RETURN QUERY WITH matches AS (SELECT p."tenantId",p.id FROM public."PaymentRequest" p JOIN public."Tenant" t ON t.id=p."tenantId" AND t.status='active' WHERE p."providerReference"=lookup_value) SELECT m."tenantId",m.id FROM matches m WHERE (SELECT count(*) FROM matches)=1 LIMIT 1;
  ELSIF kind = 'retell_call_id' THEN
    RETURN QUERY WITH matches AS (SELECT c."tenantId",c.id FROM public."ReceptionistCallLog" c JOIN public."Tenant" t ON t.id=c."tenantId" AND t.status='active' WHERE c."retellCallId"=lookup_value) SELECT m."tenantId",m.id FROM matches m WHERE (SELECT count(*) FROM matches)=1 LIMIT 1;
  ELSIF kind = 'retell_destination_phone' THEN
    RETURN QUERY WITH matches AS (SELECT c."tenantId",c.id FROM public."ReceptionistClinic" c JOIN public."Tenant" t ON t.id=c."tenantId" AND t.status='active' WHERE c.phone=lookup_value AND c.active) SELECT m."tenantId",m.id FROM matches m WHERE (SELECT count(*) FROM matches)=1 LIMIT 1;
  ELSIF kind = 'campaign_provider_message' THEN
    RETURN QUERY WITH matches AS (SELECT c."tenantId",c.id FROM public."CampaignDelivery" c JOIN public."Tenant" t ON t.id=c."tenantId" AND t.status='active' WHERE c."providerMessageId"=lookup_value) SELECT m."tenantId",m.id FROM matches m WHERE (SELECT count(*) FROM matches)=1 LIMIT 1;
  ELSE RETURN;
  END IF;
END
$fn$;
REVOKE ALL ON FUNCTION app_resolve_ingress_tenant(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_resolve_ingress_tenant(text, text) TO app_rls;
