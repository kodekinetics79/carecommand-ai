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

/**
 * Can a clinic SEE that a patient confirmed?
 *
 * Two reads answer that, and both are pinned here: the appointment list the
 * schedule is drawn from, and
 * GET /v1/receptionist/outbound-campaigns/:id/confirmations.
 *
 * The question a reminder campaign exists to answer — did the patients say
 * they are coming? — and the one the product could not answer at all: the
 * confirmation lives in `Appointment.patientConfirmedAt` (deliberately not a
 * status, because `status` defaults to CONFIRMED at creation and already means
 * "the clinic booked this"), and nothing read it.
 *
 * The assertions that matter here are the ones about ATTRIBUTION. A patient who
 * confirmed at the front desk did not confirm because of the campaign, and a
 * panel that counted them as the campaign's work would be selling the clinic a
 * result it did not get.
 */

let app: FastifyInstance;
const tenantIds: string[] = [];

function phoneFor(seed: string, suffix: number): string {
  const digits = BigInt(`0x${seed.replaceAll('-', '').slice(0, 14)}`) % 9_000_000_000n;
  return `+1${(digits + 1_000_000_000n + BigInt(suffix)).toString().slice(-10)}`;
}

async function makeTenant() {
  const id = randomUUID();
  tenantIds.push(id);
  await db.tenant.create({ data: { id, name: `Confirmations ${id.slice(0, 6)}`, slug: `confirmations-${id.slice(0, 8)}` } });
  await db.tenantFeatureEntitlement.create({ data: { tenantId: id, featureKey: 'ai_receptionist', enabled: true, source: 'test' } });
  const branch = await db.branch.create({ data: { tenantId: id, name: 'Main', location: 'New York', timezone: 'America/New_York' } });
  const owner = await db.user.create({
    data: { tenantId: id, role: 'OWNER', active: true, branchId: branch.id, email: `owner-${id.slice(0, 8)}@confirm.test`, displayName: 'Owner' },
  });
  // PROVIDER deliberately: the one clinical role that holds no
  // receptionist:call-artifacts:read grant (server/lib/permissions.ts).
  const provider = await db.user.create({
    data: { tenantId: id, role: 'PROVIDER', active: true, branchId: branch.id, email: `provider-${id.slice(0, 8)}@confirm.test`, displayName: 'Provider' },
  });
  const clinic = await db.receptionistClinic.create({
    data: { tenantId: id, name: 'Main clinic', phone: phoneFor(id, 0), timezone: 'America/New_York', country: 'US', defaultLanguage: 'en-US' },
  });
  return { id, branchId: branch.id, ownerId: owner.id, providerId: provider.id, clinicId: clinic.id };
}

type TenantFixture = Awaited<ReturnType<typeof makeTenant>>;

function auth(tenant: TenantFixture, role: 'OWNER' | 'PROVIDER' = 'OWNER') {
  const userId = role === 'OWNER' ? tenant.ownerId : tenant.providerId;
  return { authorization: `Bearer ${app.jwt.sign({ userId, tenantId: tenant.id, role, type: 'access' })}` };
}

async function makeCampaign(tenant: TenantFixture, name = 'Reminder') {
  return db.receptionistOutboundCampaign.create({
    data: {
      tenantId: tenant.id, clinicId: tenant.clinicId, name, script: 'Are you still able to come?',
      requiredFields: ['firstName'], purpose: 'APPOINTMENT_REMINDER', legalBasis: 'TREATMENT_OPERATIONS',
      policyVersion: 'CONFIRM-TEST-1', status: 'RUNNING',
      // ReceptionistOutboundCampaign_runnable_authority_check: a SCHEDULED or
      // RUNNING campaign must carry its recorded approval authority.
      authorityApprovedAt: new Date(), authorityApprovedById: tenant.ownerId, authorityFingerprint: 'f'.repeat(64),
    },
  });
}

let patientSeq = 0;

