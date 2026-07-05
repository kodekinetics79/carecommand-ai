# Row-Level Security — runtime enforcement runbook

Tenant isolation is release-blocking. This document is the operational
contract: which roles exist, what refuses to boot, how to verify, and how to
cut production over.

## The two-role model

| Role | Used by | RLS | Where configured |
|---|---|---|---|
| **owner** (e.g. `carecommand`, Neon owner) | migrations + seed ONLY | bypasses (by design — DDL must see all rows) | `DATABASE_MIGRATION_URL` |
| **`app_rls`** (`LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`) | API + worker runtime | subject to every policy | `DATABASE_URL` |

The role is created idempotently by migration `20260612170000_enable_rls_pilot`.
Its password is never committed; set/rotate it per environment:

```bash
psql "$DATABASE_MIGRATION_URL" -v app_rls_password="$APP_RLS_PASSWORD" -f prisma/rls/app_rls_setup.sql
```

Prisma migrations run as the owner via [prisma.config.ts](../prisma.config.ts)
(`DATABASE_MIGRATION_URL`, falling back to `DATABASE_URL` for single-role dev).

## Boot-time enforcement (fail-closed)

`assertRlsRuntimeRole` ([server/lib/rlsGuard.ts](../server/lib/rlsGuard.ts))
runs at boot in **both** entrypoints — API ([server/index.ts](../server/index.ts))
and worker ([server/workers/index.ts](../server/workers/index.ts)):

- **Production (`NODE_ENV=production`) always fails closed.** If the runtime
  role is a superuser or has `BYPASSRLS`, the process refuses to boot. If the
  role cannot be verified (DB unreachable at boot), the guard retries
  (4 × 2.5 s) and then refuses to boot — "cannot verify isolation" is not a
  bootable production state. **No env flag can disable this.**
- **Dev/test are advisory:** unsafe or unverifiable roles log a warning and
  boot proceeds, so single-role local setups stay usable.
- `RLS_ENFORCE_RUNTIME_ROLE=true` opts a non-production environment into the
  production behavior (recommended for staging, and for local dev once
  `DATABASE_URL` points at `app_rls`).

The flag is parsed by `booleanString` ([server/lib/booleanString.ts](../server/lib/booleanString.ts)) —
`"false"` means false. (`z.coerce.boolean()` treated the string `"false"` as
true; never reintroduce it for flags.)

## Tenant context — how policies see the tenant

Policies key on a **transaction-local GUC**, never on anything a client sends:

```sql
USING ("tenantId" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
```

[server/lib/tenantContext.ts](../server/lib/tenantContext.ts) is the only
writer of that GUC: `runWithTenantContext` / `runWithJobTenantContext` /
`runWithWebhookTenantContext` open a Prisma interactive transaction, run
`set_config('app.current_tenant_id', <tenantId>, is_local=true)` on the pinned
connection, and hand the caller that `tx`. `is_local=true` means the GUC dies
at COMMIT/ROLLBACK — it can never leak across pooled connections.

**Spoofing model.** The tenant id enters only from:
- HTTP: `request.auth.tenantId`, taken from a **signed JWT** and re-verified
  against the user row (`where: { id, tenantId, active }`) in
  [server/plugins/auth.ts](../server/plugins/auth.ts). No header or body input
  selects a tenant. The dev-token route (`/v1/auth/dev-token`) returns 404 in
  production.
- Workers: the job payload written by our own enqueue code.
- Webhooks: the tenant resolved server-side from the signed/validated resource
  (never from caller-supplied tenant fields).

Unset/invalid tenant fails closed twice: `tenantContext` throws before any DB
work, and an unset GUC makes every policy evaluate to `NULL` → **zero rows**.

## RLS-enrolled tables (ENABLE + FORCE + tenant_isolation policy)

Pilot (`20260612170000`): `NotificationTemplate`, `AiGuardrail`, `CustomerPreference`.
Wave B3 (`20260612180000`): `DepositRule`, `RevenueProtectionAlert`, `RevenueLeak`.

All other tenant-scoped tables rely on the app-level `where: { tenantId }`
filter until enrolled in a later wave. **When enrolling a table:** add the
ENABLE/FORCE/policy migration, add the table to `RLS_ENROLLED_TABLES` in
[server/scripts/verifyRlsStatus.ts](../server/scripts/verifyRlsStatus.ts), and
route its queries through `runWithTenantContext` — a FORCEd table queried on
the global `db` client sees zero rows under `app_rls`.

## Verification

```bash
npm run rls:verify        # read-only posture check against the runtime DATABASE_URL
```

Checks the runtime role (no superuser/BYPASSRLS), every enrolled table
(enabled + forced + policy present), and prints the coverage gap. Exit 1 on any
hard failure — safe for CI or a cron.

Deep behavioral proof (cross-tenant reads/writes actually blocked):

```bash
npx vitest run server/test/rls.test.ts          # DB-level isolation, drops to app_rls via SET LOCAL ROLE
npx vitest run server/test/rlsEnforcement.test.ts  # boot-time fail-closed contract (no DB needed)
npx tsx server/lib/rlsPilot.verify.ts           # leakage attempts on pilot tables (needs app_rls DATABASE_URL)
npx tsx server/lib/rlsWaveB3.verify.ts          # same for wave B3
```

Manual SQL spot-checks (as owner):

```sql
SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname IN ('app_rls', current_user);
SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
 WHERE relname IN ('NotificationTemplate','AiGuardrail','CustomerPreference','DepositRule','RevenueProtectionAlert','RevenueLeak');
SELECT tablename, policyname FROM pg_policies WHERE policyname = 'tenant_isolation';
```

<a id="production-cutover"></a>## Production cutover checklist

1. Migrations applied as owner (`DATABASE_MIGRATION_URL`) — creates `app_rls`,
   grants, policies.
2. Set the `app_rls` password: `prisma/rls/app_rls_setup.sql` (above).
3. Point the production `DATABASE_URL` at `app_rls` (Render dashboard; both API
   and worker consume the shared env group).
4. Deploy. The boot guard now proves the posture on every boot; a wrong URL
   fails the deploy loudly instead of degrading isolation silently.
5. `npm run rls:verify` against production (`DATABASE_URL=<prod app_rls url>`).

## Remaining risks (explicit)

- **Coverage is partial by design**: 6 tables are DB-enforced; the rest are
  app-level filtered (`where: { tenantId }`) until later waves. A missing
  filter on an unenrolled table is not caught by the database.
- The GUC applies only to queries run through the tenant-context `tx`. Code
  querying enrolled tables via the global `db` fails CLOSED (zero rows), which
  is safe but a functional bug — `rls:verify`'s coverage report plus code
  review are the current controls.
- `pgbouncer`/pooling: `set_config(..., is_local=true)` inside an interactive
  transaction is pool-safe (transaction pooling included). Do not replace it
  with session-level `SET`.
- The owner role still bypasses RLS by design (migrations/seed). Protect
  `DATABASE_MIGRATION_URL` accordingly; it must never be the runtime URL in
  production — the boot guard enforces exactly this.
