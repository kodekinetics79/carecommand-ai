import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  GROWTH_CHANNEL_COST_DEFAULTS,
  GROWTH_POLICY_DEFAULTS,
  GROWTH_SEGMENT_DEFAULTS,
  MONEY_AFFECTING_POLICY_FIELDS,
  PENDING_CONFIG_CALL_SITES,
  THRESHOLD_RESOLUTIONS,
} from '../modules/growth/defaults';
import { RLS_TABLE_ADAPTERS } from '../lib/rlsTableAdapters';

// ===========================================================================
// The configuration spine is only worth landing if the seeded values are
// PROVABLY today's values. Three artifacts carry the same numbers — the Prisma
// column defaults, the `-- @growth-seed` blocks in the migration, and
// server/modules/growth/defaults.ts — and the Growth module's source is the
// fourth. This suite fails the build the moment any of them disagree, which is
// the only way "this increment changes no observable number" can be a claim
// rather than a hope.
// ===========================================================================

const root = new URL('../../', import.meta.url).pathname;
const read = (relative: string) => readFileSync(`${root}${relative}`, 'utf8');

const schema = read('prisma/schema.prisma');
const migration = read('prisma/migrations/20260828140000_growth_config_spine/migration.sql');

// Columns added to GrowthPolicy AFTER the spine migration. Each one is seeded
// for every existing tenant by `ADD COLUMN ... DEFAULT` in its own migration
// rather than by the spine's `-- @growth-seed policy` block, so the parity
// assertions below pin that migration instead. The guard is EXTENDED, not
// weakened: every defaults.ts column must still be seeded exactly once — by
// the spine seed or by exactly one later ADD COLUMN — with the defaults.ts
// value.
const LATER_POLICY_COLUMNS: Record<string, { migration: string; sqlType: string }> = {
  noShowRiskHigh: {
    migration: 'prisma/migrations/20260829130000_growth_policy_no_show_risk/migration.sql',
    sqlType: 'INTEGER',
  },
};
const crmService = read('src/lib/crmService.ts');
const patientRoutes = read('server/modules/patients/routes.ts');
// The Growth module's arithmetic no longer lives in the browser. Two files now
// carry the evidence that used to be read out of src/lib/crmService.ts:
//   * legacyClient — a FROZEN transcription of the deleted browser code, so the
//     constants that shipped still have a witness that cannot drift with the
//     product;
//   * the growth module itself, which must be shown to read the configuration
//     rather than a literal.
const legacyClient = read('server/test/helpers/legacyCrmClient.ts');
const growthDefaults = read('server/modules/growth/defaults.ts');
const growthScoring = read('server/modules/growth/scoring.ts');
const growthMetrics = read('server/modules/growth/metrics.ts');

const NEW_TENANT_MODELS = ['LeadActivity', 'GrowthPolicy', 'GrowthSegmentDefinition', 'GrowthChannelCost'] as const;

function modelBody(name: string): string {
  const match = schema.match(new RegExp(`^model\\s+${name}\\s*\\{([\\s\\S]*?)^\\}`, 'm'));
  expect(match, `model ${name} is missing from prisma/schema.prisma`).toBeTruthy();
  return match![1];
}

/** `@default(...)` for one column of a model, as written in the schema. */
function schemaDefault(model: string, field: string): string {
  const line = modelBody(model).split('\n').find(l => new RegExp(`^\\s*${field}\\s`).test(l));
  expect(line, `${model}.${field} is missing from prisma/schema.prisma`).toBeTruthy();
  const match = line!.match(/@default\(([^)]*)\)/);
  expect(match, `${model}.${field} has no @default`).toBeTruthy();
  return match![1];
}

/** The single `-- @growth-seed <marker>` statement, without its trailing blocks. */
function seedBlock(marker: string): string {
  const start = migration.indexOf(`-- @growth-seed ${marker}`);
  expect(start, `migration has no "-- @growth-seed ${marker}" block`).toBeGreaterThan(-1);
  const end = migration.indexOf(';', start);
  return migration.slice(start, end);
}

