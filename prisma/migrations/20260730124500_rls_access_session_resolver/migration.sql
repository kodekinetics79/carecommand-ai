-- Verify a signed access-token identity before a TenantContext exists. Only
-- session/RBAC fields are exposed; no tenant data or credentials are returned.
CREATE OR REPLACE FUNCTION app_resolve_access_session(lookup_user uuid, lookup_tenant uuid)
RETURNS TABLE(
  user_id uuid,
  tenant_id uuid,
  user_role text,
  branch_id uuid,
  tenant_status text,
  sessions_revoked_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT u.id, u."tenantId", u.role::text, u."branchId", t.status, p."sessionsRevokedAt"
  FROM public."User" u
  JOIN public."Tenant" t ON t.id = u."tenantId"
  LEFT JOIN public."TenantSecurityPolicy" p ON p."tenantId" = t.id
  WHERE u.id = lookup_user AND u."tenantId" = lookup_tenant AND u.active
  LIMIT 1
$fn$;
REVOKE ALL ON FUNCTION app_resolve_access_session(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_resolve_access_session(uuid, uuid) TO app_rls;
