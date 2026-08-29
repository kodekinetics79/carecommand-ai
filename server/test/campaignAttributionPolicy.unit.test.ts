import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CAMPAIGN_ATTRIBUTION_OUTCOMES,
  CAMPAIGN_ATTRIBUTION_RULES,
  CAMPAIGN_ATTRIBUTION_WINDOW_DAYS_DEFAULT,
  CAMPAIGN_ENGAGEMENT_DISCLOSURE,
  EVIDENCEABLE_OUTCOMES,
} from '../lib/campaignAttribution';
import { RLS_TABLE_ADAPTERS } from '../lib/rlsTableAdapters';

// ===========================================================================
// Source-level contracts for closed-loop attribution. The behavioural suite
// proves what the job does; this one proves the things that are only true if
// nobody quietly edits them back: the window is configuration and not a
// literal, the evidence table is tenant-isolated the way every table added
// after the RLS loop must be, the legacy columns are unwritable, and this
// increment did not touch the dispatch fence or activate live dispatch.
// ===========================================================================

const root = new URL('../../', import.meta.url).pathname;
const read = (relative: string) => readFileSync(`${root}${relative}`, 'utf8');

const schema = read('prisma/schema.prisma');
const migration = read('prisma/migrations/20260828230000_campaign_attribution/migration.sql');
const fenceMigration = read('prisma/migrations/20260828200000_campaign_dispatch_fence/migration.sql');
const attributionSource = read('server/lib/campaignAttribution.ts');
const dispatchSource = read('server/lib/campaignDispatch.ts');
const queuesSource = read('server/workers/queues.ts');
const workerSource = read('server/workers/campaign.worker.ts');
const routesSource = read('server/modules/campaigns/routes.ts');
/** The migration with its prose removed, so an assertion about STATEMENTS is
 *  never satisfied or defeated by a sentence in a comment. */
const migrationStatements = migration
  .split('\n')
  .filter(line => !line.trimStart().startsWith('--'))
  .join('\n');

function modelBody(name: string): string {
  const match = schema.match(new RegExp(`^model\\s+${name}\\s*\\{([\\s\\S]*?)^\\}`, 'm'));
  expect(match, `model ${name} is missing from prisma/schema.prisma`).toBeTruthy();
  return match![1];
}

describe('attribution window — configuration, never a literal', () => {
  it('pins the code fallback to the GrowthPolicy column default', () => {
    const line = modelBody('GrowthPolicy').split('\n').find(l => /^\s*campaignAttributionWindowDays\s/.test(l));
    expect(line, 'GrowthPolicy.campaignAttributionWindowDays is missing').toBeTruthy();
    expect(Number(line!.match(/@default\(([^)]*)\)/)![1])).toBe(CAMPAIGN_ATTRIBUTION_WINDOW_DAYS_DEFAULT);
    // The seeded default must also be what an existing tenant gets, so the
    // column carries the same number in the migration.
    expect(migration).toContain('ADD COLUMN "campaignAttributionWindowDays" INTEGER NOT NULL DEFAULT 30');
  });

  it('reads the window from the policy row and applies it as a parameter', () => {
    expect(attributionSource).toContain('policy?.campaignAttributionWindowDays');
    // Every window comparison flows through one parameterised predicate. A
    // hardcoded horizon would have to bypass it, and there is nothing to bypass
    // it with: the only number in this file is the documented fallback.
    expect(attributionSource).toContain('export function bookingIsInWindow(acceptedAt: Date, bookedAt: Date, windowDays: number)');
    expect(attributionSource).toContain('booked <= accepted + windowDays * DAY_MS');
    const windowAssignments = [...attributionSource.matchAll(/windowDays\s*[:=]\s*(\d+)/g)].map(m => m[1]);
    expect(windowAssignments, 'a numeric window is assigned somewhere other than the documented fallback').toEqual([]);
  });

  it('carries the window on the row so a policy change cannot rewrite history', () => {
    const body = modelBody('CampaignAttribution');
    for (const column of ['windowDays', 'windowStartsAt', 'windowEndsAt']) {
      expect(body, `CampaignAttribution.${column} is missing`).toMatch(new RegExp(`^\\s*${column}\\s`, 'm'));
    }
    // The rationale is part of the schema, not folklore, because the next
    // person to "simplify" this will read the model and not the commit.
    expect(schema).toContain('THE WINDOW IS CAPTURED ON THE ROW ON PURPOSE');
    expect(schema).toMatch(/must never retroactively rewrite/);
    expect(routesSource).toContain('recordedAtAttributionTime: true');
  });
});

