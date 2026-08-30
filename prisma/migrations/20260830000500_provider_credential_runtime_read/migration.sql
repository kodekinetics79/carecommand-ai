-- Let the running application read the credential vault it is supposed to use.
--
-- The Control Tower encrypts provider credentials into "PlatformIntegration"
-- and reports "connected - via db - test ok". No sender ever read that table:
-- every provider call resolved process.env directly. So an operator rotating a
-- leaked Twilio token saw a green badge and a passing connection test while
-- every message kept going out on the old key. A green light wired to nothing
-- is worse than no light.
--
-- "PlatformIntegration" is deliberately NOT granted to the tenant runtime role,
-- and that stays true: this exposes exactly one narrow, read-only accessor for
-- the platform's OWN outbound provider configuration, and nothing else. It
-- returns no tenant data and touches no tenant table, so nothing about tenant
-- isolation changes. The application process already holds these same secrets
-- in its environment; this only lets the operator's stored value win over a
-- stale one.
--
-- The blob stays encrypted at rest and is decrypted in the application with
-- AUTH_ENCRYPTION_KEY, which the database never sees.
CREATE OR REPLACE FUNCTION public.app_provider_credentials()
RETURNS TABLE (
  "key"       text,
  "configEnc" text,
  "status"    text,
  "setFields" text[]
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT i."key", i."configEnc", i."status", i."setFields"
  FROM public."PlatformIntegration" i
  WHERE i."configEnc" IS NOT NULL;
$fn$;

REVOKE ALL ON FUNCTION public.app_provider_credentials() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_provider_credentials() TO app_rls;
GRANT EXECUTE ON FUNCTION public.app_provider_credentials() TO app_platform;
