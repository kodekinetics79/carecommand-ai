-- Company record for a client tenant, plus three narrow read windows the
-- platform console needs to answer "who is this customer".
--
-- Before this, Tenant held only id/name/slug/status/timestamps, so the operator
-- console could show a clinic's plan and billing but had nowhere to record who
-- the company actually is -- no address, no contact, no company number. Those
-- columns land directly on Tenant because 20260730133000_platform_database_plane
-- already grants app_platform SELECT (any active actor) and UPDATE
-- (PLATFORM_ADMIN / PLATFORM_BILLING / OWNER) on it, so no new policy is needed
-- and no new privilege is created. They are nullable: an existing tenant has no
-- company record yet, and an empty field must read as "not recorded" rather
-- than as a fabricated value.
--
-- The three functions exist because app_platform deliberately holds NO grants on
-- "User" or "Branch" -- the platform plane must never be able to query arbitrary
-- identities or PHI. Each mirrors app_platform_tenant_activity: SECURITY DEFINER,
-- pinned search_path, gated on app_platform_actor_allowed, EXECUTE granted only
-- to app_platform, and returning the narrowest useful projection:
--
--   * account_owner  -- the single OWNER login created at provisioning, so an
--     operator knows who to contact. Not the staff roster.
--   * role_breakdown -- aggregate counts per role. No identities.
--   * branches       -- branch name/location/timezone. Operational, not clinical.
--
-- Deliberately NOT added: any function returning the full user list. That would
-- hand every platform operator a clinic's entire staff directory, which is the
-- boundary this plane was built to hold. If that is ever wanted it belongs
-- behind the audited SupportAccessSession break-glass, not an open read.

ALTER TABLE "Tenant"
  ADD COLUMN "legalName"            TEXT,
  ADD COLUMN "companyNumber"        TEXT,
  ADD COLUMN "addressLine1"         TEXT,
  ADD COLUMN "addressLine2"         TEXT,
  ADD COLUMN "city"                 TEXT,
  ADD COLUMN "region"               TEXT,
  ADD COLUMN "postalCode"           TEXT,
  ADD COLUMN "country"              TEXT,
  ADD COLUMN "mainPhone"            TEXT,
  ADD COLUMN "website"              TEXT,
  ADD COLUMN "primaryContactName"   TEXT,
  ADD COLUMN "primaryContactEmail"  TEXT,
  ADD COLUMN "primaryContactPhone"  TEXT,
  ADD COLUMN "billingContactName"   TEXT,
  ADD COLUMN "billingContactEmail"  TEXT,
  ADD COLUMN "accountNotes"         TEXT;

-- Each function is dropped before being created: CREATE OR REPLACE cannot
-- change a function's return type ("cannot change return type of existing
-- function"), so a re-run after any signature change would fail without this.
DROP FUNCTION IF EXISTS app_platform_tenant_account_owner(uuid);
DROP FUNCTION IF EXISTS app_platform_tenant_role_breakdown(uuid);
DROP FUNCTION IF EXISTS app_platform_tenant_branches(uuid);

-- The account owner login for a tenant: exactly the identity an operator needs
-- to contact a customer, and nothing else. Returns at most one row.
CREATE OR REPLACE FUNCTION app_platform_tenant_account_owner(target_tenant uuid)
RETURNS TABLE(
  user_id uuid,
  display_name text,
  email text,
  role text,
  active boolean,
  mfa_enabled boolean,
  -- Prisma maps DateTime to `timestamp without time zone`, so these must be
  -- `timestamp` and not `timestamptz`: PostgreSQL rejects a RETURNS TABLE whose
  -- declared types differ from the projected columns ("structure of query does
  -- not match function result type"), it does not silently coerce them.
  last_login_at timestamp,
  created_at timestamp
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF NOT app_platform_actor_allowed(NULL) THEN RAISE EXCEPTION 'platform_actor_required' USING ERRCODE = '42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public."Tenant" t WHERE t.id = target_tenant) THEN RETURN; END IF;
  RETURN QUERY
    SELECT u.id, u."displayName", u.email, u.role::text, u.active, u."mfaEnabled", u."lastLoginAt", u."createdAt"
    FROM public."User" u
    WHERE u."tenantId" = target_tenant AND u.role = 'OWNER'
    ORDER BY u.active DESC, u."createdAt" ASC
    LIMIT 1;
END
$fn$;
REVOKE ALL ON FUNCTION app_platform_tenant_account_owner(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_platform_tenant_account_owner(uuid) TO app_platform;

-- Aggregate seat shape per role. Counts only: no identity leaves this function.
CREATE OR REPLACE FUNCTION app_platform_tenant_role_breakdown(target_tenant uuid)
RETURNS TABLE(role text, active_count bigint, inactive_count bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF NOT app_platform_actor_allowed(NULL) THEN RAISE EXCEPTION 'platform_actor_required' USING ERRCODE = '42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public."Tenant" t WHERE t.id = target_tenant) THEN RETURN; END IF;
  RETURN QUERY
    SELECT u.role::text,
           count(*) FILTER (WHERE u.active)::bigint,
           count(*) FILTER (WHERE NOT u.active)::bigint
    FROM public."User" u
    WHERE u."tenantId" = target_tenant
    GROUP BY u.role
    ORDER BY u.role::text;
END
$fn$;
REVOKE ALL ON FUNCTION app_platform_tenant_role_breakdown(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_platform_tenant_role_breakdown(uuid) TO app_platform;

-- Branch list: operational site records (name, location, timezone), which the
-- operator already sees a count of. No patient or staff data is reachable here.
CREATE OR REPLACE FUNCTION app_platform_tenant_branches(target_tenant uuid)
RETURNS TABLE(
  branch_id uuid,
  name text,
  location text,
  timezone text,
  active boolean,
  created_at timestamp
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF NOT app_platform_actor_allowed(NULL) THEN RAISE EXCEPTION 'platform_actor_required' USING ERRCODE = '42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public."Tenant" t WHERE t.id = target_tenant) THEN RETURN; END IF;
  RETURN QUERY
    SELECT b.id, b.name, b.location, b.timezone, b.active, b."createdAt"
    FROM public."Branch" b
    WHERE b."tenantId" = target_tenant
    ORDER BY b.active DESC, b.name ASC;
END
$fn$;
REVOKE ALL ON FUNCTION app_platform_tenant_branches(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_platform_tenant_branches(uuid) TO app_platform;