describe('the outcome vocabulary states what is not evidenced', () => {
  it('keeps `engaged` in the vocabulary and out of what the job will write', () => {
    expect([...CAMPAIGN_ATTRIBUTION_OUTCOMES]).toEqual(['engaged', 'booked', 'attended', 'paid']);
    expect([...EVIDENCEABLE_OUTCOMES]).toEqual(['booked', 'attended', 'paid']);
    expect(EVIDENCEABLE_OUTCOMES).not.toContain('engaged');
    expect(Object.keys(CAMPAIGN_ATTRIBUTION_RULES).sort()).toEqual([...EVIDENCEABLE_OUTCOMES].sort());
  });

  it('reports an unmeasurable open rate as unavailable rather than as zero', () => {
    expect(CAMPAIGN_ENGAGEMENT_DISCLOSURE.openRate).toBeNull();
    expect(CAMPAIGN_ENGAGEMENT_DISCLOSURE.responseRate).toBeNull();
    expect(CAMPAIGN_ENGAGEMENT_DISCLOSURE.unavailableReason.length).toBeGreaterThan(8);
  });

  it('never imputes a per-event constant, which is the competitor failure mode', () => {
    // Tebra: $3/reminder sent and $150/recall appointment. RevenueWell: flat
    // $5/$10 plus a 60-day blanket credit. The defence is that no constant is
    // multiplied by a count anywhere in this module.
    expect(attributionSource).not.toMatch(/attributedValue:\s*(?!0\b)\d/);
    expect(attributionSource).toContain('attributedValue: 0');
    expect(attributionSource).toContain('succeeded minus refunded');
  });
});

