# Worker RLS bootstrap proposal

Campaign, compliance, and monitoring schedulers need one cross-tenant bootstrap
capability after `Tenant` RLS is enforced. The runtime role must not receive a
general `SELECT` exemption on `Tenant`. Apply the following through the reviewed
owner migration path:

```sql
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
```

The function returns UUIDs only. It exposes no tenant names, configuration,
credentials, lifecycle detail, or PHI. Each returned ID is subsequently
revalidated by `runWithJobTenantContext` on the worker's pinned transaction.
