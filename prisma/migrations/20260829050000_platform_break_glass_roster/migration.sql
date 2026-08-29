-- Break-glass staff roster for the platform console.
--
-- 20260829040000_tenant_company_record deliberately stopped short of a roster:
-- app_platform holds no grants on "User", and an always-on read would hand every
-- platform operator a clinic's entire staff directory. But support work
-- genuinely needs it sometimes ("which of your admins locked the account?"), so
-- the answer is not "never" -- it is "not without a reason on the record".
--
-- This function returns the roster ONLY while an unexpired, unended
-- SupportAccessSession exists for that tenant. Sessions are opened through
-- POST /v1/platform/tenants/:id/support-session, which already demands a written
-- reason and writes a support.session.started platform audit event, and they
-- expire on their own (5 minutes to 8 hours). So the roster is reachable, but
-- only ever with an operator, a reason and an expiry attached to it.
--
-- Still excluded even under break-glass: password hashes, MFA secrets, refresh
-- tokens and reset tokens. Support needs to know who exists and whether they can
-- sign in -- never anything that would let an operator sign in as them.

DROP FUNCTION IF EXISTS app_platform_tenant_user_roster(uuid);

CREATE OR REPLACE FUNCTION app_platform_tenant_user_roster(target_tenant uuid)
RETURNS TABLE(
  user_id uuid,
  display_name text,
  email text,
  role text,
  branch_name text,
  active boolean,
  mfa_enabled boolean,
  locked_until timestamp,
  last_login_at timestamp,
  created_at timestamp
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF NOT app_platform_actor_allowed(NULL) THEN
    RAISE EXCEPTION 'platform_actor_required' USING ERRCODE = '42501';
  END IF;
  -- The break-glass condition. Without a live session this raises rather than
  -- returning an empty set, so a caller can never mistake "not permitted" for
  -- "this clinic has no staff".
  IF NOT EXISTS (
    SELECT 1 FROM public."SupportAccessSession" s
    WHERE s."tenantId" = target_tenant
      AND s."endedAt" IS NULL
      AND s."expiresAt" > now()
  ) THEN
    RAISE EXCEPTION 'support_session_required' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT u.id, u."displayName", u.email, u.role::text, b.name,
           u.active, u."mfaEnabled", u."lockedUntil", u."lastLoginAt", u."createdAt"
    FROM public."User" u
    LEFT JOIN public."Branch" b ON b."tenantId" = u."tenantId" AND b.id = u."branchId"
    WHERE u."tenantId" = target_tenant
    ORDER BY u.active DESC, u.role::text, u."displayName";
END
$fn$;
REVOKE ALL ON FUNCTION app_platform_tenant_user_roster(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_platform_tenant_user_roster(uuid) TO app_platform;
