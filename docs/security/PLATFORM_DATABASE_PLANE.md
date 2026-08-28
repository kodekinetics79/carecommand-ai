# Platform database plane

The platform console uses a database principal separate from both the schema owner and the tenant runtime. `app_platform` is a login role with `NOINHERIT`, `NOSUPERUSER`, `NOBYPASSRLS`, `NOCREATEDB`, and `NOCREATEROLE`; it owns no application objects.

## Runtime contract

- `DATABASE_URL` authenticates the tenant runtime as `app_rls`.
- `PLATFORM_DATABASE_URL` authenticates the control plane as `app_platform` and is required in production. It must use a different username from `DATABASE_URL`.
- `DATABASE_MIGRATION_URL` remains the schema-owner connection and must never be supplied to an application runtime.
- Platform startup verifies the connected role's attributes and ownership before registering the platform routes.

`requirePlatformAccess` validates an active `PlatformUser`, enforces application RBAC, and binds that identity to the complete Fastify request lifecycle. `platformDb` pins every tenant-control query to a transaction and writes the actor ID and role as transaction-local PostgreSQL settings. RLS then revalidates that persisted identity. Missing, disabled, malformed, or role-mismatched identities see no control rows and cannot mutate them.

## Privilege boundary

`app_rls` has no privileges on `PlatformUser`, `PlatformConfig`, `PlatformIntegration`, or `PlatformAuditEvent`. This prevents a compromised tenant runtime from reading platform identities, encrypted provider configuration, or the global security ledger.

`app_platform` can directly access only:

- platform identity/configuration, encrypted integrations, announcements, and append-only platform audit;
- subscription catalog and explicitly classified tenant commercial/governance tables;
- the tenant root metadata needed by the control tower.

It has no privilege or RLS policy on patient, appointment, conversation, call-log, clinical, or payment-detail tables. Counts of `User` and `Branch` are returned only by `app_platform_tenant_activity`; no identity rows are exposed. Cross-tenant totals come from `app_platform_overview`, which raises `42501` rather than returning false zeroes when the actor context is missing. Initial tenant provisioning is an execute-only function with bounded inputs and bounded output; it does not grant arbitrary identity access.

Platform audit is append-only at the database privilege layer. Tenant lifecycle and commercial tables remain protected by explicit `app_platform` policies in addition to the existing `app_rls` policies.

## Deployment

1. Apply migrations with `DATABASE_MIGRATION_URL`. The migration creates `app_platform` without a password if it does not exist.
2. Provision/rotate the `app_platform` password through the infrastructure secret manager. Never put it in a migration or repository file.
3. Set `PLATFORM_DATABASE_URL` in the API environment and deploy the application.
4. Run `server/test/platformDatabasePlane.integration.test.ts` against a disposable migrated database.
5. Verify platform login, overview counts, announcement creation, suspended-tenant visibility, and the negative PHI permission probe.

Any role posture failure is a release blocker. Do not solve it with table ownership, `BYPASSRLS`, a superuser connection, or membership in the migration-owner role.

