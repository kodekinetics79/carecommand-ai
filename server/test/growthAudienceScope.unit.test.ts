import { describe, expect, it, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { STAGES } from '../../src/lib/crmService';

// Every audience source reads an RLS-enrolled table through a tenant
// transaction. Recording the exact `where` each source builds is the only way
// to prove branch isolation without a database, so the tenant transaction and
// the Prisma client are both replaced by recorders here.
type Where = Record<string, unknown>;
const captured: Array<{ model: string; where: Where }> = [];

function recorder(model: string) {
  return {
    findMany: async (args: { where: Where }) => { captured.push({ model, where: args.where }); return []; },
    count: async (args: { where: Where }) => { captured.push({ model, where: args.where }); return 0; },
  };
}

const tx = {
  patient: recorder('patient'),
  appointment: recorder('appointment'),
  depositRequirement: recorder('depositRequirement'),
  paymentRequest: recorder('paymentRequest'),
  eligibilityVerification: recorder('eligibilityVerification'),
  appointmentRequest: recorder('appointmentRequest'),
  consentEvent: recorder('consentEvent'),
  communicationConsent: recorder('communicationConsent'),
  campaignSuppression: recorder('campaignSuppression'),
};

vi.mock('../lib/tenantContext', () => ({
  runWithTenantContext: async (_tenantId: string, fn: (client: unknown) => Promise<unknown>) => fn(tx),
}));

vi.mock('../lib/db', () => ({
  db: {
    branch: recorder('branch'),
    appointment: recorder('appointment'),
    receptionistOptOut: recorder('receptionistOptOut'),
  },
}));

const { AUDIENCE_TYPES, LEAD_STAGES, buildAudience, previewAudience, countOpenSlots } = await import('../lib/campaigns');

const BRANCH = '11111111-1111-4111-8111-111111111111';
const TENANT = '22222222-2222-4222-8222-222222222222';

beforeEach(() => { captured.length = 0; });

describe('campaign audience branch isolation', () => {
  it.each(AUDIENCE_TYPES)('scopes the %s audience source to the caller branch', async audienceType => {
    await buildAudience(TENANT, audienceType, { branchId: BRANCH });
    expect(captured.length, audienceType).toBeGreaterThan(0);
    for (const query of captured) {
      expect(query.where, `${audienceType} -> ${query.model}`).toMatchObject({ tenantId: TENANT, branchId: BRANCH });
    }
  });

  it.each(AUDIENCE_TYPES)('leaves the %s audience tenant-wide for an unscoped caller', async audienceType => {
    await buildAudience(TENANT, audienceType);
    for (const query of captured) {
      expect(query.where, `${audienceType} -> ${query.model}`).toMatchObject({ tenantId: TENANT });
      expect(query.where, `${audienceType} -> ${query.model}`).not.toHaveProperty('branchId');
    }
  });

  it('forwards the caller branch from previewAudience into the audience query', async () => {
    const preview = await previewAudience(TENANT, 'inactive_patients', 'sms', { branchId: BRANCH });
    expect(captured[0].where).toMatchObject({ tenantId: TENANT, branchId: BRANCH });
    // No candidates survive the branch filter here, so nothing may be sampled.
    expect(preview).toMatchObject({ total: 0, eligible: 0, sample: [] });
  });

  it('never reports another branch capacity to a branch-scoped caller', async () => {
    await countOpenSlots(TENANT, 7, { branchId: BRANCH });
    const branchQuery = captured.find(q => q.model === 'branch');
    const apptQuery = captured.find(q => q.model === 'appointment');
    expect(branchQuery?.where).toMatchObject({ tenantId: TENANT, id: BRANCH, active: true });
    expect(apptQuery?.where).toMatchObject({ tenantId: TENANT, branchId: BRANCH });
  });
});

describe('canonical Lead.stage vocabulary', () => {
  // Lead.stage is a free `String` column, so the API boundary is the only place
  // the vocabulary can be enforced.
  const stageSchema = z.enum(LEAD_STAGES);

  it('accepts exactly the seven canonical stages', () => {
    expect([...LEAD_STAGES]).toEqual(['new-inquiry', 'contacted', 'booked', 'visited', 'follow-up', 'retained', 'lost']);
    for (const stage of LEAD_STAGES) expect(stageSchema.safeParse(stage).success, stage).toBe(true);
  });

  it('rejects out-of-vocabulary stages instead of persisting a free string', () => {
    for (const bad of ['new', 'qualified', 'NEW-INQUIRY', 'won', '', 'follow up']) {
      expect(stageSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('does not drift from the client stage contract', () => {
    expect([...LEAD_STAGES]).toEqual(STAGES);
  });
});