/** A booked appointment and the campaign target that is calling about it. */
async function makeTargetForAppointment(tenant: TenantFixture, campaignId: string, options: {
  confirmedAt?: Date;
  confirmationSource?: 'receptionist_call' | 'staff' | 'patient_portal';
  confirmedCallLogId?: string | null;
  appointmentDeletedAt?: Date;
} = {}) {
  const suffix = ++patientSeq;
  const patient = await db.patient.create({
    data: { tenantId: tenant.id, branchId: tenant.branchId, firstName: `Patient${suffix}`, lastName: 'Reminder', phone: phoneFor(tenant.id, suffix), tags: [] },
  });
  const startsAt = new Date(Date.now() + 3 * 86_400_000);
  const appointment = await db.appointment.create({
    data: {
      tenantId: tenant.id, branchId: tenant.branchId, patientId: patient.id, service: 'Cleaning',
      startsAt, endsAt: new Date(startsAt.getTime() + 30 * 60_000), status: 'CONFIRMED', channel: 'CALL',
      deletedAt: options.appointmentDeletedAt ?? null,
      patientConfirmedAt: options.confirmedAt ?? null,
      patientConfirmationSource: options.confirmedAt ? options.confirmationSource ?? 'receptionist_call' : null,
      patientConfirmedCallLogId: options.confirmedCallLogId ?? null,
    },
  });
  const target = await db.receptionistCallTarget.create({
    data: { tenantId: tenant.id, campaignId, patientId: patient.id, appointmentId: appointment.id, phone: phoneFor(tenant.id, suffix) },
  });
  return { patient, appointment, target };
}

/** A target with no appointment behind it — a reactivation call, say. */
async function makeTargetWithoutAppointment(tenant: TenantFixture, campaignId: string) {
  const suffix = ++patientSeq;
  // ReceptionistCallTarget_exact_identity_check: a target is exactly one of a
  // patient or a lead, never neither.
  const lead = await db.lead.create({
    data: { tenantId: tenant.id, name: `Lead ${suffix}`, phone: phoneFor(tenant.id, suffix), channel: 'CALL', service: 'General care', stage: 'NEW', source: 'test' },
  });
  return db.receptionistCallTarget.create({
    data: { tenantId: tenant.id, campaignId, leadId: lead.id, firstName: 'Lapsed', phone: phoneFor(tenant.id, suffix) },
  });
}

async function makeCallLog(tenant: TenantFixture, campaignId: string | null) {
  return db.receptionistCallLog.create({
    data: {
      tenantId: tenant.id, clinicId: tenant.clinicId, outboundCampaignId: campaignId,
      direction: 'outbound', outcome: 'BOOKED', callerPhone: phoneFor(tenant.id, ++patientSeq),
    },
  });
}

function get(tenant: TenantFixture, campaignId: string, role: 'OWNER' | 'PROVIDER' = 'OWNER') {
  return app.inject({
    method: 'GET',
    url: `/v1/receptionist/outbound-campaigns/${campaignId}/confirmations`,
    headers: auth(tenant, role),
  });
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  for (const id of tenantIds) await db.tenant.delete({ where: { id } }).catch(() => undefined);
  await db.$disconnect();
});

