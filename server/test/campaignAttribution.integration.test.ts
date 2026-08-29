import 'dotenv/config';

import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

// Function/DB-level suite (no HTTP app): the properties under test are
// "what did the database let us claim" and "what did the job refuse to claim",
// and both are only meaningful against real Postgres with the real triggers.
const { fixtureDb: db } = await import('./helpers/fixtureDb');
const {
  runCampaignAttribution, attributeTenantCampaignOutcomes,
  selectAttributingDelivery, bookingIsInWindow,
  CAMPAIGN_ATTRIBUTION_WINDOW_DAYS_DEFAULT, CAMPAIGN_ATTRIBUTION_RULES,
} = await import('../lib/campaignAttribution');
const { runWithJobTenantContext } = await import('../lib/tenantContext');

const DAY = 86_400_000;
const T0 = new Date('2026-06-01T09:00:00.000Z');
const NOW = new Date('2026-09-01T09:00:00.000Z');
const tenantIds: string[] = [];

type Fixture = { tenantId: string; branchA: string; branchB: string };

async function makeTenant(windowDays?: number): Promise<Fixture> {
  const tenantId = randomUUID();
  tenantIds.push(tenantId);
  await db.tenant.create({ data: { id: tenantId, name: `attr-${tenantId.slice(0, 6)}`, slug: `attr-${tenantId.slice(0, 8)}` } });
  const [branchA, branchB] = await Promise.all([
    db.branch.create({ data: { tenantId, name: 'Branch A', location: 'A' } }),
    db.branch.create({ data: { tenantId, name: 'Branch B', location: 'B' } }),
  ]);
  if (windowDays !== undefined) {
    await db.growthPolicy.create({ data: { tenantId, campaignAttributionWindowDays: windowDays } });
  }
  return { tenantId, branchA: branchA.id, branchB: branchB.id };
}

async function makePatient(f: Fixture, label: string) {
  return db.patient.create({
    data: { tenantId: f.tenantId, branchId: f.branchA, firstName: label, lastName: 'Patient', lifecycleStage: 'ACTIVE' },
    select: { id: true },
  });
}

async function makeCampaign(f: Fixture, opts: { branchId?: string | null; campaignType?: string; audienceType?: string; name?: string } = {}) {
  return db.campaign.create({
    data: {
      tenantId: f.tenantId,
      name: opts.name ?? 'Reactivation',
      goal: 'inactive_patient_reactivation',
      status: 'ACTIVE',
      channels: [],
      branchId: opts.branchId === undefined ? null : opts.branchId,
      campaignType: opts.campaignType ?? 'inactive_patient_reactivation',
      audienceType: opts.audienceType ?? 'inactive_patients',
      campaignChannel: 'sms',
      requiresApproval: true,
      approvedAt: T0,
      draftSource: 'rule_based',
    },
    select: { id: true },
  });
}

/** A delivery the provider really accepted, at an exact moment. */
async function makeAcceptedDelivery(f: Fixture, campaignId: string, patientId: string, acceptedAt: Date, channel = 'sms') {
  return db.campaignDelivery.create({
    data: {
      tenantId: f.tenantId, campaignId, patientId, channel,
      status: 'accepted', provider: 'twilio',
      sentAt: acceptedAt, providerAcceptedAt: acceptedAt, statusUpdatedAt: acceptedAt,
    },
    select: { id: true },
  });
}

async function makeBooking(f: Fixture, patientId: string, bookedAt: Date, opts: { branchId?: string; status?: string; startsAt?: Date } = {}) {
  const startsAt = opts.startsAt ?? new Date(bookedAt.getTime() + 7 * DAY);
  return db.appointment.create({
    data: {
      tenantId: f.tenantId,
      branchId: opts.branchId ?? f.branchA,
      patientId,
      service: 'Cleaning',
      startsAt,
      endsAt: new Date(startsAt.getTime() + 3_600_000),
      status: (opts.status ?? 'CONFIRMED') as never,
      channel: 'SMS',
      value: 250,
      createdAt: bookedAt,
    },
    select: { id: true },
  });
}

