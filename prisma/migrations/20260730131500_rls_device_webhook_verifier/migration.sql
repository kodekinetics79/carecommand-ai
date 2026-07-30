-- Bootstrap only the verifier material needed to authenticate a connected-care
-- webhook. The URL selector locates a candidate; it does not grant tenant
-- authority. Application code must verify the exact raw-body HMAC before
-- entering a tenant context or touching tenant data.
CREATE OR REPLACE FUNCTION app_resolve_device_webhook_verifier(
  tenant_selector uuid,
  provider_key text
)
RETURNS TABLE(tenant_id uuid, resource_id uuid, encrypted_config text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT p."tenantId", p.id, p."encryptedConfig"
  FROM public."DeviceProvider" p
  JOIN public."Tenant" t ON t.id = p."tenantId" AND t.status = 'active'
  WHERE p."tenantId" = tenant_selector
    AND p."providerKey" = provider_key
    AND p.active
    AND p."webhookConfigured"
    AND p.status IN ('SANDBOX', 'ACTIVE')
    AND p."encryptedConfig" IS NOT NULL
  LIMIT 1
$fn$;

REVOKE ALL ON FUNCTION app_resolve_device_webhook_verifier(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_resolve_device_webhook_verifier(uuid, text) TO app_rls;
