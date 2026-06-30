-- Permission/action RBAC: optional per-tenant override of a role's permission set.
-- NULL = use the code default matrix (server/lib/permissions.ts). Additive and
-- backward compatible: existing rows default to NULL, so behaviour is unchanged
-- until a tenant explicitly sets an override.
--
-- Rollback: ALTER TABLE "RoleDefinition" DROP COLUMN "permissions";
-- (No data backfilled; dropping the column restores pre-migration behaviour.)
ALTER TABLE "RoleDefinition" ADD COLUMN "permissions" JSONB;