const run = (tenantId: string, now: Date = NOW) => runCampaignAttribution(now, tenantId);

const attributionsFor = (tenantId: string) => db.campaignAttribution.findMany({
  where: { tenantId }, orderBy: [{ outcomeType: 'asc' }, { id: 'asc' }],
});

const campaignRollup = (id: string) => db.campaign.findUniqueOrThrow({
  where: { id }, select: { opened: true, responded: true, booked: true, revenue: true, sent: true },
});

afterAll(async () => {
  for (const tenantId of tenantIds) await db.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
  await db.$disconnect();
});

describe('campaign attribution — a booking inside the window is claimed exactly once', () => {
  it('attributes one booking, and a re-run attributes nothing further', async () => {
    const f = await makeTenant(30);
    const patient = await makePatient(f, 'Inwindow');
    const campaign = await makeCampaign(f);
    const delivery = await makeAcceptedDelivery(f, campaign.id, patient.id, T0);
    const appointment = await makeBooking(f, patient.id, new Date(T0.getTime() + 2 * DAY));

    const first = await run(f.tenantId);
    expect(first.tenantSummaries[0]).toMatchObject({ windowDays: 30, attributableDeliveries: 1, candidateAppointments: 1, unattributedAppointments: 0 });
    expect(first.tenantSummaries[0]!.created).toEqual({ engaged: 0, booked: 1, attended: 0, paid: 0 });

    const rows = await attributionsFor(f.tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      outcomeType: 'booked',
      campaignId: campaign.id,
      campaignDeliveryId: delivery.id,
      patientId: patient.id,
      appointmentId: appointment.id,
      branchId: f.branchA,
      windowDays: 30,
      rule: CAMPAIGN_ATTRIBUTION_RULES.booked,
    });
    // A booking is an outcome, not revenue. This is the whole difference from
    // the vendors who multiply a count by a constant.
    expect(Number(rows[0]!.attributedValue)).toBe(0);
    expect(rows[0]!.evidence).toMatchObject({
      deliveryAcceptedAt: T0.toISOString(),
      appointmentBookedAt: new Date(T0.getTime() + 2 * DAY).toISOString(),
      rule: CAMPAIGN_ATTRIBUTION_RULES.booked,
    });

    // Idempotence: the second pass inserts nothing and changes nothing.
    const second = await run(f.tenantId);
    expect(second.created).toBe(0);
    expect(second.tenantSummaries[0]!.created).toEqual({ engaged: 0, booked: 0, attended: 0, paid: 0 });
    const after = await attributionsFor(f.tenantId);
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(rows[0]!.id);
    expect(after[0]!.attributedAt.toISOString()).toBe(rows[0]!.attributedAt.toISOString());

    const rollup = await campaignRollup(campaign.id);
    expect(rollup.booked).toBe(1);
    expect(Number(rollup.revenue)).toBe(0);
    // Pinned, not merely unwritten: there is no truthful open/reply receipt.
    expect(rollup.opened).toBe(0);
    expect(rollup.responded).toBe(0);
  });
});