describe('outbound campaign confirmations', () => {
  it('counts the patients who said yes, and only credits the campaign for its own calls', async () => {
    const tenant = await makeTenant();
    const campaign = await makeCampaign(tenant);
    const otherCampaign = await makeCampaign(tenant, 'A different campaign');

    const campaignCall = await makeCallLog(tenant, campaign.id);
    const foreignCall = await makeCallLog(tenant, otherCampaign.id);

    // Confirmed on one of THIS campaign's calls.
    await makeTargetForAppointment(tenant, campaign.id, { confirmedAt: new Date(), confirmedCallLogId: campaignCall.id });
    // Confirmed, but on a call belonging to a different campaign.
    await makeTargetForAppointment(tenant, campaign.id, { confirmedAt: new Date(), confirmedCallLogId: foreignCall.id });
    // Confirmed at the front desk — a real confirmation, but not this campaign's.
    await makeTargetForAppointment(tenant, campaign.id, { confirmedAt: new Date(), confirmationSource: 'staff' });
    // Booked, never confirmed. The whole point: status CONFIRMED is not a yes.
    await makeTargetForAppointment(tenant, campaign.id);
    // On the list, but not about an appointment at all.
    await makeTargetWithoutAppointment(tenant, campaign.id);

    const response = await get(tenant, campaign.id);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      campaignId: campaign.id,
      targets: 5,
      targetsWithAppointment: 4,
      patientConfirmed: 3,
      confirmedOnCampaignCall: 1,
    });
  });

  it('counts every appointment a single call confirmed, not the call itself', async () => {
    const tenant = await makeTenant();
    const campaign = await makeCampaign(tenant);
    const call = await makeCallLog(tenant, campaign.id);

    // One call, two appointments confirmed on it. Counting distinct call logs
    // would report 1 and under-sell what the campaign actually achieved.
    await makeTargetForAppointment(tenant, campaign.id, { confirmedAt: new Date(), confirmedCallLogId: call.id });
    await makeTargetForAppointment(tenant, campaign.id, { confirmedAt: new Date(), confirmedCallLogId: call.id });

    await expect(get(tenant, campaign.id).then(r => r.json())).resolves.toMatchObject({
      patientConfirmed: 2,
      confirmedOnCampaignCall: 2,
    });
  });

  it('leaves a cancelled-away appointment out of both halves of the ratio', async () => {
    const tenant = await makeTenant();
    const campaign = await makeCampaign(tenant);
    await makeTargetForAppointment(tenant, campaign.id, { confirmedAt: new Date() });
    await makeTargetForAppointment(tenant, campaign.id, { appointmentDeletedAt: new Date() });

    const body = await get(tenant, campaign.id).then(r => r.json());
    // Two targets on the list, but only one live appointment to confirm.
    expect(body).toMatchObject({ targets: 2, targetsWithAppointment: 1, patientConfirmed: 1 });
  });

  it('reports nothing at all for another tenant’s campaign', async () => {
    const owner = await makeTenant();
    const stranger = await makeTenant();
    const campaign = await makeCampaign(owner);
    await makeTargetForAppointment(owner, campaign.id, { confirmedAt: new Date() });

    // Not a 200 with zeroes — a zero would confirm the campaign exists.
    expect((await get(stranger, campaign.id)).statusCode).toBe(404);
  });

  it('refuses a role that cannot read this campaign’s call evidence', async () => {
    const tenant = await makeTenant();
    const campaign = await makeCampaign(tenant);
    await makeTargetForAppointment(tenant, campaign.id, { confirmedAt: new Date() });

    const response = await get(tenant, campaign.id, 'PROVIDER');
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'insufficient_permission' });
  });
});

describe('the schedule can see a patient confirmation at all', () => {
  it('sends the confirmation, how it was given, and the call that evidences it', async () => {
    const tenant = await makeTenant();
    const campaign = await makeCampaign(tenant);
    const call = await makeCallLog(tenant, campaign.id);
    const confirmedAt = new Date();
    const { appointment } = await makeTargetForAppointment(tenant, campaign.id, { confirmedAt, confirmedCallLogId: call.id });

    const list = await app.inject({ method: 'GET', url: '/v1/appointments?limit=100', headers: auth(tenant) });
    expect(list.statusCode).toBe(200);
    const row = (list.json() as { data: Array<Record<string, unknown>> }).data.find(entry => entry.id === appointment.id);
    // All three travel together, because a confirmation the clinic cannot trace
    // back to its source is not evidence — the same both-or-neither rule the
    // database CHECK enforces on the way in.
    expect(row).toMatchObject({
      status: 'CONFIRMED',
      patientConfirmationSource: 'receptionist_call',
      patientConfirmedCallLogId: call.id,
    });
    expect(new Date(String(row?.patientConfirmedAt)).toISOString()).toBe(confirmedAt.toISOString());

    const detail = await app.inject({ method: 'GET', url: `/v1/appointments/${appointment.id}`, headers: auth(tenant) });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ patientConfirmationSource: 'receptionist_call', patientConfirmedCallLogId: call.id });
  });

  it('leaves all three null on a booked appointment nobody has answered', async () => {
    const tenant = await makeTenant();
    const campaign = await makeCampaign(tenant);
    const { appointment } = await makeTargetForAppointment(tenant, campaign.id);

    const detail = await app.inject({ method: 'GET', url: `/v1/appointments/${appointment.id}`, headers: auth(tenant) });
    // status is CONFIRMED, as every new appointment is. That must never be
    // read as, or turned into, the patient's own confirmation.
    expect(detail.json()).toMatchObject({
      status: 'CONFIRMED',
      patientConfirmedAt: null,
      patientConfirmationSource: null,
      patientConfirmedCallLogId: null,
    });
  });
});
