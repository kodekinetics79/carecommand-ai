-- Let the Control Tower read the usage ledger.
--
-- The previous migration granted SELECT on "UsageEvent" to app_platform, but
-- the table is FORCE ROW LEVEL SECURITY and its only policies name app_rls.
-- Forced RLS applies to every role, so a grant with no matching policy returns
-- an empty result rather than an error - the platform console would have shown
-- every tenant zero usage and looked correct doing it.
--
-- Same shape as 20260730133000_platform_database_plane: read gated on a valid
-- platform actor, and no write policy at all. Usage is asserted by the runtime
-- that did the work, never by an operator.
DROP POLICY IF EXISTS platform_usage_event_select ON "UsageEvent";
CREATE POLICY platform_usage_event_select ON "UsageEvent"
  FOR SELECT TO app_platform USING (app_platform_actor_allowed(NULL));