describe('campaign attribution — what is deliberately NOT claimed', () => {
  it('does not attribute a booking outside the window, or one that predates the delivery', async () => {
    const f = await makeTenant(30);
    const late = await makePatient(f, 'Late');
    const early = await makePatient(f, 'Early');
    const campaignLate = await makeCampaign(f, { name: 'Late' });
    const campaignEarly = await makeCampaign(f, { name: 'Early' });
    await makeAcceptedDelivery(f, campaignLate.id, late.id, T0);
    await makeAcceptedDelivery(f, campaignEarly.id, early.id, T0);
    // One day past a 30-day window.
    await makeBooking(f, late.id, new Date(T0.getTime() + 31 * DAY));
    // Booked BEFORE the message was accepted: the campaign cannot have caused it.
    await makeBooking(f, early.id, new Date(T0.getTime() - 1 * DAY));

    const summary = await run(f.tenantId);
    expect(summary.created).toBe(0);
    expect(await attributionsFor(f.tenantId)).toHaveLength(0);
    // Neither booking is even a candidate: the job bounds its appointment read
    // to (earliest acceptance, latest acceptance + window], so a booking that
    // could not be attributed to ANY delivery is never loaded in the first
    // place. `unattributedAppointments` counts the ones that were examined and
    // refused, and there are none here.
    expect(summary.tenantSummaries[0]!.candidateAppointments).toBe(0);
    expect(summary.tenantSummaries[0]!.unattributedAppointments).toBe(0);

    // ...and the boundary itself is inclusive at exactly the window edge.
    const edge = await makePatient(f, 'Edge');
    const campaignEdge = await makeCampaign(f, { name: 'Edge' });
    await makeAcceptedDelivery(f, campaignEdge.id, edge.id, T0);
    await makeBooking(f, edge.id, new Date(T0.getTime() + 30 * DAY));
    await run(f.tenantId);
    const rows = await attributionsFor(f.tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.patientId).toBe(edge.id);
  });

  it('never attributes a booking by a patient who was suppressed and never received the message', async () => {
    const f = await makeTenant(30);
    const patient = await makePatient(f, 'Suppressed');
    const campaign = await makeCampaign(f);
    await db.campaignSuppression.create({
      data: { tenantId: f.tenantId, patientId: patient.id, channel: 'sms', reason: 'opted_out', active: true },
    });
    // Exactly what dispatchCampaign writes for a suppressed recipient: no
    // provider acceptance, no delivery timestamp, nothing handed to a provider.
    await db.campaignDelivery.create({
      data: {
        tenantId: f.tenantId, campaignId: campaign.id, patientId: patient.id, channel: 'sms',
        status: 'suppressed', provider: 'twilio', statusUpdatedAt: T0,
      },
    });
    await makeBooking(f, patient.id, new Date(T0.getTime() + 2 * DAY));

    const summary = await run(f.tenantId);
    expect(summary.created).toBe(0);
    expect(summary.tenantSummaries[0]!.attributableDeliveries).toBe(0);
    expect(await attributionsFor(f.tenantId)).toHaveLength(0);
    expect((await campaignRollup(campaign.id)).booked).toBe(0);
  });

  it('ignores a non-accepted delivery state and a status with no acceptance timestamp', async () => {
    const f = await makeTenant(30);
    const campaign = await makeCampaign(f);
    const cases: Array<{ label: string; status: string; accepted: boolean }> = [
      { label: 'Failed', status: 'failed', accepted: false },
      { label: 'Queued', status: 'queued', accepted: false },
      { label: 'Unknown', status: 'delivery_unknown', accepted: false },
      { label: 'Setup', status: 'setup_required', accepted: false },
      // The dangerous one: an "accepted" status column with no truthful
      // acceptance milestone behind it. sentAt alone is explicitly not evidence.
      { label: 'Legacy', status: 'accepted', accepted: false },
    ];
    for (const testCase of cases) {
      const patient = await makePatient(f, testCase.label);
      await db.campaignDelivery.create({
        data: {
          tenantId: f.tenantId, campaignId: campaign.id, patientId: patient.id, channel: testCase.label,
          status: testCase.status, provider: 'twilio', sentAt: T0, statusUpdatedAt: T0,
        },
      });
      await makeBooking(f, patient.id, new Date(T0.getTime() + 2 * DAY));
    }
    const summary = await run(f.tenantId);
    expect(summary.tenantSummaries[0]!.attributableDeliveries).toBe(0);
    expect(await attributionsFor(f.tenantId)).toHaveLength(0);
  });

  it('never writes an `engaged` outcome, because no open or reply receipt is trusted', async () => {
    const f = await makeTenant(30);
    const patient = await makePatient(f, 'Delivered');
    const campaign = await makeCampaign(f);
    await db.campaignDelivery.create({
      data: {
        tenantId: f.tenantId, campaignId: campaign.id, patientId: patient.id, channel: 'sms',
        status: 'delivered', provider: 'twilio', sentAt: T0, providerAcceptedAt: T0, deliveredAt: T0, statusUpdatedAt: T0,
      },
    });
    await makeBooking(f, patient.id, new Date(T0.getTime() + 1 * DAY));
    const summary = await run(f.tenantId);
    expect(summary.tenantSummaries[0]!.created.engaged).toBe(0);
    expect(await db.campaignAttribution.count({ where: { tenantId: f.tenantId, outcomeType: 'engaged' } })).toBe(0);
    expect((await campaignRollup(campaign.id)).opened).toBe(0);
  });
});

