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

## Cutover checklist

1. Set runtime `DATABASE_URL` to `app_rls`.
2. Keep `DATABASE_MIGRATION_URL` on the owner role.
3. Run `npm run rls:verify`.
4. Boot the API and worker and confirm they start cleanly.

## Non-production behavior

- Development can warn only when the role is unsafe and enforcement is disabled.
- Set `RLS_ENFORCE_RUNTIME_ROLE=true` in non-production to opt into fail-closed behavior before cutover.
