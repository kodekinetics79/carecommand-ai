-- Keep a valid public intake capability readable after final submission so a
-- patient can see confirmation and safely retry an interrupted submit. The
-- application separately rejects section writes once the packet is submitted.
-- This avoids the former mid-transaction RLS self-revocation while preserving
-- packet scope, active-tenant validation, token expiry, and terminal-state
-- denial for cancelled, expired, and approved packets.

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
            AND p.status NOT IN ('cancelled', 'expired', 'approved')
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

CREATE OR REPLACE FUNCTION app_resolve_ingress_tenant(kind text, lookup_value text)
RETURNS TABLE(tenant_id uuid, resource_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $ingress$
BEGIN
  IF lookup_value IS NULL OR length(lookup_value)<3 THEN RETURN; END IF;
  IF kind='tenant_slug' THEN
    RETURN QUERY SELECT t.id,t.id FROM public."Tenant" t WHERE t.slug=lookup_value AND t.status='active' LIMIT 1;
  ELSIF kind='portal_token_hash' THEN
    RETURN QUERY SELECT p."tenantId",p.id FROM public."PatientPortalToken" p JOIN public."Tenant" t ON t.id=p."tenantId" AND t.status='active' WHERE p."tokenHash"=lookup_value AND p."usedAt" IS NULL AND p."expiresAt">statement_timestamp() LIMIT 1;
  ELSIF kind='refresh_token_hash' THEN
    RETURN QUERY SELECT u."tenantId",u.id FROM public."User" u JOIN public."Tenant" t ON t.id=u."tenantId" AND t.status='active' WHERE u."refreshTokenHash"=lookup_value AND u.active AND u."refreshTokenExpiresAt">statement_timestamp() LIMIT 1;
  ELSIF kind='password_reset_hash' THEN
    RETURN QUERY SELECT p."tenantId",p.id FROM public."PasswordResetToken" p JOIN public."Tenant" t ON t.id=p."tenantId" AND t.status='active' WHERE p."tokenHash"=lookup_value AND p."usedAt" IS NULL AND p."expiresAt">statement_timestamp() LIMIT 1;
  ELSIF kind='intake_token_hash' THEN
    RETURN QUERY SELECT p."tenantId",p.id FROM public."PatientIntakePacket" p JOIN public."Tenant" t ON t.id=p."tenantId" AND t.status='active' WHERE p."publicTokenHash"=lookup_value AND p."tokenExpiresAt">statement_timestamp() AND p.status NOT IN ('cancelled','expired','approved') LIMIT 1;
  ELSIF kind='payment_public_token' THEN
    RETURN QUERY SELECT p."tenantId",p.id FROM public."PaymentRequest" p JOIN public."Tenant" t ON t.id=p."tenantId" AND t.status='active' WHERE p."publicToken"::text=lookup_value AND (p."linkExpiresAt" IS NULL OR p."linkExpiresAt">statement_timestamp()) LIMIT 1;
  ELSIF kind='pilot_share_hash' THEN
    RETURN QUERY SELECT p."tenantId",p.id FROM public."PilotStatusShare" p JOIN public."Tenant" t ON t.id=p."tenantId" AND t.status='active' WHERE p."tokenHash"=lookup_value AND p."expiresAt">statement_timestamp() LIMIT 1;
  ELSIF kind='stripe_provider_reference' THEN
    RETURN QUERY WITH matches AS (SELECT p."tenantId",p.id FROM public."PaymentRequest" p JOIN public."Tenant" t ON t.id=p."tenantId" AND t.status='active' WHERE p."providerReference"=lookup_value) SELECT m."tenantId",m.id FROM matches m WHERE (SELECT count(*) FROM matches)=1 LIMIT 1;
  ELSIF kind='retell_call_id' THEN
    RETURN QUERY WITH matches AS (SELECT c."tenantId",c.id FROM public."ReceptionistCallLog" c JOIN public."Tenant" t ON t.id=c."tenantId" AND t.status='active' WHERE c."retellCallId"=lookup_value) SELECT m."tenantId",m.id FROM matches m WHERE (SELECT count(*) FROM matches)=1 LIMIT 1;
  ELSIF kind='retell_destination_phone' THEN
    RETURN QUERY WITH matches AS (
      SELECT c."tenantId",c.id FROM public."ReceptionistClinic" c
      JOIN public."Tenant" t ON t.id=c."tenantId" AND t.status='active'
      WHERE COALESCE(NULLIF(btrim(c."inboundNumber"), ''), c.phone)=lookup_value AND c.active
    ) SELECT m."tenantId",m.id FROM matches m WHERE (SELECT count(*) FROM matches)=1 LIMIT 1;
  ELSIF kind='retell_provider_intent' THEN
    IF lookup_value !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN; END IF;
    RETURN QUERY
      SELECT i."tenantId",i.id FROM public."ReceptionistOutboundProviderIntent" i
      JOIN public."ReceptionistCallLog" c ON c."tenantId"=i."tenantId" AND c."outboundCampaignId"=i."outboundCampaignId" AND c.id=i."callLogId"
      JOIN public."Tenant" t ON t.id=i."tenantId" AND t.status='active'
      WHERE i.id=lookup_value::uuid AND i."boundaryVersion"=1 AND c.outcome='IN_PROGRESS' AND c."endedAt" IS NULL LIMIT 1;
  ELSIF kind='campaign_provider_message' THEN
    RETURN QUERY WITH matches AS (SELECT c."tenantId",c.id FROM public."CampaignDelivery" c JOIN public."Tenant" t ON t.id=c."tenantId" AND t.status='active' WHERE c."providerMessageId"=lookup_value) SELECT m."tenantId",m.id FROM matches m WHERE (SELECT count(*) FROM matches)=1 LIMIT 1;
  ELSE RETURN;
  END IF;
END
$ingress$;

REVOKE ALL ON FUNCTION app_resolve_ingress_tenant(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_resolve_ingress_tenant(text,text) TO app_rls;