describe('campaign attribution — two campaigns cannot both claim one booking', () => {
  it('gives the booking to the LAST accepted delivery before it, and only that one', async () => {
    const f = await makeTenant(30);
    const patient = await makePatient(f, 'Shared');
    const older = await makeCampaign(f, { name: 'Older' });
    const newer = await makeCampaign(f, { name: 'Newer' });
    const olderDelivery = await makeAcceptedDelivery(f, older.id, patient.id, new Date(T0.getTime() - 5 * DAY));
    const newerDelivery = await makeAcceptedDelivery(f, newer.id, patient.id, new Date(T0.getTime() - 1 * DAY));
    const appointment = await makeBooking(f, patient.id, T0);

    await run(f.tenantId);
    const rows = await attributionsFor(f.tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ campaignId: newer.id, campaignDeliveryId: newerDelivery.id, appointmentId: appointment.id });
    expect(rows[0]!.evidence).toMatchObject({
      tieBreak: {
        rule: 'last_accepted_delivery_before_outcome',
        chosenDeliveryId: newerDelivery.id,
        consideredDeliveryIds: [olderDelivery.id, newerDelivery.id].sort(),
      },
    });
    expect((await campaignRollup(older.id)).booked).toBe(0);
    expect((await campaignRollup(newer.id)).booked).toBe(1);
  });

  it('breaks an exact timestamp tie deterministically, and the database refuses the loser', async () => {
    const f = await makeTenant(30);
    const patient = await makePatient(f, 'Tied');
    const one = await makeCampaign(f, { name: 'One' });
    const two = await makeCampaign(f, { name: 'Two' });
    const deliveryOne = await makeAcceptedDelivery(f, one.id, patient.id, T0);
    const deliveryTwo = await makeAcceptedDelivery(f, two.id, patient.id, T0);
    const appointment = await makeBooking(f, patient.id, new Date(T0.getTime() + DAY));

    await run(f.tenantId);
    const rows = await attributionsFor(f.tenantId);
    expect(rows).toHaveLength(1);
    // Documented tie-break: the lexicographically smallest delivery id wins, so
    // a re-run cannot flip the answer.
    const expectedWinner = [deliveryOne.id, deliveryTwo.id].sort()[0]!;
    expect(rows[0]!.campaignDeliveryId).toBe(expectedWinner);

    // The tie-break is a policy; the anti-double-count is a constraint. Even a
    // direct insert of the losing claim is refused by the database.
    const loser = [deliveryOne.id, deliveryTwo.id].sort()[1]!;
    const loserCampaign = loser === deliveryOne.id ? one.id : two.id;
    await expect(db.campaignAttribution.create({
      data: {
        tenantId: f.tenantId, campaignId: loserCampaign, campaignDeliveryId: loser, patientId: patient.id,
        outcomeType: 'booked', appointmentId: appointment.id, windowDays: 30,
        windowStartsAt: T0, windowEndsAt: new Date(T0.getTime() + 30 * DAY),
        rule: 'manual', evidence: {},
      },
    })).rejects.toThrow();
    expect(await attributionsFor(f.tenantId)).toHaveLength(1);
  });

  it('selectAttributingDelivery is a pure, order-independent function', () => {
    const make = (id: string, ms: number) => ({
      id, campaignId: 'c', campaignBranchId: null, patientId: 'p', leadId: null, channel: 'sms',
      acceptedAt: new Date(ms),
    });
    const a = make('aaaa', 1_000);
    const b = make('bbbb', 2_000);
    const c = make('cccc', 2_000);
    expect(selectAttributingDelivery([a, b, c])!.id).toBe('bbbb');
    expect(selectAttributingDelivery([c, b, a])!.id).toBe('bbbb');
    expect(selectAttributingDelivery([])).toBeNull();
    expect(bookingIsInWindow(new Date(0), new Date(0), 30)).toBe(false);
    expect(bookingIsInWindow(new Date(0), new Date(1), 30)).toBe(true);
    expect(bookingIsInWindow(new Date(0), new Date(30 * DAY), 30)).toBe(true);
    expect(bookingIsInWindow(new Date(0), new Date(30 * DAY + 1), 30)).toBe(false);
  });
});

