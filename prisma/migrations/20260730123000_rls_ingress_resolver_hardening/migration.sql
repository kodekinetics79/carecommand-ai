-- Repair UUID ambiguity handling and make every token resolver enforce its
-- persisted lifecycle state. This follows the complete-RLS migration
-- immediately, before provider ingress is exercised.
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
      WHERE p."tokenHash" = lookup_value AND p."usedAt" IS NULL
        AND p."expiresAt" > statement_timestamp() LIMIT 1;
  ELSIF kind = 'refresh_token_hash' THEN
    RETURN QUERY SELECT u."tenantId", u.id FROM public."User" u
      JOIN public."Tenant" t ON t.id = u."tenantId" AND t.status = 'active'
      WHERE u."refreshTokenHash" = lookup_value AND u.active
        AND u."refreshTokenExpiresAt" > statement_timestamp() LIMIT 1;
  ELSIF kind = 'password_reset_hash' THEN
    RETURN QUERY SELECT p."tenantId", p.id FROM public."PasswordResetToken" p
      JOIN public."Tenant" t ON t.id = p."tenantId" AND t.status = 'active'
      WHERE p."tokenHash" = lookup_value AND p."usedAt" IS NULL
        AND p."expiresAt" > statement_timestamp() LIMIT 1;
  ELSIF kind = 'intake_token_hash' THEN
    RETURN QUERY SELECT p."tenantId", p.id FROM public."PatientIntakePacket" p
      JOIN public."Tenant" t ON t.id = p."tenantId" AND t.status = 'active'
      WHERE p."publicTokenHash" = lookup_value
        AND p."tokenExpiresAt" > statement_timestamp()
        AND p.status NOT IN ('submitted', 'cancelled') LIMIT 1;
  ELSIF kind = 'payment_public_token' THEN
    RETURN QUERY SELECT p."tenantId", p.id FROM public."PaymentRequest" p
      JOIN public."Tenant" t ON t.id = p."tenantId" AND t.status = 'active'
      WHERE p."publicToken"::text = lookup_value
        AND (p."linkExpiresAt" IS NULL OR p."linkExpiresAt" > statement_timestamp()) LIMIT 1;
  ELSIF kind = 'pilot_share_hash' THEN
    RETURN QUERY SELECT p."tenantId", p.id FROM public."PilotStatusShare" p
      JOIN public."Tenant" t ON t.id = p."tenantId" AND t.status = 'active'
      WHERE p."tokenHash" = lookup_value AND p."expiresAt" > statement_timestamp() LIMIT 1;
  ELSIF kind = 'stripe_provider_reference' THEN
    RETURN QUERY WITH matches AS (
      SELECT p."tenantId", p.id
      FROM public."PaymentRequest" p
      JOIN public."Tenant" t ON t.id = p."tenantId" AND t.status = 'active'
      WHERE p."providerReference" = lookup_value
    ) SELECT m."tenantId", m.id FROM matches m
      WHERE (SELECT count(*) FROM matches) = 1 LIMIT 1;
  ELSIF kind = 'retell_call_id' THEN
    RETURN QUERY WITH matches AS (
      SELECT c."tenantId", c.id
      FROM public."ReceptionistCallLog" c
      JOIN public."Tenant" t ON t.id = c."tenantId" AND t.status = 'active'
      WHERE c."retellCallId" = lookup_value
    ) SELECT m."tenantId", m.id FROM matches m
      WHERE (SELECT count(*) FROM matches) = 1 LIMIT 1;
  ELSIF kind = 'campaign_provider_message' THEN
    RETURN QUERY WITH matches AS (
      SELECT c."tenantId", c.id
      FROM public."CampaignDelivery" c
      JOIN public."Tenant" t ON t.id = c."tenantId" AND t.status = 'active'
      WHERE c."providerMessageId" = lookup_value
    ) SELECT m."tenantId", m.id FROM matches m
      WHERE (SELECT count(*) FROM matches) = 1 LIMIT 1;
  ELSE
    RETURN;
  END IF;
END
$fn$;
REVOKE ALL ON FUNCTION app_resolve_ingress_tenant(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_resolve_ingress_tenant(text, text) TO app_rls;
