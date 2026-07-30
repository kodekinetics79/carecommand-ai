# PostgreSQL RLS Policy Design

## Security boundary

The runtime connects as `app_rls`, a `NOSUPERUSER NOBYPASSRLS` role that does not own the public schema or protected tables. Schema changes, migrations, seed administration, backup, and restore use the separate owner connection in `DATABASE_MIGRATION_URL`.

There are 127 application tables plus the `_prisma_migrations` metadata table in the migrated public catalog. PostgreSQL RLS is enabled and forced on 119 tenant/PHI tables: 118 tenant-keyed tables plus the `Tenant` root. Eight application tables are explicit RLS exemptions; Prisma migration metadata is tracked separately and is inaccessible to the runtime role.

## Policy shape

- Tenant tables: explicit `SELECT`, `INSERT`, `UPDATE`, and `DELETE` policies for `app_rls`.
- `INSERT` uses `WITH CHECK`; `UPDATE` uses both `USING` and `WITH CHECK`, preventing tenant reassignment.
- `AuditEvent`: `SELECT` and `INSERT` only; runtime `UPDATE` and `DELETE` privileges are revoked.
- `Tenant`: `SELECT` only; lifecycle mutation is not granted to the runtime role.
- Every predicate calls `app_rls_tenant_allowed`, which validates transaction-local context and active tenant state.
- Tenant-consistent composite foreign keys prevent cross-tenant parent attachment where both records are tenant keyed.
- No public views or materialized views currently depend on protected tables. The catalog guard rejects a future protected-table view unless a normal view is explicitly `security_invoker`; materialized views fail the guard.

## Explicit exemptions

| Object | Runtime privilege | Rationale |
|---|---|---|
| `SubscriptionPlan`, `SubscriptionPlanFeature`, `SubscriptionAddon` | SELECT | Shared commercial catalogue, deliberately identical across tenants |
| `PlatformAnnouncement` | SELECT | Deliberately shared announcement reference data |
| `PlatformConfig`, `PlatformIntegration`, `PlatformUser` | none required; **current CRUD is a P0 failure** | Platform control-plane objects must use a separate least-privilege platform path, never the tenant runtime role |
| `PlatformAuditEvent` | none required; **current SELECT/INSERT is a P0 failure** | Global platform ledger must use a dedicated append-only platform path; optional `tenantId` is a target, not row ownership |
| `_prisma_migrations` | none | Migration metadata is owner-only |

These exemptions are enforced as an exact allowlist by `server/scripts/verifyRlsCatalog.ts`; any new non-tenant table is unclassified and fails CI. An RLS exemption does not imply runtime access: the catalog guard requires no `app_rls` privileges on platform control-plane tables.

## Automated guard

`npm run rls:verify` must execute through the restricted `app_rls` connection. It fails on:

- an unsafe or incorrectly named runtime role;
- superuser, `BYPASSRLS`, `CREATEROLE`, `CREATEDB`, replication, public-schema CREATE, schema ownership, or protected-table ownership;
- an unclassified table or missing coverage-matrix row;
- missing ENABLE/FORCE RLS;
- missing command policy, `USING`, or `WITH CHECK`;
- unexpected runtime table privileges;
- a protected-table view that can bypass invoker RLS.

`npm run rls:docs` runs the same checks and regenerates the catalog-backed matrix. CI deploys migrations with the owner role, assigns a CI-only password to `app_rls`, then runs the guard with `DATABASE_URL` set to that restricted role.

## Evidence boundary

The catalog guard proves structural policy coverage and runtime-role posture. `rlsCatalog.integration.test.ts` additionally proves every tenant table is invisible without context, while `rls.test.ts` proves representative same/cross-tenant CRUD on `AiGuardrail` and `rlsPoolIsolation.integration.test.ts` proves pool cleanup and concurrency isolation. This is not equivalent to full per-table CRUD evidence; 118 protected tables remain pending that stronger acceptance criterion.