describe('campaign attribution — the window is captured, not re-derived', () => {
  it('records the window in force at attribution time and never rewrites it when policy changes', async () => {
    const f = await makeTenant(7);
    const near = await makePatient(f, 'Near');
    const far = await makePatient(f, 'Far');
    const nearCampaign = await makeCampaign(f, { name: 'Near' });
    const farCampaign = await makeCampaign(f, { name: 'Far' });
    await makeAcceptedDelivery(f, nearCampaign.id, near.id, T0);
    await makeAcceptedDelivery(f, farCampaign.id, far.id, T0);
    await makeBooking(f, near.id, new Date(T0.getTime() + 3 * DAY));
    await makeBooking(f, far.id, new Date(T0.getTime() + 40 * DAY));

    await run(f.tenantId);
    const firstPass = await attributionsFor(f.tenantId);
    expect(firstPass).toHaveLength(1);
    expect(firstPass[0]!.patientId).toBe(near.id);
    expect(firstPass[0]!.windowDays).toBe(7);
    expect(firstPass[0]!.windowStartsAt.toISOString()).toBe(T0.toISOString());
    expect(firstPass[0]!.windowEndsAt.toISOString()).toBe(new Date(T0.getTime() + 7 * DAY).toISOString());
    expect(firstPass[0]!.evidence).toMatchObject({ windowDays: 7 });

    // Widen the policy. This must change what is attributed NEXT and nothing
    // about what was already claimed.
    await db.growthPolicy.update({ where: { tenantId: f.tenantId }, data: { campaignAttributionWindowDays: 60 } });
    await run(f.tenantId);

    const secondPass = await attributionsFor(f.tenantId);
    expect(secondPass).toHaveLength(2);
    const unchanged = secondPass.find(row => row.id === firstPass[0]!.id)!;
    expect(unchanged.windowDays).toBe(7);
    expect(unchanged.windowEndsAt.toISOString()).toBe(new Date(T0.getTime() + 7 * DAY).toISOString());
    expect(unchanged.attributedAt.toISOString()).toBe(firstPass[0]!.attributedAt.toISOString());

    const newlyClaimed = secondPass.find(row => row.id !== firstPass[0]!.id)!;
    expect(newlyClaimed.patientId).toBe(far.id);
    expect(newlyClaimed.windowDays).toBe(60);
    expect(newlyClaimed.windowEndsAt.toISOString()).toBe(new Date(T0.getTime() + 60 * DAY).toISOString());
  });

  it('resolves a tenant with no stored GrowthPolicy to the code default, not to a literal in the job', async () => {
    const f = await makeTenant();
    const patient = await makePatient(f, 'Default');
    const campaign = await makeCampaign(f);
    await makeAcceptedDelivery(f, campaign.id, patient.id, T0);
    await makeBooking(f, patient.id, new Date(T0.getTime() + 29 * DAY));
    const summary = await run(f.tenantId);
    expect(summary.tenantSummaries[0]!.windowDays).toBe(CAMPAIGN_ATTRIBUTION_WINDOW_DAYS_DEFAULT);
    const rows = await attributionsFor(f.tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.windowDays).toBe(CAMPAIGN_ATTRIBUTION_WINDOW_DAYS_DEFAULT);
  });
});

