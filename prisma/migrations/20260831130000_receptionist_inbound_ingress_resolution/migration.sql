-- ===========================================================================
-- Answer the number a caller actually dialled.
--
-- `20260831100000_receptionist_inbound_number` added
-- `ReceptionistClinic.inboundNumber` — the provider-owned line THIS clinic
-- answers on, deliberately distinct from `phone`, which is the public number
-- the agent SPEAKS. Deploy binds `inboundNumber`, verification re-reads it, and
-- readiness passes `number_bound` on it. Every one of those was taught the new
-- column. The ingress resolver was not: its `retell_destination_phone` branch
-- still matched `c.phone` alone.
--
-- The introducing migration backfilled `inboundNumber` from `phone`, so the two
-- are identical on every existing row and nothing could show the gap. It opens
-- the moment an operator does the supported thing and points a clinic at a
-- provider DID that differs from the number on its letterhead. From then on:
--
--   * deploy binds the DID                       -> ok
--   * verification re-reads the DID              -> ok
--   * readiness reports `number_bound = pass`    -> ok
--   * every real call to that DID resolves to NO tenant
--
-- and the caller reaches an agent with no clinic name, no hours
-- (`is_open_now = "unknown"`), no fallback number, no returning-caller
-- recognition and no admission state — while all 21 checks sit green. That is
-- the failure mode this module was rebuilt to eliminate: a checklist that
-- reports on what we wrote rather than on what a caller gets.
--
-- Resolution now keys on the SAME expression the application uses
-- (`clinicInboundNumber` = inboundNumber ?? phone), so the provider boundary
-- and the ingress boundary cannot drift apart again.
--
-- The one-match rule is unchanged and still fail-closed: if a lookup value
-- matches two active clinics -- including one clinic's `phone` colliding with
-- another's `inboundNumber` -- the resolver returns nothing rather than
-- guessing which tenant a caller belongs to.
-- ===========================================================================

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
    RETURN QUERY SELECT p."tenantId",p.id FROM public."PatientIntakePacket" p JOIN public."Tenant" t ON t.id=p."tenantId" AND t.status='active' WHERE p."publicTokenHash"=lookup_value AND p."tokenExpiresAt">statement_timestamp() AND p.status NOT IN ('submitted','cancelled') LIMIT 1;
  ELSIF kind='payment_public_token' THEN
    RETURN QUERY SELECT p."tenantId",p.id FROM public."PaymentRequest" p JOIN public."Tenant" t ON t.id=p."tenantId" AND t.status='active' WHERE p."publicToken"::text=lookup_value AND (p."linkExpiresAt" IS NULL OR p."linkExpiresAt">statement_timestamp()) LIMIT 1;
  ELSIF kind='pilot_share_hash' THEN
    RETURN QUERY SELECT p."tenantId",p.id FROM public."PilotStatusShare" p JOIN public."Tenant" t ON t.id=p."tenantId" AND t.status='active' WHERE p."tokenHash"=lookup_value AND p."expiresAt">statement_timestamp() LIMIT 1;
  ELSIF kind='stripe_provider_reference' THEN
    RETURN QUERY WITH matches AS (SELECT p."tenantId",p.id FROM public."PaymentRequest" p JOIN public."Tenant" t ON t.id=p."tenantId" AND t.status='active' WHERE p."providerReference"=lookup_value) SELECT m."tenantId",m.id FROM matches m WHERE (SELECT count(*) FROM matches)=1 LIMIT 1;
  ELSIF kind='retell_call_id' THEN
    RETURN QUERY WITH matches AS (SELECT c."tenantId",c.id FROM public."ReceptionistCallLog" c JOIN public."Tenant" t ON t.id=c."tenantId" AND t.status='active' WHERE c."retellCallId"=lookup_value) SELECT m."tenantId",m.id FROM matches m WHERE (SELECT count(*) FROM matches)=1 LIMIT 1;
  ELSIF kind='retell_destination_phone' THEN
    -- COALESCE mirrors `clinicInboundNumber()` in the application: the assigned
    -- provider DID when there is one, the public number when there is not.
    RETURN QUERY WITH matches AS (
      SELECT c."tenantId",c.id
      FROM public."ReceptionistClinic" c
      JOIN public."Tenant" t ON t.id=c."tenantId" AND t.status='active'
      WHERE COALESCE(NULLIF(btrim(c."inboundNumber"), ''), c.phone)=lookup_value AND c.active
    ) SELECT m."tenantId",m.id FROM matches m WHERE (SELECT count(*) FROM matches)=1 LIMIT 1;
  ELSIF kind='retell_provider_intent' THEN
    IF lookup_value !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN; END IF;
    RETURN QUERY
      SELECT i."tenantId",i.id
      FROM public."ReceptionistOutboundProviderIntent" i
      JOIN public."ReceptionistCallLog" c
        ON c."tenantId"=i."tenantId" AND c."outboundCampaignId"=i."outboundCampaignId" AND c.id=i."callLogId"
      JOIN public."Tenant" t ON t.id=i."tenantId" AND t.status='active'
      WHERE i.id=lookup_value::uuid AND i."boundaryVersion"=1
        AND c.outcome='IN_PROGRESS' AND c."endedAt" IS NULL
      LIMIT 1;
  ELSIF kind='campaign_provider_message' THEN
    RETURN QUERY WITH matches AS (SELECT c."tenantId",c.id FROM public."CampaignDelivery" c JOIN public."Tenant" t ON t.id=c."tenantId" AND t.status='active' WHERE c."providerMessageId"=lookup_value) SELECT m."tenantId",m.id FROM matches m WHERE (SELECT count(*) FROM matches)=1 LIMIT 1;
  ELSE RETURN;
  END IF;
END
$ingress$;

REVOKE ALL ON FUNCTION app_resolve_ingress_tenant(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_resolve_ingress_tenant(text,text) TO app_rls;
