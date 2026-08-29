import 'dotenv/config';
import { spawn } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// ===========================================================================
// Demo readiness evidence.
//
// A freshly provisioned tenant used to open every Growth screen either locked
// (`feature_locked`, because the seed wrote no TenantSubscription) or empty
// (no Lead / Campaign / Review / consent rows, and no Patient.lastVisitAt at
// all). This suite is the standing proof that it no longer does.
//
// It asserts through the PRODUCTION read paths, not through hand-written SQL
// that happens to agree with the seed: `previewGrowthSegments` for the
// inactivity windows and `previewAudience` for consent/suppression, so a
// regression in the product is caught here and not only a regression in the
// fixture.
//
// Lifecycle, same contract as rlsBehavioralCoverage.integration.test.ts: this
// suite creates the whole database contents, so it runs ONLY inside the
// disposable-database lifecycle and refuses to touch a shared database.
//
//     npm run demo:verify
// ===========================================================================

if (!process.env.RLS_DISPOSABLE_DB) {
  describe('demo readiness execution guard', () => {
    it('requires the explicit disposable-database lifecycle', () => {
      expect(process.env.RLS_DISPOSABLE_DB).toBeUndefined();
    });
  });
} else {
  const { fixtureDb } = await import('./helpers/fixtureDb');
  const { previewAudience } = await import('../lib/campaigns');
  const { previewGrowthSegments } = await import('../modules/growth/metrics');
  const {
    getEffectiveGrowthPolicy, listEffectiveChannelCosts, listEffectiveSegmentDefinitions,
  } = await import('../modules/growth/service');
  const { runInTenantContext, runWithTenantContext } = await import('../lib/tenantContext');
  type AppDb = typeof import('../lib/db').db;

  function seedSynthetic(): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['tsx', 'prisma/seedSynthetic.ts'], {
        stdio: 'inherit',
        env: {
          ...process.env,
          // The seed guard is evaluated exactly as it always is: NODE_ENV=test,
          // a disposable database name, and an explicit confirmation. Both of
          // the latter are supplied by withDisposableRlsDatabase.
          NODE_ENV: 'test',
          SYNTHETIC_PROFILE: 'FUNCTIONAL',
        },
      });
      child.once('error', reject);
      child.once('exit', code => (code === 0 ? resolve() : reject(new Error(`synthetic seed failed (exit ${code ?? 'unknown'})`))));
    });
  }

  let demoTenantId: string;
  let demoActorId: string;

  /**
   * The production reads below are the ones a signed-in OWNER's request would
   * make, and they fail closed without a tenant context. Establishing one here
   * (rather than reading the tables directly) is what makes this suite evidence
   * about the product and not about the fixture.
   */
  function asDemoTenant<T>(fn: () => Promise<T>): Promise<T> {
    return runInTenantContext(
      { tenantId: demoTenantId, actorId: demoActorId, actorRole: 'OWNER', source: 'request' },
      fn,
    );
  }

  beforeAll(async () => {
    await seedSynthetic();
    // "The demo tenant" is defined the same way the provisioning script defines
    // it: the first active tenant the entitlement resolver actually unlocked.
    const unlocked = await fixtureDb.tenantFeatureEntitlement.findMany({
      where: { featureKey: 'campaign_automation', enabled: true },
      select: { tenantId: true },
    });
    const tenant = await fixtureDb.tenant.findFirst({
      where: { status: 'active', id: { in: unlocked.map(row => row.tenantId) } },
      orderBy: { slug: 'asc' },
      select: { id: true },
    });
    if (!tenant) throw new Error('Seed produced no active tenant entitled to campaign_automation');
    demoTenantId = tenant.id;
    const owner = await fixtureDb.user.findFirst({
      where: { tenantId: demoTenantId, role: 'OWNER', active: true },
      orderBy: { email: 'asc' },
      select: { id: true },
    });
    if (!owner) throw new Error('Seed produced no active OWNER for the demo tenant');
    demoActorId = owner.id;
  }, 300_000);

  afterAll(async () => {
    await fixtureDb.$disconnect();
  });

  describe('entitlements resolve from a real subscription', () => {
    it('gives the demo tenant a TenantSubscription against a catalog plan', async () => {
      const subscription = await fixtureDb.tenantSubscription.findUnique({
        where: { tenantId: demoTenantId },
        include: { plan: { select: { key: true } } },
      });
      expect(subscription).not.toBeNull();
      expect(['starter', 'growth', 'command', 'enterprise']).toContain(subscription!.plan.key);
      expect(['TRIAL', 'ACTIVE', 'PAST_DUE']).toContain(subscription!.status);
    });

    it('unlocks campaign_automation and patient_crm, so /v1/crm is not feature_locked', async () => {
      const enabled = await fixtureDb.tenantFeatureEntitlement.findMany({
        where: { tenantId: demoTenantId, enabled: true },
        select: { featureKey: true },
      });
      const keys = enabled.map(row => row.featureKey);
      expect(keys).toContain('campaign_automation');
      expect(keys).toContain('patient_crm');
    });

    it('leaves a plan that does not include a feature genuinely locked', async () => {
      // Entitlements are resolved, not blanket-granted: at least one tenant in
      // the seed is on a plan that really does lock something, so a demo can
      // show the upgrade path honestly.
      const lockedSomewhere = await fixtureDb.tenantFeatureEntitlement.count({ where: { enabled: false } });
      expect(lockedSomewhere).toBeGreaterThan(0);
    });
  });

  describe('CRM pipeline has real leads', () => {
    it('spans multiple stages with recorded transitions', async () => {
      const byStage = await fixtureDb.lead.groupBy({
        by: ['stage'],
        where: { tenantId: demoTenantId, deletedAt: null },
        _count: { _all: true },
      });
      expect(byStage.length).toBeGreaterThanOrEqual(3);
      for (const group of byStage) expect(group._count._all).toBeGreaterThan(0);

      // A stage the lead reached without a recorded transition has no history
      // behind it, and "why are we losing leads?" would have no answer.
      const activities = await fixtureDb.leadActivity.count({
        where: { tenantId: demoTenantId, activityType: 'stage_change' },
      });
      expect(activities).toBeGreaterThan(0);

      const lost = await fixtureDb.lead.findFirst({ where: { tenantId: demoTenantId, stage: 'lost' } });
      expect(lost?.lostReason ?? '').not.toBe('');
    });
  });

  describe('inactive-patient segments have real members', () => {
    it('populates 30-60, 60-90 and 90-180 through the production segment query', async () => {
      const now = new Date();
      const preview = await asDemoTenant(() => runWithTenantContext(demoTenantId, async tx => {
        // The growth reads take the PrismaClient surface; inside a tenant
        // transaction the GUC is set on this same connection, which is what
        // stops the RLS-enrolled GrowthPolicy read from silently returning
        // nothing and falling back to code defaults.
        const client = tx as unknown as AppDb;
        const policy = await getEffectiveGrowthPolicy(demoTenantId, client);
        const definitions = await listEffectiveSegmentDefinitions(demoTenantId, client);
        const costs = await listEffectiveChannelCosts(demoTenantId, client);
        return previewGrowthSegments({ tenantId: demoTenantId, branchId: null }, policy, definitions, costs, now, client);
      }));
      const byKey = new Map(preview.segments.map(segment => [segment.key, segment]));
      for (const key of ['inactive-30-60', 'inactive-60-90', 'inactive-90-180']) {
        expect(byKey.get(key), `segment ${key} is missing`).toBeDefined();
        expect(byKey.get(key)!.patientCount, `segment ${key} has no members`).toBeGreaterThan(0);
      }
      // includeNeverVisited only means something if somebody has never visited.
      expect(byKey.get('inactive-30-60')!.neverVisitedCandidates).toBeGreaterThan(0);
    });
  });

  describe('reviews aggregate honestly', () => {
    it('produces a non-null average rating from real Review rows', async () => {
      const aggregate = await fixtureDb.review.aggregate({
        where: { tenantId: demoTenantId },
        _avg: { rating: true },
        _count: { _all: true },
      });
      expect(aggregate._count._all).toBeGreaterThan(0);
      expect(aggregate._avg.rating).not.toBeNull();
      expect(aggregate._avg.rating!).toBeGreaterThan(1);
      expect(aggregate._avg.rating!).toBeLessThan(5);

      // A mixed book, not a wall of five stars: the negative reviews are what
      // the reputation workflow on the next screen is about.
      const negative = await fixtureDb.review.count({ where: { tenantId: demoTenantId, rating: { lte: 3 } } });
      expect(negative).toBeGreaterThan(0);
    });
  });

  describe('audience preview shows the consent fence working', () => {
    it('returns both genuinely eligible and genuinely suppressed recipients', async () => {
      const preview = await asDemoTenant(() => previewAudience(demoTenantId, 'inactive_patients', 'sms'));
      expect(preview.total).toBeGreaterThan(0);
      expect(preview.eligible).toBeGreaterThan(0);
      expect(preview.suppressed).toBeGreaterThan(0);
      expect(preview.sample.length).toBeGreaterThan(0);
      // The sample carries masked destinations only.
      for (const entry of preview.sample) {
        expect(entry.destinationMasked).toMatch(/\*/);
      }
    });

    it('backs the suppression with readable evidence rather than a flag', async () => {
      const optedOut = await fixtureDb.communicationConsent.count({
        where: { tenantId: demoTenantId, status: 'opted_out' },
      });
      const revoked = await fixtureDb.consentEvent.count({
        where: { tenantId: demoTenantId, granted: false },
      });
      expect(optedOut).toBeGreaterThan(0);
      expect(revoked).toBeGreaterThan(0);
    });
  });

  describe('campaign outcomes are evidence-derived', () => {
    it('rolls booked/revenue up from CampaignAttribution rows', async () => {
      const attributions = await fixtureDb.campaignAttribution.findMany({
        where: { tenantId: demoTenantId },
        select: { campaignId: true, outcomeType: true, attributedValue: true, rule: true },
      });
      expect(attributions.length).toBeGreaterThan(0);
      expect(attributions.every(row => row.rule.length > 0)).toBe(true);

      const booked = attributions.filter(row => row.outcomeType === 'booked').length;
      const revenue = attributions
        .filter(row => row.outcomeType === 'paid')
        .reduce((sum, row) => sum + Number(row.attributedValue), 0);

      const rollup = await fixtureDb.campaign.aggregate({
        where: { tenantId: demoTenantId },
        _sum: { booked: true, revenue: true, opened: true, responded: true },
      });
      expect(rollup._sum.booked).toBe(booked);
      expect(Number(rollup._sum.revenue ?? 0)).toBeCloseTo(revenue, 2);
      // Pinned at zero by construction: this platform has no truthful
      // engagement receipt, so an open rate would be a fabricated number.
      expect(rollup._sum.opened).toBe(0);
      expect(rollup._sum.responded).toBe(0);
    });
  });

  describe('live dispatch stays off', () => {
    it('creates no CampaignLiveDispatchActivation anywhere in the seed', async () => {
      expect(await fixtureDb.campaignLiveDispatchActivation.count()).toBe(0);
    });
  });

  describe('the rest of the Growth module is populated', () => {
    it('has reputation, competitor, autopilot and automation records', async () => {
      const [cases, competitors, insights, playbooks, approvals, rules, requests] = await Promise.all([
        fixtureDb.reputationCase.count({ where: { tenantId: demoTenantId } }),
        fixtureDb.competitor.count({ where: { tenantId: demoTenantId } }),
        fixtureDb.competitorReviewInsight.count({ where: { tenantId: demoTenantId } }),
        fixtureDb.autopilotPlaybook.count({ where: { tenantId: demoTenantId } }),
        fixtureDb.autopilotApproval.count({ where: { tenantId: demoTenantId, status: 'PENDING' } }),
        fixtureDb.automationRule.count({ where: { tenantId: demoTenantId } }),
        fixtureDb.reviewRequest.count({ where: { tenantId: demoTenantId } }),
      ]);
      expect(cases).toBeGreaterThan(0);
      expect(competitors).toBeGreaterThan(0);
      expect(insights).toBeGreaterThan(0);
      expect(playbooks).toBeGreaterThan(0);
      expect(approvals).toBeGreaterThan(0);
      expect(rules).toBeGreaterThan(0);
      expect(requests).toBeGreaterThan(0);
    });

    it('does not claim an automation rule has run when it has not', async () => {
      const ran = await fixtureDb.automationRule.count({
        where: { tenantId: demoTenantId, OR: [{ runCount: { gt: 0 } }, { lastRunAt: { not: null } }] },
      });
      expect(ran).toBe(0);
    });
  });
}