describe('campaign attribution — money is money, and only money', () => {
  it('attributes the payment actually recorded, nets refunds, and claims nothing when nothing was paid', async () => {
    const f = await makeTenant(30);
    const paid = await makePatient(f, 'Paid');
    const unpaid = await makePatient(f, 'Unpaid');
    const refunded = await makePatient(f, 'Refunded');
    const paidCampaign = await makeCampaign(f, { name: 'Paid' });
    const unpaidCampaign = await makeCampaign(f, { name: 'Unpaid' });
    const refundedCampaign = await makeCampaign(f, { name: 'Refunded' });
    await makeAcceptedDelivery(f, paidCampaign.id, paid.id, T0);
    await makeAcceptedDelivery(f, unpaidCampaign.id, unpaid.id, T0);
    await makeAcceptedDelivery(f, refundedCampaign.id, refunded.id, T0);
    const paidAppointment = await makeBooking(f, paid.id, new Date(T0.getTime() + DAY), { status: 'COMPLETED' });
    await makeBooking(f, unpaid.id, new Date(T0.getTime() + DAY), { status: 'COMPLETED' });
    const refundedAppointment = await makeBooking(f, refunded.id, new Date(T0.getTime() + DAY), { status: 'COMPLETED' });

    const payment = await db.paymentTransaction.create({
      data: {
        tenantId: f.tenantId, branchId: f.branchA, patientId: paid.id, appointmentId: paidAppointment.id,
        amount: 180.5, currency: 'USD', status: 'succeeded', mode: 'test', receivedAt: new Date(T0.getTime() + 8 * DAY),
      },
      select: { id: true },
    });
    await db.paymentTransaction.create({
      data: {
        tenantId: f.tenantId, branchId: f.branchA, patientId: refunded.id, appointmentId: refundedAppointment.id,
        amount: 120, currency: 'USD', status: 'succeeded', mode: 'test', receivedAt: new Date(T0.getTime() + 8 * DAY),
      },
    });
    await db.paymentTransaction.create({
      data: {
        tenantId: f.tenantId, branchId: f.branchA, patientId: refunded.id, appointmentId: refundedAppointment.id,
        amount: 120, currency: 'USD', status: 'refunded', mode: 'test', receivedAt: new Date(T0.getTime() + 9 * DAY),
      },
    });

    await run(f.tenantId);

    const paidRows = await db.campaignAttribution.findMany({ where: { tenantId: f.tenantId, outcomeType: 'paid' } });
    expect(paidRows).toHaveLength(1);
    expect(paidRows[0]).toMatchObject({
      campaignId: paidCampaign.id,
      appointmentId: paidAppointment.id,
      paymentTransactionId: payment.id,
      currency: 'USD',
      rule: CAMPAIGN_ATTRIBUTION_RULES.paid,
    });
    expect(Number(paidRows[0]!.attributedValue)).toBe(180.5);
    expect(paidRows[0]!.evidence).toMatchObject({
      succeededPaymentTransactionIds: [payment.id],
      refundedPaymentTransactionIds: [],
      netAttributed: '180.50',
    });

    // Attendance is an outcome, not revenue: it is recorded and it is worth 0.
    const attended = await db.campaignAttribution.findMany({ where: { tenantId: f.tenantId, outcomeType: 'attended' } });
    expect(attended).toHaveLength(3);
    expect(attended.every(row => Number(row.attributedValue) === 0)).toBe(true);

    // Rollups: only the campaign whose patient actually paid carries money, and
    // a fully-refunded appointment carries none at all.
    expect(Number((await campaignRollup(paidCampaign.id)).revenue)).toBe(180.5);
    expect(Number((await campaignRollup(unpaidCampaign.id)).revenue)).toBe(0);
    expect(Number((await campaignRollup(refundedCampaign.id)).revenue)).toBe(0);
    expect((await campaignRollup(unpaidCampaign.id)).booked).toBe(1);
  });
});

