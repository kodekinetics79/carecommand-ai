import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../workers/queues', () => ({
  redisConnection: {},
  autopilotQueue: { client: Promise.resolve(undefined), add: async () => undefined },
  enqueueAutopilotExecution: async () => undefined,
  complianceQueue: { add: async () => undefined },
  registerComplianceSchedules: async () => undefined,
  campaignQueue: { add: async () => undefined },
  registerCampaignSchedules: async () => undefined,
}));

const { buildApp } = await import('../app');
const { fixtureDb: db } = await import('./helpers/fixtureDb');
const { runCampaignAttribution } = await import('../lib/campaignAttribution');

// ===========================================================================
// The attribution read surface. Two properties are under test:
//   1. every number it returns is derived from CampaignAttribution rows the
//      caller can also fetch and read, never from Campaign.revenue/booked;
//   2. it obeys the class-scoped campaign authority that landed with
//      CAMPAIGN_CLASS_AUTHORITY — a billing-only role sees payment-class
//      campaigns and is not even told that a marketing campaign exists.
// ===========================================================================

type Role = 'OWNER' | 'BILLING' | 'ANALYST' | 'AUDITOR' | 'MANAGER';

const DAY = 86_400_000;
const T0 = new Date('2026-06-01T09:00:00.000Z');
const NOW = new Date('2026-09-01T09:00:00.000Z');

let app: FastifyInstance;
const tenantIds: string[] = [];

type Fixture = {
  tenantId: string;
  branchA: string;
  branchB: string;
  users: Record<Role, string>;
  marketingCampaignId: string;
  paymentCampaignId: string;
  branchBCampaignId: string;
  paidAmount: number;
  // Branch restriction is a property of the USER record (request.auth.branchId
  // is read from the stored user, not from the token), so a restricted caller
  // needs its own user rather than an extra JWT claim.
  branchAManagerUserId: string;
  branchBManagerUserId: string;
};

function headers(f: Fixture, role: Role) {
  return { authorization: `Bearer ${app.jwt.sign({ userId: f.users[role], tenantId: f.tenantId, role, type: 'access' })}` };
}

function headersForUser(f: Fixture, userId: string, role: Role = 'MANAGER') {
  return { authorization: `Bearer ${app.jwt.sign({ userId, tenantId: f.tenantId, role, type: 'access' })}` };
}

