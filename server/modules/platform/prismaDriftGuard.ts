import type { PrismaClient } from '../../generated/prisma/client';
import { TENANT_INTEGRITY_OBJECTS } from './tenantIntegrityObjects';

/**
 * Raw tenant-integrity objects intentionally owned by SQL migrations. Prisma
 * cannot safely express both the legacy id relation and the additional
 * tenant-consistency FK on the same relation without a destructive rewrite.
 */
export const TENANT_INTEGRITY_MANIFEST = Object.freeze({
  // 20260830130000_front_desk_loop dropped the dead ReceptionistAppointmentRequest
  // table, and DROP TABLE takes the two composite FKs the generator had built for
  // its clinicId and campaignId relations (rls_fk_4f9522140340599c0abf,
  // rls_fk_8ac2cbf8d46bb044d220) and their two supporting child indexes
  // (rls_ix_99b8d38f420976c6a62c, rls_ix_2db737562fe7cfbf7c87) with it. That is
  // the whole difference from the previous 123/123/154/135 pins; the parent
  // unique indexes are shared with live tables and are unchanged.
  compositeForeignKeys: 121,
  childSupportingIndexes: 121,
  parentUniqueIndexes: 31,
  totalManagedIndexes: 152,
  // Nineteen managed indexes are structurally represented by ordinary Prisma
  // indexes. Prisma therefore preserves them even though their physical names
  // use the migration-owned prefixes; only the remainder appears in diff SQL.
  prismaDiffManagedIndexes: 133,
  foreignKeyPrefix: 'rls_fk_',
  childIndexPrefix: 'rls_ix_',
  parentIndexPrefix: 'rls_uq_',
});

interface IntegrityCatalogRow {
  foreign_keys: bigint;
  invalid_foreign_keys: bigint;
  malformed_foreign_keys: bigint;
  missing_child_indexes: bigint;
  missing_parent_indexes: bigint;
  child_indexes: bigint;
  parent_indexes: bigint;
}

export async function inspectTenantIntegrityManifest(client: PrismaClient): Promise<string[]> {
  const rows = await client.$queryRaw<IntegrityCatalogRow[]>`
    WITH managed_fks AS (
      SELECT fk.*
      FROM pg_constraint fk
      JOIN pg_class child ON child.oid = fk.conrelid
      JOIN pg_namespace n ON n.oid = child.relnamespace
      WHERE n.nspname = 'public' AND fk.contype = 'f' AND fk.conname LIKE 'rls_fk_%'
    )
    SELECT
      (SELECT count(*) FROM managed_fks) AS foreign_keys,
      (SELECT count(*) FROM managed_fks WHERE NOT convalidated) AS invalid_foreign_keys,
      (SELECT count(*) FROM managed_fks fk
        WHERE (SELECT a.attname FROM pg_attribute a WHERE a.attrelid=fk.conrelid AND a.attnum=fk.conkey[1]) <> 'tenantId'
           OR (SELECT a.attname FROM pg_attribute a WHERE a.attrelid=fk.confrelid AND a.attnum=fk.confkey[1]) <> 'tenantId') AS malformed_foreign_keys,
      (SELECT count(*) FROM managed_fks fk WHERE NOT EXISTS (
        SELECT 1 FROM pg_index i WHERE i.indrelid=fk.conrelid AND i.indkey::text=array_to_string(fk.conkey, ' ')
      )) AS missing_child_indexes,
      (SELECT count(*) FROM managed_fks fk WHERE NOT EXISTS (
        SELECT 1 FROM pg_index i WHERE i.indrelid=fk.confrelid AND i.indisunique AND i.indkey::text=array_to_string(fk.confkey, ' ')
      )) AS missing_parent_indexes,
      (SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND indexname LIKE 'rls_ix_%') AS child_indexes,
      (SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND indexname LIKE 'rls_uq_%') AS parent_indexes
  `;
  const row = rows[0];
  if (!row) return ['tenant-integrity catalog query returned no row'];
  const defects: string[] = [];
  // Counts cannot see a swap: drop one managed object and add another and the
  // totals net out, leaving the pin green while a composite foreign key that
  // prevents cross-tenant attachment has quietly gone. Compare the SET too, and
  // report what actually moved rather than that a number changed.
  const live = await client.$queryRaw<Array<{ name: string }>>`
    SELECT conname AS name
    FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND c.conname LIKE 'rls_fk_%'
    UNION ALL
    SELECT indexname AS name FROM pg_indexes
    WHERE schemaname = 'public' AND (indexname LIKE 'rls_ix_%' OR indexname LIKE 'rls_uq_%')
  `;
  const liveNames = new Set(live.map(row => row.name));
  const pinnedNames = new Set(TENANT_INTEGRITY_OBJECTS);
  const missing = [...pinnedNames].filter(name => !liveNames.has(name)).sort();
  const unexpected = [...liveNames].filter(name => !pinnedNames.has(name)).sort();
  const sample = (names: string[]) => (names.length > 6 ? `${names.slice(0, 6).join(', ')} (+${names.length - 6} more)` : names.join(', '));
  if (missing.length) {
    defects.push(`tenant-integrity objects missing (${missing.length}): ${sample(missing)}`);
  }
  if (unexpected.length) {
    defects.push(`tenant-integrity objects not in the pinned set (${unexpected.length}): ${sample(unexpected)}`);
  }

  const expected = TENANT_INTEGRITY_MANIFEST;
  if (Number(row.foreign_keys) !== expected.compositeForeignKeys) defects.push(`composite FKs: ${row.foreign_keys} != ${expected.compositeForeignKeys}`);
  if (Number(row.child_indexes) !== expected.childSupportingIndexes) defects.push(`child indexes: ${row.child_indexes} != ${expected.childSupportingIndexes}`);
  if (Number(row.parent_indexes) !== expected.parentUniqueIndexes) defects.push(`parent indexes: ${row.parent_indexes} != ${expected.parentUniqueIndexes}`);
  if (row.invalid_foreign_keys !== 0n) defects.push(`unvalidated composite FKs: ${row.invalid_foreign_keys}`);
  if (row.malformed_foreign_keys !== 0n) defects.push(`composite FKs missing tenantId leading key: ${row.malformed_foreign_keys}`);
  if (row.missing_child_indexes !== 0n) defects.push(`composite FKs without matching child index: ${row.missing_child_indexes}`);
  if (row.missing_parent_indexes !== 0n) defects.push(`composite FKs without matching parent unique index: ${row.missing_parent_indexes}`);
  return defects;
}