describe('campaign attribution — tenant and branch isolation', () => {
  it('never crosses tenants, and the database refuses a cross-tenant attribution outright', async () => {
    const a = await makeTenant(30);
    const b = await makeTenant(30);
    const patientA = await makePatient(a, 'A');
    const patientB = await makePatient(b, 'B');
    const campaignA = await makeCampaign(a, { name: 'A' });
    const campaignB = await makeCampaign(b, { name: 'B' });
    const deliveryA = await makeAcceptedDelivery(a, campaignA.id, patientA.id, T0);
    await makeAcceptedDelivery(b, campaignB.id, patientB.id, T0);
    await makeBooking(a, patientA.id, new Date(T0.getTime() + DAY));
    await makeBooking(b, patientB.id, new Date(T0.getTime() + DAY));

    await run(a.tenantId);
    expect(await db.campaignAttribution.count({ where: { tenantId: a.tenantId } })).toBe(1);
    expect(await db.campaignAttribution.count({ where: { tenantId: b.tenantId } })).toBe(0);

    // Tenant B's campaign can never be credited with tenant A's delivery.
    await expect(db.campaignAttribution.create({
      data: {
        tenantId: b.tenantId, campaignId: campaignB.id, campaignDeliveryId: deliveryA.id,
        outcomeType: 'booked', windowDays: 30, windowStartsAt: T0, windowEndsAt: new Date(T0.getTime() + 30 * DAY),
        rule: 'manual', evidence: {},
      },
    })).rejects.toThrow();

    // ...and neither can a campaign that is not the one the delivery belongs to.
    const otherA = await makeCampaign(a, { name: 'Other A' });
    await expect(db.campaignAttribution.create({
      data: {
        tenantId: a.tenantId, campaignId: otherA.id, campaignDeliveryId: deliveryA.id,
        outcomeType: 'attended', windowDays: 30, windowStartsAt: T0, windowEndsAt: new Date(T0.getTime() + 30 * DAY),
        rule: 'manual', evidence: {},
      },
    })).rejects.toThrow(/not the campaign its delivery belongs to/);
  });

  it('never lets a branch-scoped campaign claim another branch\'s outcome', async () => {
    const f = await makeTenant(30);
    const patient = await makePatient(f, 'Branched');
    const scoped = await makeCampaign(f, { branchId: f.branchA, name: 'Branch A only' });
    await makeAcceptedDelivery(f, scoped.id, patient.id, T0);
    // The booking happened at the OTHER branch.
    await makeBooking(f, patient.id, new Date(T0.getTime() + DAY), { branchId: f.branchB });

    const summary = await run(f.tenantId);
    expect(summary.created).toBe(0);
    expect(summary.tenantSummaries[0]!.unattributedAppointments).toBe(1);

    // The same campaign does claim its own branch's booking.
    await makeBooking(f, patient.id, new Date(T0.getTime() + 2 * DAY), { branchId: f.branchA });
    await run(f.tenantId);
    const rows = await attributionsFor(f.tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.branchId).toBe(f.branchA);
  });

  it('runs under a real tenant context, so a missing context fails closed at RLS', async () => {
    const f = await makeTenant(30);
    const patient = await makePatient(f, 'Contexted');
    const campaign = await makeCampaign(f);
    await makeAcceptedDelivery(f, campaign.id, patient.id, T0);
    await makeBooking(f, patient.id, new Date(T0.getTime() + DAY));

    // Same work, driven through the worker's own context helper.
    const summary = await runWithJobTenantContext(
      f.tenantId,
      () => attributeTenantCampaignOutcomes(f.tenantId, NOW),
      'worker:campaign-attribution',
    );
    expect(summary.created.booked).toBe(1);

    // Without a tenant context the runtime role sees nothing at all: no
    // deliveries, therefore no attribution, therefore no cross-tenant leak.
    const { db: runtimeDb } = await import('../lib/db');
    await expect(attributeTenantCampaignOutcomes(f.tenantId, NOW, runtimeDb))
      .resolves.toMatchObject({ attributableDeliveries: 0, created: { booked: 0 } });
  });
});

