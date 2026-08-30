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

## Preflight added 2026-08-29 (evening) — read before step 2

**Both database roles must EXIST before migrations are applied.** Five migrations added
since this runbook was written issue `GRANT ... TO app_rls` / `TO app_platform`, and a
GRANT to a missing role aborts the whole `migrate deploy` part-way through:

| Migration | What it grants |
|---|---|
| `20260829234500_usage_event_period_metering` | `SELECT, INSERT` on `UsageEvent` to `app_rls`; `SELECT` to `app_platform` |
| `20260829234600_usage_event_platform_read` | platform read policy on `UsageEvent` |
| `20260830000500_provider_credential_runtime_read` | `EXECUTE` on `app_provider_credentials()` to both roles |
| `20260830003500` + `20260830003600_platform_price_book_grant*` | column-scoped `UPDATE ("monthlyPrice","updatedAt")` on `SubscriptionPlan` to `app_platform` |

So run this as the owner FIRST, and do not proceed until both rows come back:

```sql
SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname IN ('app_rls','app_platform');
```

`app_rls` must be `rolsuper = f` and `rolbypassrls = f` — that is precisely what the boot
guard checks, and the reason production is currently refusing to start. If `app_platform`
is absent, create it the same way; the platform console cannot serve without it.

Two more things that changed since this was written:

- **`UsageEvent` is append-only by trigger for every role, owner included.** After cutover,
  a `DELETE`/`UPDATE` against it raises `P0001`, and a cascading tenant delete will fail for
  any tenant that has usage. That is intended: it is the billing ledger.
- The RLS catalog is now **132 protected tables**, not 131. `npm run rls:verify` against
  prod is the acceptance test for this cutover; `npm run rls:docs` regenerates the coverage
  matrix if it disagrees.

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

   Added since, by the platform control-plane program (all additive; see the preflight
   above for the ones that GRANT): tenant company record, platform break-glass roster,
   rpm evidence v4/v5, reading alert severity rank, platform config provisioning defaults,
   entitlement override durability, usage event period metering (+ its platform read),
   provider credential runtime read, platform operator account controls, platform session
   epoch, and the two price-book grants.
3. Point Vercel Production `DATABASE_URL` at the `app_rls` connection string
   (keep `DATABASE_MIGRATION_URL` as the owner). Redeploy or `vercel redeploy`.
4. Verify: `POST /v1/auth/login` returns 400/401 JSON (not 500); `GET /v1/health` 200;
   then an authenticated smoke of `/v1/growth/policy` and `/v1/crm/campaigns`.
   Then the real acceptance test, as the runtime role:
   `DATABASE_URL=<app_rls-url> npm run rls:verify` — it must print
   `RLS catalog guard passed.` **Capture that output.** Until it has run against
   production, every isolation claim in the security documentation is proven in CI only.
   Also smoke the control plane now that it depends on both roles:
   `GET /v1/platform/auth/me` (401 without a token is the correct answer) and, signed in,
   the Integrations page — a provider showing `via db` proves the credential vault is
   readable through `app_provider_credentials()`.
5. The Render blueprint (`render.yaml`) runs `npm run db:deploy` in its build and its
   DATABASE_URL needs the same role treatment if that service is live.

## Notes for whoever runs this

- All prod DB secrets are marked Sensitive in Vercel and cannot be pulled via CLI;
  the cutover needs the Neon owner URL from the dashboard or wherever it is held.
- `CampaignLiveDispatchActivation` ships empty and must stay empty: live campaign
  dispatch is off by design until a tenant owner activates it in-app.
- After cutover, old pre-hardening builds still boot fine against the new role/schema,
  so rollbacks remain safe in both directions.
