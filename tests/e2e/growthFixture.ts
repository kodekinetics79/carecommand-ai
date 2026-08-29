import { randomUUID } from 'node:crypto';
import { fixtureDb as db } from '../../server/test/helpers/fixtureDb';
import { generatePasswordHash } from '../../server/lib/security';
import { recomputeEntitlements } from '../../server/lib/entitlements';
import { ensureE2eSubscriptionPlan } from './subscriptionFixture';

// ===========================================================================
// Growth-module browser fixtures.
//
// Same provisioning shape as golden-journey.spec.ts / roleAccounts.ts: a
// throwaway tenant on the enterprise plan (every feature entitled, so nothing
// in the Growth surfaces is hidden behind a plan lock), users created through
// the same password hasher the product uses, and cleanup by deleting the
// tenant (cascades). Only the schema-owner fixture client writes rows; every
// assertion against the running app goes through the real UI + API.
// ===========================================================================

export const GROWTH_PASSWORD = 'E2E-Growth-Pw-123!';

export type GrowthRole = 'OWNER' | 'ADMIN' | 'PROVIDER' | 'FRONT_DESK';

export interface GrowthTenant {
  tenantId: string;
  slug: string;
  branchId: string;
  tag: string;
  /** role -> login email */
  emails: Partial<Record<GrowthRole, string>>;
  dispose(): Promise<void>;
}

export async function createGrowthTenant(
  projectName: string,
  roles: readonly GrowthRole[] = ['OWNER'],
): Promise<GrowthTenant> {
  const tag = `${projectName.replace(/[^a-z0-9]/gi, '').toLowerCase()}-${randomUUID().slice(0, 8)}`;
  const tenantId = randomUUID();
  const slug = `e2e-growth-${tag}`;
  await db.tenant.create({ data: { id: tenantId, name: `E2E Growth ${tag}`, slug } });
  const plan = await ensureE2eSubscriptionPlan();
  await db.tenantSubscription.create({ data: { tenantId, planId: plan.id, status: 'ACTIVE', startedAt: new Date() } });
  await recomputeEntitlements(tenantId, db);
  const branch = await db.branch.create({ data: { tenantId, name: 'Main Clinic', location: 'Growth E2E' } });

  const passwordHash = await generatePasswordHash(GROWTH_PASSWORD);
  const emails: Partial<Record<GrowthRole, string>> = {};
  for (const role of roles) {
    const email = `${role.toLowerCase()}-${tag}@growth-e2e.test`;
    await db.user.create({
      data: {
        tenantId, role, active: true, email,
        displayName: `E2E ${role}`,
        passwordHash, passwordChangedAt: new Date(),
      },
    });
    emails[role] = email;
  }

  return {
    tenantId, slug, branchId: branch.id, tag, emails,
    async dispose() {
      await db.tenant.delete({ where: { id: tenantId } }).catch(() => {});
    },
  };
}

/**
 * The three-person `inactive_patients` audience the campaign journey is built
 * on. All three qualify for the audience (last visit far past the 180-day
 * inactivity window); they differ only in contactability:
 *   - eligible:       has a phone and no suppression -> "Contactable"
 *   - suppressed:     has a phone AND an active CampaignSuppression row for
 *                     the sms channel -> the consent gate must count them
 *   - missingContact: no phone at all -> "No contact" for an sms campaign
 */
export const AUDIENCE_PEOPLE = {
  eligible: { firstName: 'Paula', lastName: 'Reachable', phone: '+15555550111' },
  suppressed: { firstName: 'Sam', lastName: 'OptedOut', phone: '+15555550112' },
  missingContact: { firstName: 'Nora', lastName: 'NoPhone', phone: null },
} as const;

export async function seedInactiveAudience(tenant: GrowthTenant) {
  const lastVisitAt = new Date(Date.now() - 400 * 86400000);
  const ids: Record<keyof typeof AUDIENCE_PEOPLE, string> = { eligible: '', suppressed: '', missingContact: '' };
  for (const [key, person] of Object.entries(AUDIENCE_PEOPLE) as Array<[keyof typeof AUDIENCE_PEOPLE, typeof AUDIENCE_PEOPLE[keyof typeof AUDIENCE_PEOPLE]]>) {
    const patient = await db.patient.create({
      data: {
        tenantId: tenant.tenantId,
        branchId: tenant.branchId,
        firstName: person.firstName,
        lastName: person.lastName,
        email: `${person.firstName.toLowerCase()}-${tenant.tag}@growth-e2e.test`,
        phone: person.phone,
        lifecycleStage: 'ACTIVE',
        lastVisitAt,
      },
    });
    ids[key] = patient.id;
  }
  // The opt-out record. This one row is what must surface as "Suppressed: 1"
  // in the audience preview and in the exact-preview authorization.
  await db.campaignSuppression.create({
    data: {
      tenantId: tenant.tenantId,
      patientId: ids.suppressed,
      channel: 'sms',
      reason: 'Patient opted out of SMS outreach (E2E fixture)',
      active: true,
    },
  });
  return ids;
}

/**
 * A small, fully deterministic CRM pipeline:
 * three open leads (total estimated value $2,600), one retained lead, so the
 * server-computed metrics have exact expected values the spec can assert.
 */
export const CRM_LEADS = [
  { name: 'Liam Newinquiry', stage: 'new-inquiry', estimatedValue: 1200, service: 'Implant consult', source: 'Website' },
  { name: 'Rita Contacted', stage: 'contacted', estimatedValue: 600, service: 'Whitening', source: 'Phone' },
  { name: 'Mona Booker', stage: 'booked', estimatedValue: 800, service: 'Crown', source: 'Referral' },
  { name: 'Vic Retained', stage: 'retained', estimatedValue: 400, service: 'Cleaning', source: 'Website' },
] as const;

export async function seedCrmPipeline(tenant: GrowthTenant) {
  const ids: Record<string, string> = {};
  for (const lead of CRM_LEADS) {
    const row = await db.lead.create({
      data: {
        tenantId: tenant.tenantId,
        name: lead.name,
        stage: lead.stage,
        estimatedValue: lead.estimatedValue,
        service: lead.service,
        source: lead.source,
        channel: 'CALL',
        phone: '+15555550140',
        email: `${lead.name.split(' ')[0].toLowerCase()}-${tenant.tag}@growth-e2e.test`,
      },
    });
    ids[lead.name] = row.id;
  }
  // Two patients so Patient Intelligence has real rows and the server-side
  // search has one clear match and one clear non-match.
  await db.patient.create({
    data: {
      tenantId: tenant.tenantId, branchId: tenant.branchId,
      firstName: 'Avery', lastName: 'Findme',
      email: `avery-${tenant.tag}@growth-e2e.test`, phone: '+15555550151',
      lifecycleStage: 'ACTIVE', lifetimeValue: 250,
    },
  });
  await db.patient.create({
    data: {
      tenantId: tenant.tenantId, branchId: tenant.branchId,
      firstName: 'Blair', lastName: 'Bystander',
      email: `blair-${tenant.tag}@growth-e2e.test`, phone: '+15555550152',
      lifecycleStage: 'ACTIVE', lifetimeValue: 150,
    },
  });
  return ids;
}

export { db as fixtureDb };
