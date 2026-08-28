-- Completion-grade tenant RLS foundation.
-- Applied by DATABASE_MIGRATION_URL (schema owner). Runtime remains app_rls.

-- The arbitrary-text translation cache was a global PHI sink. Runtime
-- translation is disabled until curated static message identifiers exist.
DROP TABLE IF EXISTS "TranslationCache";

-- Future objects are deny-by-default. Migrations must grant the minimum
-- privileges deliberately and update the catalog guard/classification matrix.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM app_rls;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM app_rls;
REVOKE ALL ON TABLE "_prisma_migrations" FROM app_rls;

-- Global reference/control objects are explicit exemptions, not an accidental
-- consequence of blanket default grants.
REVOKE ALL ON TABLE
  "SubscriptionPlan", "SubscriptionPlanFeature", "SubscriptionAddon",
  "PlatformAnnouncement", "PlatformConfig", "PlatformIntegration",
  "PlatformUser", "PlatformAuditEvent"
FROM app_rls;
GRANT SELECT ON TABLE
  "SubscriptionPlan", "SubscriptionPlanFeature", "SubscriptionAddon",
  "PlatformAnnouncement"
TO app_rls;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  "PlatformConfig", "PlatformIntegration", "PlatformUser"
TO app_rls;
-- Platform audit is a global append-only security ledger. tenantId identifies
-- an optional target; it is not row ownership.
GRANT SELECT, INSERT ON TABLE "PlatformAuditEvent" TO app_rls;

-- Every tenant-keyed table remains available to app_rls only through RLS.
DO $grant$
DECLARE row record;
BEGIN
  FOR row IN
    SELECT c.oid::regclass AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND EXISTS (
        SELECT 1 FROM pg_attribute a
        WHERE a.attrelid = c.oid AND a.attname = 'tenantId' AND NOT a.attisdropped
      )
      AND c.relname <> 'PlatformAuditEvent'
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %s TO app_rls', row.table_name);
  END LOOP;
END
$grant$;
REVOKE INSERT, UPDATE, DELETE ON TABLE "Tenant" FROM app_rls;
GRANT SELECT ON TABLE "Tenant" TO app_rls;
-- Audit evidence is append-only for the runtime role even if an earlier
-- migration granted blanket CRUD privileges.
REVOKE UPDATE, DELETE ON TABLE "AuditEvent" FROM app_rls;

