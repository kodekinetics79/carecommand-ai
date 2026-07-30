# RLS Runbook

CareCommand AI treats the runtime database role as a boot-time safety check.

## Runtime role

- Production `DATABASE_URL` must point at the restricted `app_rls` role.
- `DATABASE_MIGRATION_URL` stays on the owner/migration role.
- Production always fails closed if the runtime role is superuser or has `BYPASSRLS`.
- Production also fails closed if the role cannot be verified at boot.

## Verification

- `npm run rls:verify` performs a read-only posture check against the connected runtime database.
- It exits non-zero if the role is unsafe or cannot be verified.
- `server/test/tenantContext.integration.test.ts` proves request, worker, and
  webhook source attribution, same-connection GUC binding, fail-closed tenant-id
  validation, concurrent-context isolation, and cleanup after commit/rollback.

## Rollout state

- Tenant context is explicit and transaction-scoped; callers must execute every
  protected query through the callback's `tx` client. Async-local context alone
  does not alter queries made through the global Prisma client.
- Authenticated Patient and Appointment CRUD paths, their audit writes,
  scheduling conflict checks, deposit/payment summaries, and the autopilot
  execution worker have adopted the context primitive locally.
- The PHI-wave tables remain deliberately disabled by
  `20260721160000_defer_phi_rls_pending_runtime_context`. Other request,
  webhook, portal, and worker paths still require adoption and cross-tenant CRUD
  evidence before a new migration may re-enable those policies.
- Do not enable or FORCE RLS table-by-table merely because one module is ready.
  Inventory every read/write path for the table first, including public
  webhooks, background jobs, relationship includes, and maintenance scripts.

## Cutover checklist

1. Set runtime `DATABASE_URL` to `app_rls`.
2. Keep `DATABASE_MIGRATION_URL` on the owner role.
3. Run `npm run rls:verify`.
4. Confirm every access path for each proposed table uses a tenant transaction,
   and run positive plus cross-tenant CRUD tests under `app_rls`.
5. Apply only the reviewed, reversible table-enrollment migration.
6. Boot the API and worker and confirm they start cleanly.

## Non-production behavior

- Development can warn only when the role is unsafe and enforcement is disabled.
- Set `RLS_ENFORCE_RUNTIME_ROLE=true` in non-production to opt into fail-closed behavior before cutover.