/** The line in the frozen browser transcription's `defs` array that declares one segment. */
function segmentSourceLine(key: string): string {
  const line = legacyClient.split('\n').find(l => l.includes(`id: '${key}'`));
  expect(line, `the frozen browser transcription no longer declares the '${key}' segment`).toBeTruthy();
  return line!;
}

describe('growth config spine — schema, migration and defaults.ts agree', () => {
  it('gives every GrowthPolicy field the same default in the schema and in defaults.ts', () => {
    for (const [field, value] of Object.entries(GROWTH_POLICY_DEFAULTS)) {
      expect(Number(schemaDefault('GrowthPolicy', field)), `GrowthPolicy.${field} @default`).toBe(value);
    }
  });

  it('seeds every existing tenant the policy values defaults.ts declares', () => {
    const block = seedBlock('policy');
    // The INSERT column list and the SELECT value list must line up position for
    // position. `id`/`tenantId` are supplied by gen_random_uuid()/t.id and the
    // timestamps by now(), so both lists are read with those stripped.
    const positional = ['id', 'tenantId', 'createdAt', 'updatedAt'];
    const columnList = block.slice(block.indexOf('('), block.indexOf('SELECT gen_random_uuid'));
    const columns = [...columnList.matchAll(/"(\w+)"/g)].map(m => m[1])
      .filter(c => !positional.includes(c));
    const values = block.slice(block.indexOf('SELECT gen_random_uuid(), t.id,'))
      .replace('SELECT gen_random_uuid(), t.id,', '')
      .split('FROM "Tenant"')[0]
      .split(',').map(v => v.trim()).filter(v => v.length > 0 && v !== 'now()');

    expect(columns.length, 'seed column list and value list are different lengths').toBe(values.length);
    const seeded = new Map(columns.map((column, index) => [column, values[index]]));
    for (const [field, value] of Object.entries(GROWTH_POLICY_DEFAULTS)) {
      const later = LATER_POLICY_COLUMNS[field];
      if (later) {
        // Backfilled by its own migration: existing tenants get exactly the
        // defaults.ts value via the column DEFAULT.
        expect(
          read(later.migration),
          `GrowthPolicy.${field} must be backfilled with its defaults.ts value by ${later.migration}`,
        ).toContain(`ADD COLUMN "${field}" ${later.sqlType} NOT NULL DEFAULT ${value};`);
        continue;
      }
      expect(Number(seeded.get(field)), `seeded GrowthPolicy.${field}`).toBe(value);
    }
    // Exactly-once seeding: if a later column ever also appears in the spine
    // seed (a duplicate), or a defaults.ts column is seeded nowhere, the sorted
    // union stops matching.
    expect(
      [...columns, ...Object.keys(LATER_POLICY_COLUMNS)].sort(),
      'every defaults.ts column is seeded exactly once — by the spine seed or by one later ADD COLUMN migration',
    ).toEqual(Object.keys(GROWTH_POLICY_DEFAULTS).sort());
  });

  it('seeds the six segment definitions and four channel costs verbatim', () => {
    const segments = seedBlock('segments');
    for (const definition of GROWTH_SEGMENT_DEFAULTS) {
      const row = segments.split('\n').find(l => l.includes(`('${definition.key}',`));
      expect(row, `segment seed row for ${definition.key}`).toBeTruthy();
      expect(row).toContain(`'${definition.label}'`);
      expect(row).toContain(`'${definition.description}'`);
      expect(row).toContain(`'${definition.suggestedChannel}'`);
      expect(row).toContain(`'${definition.plannedOffer}'`);
      expect(row).toContain(`, ${definition.assumedBookingRatePct},`);
      expect(row).toContain(`, ${definition.includeNeverVisited},`);
    }

    const costs = seedBlock('channel-costs');
    for (const cost of GROWTH_CHANNEL_COST_DEFAULTS) {
      expect(costs).toContain(`('${cost.channel}', ${cost.unitCostMinor}, '${cost.currency}')`);
    }
  });
});

