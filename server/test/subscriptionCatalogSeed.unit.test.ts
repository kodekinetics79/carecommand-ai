import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ADDONS, FEATURE_KEYS, PLANS } from '../modules/subscriptions/catalog';

// The catalog is reference data the application cannot run without, so it is
// installed by migration rather than by a seed script (see the header of
// 20260828120000_subscription_catalog_reference_data). That puts the row values
// in SQL while server/modules/subscriptions/catalog.ts stays the source of
// truth, so this suite fails the build the moment the two disagree. A missed
// row does not raise an error at runtime — it silently locks a feature.

const migrationsRoot = new URL('../../prisma/migrations', import.meta.url).pathname;

const catalogMigrations = readdirSync(migrationsRoot)
  .filter(name => /^\d{14}_/.test(name))
  .sort()
  .map(name => readFileSync(join(migrationsRoot, name, 'migration.sql'), 'utf8'))
  .filter(sql => sql.includes('-- @catalog-seed'));

const catalogSql = catalogMigrations.join('\n');

/** Row tuples exactly as the migration renders them. */
const sqlText = (value: string) => `'${value.replaceAll("'", "''")}'`;
const sqlOptionalText = (value: string | null | undefined) => (value == null ? 'NULL' : sqlText(value));
const sqlOptionalInt = (value: number | null | undefined) => (value == null ? 'NULL' : String(value));

function tupleCount(marker: string): number {
  const section = catalogSql.slice(catalogSql.indexOf(`-- @catalog-seed ${marker}`));
  const body = section.slice(section.indexOf('(VALUES'), section.indexOf('), upserted AS ('));
  return body.split('\n').filter(line => /^\s*\(.*\),?$/.test(line)).length;
}

function serverSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'generated' ? [] : serverSources(path);
    return entry.name.endsWith('.ts') ? [readFileSync(path, 'utf8')] : [];
  });
}

describe('subscription catalog seed', () => {
  it('is installed by a migration, the only writer the catalog tables grant', () => {
    // 20260730120000_complete_rls_isolation and 20260730133000_platform_database_plane
    // leave app_rls and app_platform with SELECT only, so nothing at runtime can
    // install this. A seed script would need schema-owner credentials, and
    // prisma/synthetic/seedSafety.ts refuses to seed outside a test database.
    expect(catalogMigrations.length).toBeGreaterThan(0);
    const isolation = readFileSync(join(migrationsRoot, '20260730120000_complete_rls_isolation', 'migration.sql'), 'utf8');
    expect(isolation).toContain('GRANT SELECT ON TABLE\n  "SubscriptionPlan", "SubscriptionPlanFeature", "SubscriptionAddon",');
  });

  it('carries every plan in catalog.ts with the same name, description, and tier', () => {
    for (const plan of PLANS) {
      expect(catalogSql, `plan ${plan.key} missing from the catalog migration`).toContain(
        `(${sqlText(plan.key)}, ${sqlText(plan.name)}, ${sqlText(plan.description)}, ${plan.tier})`,
      );
    }
    expect(tupleCount('plans'), 'catalog migration seeds a plan that catalog.ts does not define').toBe(PLANS.length);
  });

  it('carries every plan feature in catalog.ts with the same limit and note', () => {
    const expected = PLANS.flatMap(plan => plan.features.map(feature =>
      `(${sqlText(plan.key)}, ${sqlText(feature.featureKey)}, ${sqlOptionalInt(feature.limitValue)}, ${sqlOptionalText(feature.note)})`));
    for (const tuple of expected) {
      expect(catalogSql, `plan feature missing from the catalog migration: ${tuple}`).toContain(tuple);
    }
    expect(tupleCount('plan_features'), 'catalog migration seeds a plan feature that catalog.ts does not define').toBe(expected.length);
  });

  it('carries every add-on in catalog.ts with the same feature mapping', () => {
    for (const addon of ADDONS) {
      expect(catalogSql, `add-on ${addon.key} missing from the catalog migration`).toContain(
        `(${sqlText(addon.key)}, ${sqlText(addon.name)}, ${sqlText(addon.description)}, ${sqlOptionalText(addon.featureKey)})`,
      );
    }
    expect(tupleCount('addons'), 'catalog migration seeds an add-on that catalog.ts does not define').toBe(ADDONS.length);
  });

  it('fails closed when a catalogued row is not written', () => {
    // A mistyped plan key would drop plan features through the join and leave a
    // feature permanently locked with no error, so the migration counts its own
    // work and aborts rather than reporting a success that did not happen.
    expect(catalogSql).toContain('Subscription catalog seed incomplete');
    expect(catalogSql).toContain(`OR features_inserted + features_updated <> ${PLANS.reduce((total, plan) => total + plan.features.length, 0)}`);
    expect(catalogSql).toContain(`OR addons_inserted + addons_updated <> ${ADDONS.length}`);
    expect(catalogSql).toContain("'subscription.catalog.seeded'");
  });

  it('never moves an existing tenant onto a different plan or entitlement', () => {
    expect(catalogSql).not.toContain('"TenantSubscription"');
    expect(catalogSql).not.toContain('"TenantSubscriptionAddon"');
    expect(catalogSql).not.toContain('"TenantFeatureEntitlement"');
    expect(catalogSql).not.toMatch(/\bDELETE\s+FROM\b/i);
    // Commercial terms and plan retirement live in the database, not here.
    expect(catalogSql).not.toContain('"monthlyPrice"');
    expect(catalogSql).not.toContain('"active"');
  });

  it('sells every feature key the entitlement resolver materialises', () => {
    // recomputeEntitlements writes one row per FEATURE_KEYS entry. A key no plan
    // includes can never be enabled by any plan, which reads to the user as a
    // feature that is permanently locked.
    const sold = new Set(PLANS.flatMap(plan => plan.features.map(feature => feature.featureKey)));
    expect([...FEATURE_KEYS].filter(key => !sold.has(key))).toEqual([]);
  });

  it('gates only on feature keys the catalog actually defines', () => {
    // The inverse silent lock: a route guarded by a key outside FEATURE_KEYS
    // never receives an entitlement row, so it answers 403 forever.
    const gated = new Set<string>();
    for (const source of serverSources(new URL('..', import.meta.url).pathname)) {
      for (const match of source.matchAll(/requireFeature\(\s*'([a-z_]+)'/g)) gated.add(match[1]);
      for (const match of source.matchAll(/isFeatureEnabled\([^,)]+,\s*'([a-z_]+)'/g)) gated.add(match[1]);
    }
    expect(gated.size).toBeGreaterThan(0);
    expect([...gated].filter(key => !FEATURE_KEYS.includes(key as never)).sort()).toEqual([]);
  });
});