-- Custom context settings are transaction-local. This function validates all
-- security-relevant settings and the persisted tenant state. It returns false
-- for missing, empty, malformed, unknown, suspended, archived or expired
-- support context instead of granting access.
CREATE OR REPLACE FUNCTION app_rls_tenant_allowed(row_tenant uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  tenant_text text := NULLIF(current_setting('app.current_tenant_id', true), '');
  actor_text text := NULLIF(current_setting('app.current_actor_id', true), '');
  actor_role_text text := NULLIF(current_setting('app.current_actor_role', true), '');
  source_text text := NULLIF(current_setting('app.current_context_source', true), '');
  reason_text text := NULLIF(current_setting('app.current_support_reason', true), '');
  expiry_text text := NULLIF(current_setting('app.current_support_expires_at', true), '');
  support_session_text text := NULLIF(current_setting('app.current_support_session_id', true), '');
  context_tenant uuid;
BEGIN
  IF row_tenant IS NULL OR tenant_text IS NULL OR actor_text IS NULL OR actor_role_text IS NULL OR source_text IS NULL THEN
    RETURN false;
  END IF;
  IF source_text NOT IN ('request', 'portal', 'worker', 'webhook', 'platform', 'support', 'system') THEN
    RETURN false;
  END IF;
  IF tenant_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN false;
  END IF;
  context_tenant := tenant_text::uuid;
  IF row_tenant <> context_tenant THEN RETURN false; END IF;

  IF source_text = 'request' THEN
    IF actor_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR NOT EXISTS (
         SELECT 1 FROM public."User" u
         WHERE u.id = actor_text::uuid AND u."tenantId" = context_tenant AND u.active
       ) THEN RETURN false;
    END IF;
  ELSIF source_text = 'portal' THEN
    IF actor_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      IF actor_role_text <> 'PATIENT_PORTAL' OR NOT EXISTS (
        SELECT 1 FROM public."PatientPortalAccount" p
        WHERE p.id = actor_text::uuid AND p."tenantId" = context_tenant
          AND p.status IN ('invited', 'active')
      ) THEN RETURN false;
      END IF;
    ELSIF actor_text NOT IN ('portal:request-link', 'portal:signup', 'portal:verify')
          OR actor_role_text <> 'PUBLIC_PORTAL' THEN
      RETURN false;
    END IF;
  ELSIF source_text = 'platform' THEN
    IF actor_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR NOT EXISTS (
         SELECT 1 FROM public."PlatformUser" p
         WHERE p.id = actor_text::uuid AND p.status = 'active'
       ) THEN RETURN false;
    END IF;
  ELSIF source_text = 'support' THEN
    IF reason_text IS NULL OR expiry_text IS NULL OR support_session_text IS NULL
       OR actor_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR support_session_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RETURN false;
    END IF;
    BEGIN
      IF expiry_text::timestamptz <= statement_timestamp() THEN RETURN false; END IF;
    EXCEPTION WHEN others THEN
      RETURN false;
    END;
    IF NOT EXISTS (
      SELECT 1
      FROM public."SupportAccessSession" s
      JOIN public."PlatformUser" p ON p.id = s."platformUserId" AND p.status = 'active'
      WHERE s.id = support_session_text::uuid
        AND s."tenantId" = context_tenant
        AND s."platformUserId" = actor_text::uuid
        AND s.reason = reason_text
        AND s."endedAt" IS NULL
        AND s."expiresAt" > statement_timestamp()
        AND s."expiresAt" >= expiry_text::timestamptz
    ) THEN RETURN false;
    END IF;
  ELSIF source_text = 'worker' THEN
    IF actor_role_text <> 'WORKER' OR actor_text !~ '^worker:[a-z0-9._:-]{3,120}$' THEN RETURN false; END IF;
  ELSIF source_text = 'webhook' THEN
    IF actor_role_text <> 'WEBHOOK' OR actor_text !~ '^webhook:[a-z0-9._:-]{3,120}$' THEN RETURN false; END IF;
  ELSE
    -- The system source is reserved for owner-controlled maintenance and is
    -- never accepted for runtime tenant-table access.
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM public."Tenant" t
    WHERE t.id = context_tenant AND t.status = 'active'
  );
EXCEPTION WHEN others THEN
  RETURN false;