describe('growth config spine — the seed reproduces today\'s constants', () => {
  it('keeps the hot-lead score and the recoverable-value assumption the browser shipped', () => {
    // The browser is out of this business entirely: it no longer scores a lead,
    // averages a patient, or multiplies a lifetime value by anything.
    expect(crmService).not.toContain('function scoreLead');
    expect(crmService).not.toContain('commandMetrics(');
    expect(crmService).not.toContain('smartSegments(');
    expect(crmService).not.toMatch(/score >= \d/);
    expect(crmService).not.toMatch(/lifetimeValue \* /);

    // The constants it used to apply still have a witness, and the config still
    // equals them.
    expect(legacyClient).toContain(`l.score >= ${GROWTH_POLICY_DEFAULTS.hotLeadScore}`);
    // 0.30 is stored with four decimals; the source writes it as 0.3.
    expect(legacyClient).toContain(`p.lifetimeValue * ${GROWTH_POLICY_DEFAULTS.recoverableLtvFraction}`);

    // ...and the server applies them FROM the configuration, not from a literal.
    expect(growthScoring).toContain('context.policy.hotLeadScore');
    expect(growthMetrics).toContain('policy.recoverableLtvFraction');
    expect(growthMetrics).not.toMatch(/\* 0\.3\b/);
    expect(growthScoring).not.toMatch(/score >= 70/);
  });

  it('reproduces each of the six smart segments the browser shipped, filter for filter', () => {
    expect(GROWTH_SEGMENT_DEFAULTS).toHaveLength(6);
    for (const definition of GROWTH_SEGMENT_DEFAULTS) {
      const line = segmentSourceLine(definition.key);
      expect(line, `${definition.key} label`).toContain(`label: '${definition.label}'`);
      expect(line, `${definition.key} description`).toContain(`description: '${definition.description}'`);
      expect(line, `${definition.key} channel`).toContain(`channel: '${definition.suggestedChannel}'`);
      expect(line, `${definition.key} offer`).toContain(`offer: '${definition.plannedOffer}'`);
      expect(line, `${definition.key} booking rate`).toContain(`rate: ${definition.assumedBookingRatePct}`);

      if (definition.minInactiveDays !== null && definition.maxInactiveDays !== null) {
        // The window is [min, max): min inclusive, max exclusive.
        expect(line, `${definition.key} window`).toContain(`d >= ${definition.minInactiveDays} && d < ${definition.maxInactiveDays}`);
      } else if (definition.minInactiveDays !== null) {
        expect(line, `${definition.key} open-ended window`).toContain(`daysSince(p.lastVisit) >= ${definition.minInactiveDays}`);
      }
      if (definition.minLifetimeValue !== null) {
        expect(line, `${definition.key} LTV floor`).toContain(`p.lifetimeValue >= ${definition.minLifetimeValue}`);
      }
      if (definition.minChurnRisk !== null) {
        expect(line, `${definition.key} churn floor`).toContain(`p.churnRisk >= ${definition.minChurnRisk}`);
      }
      if (definition.requiredTag !== null) {
        expect(line, `${definition.key} tag`).toContain(`includes('${definition.requiredTag}')`);
      }
    }
  });

  it('reproduces the per-channel planning cost in minor units instead of bare integers', () => {
    // What shipped: `ps.length * (channel === 'Email' ? 0 : channel === 'Voice' ? 3 : 1)`,
    // rendered through formatCurrency with no currency awareness at all.
    expect(legacyClient).toContain("d.channel === 'Email' ? 0 : d.channel === 'Voice' ? 3 : 1");
    expect(crmService).not.toContain("? 3 : 1");
    // The server prices a group from the tenant's configured per-channel cost,
    // and says so when there isn't one rather than defaulting to a unit.
    expect(growthMetrics).toContain('members * cost.unitCostMinor');
    expect(growthMetrics).toContain('costUnavailableReason');
    const byChannel = new Map(GROWTH_CHANNEL_COST_DEFAULTS.map(c => [c.channel, c]));
    expect(byChannel.get('Email')?.unitCostMinor).toBe(0);
    expect(byChannel.get('Voice')?.unitCostMinor).toBe(3 * 100);
    expect(byChannel.get('SMS')?.unitCostMinor).toBe(1 * 100);
    expect(byChannel.get('WhatsApp')?.unitCostMinor).toBe(1 * 100);
    for (const cost of GROWTH_CHANNEL_COST_DEFAULTS) {
      expect(cost.currency, 'a stored cost is meaningless without its currency').toMatch(/^[A-Z]{3}$/);
    }
    // Every channel a seeded segment suggests must have a seeded cost, or the
    // planning number silently becomes zero.
    for (const definition of GROWTH_SEGMENT_DEFAULTS) {
      expect(byChannel.has(definition.suggestedChannel), `no seeded cost for ${definition.suggestedChannel}`).toBe(true);
    }
  });

  it('carries the reputation and competitor severity thresholds the radar screens use', () => {
    // Reviews.tsx and ClinicRadar.tsx belong to another team's concurrent
    // increment, so the comparison is deliberately variable-name agnostic: it
    // pins the NUMBER and the OPERATOR, which are what this configuration
    // replaces, and not whatever the local identifier is called this week.
    const reviews = read('src/pages/Reviews.tsx');
    const radar = read('src/pages/ClinicRadar.tsx');
    const has = (source: string, pattern: RegExp, label: string) =>
      expect(pattern.test(source), `${label} is no longer expressed as ${pattern}`).toBe(true);

    has(reviews, />=\s*4\.5\b/, 'reviewRatingGood');
    has(reviews, />=\s*4\b/, 'reviewRatingFair');
    has(radar, />=\s*80\b/, 'reputationRiskHigh');
    has(radar, />=\s*55\b/, 'reputationRiskMedium');
    has(radar, /<=\s*4\.2\b/, 'competitorRatingHighSeverityMax');
    has(radar, /<=\s*4\.5\b/, 'competitorRatingMediumSeverityMax');
    has(radar, />\s*350\b/, 'competitorReviewVolumeHigh');

    expect(GROWTH_POLICY_DEFAULTS.reviewRatingGood).toBe(4.5);
    expect(GROWTH_POLICY_DEFAULTS.reviewRatingFair).toBe(4.0);
    expect(GROWTH_POLICY_DEFAULTS.reputationRiskHigh).toBe(80);
    expect(GROWTH_POLICY_DEFAULTS.reputationRiskMedium).toBe(55);
    expect(GROWTH_POLICY_DEFAULTS.competitorRatingHighSeverityMax).toBe(4.2);
    expect(GROWTH_POLICY_DEFAULTS.competitorRatingMediumSeverityMax).toBe(4.5);
    expect(GROWTH_POLICY_DEFAULTS.competitorReviewVolumeHigh).toBe(350);
  });
});

