# Production RLS cutover — state and remaining steps

**Status as of 2026-08-29 ~07:50 ET: production API is DOWN, by design, awaiting cutover.**
Written by the Growth-program session as a handoff; the cutover itself belongs to the
session that was already working it (it had `scripts/set-runtime-role-passwords.ts` and
`scripts/fix-prod-migration.ts` in flight, since removed from the tree).

## What is happening

Every prod API route (including login) returns FUNCTION_INVOCATION_FAILED. The Vercel
function log shows the exact cause:

> Error: RLS runtime-role guard: database role "neondb_owner" BYPASSES row-level
> security (rolbypassrls). ... Use a restricted role (app_rls, NOSUPERUSER NOBYPASSRLS)
> for the runtime DATABASE_URL.

This is `server/lib/rlsGuard.ts` doing its job. The hardening release (PR #10) made the
guard fatal in production; PR #10/#11 reached prod for the first time with the deploys of
2026-08-29 (~06:50 and ~07:40 ET). Prod's runtime `DATABASE_URL` has always been the Neon
owner role, so the guard now refuses to boot rather than run with RLS silently bypassed.

Rolling back was proposed and NOT executed (blocked pending human approval). Last known
good deployment (pre-hardening code): `carecommand-inx7oopas-kode-kinetics-projects.vercel.app`.

## Remaining steps (in order)

1. On prod Neon, as the owner role: create the runtime role if absent —
   `CREATE ROLE app_rls LOGIN PASSWORD '<strong>' NOSUPERUSER NOBYPASSRLS;`
   plus the grants the disposable-DB harness applies (see
   `server/scripts/withDisposableRlsDatabase.ts` for the canonical grant set, and the
   RLS migrations' `GRANT ... TO app_rls` statements which cover new tables).
2. Apply pending migrations as the owner, through the sanctioned script (never raw
   `prisma migrate deploy` without it):
   `RELEASE_MIGRATION_ACK=APPLY_REVIEWED_CARECOMMAND_MIGRATIONS \
    DATABASE_MIGRATION_URL=<owner-url> DATABASE_MIGRATION_PRINCIPAL=<owner-role> \
    npm run release:migrate`
   Pending as of this writing: growth config spine, campaign dispatch fence,
   campaign branch scope, campaign attribution (includes triggers + a one-time reset of
   hand-set rollup values), growth_policy_no_show_risk, plus anything the connected-care
   and monitoring lanes added.
3. Point Vercel Production `DATABASE_URL` at the `app_rls` connection string
   (keep `DATABASE_MIGRATION_URL` as the owner). Redeploy or `vercel redeploy`.
4. Verify: `POST /v1/auth/login` returns 400/401 JSON (not 500); `GET /v1/health` 200;
   then an authenticated smoke of `/v1/growth/policy` and `/v1/crm/campaigns`.
5. The Render blueprint (`render.yaml`) runs `npm run db:deploy` in its build and its
   DATABASE_URL needs the same role treatment if that service is live.

## Notes for whoever runs this

- All prod DB secrets are marked Sensitive in Vercel and cannot be pulled via CLI;
  the cutover needs the Neon owner URL from the dashboard or wherever it is held.
- `CampaignLiveDispatchActivation` ships empty and must stay empty: live campaign
  dispatch is off by design until a tenant owner activates it in-app.
- After cutover, old pre-hardening builds still boot fine against the new role/schema,
  so rollbacks remain safe in both directions.
