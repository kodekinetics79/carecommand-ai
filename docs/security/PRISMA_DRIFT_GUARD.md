# Prisma drift guard for tenant-integrity objects

The complete RLS migration adds a second, tenant-consistent foreign key beside each legacy ID relation. The deployed catalog currently contains 120 validated `rls_fk_*` composite foreign keys, 120 matching `rls_ix_*` child indexes, and 29 shared `rls_uq_*` parent unique indexes (149 managed indexes total).

These objects are intentionally SQL-owned. Prisma cannot represent both the existing ID relation and the additional `("tenantId", id)` enforcement relation without rewriting relation metadata and proposing destructive drops. The Prisma schema remains authoritative for models and ordinary indexes; the tenant-integrity manifest remains authoritative for this additional database enforcement layer.

## Guard

`server/modules/platform/prismaDriftGuard.ts` defines the versioned manifest and checks:

- exact managed-object counts;
- validation state for all 120 foreign keys;
- `tenantId` as the leading child and parent key;
- a matching child index for every foreign key;
- a matching unique parent index for every foreign key.

`server/test/platformDatabasePlane.integration.test.ts` executes that catalog inspection and scans every migration after `20260730120000_complete_rls_isolation` for attempts to drop an `rls_fk_*`, `rls_ix_*`, or `rls_uq_*` object.

## Migration workflow

Never run an unreviewed `prisma migrate dev` result against shared or production data. Use a disposable database:

1. Create an empty database.
2. Run `prisma migrate deploy` with the disposable owner URL.
3. Generate or inspect the candidate Prisma diff.
4. Reject any `DROP CONSTRAINT`/`DROP INDEX` targeting a manifest prefix.
5. Run the platform database-plane integration test.
6. If a legitimate schema change adds tenant relations, update the SQL migration and manifest counts together and document the review evidence.

The manifest count is 149 rather than an earlier 144-index estimate because the current schema requires 29 distinct parent unique indexes, not 24. The guard records the deployed structural truth and preserves all of those indexes.

