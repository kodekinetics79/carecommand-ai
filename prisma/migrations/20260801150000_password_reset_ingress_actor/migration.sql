-- Password reset needs the exact opaque token row for serialized single-use
-- consumption, while request-mode RLS requires an active User UUID as actor.
-- Resolve both identifiers only after verifying the application-HMACed token.
CREATE OR REPLACE FUNCTION app_resolve_password_reset_ingress(verified_hash text)
RETURNS TABLE(tenant_id uuid, token_id uuid, user_id uuid)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $fn$
BEGIN
  IF verified_hash IS NULL OR verified_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN;
  END IF;

  RETURN QUERY
    SELECT p."tenantId", p.id, p."userId"
    FROM public."PasswordResetToken" p
    JOIN public."User" u
      ON u.id = p."userId"
     AND u."tenantId" = p."tenantId"
     AND u.active
    JOIN public."Tenant" t
      ON t.id = p."tenantId"
     AND t.status = 'active'
    WHERE p."tokenHash" = verified_hash
      AND p."usedAt" IS NULL
      AND p."expiresAt" > statement_timestamp()
    LIMIT 1;
END
$fn$;

REVOKE ALL ON FUNCTION app_resolve_password_reset_ingress(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_resolve_password_reset_ingress(text) TO app_rls;
