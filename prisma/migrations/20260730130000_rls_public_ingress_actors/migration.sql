-- Permit only resolver-backed, resource-scoped public actors to activate RLS.
-- The opaque token is validated by app_resolve_ingress_tenant before these
-- contexts are entered; this second check binds the actor UUID to the same
-- active tenant and to the expected resource type.
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
      IF actor_role_text = 'PATIENT_PORTAL' THEN
        IF NOT EXISTS (
          SELECT 1 FROM public."PatientPortalAccount" p
          WHERE p.id = actor_text::uuid AND p."tenantId" = context_tenant
            AND p.status IN ('invited', 'active')
        ) THEN RETURN false; END IF;
      ELSIF actor_role_text = 'PUBLIC_INTAKE' THEN
        IF NOT EXISTS (
          SELECT 1 FROM public."PatientIntakePacket" p
          WHERE p.id = actor_text::uuid AND p."tenantId" = context_tenant
            AND p."publicTokenHash" IS NOT NULL
            AND p."tokenExpiresAt" > statement_timestamp()
            AND p.status NOT IN ('submitted', 'cancelled', 'expired', 'approved')
        ) THEN RETURN false; END IF;
      ELSIF actor_role_text = 'PUBLIC_PAYMENT' THEN
        IF NOT EXISTS (
          SELECT 1 FROM public."PaymentRequest" p
          WHERE p.id = actor_text::uuid AND p."tenantId" = context_tenant
            AND p."publicToken" IS NOT NULL
            AND (p."linkExpiresAt" IS NULL OR p."linkExpiresAt" > statement_timestamp())
        ) THEN RETURN false; END IF;
      ELSIF actor_role_text = 'PILOT_SHARE' THEN
        IF NOT EXISTS (
          SELECT 1 FROM public."PilotStatusShare" p
          WHERE p.id = actor_text::uuid AND p."tenantId" = context_tenant
            AND p."expiresAt" > statement_timestamp()
        ) THEN RETURN false; END IF;
      ELSE
        RETURN false;
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