END
$fn$;
REVOKE ALL ON FUNCTION app_rls_tenant_allowed(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_rls_tenant_allowed(uuid) TO app_rls;

-- Narrow bootstrap resolver. It returns only a tenant/resource mapping after a
-- stored opaque identifier matches exactly and the tenant is active. Ambiguous
-- provider identifiers fail closed via HAVING count(*) = 1.
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
    RETURN QUERY SELECT t.id, t.id FROM public."Tenant" t
      WHERE t.slug = lookup_value AND t.status = 'active' LIMIT 1;
  ELSIF kind = 'portal_token_hash' THEN
    RETURN QUERY SELECT p."tenantId", p.id FROM public."PatientPortalToken" p
      JOIN public."Tenant" t ON t.id = p."tenantId" AND t.status = 'active'
      WHERE p."tokenHash" = lookup_value LIMIT 1;
  ELSIF kind = 'refresh_token_hash' THEN
    RETURN QUERY SELECT u."tenantId", u.id FROM public."User" u
      JOIN public."Tenant" t ON t.id = u."tenantId" AND t.status = 'active'
      WHERE u."refreshTokenHash" = lookup_value LIMIT 1;
  ELSIF kind = 'password_reset_hash' THEN
    RETURN QUERY SELECT p."tenantId", p.id FROM public."PasswordResetToken" p
      JOIN public."Tenant" t ON t.id = p."tenantId" AND t.status = 'active'
      WHERE p."tokenHash" = lookup_value LIMIT 1;
  ELSIF kind = 'intake_token_hash' THEN
    RETURN QUERY SELECT p."tenantId", p.id FROM public."PatientIntakePacket" p
      JOIN public."Tenant" t ON t.id = p."tenantId" AND t.status = 'active'
      WHERE p."publicTokenHash" = lookup_value LIMIT 1;
  ELSIF kind = 'payment_public_token' THEN
    RETURN QUERY SELECT p."tenantId", p.id FROM public."PaymentRequest" p
      JOIN public."Tenant" t ON t.id = p."tenantId" AND t.status = 'active'
      WHERE p."publicToken"::text = lookup_value LIMIT 1;
  ELSIF kind = 'pilot_share_hash' THEN
    RETURN QUERY SELECT p."tenantId", p.id FROM public."PilotStatusShare" p
      JOIN public."Tenant" t ON t.id = p."tenantId" AND t.status = 'active'
      WHERE p."tokenHash" = lookup_value LIMIT 1;
  ELSIF kind = 'stripe_provider_reference' THEN
    RETURN QUERY
      SELECT min(p."tenantId"), min(p.id)
      FROM public."PaymentRequest" p
      JOIN public."Tenant" t ON t.id = p."tenantId" AND t.status = 'active'
      WHERE p."providerReference" = lookup_value
      HAVING count(*) = 1;
  ELSIF kind = 'retell_call_id' THEN
    RETURN QUERY
      SELECT min(c."tenantId"), min(c.id)
      FROM public."ReceptionistCallLog" c
      JOIN public."Tenant" t ON t.id = c."tenantId" AND t.status = 'active'
      WHERE c."retellCallId" = lookup_value
      HAVING count(*) = 1;
  ELSIF kind = 'campaign_provider_message' THEN
    RETURN QUERY
      SELECT min(c."tenantId"), min(c.id)
      FROM public."CampaignDelivery" c
      JOIN public."Tenant" t ON t.id = c."tenantId" AND t.status = 'active'
      WHERE c."providerMessageId" = lookup_value
      HAVING count(*) = 1;
  ELSE
    RETURN;
  END IF;
END
$fn$;
REVOKE ALL ON FUNCTION app_resolve_ingress_tenant(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_resolve_ingress_tenant(text, text) TO app_rls;

-- Cross-tenant scheduled ticks may enumerate active tenant UUIDs only. The
-- signed per-tenant job envelope is validated by the worker before the returned
-- identifier is used to establish a worker context.
CREATE OR REPLACE FUNCTION app_active_tenant_ids()
RETURNS TABLE(tenant_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT t.id
  FROM public."Tenant" t
  WHERE t.status = 'active'
  ORDER BY t.id
$fn$;
REVOKE ALL ON FUNCTION app_active_tenant_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_active_tenant_ids() TO app_rls;

-- Inactive tenants cannot establish a normal TenantContext. This single-purpose
-- function revokes an otherwise-valid refresh credential without exposing any
-- tenant rows to the caller.
CREATE OR REPLACE FUNCTION app_revoke_inactive_refresh_token(lookup_hash text)
RETURNS TABLE(user_id uuid, tenant_id uuid, tenant_status text)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  WITH candidate AS (
    SELECT u.id, u."tenantId", t.status
    FROM public."User" u
    JOIN public."Tenant" t ON t.id = u."tenantId"
    WHERE u."refreshTokenHash" = lookup_hash
      AND u."refreshTokenExpiresAt" > statement_timestamp()
      AND t.status <> 'active'
    LIMIT 1
  ), revoked AS (
    UPDATE public."User" u
    SET "refreshTokenHash" = NULL, "refreshTokenExpiresAt" = NULL, "updatedAt" = statement_timestamp()
    FROM candidate c
    WHERE u.id = c.id
    RETURNING u.id, u."tenantId"
  )
  SELECT r.id, r."tenantId", c.status
  FROM revoked r JOIN candidate c ON c.id = r.id
$fn$;
REVOKE ALL ON FUNCTION app_revoke_inactive_refresh_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_revoke_inactive_refresh_token(text) TO app_rls;

-- Email/password bootstrap. Only the fields required to verify credentials and
-- issue a scoped session are returned. Tenant slugs are selectors, never trust.
CREATE OR REPLACE FUNCTION app_auth_login_candidates(login_email text, tenant_slug text DEFAULT NULL)
RETURNS TABLE(
  user_id uuid, tenant_id uuid, email text, display_name text, user_role text,
  branch_id uuid, password_hash text, locked_until timestamptz,
  failed_login_count integer, password_changed_at timestamptz,
  mfa_enabled boolean, mfa_secret_enc text, mfa_enrolled_at timestamptz,
  tenant_name text, resolved_tenant_slug text, tenant_status text,
  branch_name text, branch_location text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT u.id, u."tenantId", u.email, u."displayName", u.role::text,
         u."branchId", u."passwordHash", u."lockedUntil",
         u."failedLoginCount", u."passwordChangedAt", u."mfaEnabled",
         u."mfaSecretEnc", u."mfaEnrolledAt", t.name, t.slug, t.status,
         b.name, b.location
  FROM public."User" u
  JOIN public."Tenant" t ON t.id = u."tenantId"
  LEFT JOIN public."Branch" b ON b.id = u."branchId" AND b."tenantId" = u."tenantId"
  WHERE u.email = lower(login_email) AND u.active
    AND (tenant_slug IS NULL OR t.slug = lower(tenant_slug))
  ORDER BY u.id
  LIMIT CASE WHEN tenant_slug IS NULL THEN 10 ELSE 1 END
$fn$;
REVOKE ALL ON FUNCTION app_auth_login_candidates(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_auth_login_candidates(text, text) TO app_rls;

-- Explicit per-command RLS for every direct tenant table except the platform
-- audit exemption. AuditEvent is append-only at runtime.
DO $policies$
DECLARE tbl record;
DECLARE pol record;
DECLARE prefix text;
BEGIN
  FOR tbl IN
    SELECT c.oid, c.oid::regclass AS table_name, c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
      AND c.relname <> 'PlatformAuditEvent'
      AND EXISTS (
        SELECT 1 FROM pg_attribute a
        WHERE a.attrelid = c.oid AND a.attname = 'tenantId' AND NOT a.attisdropped
      )
  LOOP
    FOR pol IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = tbl.relname
    LOOP
      EXECUTE format('DROP POLICY %I ON %s', pol.policyname, tbl.table_name);
    END LOOP;
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl.table_name);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tbl.table_name);
    prefix := 'rls_' || substr(md5(tbl.relname), 1, 12);
    EXECUTE format('CREATE POLICY %I ON %s FOR SELECT TO app_rls USING (app_rls_tenant_allowed("tenantId"))', prefix || '_select', tbl.table_name);
    EXECUTE format('CREATE POLICY %I ON %s FOR INSERT TO app_rls WITH CHECK (app_rls_tenant_allowed("tenantId"))', prefix || '_insert', tbl.table_name);
    IF tbl.relname <> 'AuditEvent' THEN
      EXECUTE format('CREATE POLICY %I ON %s FOR UPDATE TO app_rls USING (app_rls_tenant_allowed("tenantId")) WITH CHECK (app_rls_tenant_allowed("tenantId"))', prefix || '_update', tbl.table_name);
      EXECUTE format('CREATE POLICY %I ON %s FOR DELETE TO app_rls USING (app_rls_tenant_allowed("tenantId"))', prefix || '_delete', tbl.table_name);
    END IF;
  END LOOP;
END
$policies$;

-- Tenant root is visible only for the active selected context. Creation and
-- lifecycle changes are handled by separately authenticated platform paths.
ALTER TABLE "Tenant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Tenant" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_tenant_select ON "Tenant";
DROP POLICY IF EXISTS rls_tenant_insert ON "Tenant";
DROP POLICY IF EXISTS rls_tenant_update ON "Tenant";
DROP POLICY IF EXISTS rls_tenant_delete ON "Tenant";
CREATE POLICY rls_tenant_select ON "Tenant" FOR SELECT TO app_rls
  USING (app_rls_tenant_allowed(id));

-- Policy predicates and token bootstrap lookups must be indexed.
CREATE INDEX IF NOT EXISTS "PatientPortalToken_tenantId_idx" ON "PatientPortalToken"("tenantId");
CREATE INDEX IF NOT EXISTS "ReceptionistIntakeField_tenantId_idx" ON "ReceptionistIntakeField"("tenantId");

-- Add tenant-consistent composite foreign keys wherever both sides are tenant
-- keyed. Existing id-only FKs retain their delete action; these additional
-- constraints make cross-tenant attachment impossible in the database.
DO $tenant_fks$
DECLARE fk record;
DECLARE unique_name text;
DECLARE index_name text;
DECLARE constraint_name text;
BEGIN
  FOR fk IN
    SELECT
      child.oid::regclass AS child_table,
      parent.oid::regclass AS parent_table,
      child.relname AS child_name,
      parent.relname AS parent_name,
      con.conname,
      (SELECT string_agg(format('%I', a.attname), ', ' ORDER BY u.ord)
       FROM unnest(con.conkey) WITH ORDINALITY u(attnum, ord)
       JOIN pg_attribute a ON a.attrelid = child.oid AND a.attnum = u.attnum) AS child_cols,
      (SELECT string_agg(format('%I', a.attname), ', ' ORDER BY u.ord)
       FROM unnest(con.confkey) WITH ORDINALITY u(attnum, ord)
       JOIN pg_attribute a ON a.attrelid = parent.oid AND a.attnum = u.attnum) AS parent_cols
    FROM pg_constraint con
    JOIN pg_class child ON child.oid = con.conrelid
    JOIN pg_class parent ON parent.oid = con.confrelid
    JOIN pg_namespace n ON n.oid = child.relnamespace
    WHERE con.contype = 'f' AND n.nspname = 'public'
      AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = child.oid AND a.attname = 'tenantId' AND NOT a.attisdropped)
      AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = parent.oid AND a.attname = 'tenantId' AND NOT a.attisdropped)
      AND NOT ('tenantId' = ANY (
        SELECT a.attname FROM unnest(con.conkey) key(attnum)
        JOIN pg_attribute a ON a.attrelid = child.oid AND a.attnum = key.attnum
      ))
  LOOP
    unique_name := 'rls_uq_' || substr(md5(fk.parent_name || ':' || fk.parent_cols), 1, 20);
    index_name := 'rls_ix_' || substr(md5(fk.child_name || ':' || fk.child_cols), 1, 20);
    constraint_name := 'rls_fk_' || substr(md5(fk.child_name || ':' || fk.conname), 1, 20);
    EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS %I ON %s ("tenantId", %s)', unique_name, fk.parent_table, fk.parent_cols);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %s ("tenantId", %s)', index_name, fk.child_table, fk.child_cols);
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = constraint_name AND conrelid = fk.child_table) THEN
      EXECUTE format(
        'ALTER TABLE %s ADD CONSTRAINT %I FOREIGN KEY ("tenantId", %s) REFERENCES %s ("tenantId", %s) NOT VALID',
        fk.child_table, constraint_name, fk.child_cols, fk.parent_table, fk.parent_cols
      );
      EXECUTE format('ALTER TABLE %s VALIDATE CONSTRAINT %I', fk.child_table, constraint_name);
    END IF;
  END LOOP;
END
$tenant_fks$;