describe('CampaignAttribution is tenant-isolated the way a post-loop table must be', () => {
  it('has a real tenantId and a real Tenant relation, unlike AutomationRule', () => {
    const body = modelBody('CampaignAttribution');
    expect(body).toMatch(/^\s*tenantId\s+String\s+[^\n]*@db\.Uuid/m);
    expect(body).toMatch(/tenant\s+Tenant\s+@relation\(fields: \[tenantId\], references: \[id\], onDelete: Cascade/);
    // The mistake this assertion exists to prevent repeating.
    expect(modelBody('AutomationRule')).not.toMatch(/tenant\s+Tenant\s+@relation/);
  });

  it('declares its own RLS policies and CRUD grants, because the isolation loop already ran', () => {
    expect(migration).toContain('ALTER TABLE "CampaignAttribution" ENABLE ROW LEVEL SECURITY;');
    expect(migration).toContain('ALTER TABLE "CampaignAttribution" FORCE ROW LEVEL SECURITY;');
    for (const command of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
      expect(migration, `missing ${command} policy`).toMatch(
        new RegExp(`CREATE POLICY \\w+ ON "CampaignAttribution" FOR ${command} TO app_rls`),
      );
    }
    expect(migration).toContain('REVOKE ALL ON TABLE "CampaignAttribution" FROM app_rls;');
    expect(migration).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "CampaignAttribution" TO app_rls;');
    expect(migration).toContain('ALTER TABLE "CampaignAttribution" ADD CONSTRAINT "CampaignAttribution_tenantId_fkey"');
  });

  it('is enrolled in the schema-derived RLS adapter catalog as a MUTABLE tenant table', () => {
    const adapter = RLS_TABLE_ADAPTERS.find(entry => entry.table === 'CampaignAttribution');
    expect(adapter, 'CampaignAttribution is not enrolled in the RLS adapter catalog').toBeTruthy();
    expect(adapter).toMatchObject({ ownershipColumn: 'tenantId', mode: 'MUTABLE' });
  });

  it('makes both anti-double-count constraints database constraints, not conventions', () => {
    expect(migration).toContain('CREATE UNIQUE INDEX "CampaignAttribution_tenantId_campaignDeliveryId_outcomeType_key"');
    expect(migration).toContain('CREATE UNIQUE INDEX "CampaignAttribution_tenantId_outcomeType_appointmentId_key"');
    expect(migration).toContain('CREATE TRIGGER "CampaignAttribution_tenant_consistency"');
  });
});

describe('the deprecated columns are a rollup nobody can hand-set', () => {
  it('documents the deprecation on the model itself', () => {
    const body = modelBody('Campaign');
    expect(body).toContain('DEPRECATED AS WRITABLE COLUMNS');
    expect(body).toContain('MATERIALIZED ROLLUP');
    expect(body).toMatch(/opened\s+= 0 and responded = 0, PINNED/);
  });

  it('installs a guard with no escape hatch and resets the values that no code produced', () => {
    expect(migration).toContain('CREATE TRIGGER "Campaign_attribution_rollup_guard"');
    expect(migration).toContain('BEFORE INSERT OR UPDATE ON "Campaign"');
    expect(migration).toContain('CREATE TRIGGER "CampaignAttribution_rollup_refresh"');
    expect(migration).toMatch(/UPDATE "Campaign"\s*\n\s*SET "opened" = 0, "responded" = 0, "booked" = 0, "revenue" = 0/);
    // No session flag, GUC or privileged role turns the guard off. If one is
    // ever added, this fails.
    expect(migrationStatements).not.toMatch(/current_setting\('app\.[a-z_]*rollup/);
    expect(migrationStatements).not.toMatch(/current_user\s*=\s*'app_rls'[\s\S]{0,200}rollup/);
  });

  it('leaves dispatch writing only `sent`', () => {
    expect(dispatchSource).toContain('audienceSize: candidates.length, sent: s.accepted');
    for (const column of ['opened', 'responded', 'booked', 'revenue']) {
      expect(dispatchSource, `campaignDispatch writes Campaign.${column}`).not.toMatch(new RegExp(`\\b${column}:`));
    }
  });
});

describe('this increment did not weaken the dispatch fence and activates nobody', () => {
  it('leaves the fence sequence in campaignDispatch exactly where it was', () => {
    // Advisory-locked intent committed BEFORE provider I/O, suppression
    // re-checked inside the claim transaction, then the truthful result.
    const intent = dispatchSource.indexOf('await claimCampaignProviderIntent({');
    const send = dispatchSource.indexOf('await sendMessage(');
    const result = dispatchSource.indexOf('await recordCampaignSubmissionResult({');
    expect(intent).toBeGreaterThan(-1);
    expect(send).toBeGreaterThan(intent);
    expect(result).toBeGreaterThan(send);
    expect(dispatchSource).toContain("if (intent.outcome === 'suppressed')");
    expect(dispatchSource).toContain("failureReason = 'live_outreach_atomic_boundary_not_activated'");
  });

  it('creates no live-dispatch activation and adds no default that could', () => {
    // The header names the activation table to say it activates nobody; what
    // must not exist is a statement that could write one, or any write at all
    // to the dispatch-fence tables.
    expect(migrationStatements).not.toMatch(/INSERT\s+INTO\s+"CampaignLiveDispatchActivation"/i);
    expect(migrationStatements).not.toMatch(/(INSERT\s+INTO|UPDATE|ALTER\s+TABLE|DROP)\s+"?(CampaignLiveDispatchActivation|CampaignSubmissionClaim)"?/i);
    expect(migrationStatements).not.toMatch(/DEFAULT[^\n]*activat/i);
    // And the fence migration still says what it said.
    expect(fenceMigration).toContain('CampaignLiveDispatchActivation is the per-tenant, per-channel switch');
    expect(attributionSource).not.toMatch(/sendMessage|dispatchCampaign|LiveDispatchActivation/);
  });
});

describe('the job is registered on the existing worker runtime', () => {
  it('registers a repeatable schedule on the campaign queue and consumes both job names', () => {
    expect(queuesSource).toContain("upsertJobScheduler('campaign-attribution'");
    expect(queuesSource).toContain("operation: 'attribute-outcomes'");
    expect(queuesSource).toContain('export async function enqueueCampaignAttributionTenantJob');
    // Same signed fan-out shape as the dispatch scheduler, so it inherits the
    // same replay/tenant-binding/expiry guarantees rather than inventing new ones.
    expect(workerSource).toContain("assertSchedulerTick(job, { name: 'attribute-outcomes', schedulerId: 'campaign-attribution' })");
    expect(workerSource).toContain("queue: 'campaign-scheduler', operation: 'attribute-outcomes', jobId: job.id,");
    expect(workerSource).toContain('attributeTenantCampaignOutcomes(envelope.tenantId)');
    expect(workerSource).toContain("'worker:campaign-attribution'");
  });
});

describe('the read surface derives from evidence and ships its own basis', () => {
  it('never reads a rollup column and always returns the rules it applied', () => {
    expect(routesSource).toContain('summarizeCampaignAttribution');
    expect(routesSource).toContain("derivedFrom: 'CampaignAttribution rows only'");
    expect(routesSource).toContain('CAMPAIGN_ENGAGEMENT_DISCLOSURE');
    for (const column of ['opened', 'responded', 'booked', 'revenue']) {
      expect(routesSource, `the CRM routes read Campaign.${column}`).not.toMatch(new RegExp(`c\\.${column}\\b`));
    }
  });
});