async function seed(): Promise<Fixture> {
  const tenantId = randomUUID();
  tenantIds.push(tenantId);
  await db.tenant.create({ data: { id: tenantId, name: `attr-api-${tenantId.slice(0, 6)}`, slug: `attr-api-${tenantId.slice(0, 8)}` } });
  for (const featureKey of ['campaign_automation', 'patient_crm', 'payments_deposits']) {
    await db.tenantFeatureEntitlement.create({ data: { tenantId, featureKey, enabled: true, source: 'test' } });
  }
  const [branchA, branchB] = await Promise.all([
    db.branch.create({ data: { tenantId, name: 'Branch A', location: 'A' } }),
    db.branch.create({ data: { tenantId, name: 'Branch B', location: 'B' } }),
  ]);
  const users = {} as Record<Role, string>;
  for (const role of ['OWNER', 'BILLING', 'ANALYST', 'AUDITOR', 'MANAGER'] as Role[]) {
    const user = await db.user.create({
      data: { tenantId, role, active: true, email: `${role}-${tenantId.slice(0, 8)}@attr.test`, displayName: role },
    });
    users[role] = user.id;
  }
  const [branchAManager, branchBManager] = await Promise.all([
    db.user.create({ data: { tenantId, role: 'MANAGER', active: true, branchId: branchA.id, email: `mgr-a-${tenantId.slice(0, 8)}@attr.test`, displayName: 'Manager A' } }),
    db.user.create({ data: { tenantId, role: 'MANAGER', active: true, branchId: branchB.id, email: `mgr-b-${tenantId.slice(0, 8)}@attr.test`, displayName: 'Manager B' } }),
  ]);
  await db.growthPolicy.create({ data: { tenantId, campaignAttributionWindowDays: 30 } });

  const makeCampaign = (name: string, campaignType: string, audienceType: string, branchId: string | null) =>
    db.campaign.create({
      data: {
        tenantId, name, goal: name, status: 'ACTIVE', channels: [], branchId,
        campaignType, audienceType, campaignChannel: 'sms', requiresApproval: true, approvedAt: T0,
      },
      select: { id: true },
    });

  const marketing = await makeCampaign('Reactivation', 'inactive_patient_reactivation', 'inactive_patients', null);
  const payment = await makeCampaign('Failed payment recovery', 'failed_payment_recovery', 'failed_payment_recovery', null);
  const branchScoped = await makeCampaign('Branch B only', 'inactive_patient_reactivation', 'inactive_patients', branchB.id);

  const patient = async (label: string, branchId: string) => db.patient.create({
    data: { tenantId, branchId, firstName: label, lastName: 'Patient', lifecycleStage: 'ACTIVE' },
    select: { id: true },
  });
  const marketingPatient = await patient('Marketing', branchA.id);
  const paymentPatient = await patient('Payment', branchA.id);
  const branchBPatient = await patient('BranchB', branchB.id);

  const delivery = (campaignId: string, patientId: string) => db.campaignDelivery.create({
    data: {
      tenantId, campaignId, patientId, channel: 'sms', status: 'accepted', provider: 'twilio',
      sentAt: T0, providerAcceptedAt: T0, statusUpdatedAt: T0,
    },
  });
  await delivery(marketing.id, marketingPatient.id);
  await delivery(payment.id, paymentPatient.id);
  await delivery(branchScoped.id, branchBPatient.id);

  const booking = (patientId: string, branchId: string) => db.appointment.create({
    data: {
      tenantId, branchId, patientId, service: 'Cleaning',
      startsAt: new Date(T0.getTime() + 10 * DAY), endsAt: new Date(T0.getTime() + 10 * DAY + 3_600_000),
      status: 'COMPLETED', channel: 'SMS', value: 400, createdAt: new Date(T0.getTime() + 2 * DAY),
    },
    select: { id: true },
  });
  await booking(marketingPatient.id, branchA.id);
  const paymentAppointment = await booking(paymentPatient.id, branchA.id);
  await booking(branchBPatient.id, branchB.id);

  const paidAmount = 275.25;
  await db.paymentTransaction.create({
    data: {
      tenantId, branchId: branchA.id, patientId: paymentPatient.id, appointmentId: paymentAppointment.id,
      amount: paidAmount, currency: 'USD', status: 'succeeded', mode: 'test', receivedAt: new Date(T0.getTime() + 12 * DAY),
    },
  });

  await runCampaignAttribution(NOW, tenantId);

  return {
    tenantId, branchA: branchA.id, branchB: branchB.id, users,
    marketingCampaignId: marketing.id, paymentCampaignId: payment.id, branchBCampaignId: branchScoped.id,
    paidAmount,
    branchAManagerUserId: branchAManager.id,
    branchBManagerUserId: branchBManager.id,
  };
}

let f: Fixture;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  f = await seed();
}, 60_000);

afterAll(async () => {
  await app.close();
  for (const tenantId of tenantIds) await db.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
  await db.$disconnect();
});

describe('GET /v1/crm/attribution/summary', () => {
  it('derives every figure from CampaignAttribution rows, and says so', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/crm/attribution/summary', headers: headers(f, 'OWNER') });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const payment = body.campaigns.find((c: { campaignId: string }) => c.campaignId === f.paymentCampaignId);
    const marketing = body.campaigns.find((c: { campaignId: string }) => c.campaignId === f.marketingCampaignId);

    expect(payment.outcomes).toEqual({ engaged: 0, booked: 1, attended: 1, paid: 1 });
    expect(payment.attributedValue).toBe(f.paidAmount.toFixed(2));
    expect(payment.currency).toBe('USD');
    expect(payment.windowDaysObserved).toEqual([30]);

    // The booked campaign whose patient never paid reports the booking and NO
    // money. This is the whole point: no per-event constant is imputed, so a
    // booking without a payment is worth exactly zero.
    expect(marketing.outcomes).toEqual({ engaged: 0, booked: 1, attended: 1, paid: 0 });
    expect(marketing.attributedValue).toBe('0.00');

    // Engagement is reported as unavailable with a reason, never as 0%.
    expect(payment.engagement).toEqual({ openRate: null, responseRate: null, unavailableReason: 'no_truthful_open_or_reply_receipt' });

    // The basis travels with the numbers.
    expect(body.basis.derivedFrom).toBe('CampaignAttribution rows only');
    expect(body.basis.evidenceableOutcomes).toEqual(['booked', 'attended', 'paid']);
    expect(body.basis.windowSource).toMatch(/captured on each row at attribution time/);
  });

  it('narrows the list to the classes a billing-only grant actually covers', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/crm/attribution/summary', headers: headers(f, 'BILLING') });
    expect(res.statusCode).toBe(200);
    const ids = res.json().campaigns.map((c: { campaignId: string }) => c.campaignId);
    // BILLING holds campaign:payment-followup:manage and neither campaign:read
    // nor campaign:manage, so the marketing campaigns are not merely
    // unreadable — their existence is not disclosed.
    expect(ids).toEqual([f.paymentCampaignId]);
  });

  it('gives a campaign:read holder every class, and a caller with no campaign grant nothing at all', async () => {
    const analyst = await app.inject({ method: 'GET', url: '/v1/crm/attribution/summary', headers: headers(f, 'ANALYST') });
    expect(analyst.statusCode).toBe(200);
    expect(analyst.json().campaigns.map((c: { campaignId: string }) => c.campaignId).sort())
      .toEqual([f.branchBCampaignId, f.marketingCampaignId, f.paymentCampaignId].sort());

    const auditor = await app.inject({ method: 'GET', url: '/v1/crm/attribution/summary', headers: headers(f, 'AUDITOR') });
    expect(auditor.statusCode).toBe(403);
  });

  it('keeps a branch-restricted caller inside their own branch', async () => {
    const res = await app.inject({
      method: 'GET', url: '/v1/crm/attribution/summary', headers: headersForUser(f, f.branchBManagerUserId),
    });
    expect(res.statusCode).toBe(200);
    // branchScope(): exact branch match, so a tenant-wide (NULL-branch) campaign
    // is out of scope for a branch-restricted caller, exactly as the campaign
    // list itself behaves.
    expect(res.json().campaigns.map((c: { campaignId: string }) => c.campaignId)).toEqual([f.branchBCampaignId]);
  });
});