describe('growth config spine — the churn-risk / LTV threshold conflict is resolved, not papered over', () => {
  it('records both sides of each conflict and the value that won', () => {
    const churn = THRESHOLD_RESOLUTIONS.find(r => r.concept === 'churnRiskHigh');
    const ltv = THRESHOLD_RESOLUTIONS.find(r => r.concept === 'highValuePatientLtv');
    expect(churn?.chosen).toBe(50);
    expect(churn?.comparison).toBe('>=');
    expect(ltv?.chosen).toBe(4000);
    expect(ltv?.comparison).toBe('>=');
    for (const resolution of THRESHOLD_RESOLUTIONS) {
      expect(resolution.reasoning.length, `${resolution.concept} needs a stated reason`).toBeGreaterThan(80);
    }
  });

  it('records the no-show divergence as resolved, with the register semantics', () => {
    const noShow = THRESHOLD_RESOLUTIONS.find(r => r.concept === 'noShowRiskHigh');
    expect(noShow, 'the Scheduling/advisory/revenue-protection no-show divergence is not recorded').toBeTruthy();
    expect(noShow?.kind).toBe('divergence-resolved');
    expect(noShow?.chosen).toBe(50);
    expect(noShow?.comparison).toBe('>=');
    expect(GROWTH_POLICY_DEFAULTS.noShowRiskHigh).toBe(50);
    // The resolution must name all three formerly divergent layers.
    expect(noShow?.frontend).toContain('Scheduling.tsx');
    expect(noShow?.server).toContain('advisory');
    expect(noShow?.server).toContain('revenue-protection');
  });

  it('makes one value per concept the single source of truth', () => {
    expect(GROWTH_POLICY_DEFAULTS.churnRiskHigh).toBe(50);
    expect(GROWTH_POLICY_DEFAULTS.highValuePatientLtv).toBe(4000);
    // Both numbers are exactly what the browser applied, per the frozen witness.
    expect(legacyClient).toContain(`p.churnRisk >= ${GROWTH_POLICY_DEFAULTS.churnRiskHigh}`);
    expect(legacyClient).toContain(`p.lifetimeValue >= ${GROWTH_POLICY_DEFAULTS.highValuePatientLtv}`);

    // The frontend no longer restates either one. The at-risk badge renders the
    // band the server computed; the segment floors come from the definitions.
    expect(crmService).not.toMatch(/churnRisk >= \d/);
    expect(crmService).not.toMatch(/lifetimeValue >= \d/);
    expect(read('src/pages/CRM.tsx')).not.toMatch(/churnRisk >= \d/);
    expect(growthMetrics).toContain('churnRiskHigh: policy.churnRiskHigh');

    // The high-LTV segment floor and the policy's high-value threshold are the
    // same concept, so they are the same number.
    const highLtv = GROWTH_SEGMENT_DEFAULTS.find(definition => definition.key === 'high-ltv-inactive');
    expect(highLtv?.minLifetimeValue).toBe(GROWTH_POLICY_DEFAULTS.highValuePatientLtv);
    const atRisk = GROWTH_SEGMENT_DEFAULTS.find(definition => definition.key === 'at-risk');
    expect(atRisk?.minChurnRisk).toBe(GROWTH_POLICY_DEFAULTS.churnRiskHigh);
  });

  it('replaces the 9999-day sentinel with a configured includeNeverVisited decision', () => {
    // The sentinel is what made all three inactivity windows unreachable for a
    // patient with no recorded visit, silently.
    expect(legacyClient).toContain('9999');
    expect(crmService).not.toContain('9999');
    expect(growthMetrics).not.toContain('9999');
    // The window is [min, max): inclusive floor, exclusive ceiling, in SQL.
    expect(growthMetrics).toContain('${daysSinceVisit} >= ${definition.minInactiveDays}');
    expect(growthMetrics).toContain('${daysSinceVisit} < ${definition.maxInactiveDays}');
    expect(growthMetrics).toContain('definition.includeNeverVisited');
  });

  it('keeps every lead-scoring weight the browser used, now as named configuration', () => {
    // Each weight is asserted against the frozen browser source, so a change to
    // the curve has to be a deliberate edit to a documented constant rather than
    // a number quietly drifting inside a component.
    expect(growthDefaults).toContain('GROWTH_LEAD_SCORE_WEIGHTS');
    expect(legacyClient).toContain('intent * 0.4');
    expect(legacyClient).toContain('(lead.estimatedValue / maxValue) * 30');
    expect(legacyClient).toContain('ageDays <= 2 ? 20 : ageDays <= 7 ? 12 : ageDays <= 30 ? 4 : 0');
    expect(legacyClient).toContain("['whatsapp', 'sms'].includes(lead.channel.toLowerCase())");
    for (const literal of ['stageIntentMultiplier: 0.4', 'valueWeight: 30', 'reachableChannelWeight: 8']) {
      expect(growthDefaults, `GROWTH_LEAD_SCORE_WEIGHTS is missing ${literal}`).toContain(literal);
    }
    // The denominator is a tenant-wide MAX, not the maximum of a loaded page —
    // which is what made the same lead score differently on different screens.
    expect(legacyClient).toContain('Math.max(1, ...rows.map(r => num(r.estimatedValue)))');
    expect(growthMetrics).toContain('_max: { estimatedValue: true }');
    expect(crmService).not.toContain('Math.max(1, ...');
  });

  it('has the patients summary reading the policy instead of its own literals', () => {
    // This assertion used to pin the divergence rather than the fix: the server
    // counted churnRisk >= 60 while three frontend files used >= 50, so a
    // patient at 55% was at risk on one screen and not another in the same
    // session. That call site now reads GrowthPolicy, so the guard flips to
    // pinning the convergence — the literals must not come back, and the read
    // must stay.
    expect(patientRoutes).not.toContain('churnRisk: { gte: 60 }');
    expect(patientRoutes).not.toContain('lifetimeValue: { gt: 4000 }');
    expect(patientRoutes).toContain('getEffectiveGrowthPolicy');
    expect(patientRoutes).toContain('churnRiskHigh');
    expect(patientRoutes).toContain('highValuePatientLtv');
    expect(PENDING_CONFIG_CALL_SITES.some(site => site.includes('patients/routes.ts'))).toBe(false);
  });
});