describe('campaign attribution — the deprecated columns cannot be hand-set', () => {
  it('refuses any caller-supplied value and re-derives on every ordinary write', async () => {
    const f = await makeTenant(30);
    const patient = await makePatient(f, 'Rollup');
    const campaign = await makeCampaign(f);
    await makeAcceptedDelivery(f, campaign.id, patient.id, T0);
    await makeBooking(f, patient.id, new Date(T0.getTime() + DAY));
    await run(f.tenantId);
    expect((await campaignRollup(campaign.id)).booked).toBe(1);

    // A route, a script or a human — through the ORM or through raw SQL as the
    // schema OWNER — is refused identically. There is no flag that turns this
    // off, because the only value accepted is the value the evidence produces.
    await expect(db.campaign.update({ where: { id: campaign.id }, data: { revenue: 15_000 } }))
      .rejects.toThrow(/cannot be set by a caller/);
    await expect(db.campaign.update({ where: { id: campaign.id }, data: { booked: 42 } }))
      .rejects.toThrow(/cannot be set by a caller/);
    await expect(db.campaign.update({ where: { id: campaign.id }, data: { opened: 120 } }))
      .rejects.toThrow(/cannot be set by a caller/);
    await expect(db.$executeRawUnsafe(`UPDATE "Campaign" SET "revenue" = 15000 WHERE id = '${campaign.id}'`))
      .rejects.toThrow(/cannot be set by a caller/);
    await expect(db.campaign.create({
      data: {
        tenantId: f.tenantId, name: 'Prefilled', goal: 'x', channels: [],
        campaignType: 'custom', booked: 9, revenue: 1234,
      },
    })).rejects.toThrow(/cannot be set by a caller/);

    // An ordinary write is untouched and silently re-derives, so no campaign row
    // can carry a stale figure.
    await db.campaign.update({ where: { id: campaign.id }, data: { status: 'COMPLETED' } });
    expect(await campaignRollup(campaign.id)).toMatchObject({ opened: 0, responded: 0, booked: 1 });

    // Removing the evidence removes the number, in the same transaction.
    await db.campaignAttribution.deleteMany({ where: { tenantId: f.tenantId } });
    expect((await campaignRollup(campaign.id)).booked).toBe(0);
  });

  it('has no Prisma write anywhere that names one of the four columns', () => {
    // Belt to the trigger's braces: the database refuses the write, and this
    // pins that no code even tries. Every `campaign.create/update/updateMany/
    // upsert` call site is read and its argument object checked for the four
    // names, so a future edit that reintroduces the defect fails here first,
    // with a message that says which call site did it.
    const sources = [
      'server/lib/campaignDispatch.ts',
      'server/lib/campaignAttribution.ts',
      'server/lib/campaignIntegrity.ts',
      'server/modules/campaigns/routes.ts',
      'server/modules/campaigns/jobs.ts',
      'server/modules/operations/routes.ts',
    ];
    const root = new URL('../../', import.meta.url).pathname;
    const callSite = /\bcampaign\.(create|update|updateMany|upsert|createMany)\(/g;
    for (const source of sources) {
      const text = readFileSync(`${root}${source}`, 'utf8');
      for (const match of text.matchAll(callSite)) {
        const argument = text.slice(match.index!, match.index! + 600);
        for (const column of ['opened', 'responded', 'booked', 'revenue']) {
          expect(argument, `${source} writes Campaign.${column} at offset ${match.index}`)
            .not.toMatch(new RegExp(`\\b${column}\\s*:`));
        }
      }
    }
  });
});