describe('GET /v1/crm/campaigns/:id/attribution', () => {
  it('returns the evidence behind every number, with the window as recorded', async () => {
    const res = await app.inject({
      method: 'GET', url: `/v1/crm/campaigns/${f.paymentCampaignId}/attribution`, headers: headers(f, 'OWNER'),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.outcomes).toEqual({ engaged: 0, booked: 1, attended: 1, paid: 1 });
    expect(body.attributions).toHaveLength(3);

    const paid = body.attributions.find((row: { outcomeType: string }) => row.outcomeType === 'paid');
    expect(paid.attributedValue).toBe(f.paidAmount.toFixed(2));
    expect(paid.paymentTransactionId).toBeTruthy();
    expect(paid.appointmentId).toBeTruthy();
    expect(paid.rule).toBe('net-payment-on-attributed-appointment@v1');
    expect(paid.window).toMatchObject({ days: 30, recordedAtAttributionTime: true });
    expect(paid.window.startsAt).toBe(T0.toISOString());
    expect(paid.window.endsAt).toBe(new Date(T0.getTime() + 30 * DAY).toISOString());
    expect(paid.evidence).toMatchObject({
      deliveryAcceptedAt: T0.toISOString(),
      appointmentBookedAt: new Date(T0.getTime() + 2 * DAY).toISOString(),
      valueBasis: 'net of recorded PaymentTransactions on the attributed appointment (succeeded minus refunded)',
    });

    // The summed value on the summary is exactly the sum of the paid rows the
    // same response hands back — the number cannot drift from its evidence.
    const summed = body.attributions
      .filter((row: { outcomeType: string }) => row.outcomeType === 'paid')
      .reduce((sum: number, row: { attributedValue: string }) => sum + Number(row.attributedValue), 0);
    expect(body.attributedValue).toBe(summed.toFixed(2));

    // Every booking/attendance row is explicitly worth nothing.
    for (const row of body.attributions.filter((r: { outcomeType: string }) => r.outcomeType !== 'paid')) {
      expect(row.attributedValue).toBe('0.00');
    }
  });

  it('applies the per-class authority to one campaign, and hides one out of branch scope', async () => {
    const paymentClass = await app.inject({
      method: 'GET', url: `/v1/crm/campaigns/${f.paymentCampaignId}/attribution`, headers: headers(f, 'BILLING'),
    });
    expect(paymentClass.statusCode).toBe(200);

    const marketingClass = await app.inject({
      method: 'GET', url: `/v1/crm/campaigns/${f.marketingCampaignId}/attribution`, headers: headers(f, 'BILLING'),
    });
    expect(marketingClass.statusCode).toBe(403);
    expect(marketingClass.json().error).toBe('insufficient_permission');

    const outOfBranch = await app.inject({
      method: 'GET', url: `/v1/crm/campaigns/${f.branchBCampaignId}/attribution`, headers: headersForUser(f, f.branchAManagerUserId),
    });
    expect(outOfBranch.statusCode).toBe(404);

    const noGrant = await app.inject({
      method: 'GET', url: `/v1/crm/campaigns/${f.paymentCampaignId}/attribution`, headers: headers(f, 'AUDITOR'),
    });
    expect(noGrant.statusCode).toBe(403);
  });
});