describe('growth config spine — tenancy is inherited, not assumed', () => {
  it('gives every new table a tenantId UUID and a real Tenant relation', () => {
    for (const model of NEW_TENANT_MODELS) {
      const body = modelBody(model);
      // AutomationRule (schema.prisma) has a tenantId with no Tenant relation and
      // no FK. That is the mistake this assertion exists to prevent repeating.
      expect(body, `${model} needs "tenantId String @db.Uuid"`).toMatch(/^\s*tenantId\s+String\s+[^\n]*@db\.Uuid/m);
      expect(body, `${model} needs a real Tenant relation`).toMatch(/tenant\s+Tenant\s+@relation\(fields: \[tenantId\], references: \[id\], onDelete: Cascade/);
    }
  });

  it('is picked up by the RLS table adapter schema parse', () => {
    const covered = new Set(RLS_TABLE_ADAPTERS.map(a => a.table));
    for (const model of NEW_TENANT_MODELS) {
      expect(covered.has(model), `${model} is not enrolled in the RLS adapter catalog`).toBe(true);
    }
  });

  it('declares its own RLS policies, because the isolation loop already ran', () => {
    // 20260730120000_complete_rls_isolation applied its dynamic policy loop once.
    // A table created afterwards inherits nothing and must say so itself.
    for (const model of NEW_TENANT_MODELS) {
      expect(migration).toContain(`ALTER TABLE "${model}" ENABLE ROW LEVEL SECURITY;`);
      expect(migration).toContain(`ALTER TABLE "${model}" FORCE ROW LEVEL SECURITY;`);
      for (const command of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
        expect(migration, `${model} is missing a ${command} policy`).toMatch(
          new RegExp(`CREATE POLICY \\w+ ON "${model}" FOR ${command} TO app_rls`),
        );
      }
      expect(migration).toContain(`REVOKE ALL ON TABLE "${model}" FROM app_rls;`);
      expect(migration).toContain(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "${model}" TO app_rls;`);
      expect(migration).toContain(`ALTER TABLE "${model}" ADD CONSTRAINT "${model}_tenant`);
    }
  });

  it('names money-affecting policy fields explicitly so the API can gate them', () => {
    expect([...MONEY_AFFECTING_POLICY_FIELDS].sort()).toEqual(['highValuePatientLtv', 'recoverableLtvFraction']);
    for (const field of MONEY_AFFECTING_POLICY_FIELDS) {
      expect(Object.keys(GROWTH_POLICY_DEFAULTS)).toContain(field);
    }
  });
});
