import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

// Proves patient SELF-SERVICE cancel + reschedule on the PORTAL identity plane:
// a patient acts only on THEIR OWN appointment (ownership scoped to session
// tenantId AND patientId → 404 otherwise), conflict-safe reschedule (excludes
// self, honours the DB exclusion constraint), and the clinic min-notice window.
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
const { db: appDb } = await import('../lib/db');
const { recomputeEntitlements } = await import('../lib/entitlements');
const { issuePortalSession } = await import('../lib/portalAuth');

let app: FastifyInstance;
const createdTenantIds: string[] = [];

function nextMondayISO(): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  do { d.setUTCDate(d.getUTCDate() + 1); } while (d.getUTCDay() !== 1);
  d.setUTCDate(d.getUTCDate() + 7);
  return d.toISOString().slice(0, 10);
}
const MONDAY = nextMondayISO();
const at = (hhmm: string) => new Date(`${MONDAY}T${hhmm}:00.000Z`);

async function makeTenant() {
  const id = randomUUID();
  await db.tenant.create({ data: { id, name: `ss-${id.slice(0, 6)}`, slug: `ss-${id.slice(0, 8)}` } });
  createdTenantIds.push(id);
  const plan = await db.subscriptionPlan.findUnique({ where: { key: 'enterprise' } });
  await db.tenantSubscription.create({ data: { tenantId: id, planId: plan!.id, status: 'ACTIVE', startedAt: new Date() } });
  await recomputeEntitlements(id, db); // enables patient_crm (portal feature gate)
  const branch = await db.branch.create({ data: { tenantId: id, name: 'b', location: 'x', timezone: 'UTC' } });
  const provUser = await db.user.create({ data: { tenantId: id, role: 'PROVIDER', active: true, email: `pv-${id.slice(0, 8)}@ss.test`, displayName: 'Dr Who' } });
  const provider = await db.providerProfile.create({ data: { tenantId: id, branchId: branch.id, userId: provUser.id, specialty: 'Primary Care', rating: 4.8, reviewCount: 12 } });
  // Mon 09:00–12:00, 30-min slots
  await db.providerAvailability.create({ data: { tenantId: id, branchId: branch.id, providerProfileId: provider.id, dayOfWeek: 1, startMinute: 540, endMinute: 720, slotMinutes: 30 } });
  const patient = await db.patient.create({ data: { tenantId: id, branchId: branch.id, firstName: 'Pat', lastName: 'Roe', lifecycleStage: 'ACTIVE' } });
  const account = await db.patientPortalAccount.create({ data: { tenantId: id, patientId: patient.id, status: 'active', email: `pat-${id.slice(0, 8)}@ss.test` } });
  const portalToken = await issuePortalSession(app, account, db);
  return { id, branchId: branch.id, providerId: provider.id, patientId: patient.id, accountId: account.id, portalToken };
}

async function makeAppt(t: { id: string; branchId: string; providerId: string }, patientId: string, startsAt: Date, durationMin = 30, status = 'CONFIRMED') {
  return db.appointment.create({
    data: {
      tenantId: t.id, branchId: t.branchId, patientId, providerProfileId: t.providerId, providerRef: t.providerId,
      service: 'Checkup', startsAt, endsAt: new Date(startsAt.getTime() + durationMin * 60_000),
      status: status as 'CONFIRMED', channel: 'EMAIL',
    },
  });
}

const portalTok = (t: { id: string; patientId: string; accountId: string }) =>
  'portalToken' in t ? String(t.portalToken) : '';
const phdr = (t: { id: string; patientId: string; accountId: string; portalToken: string }) => ({ authorization: `Bearer ${portalTok(t)}` });

beforeAll(async () => { app = await buildApp(); }, 60_000);
afterAll(async () => {
  for (const id of createdTenantIds) await db.tenant.delete({ where: { id } }).catch(() => {});
  await app?.close();
  await db.$disconnect();
});

describe('portal self-service — patient cancels/reschedules only their own appointment', () => {
  it('cancels the session patient\'s own appointment and writes a critical audit', async () => {
    const t = await makeTenant();
    const appt = await makeAppt(t, t.patientId, at('09:00'));
    const res = await app.inject({ method: 'POST', url: `/v1/portal/appointments/${appt.id}/cancel`, headers: phdr(t), payload: { reason: 'Feeling better' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('CANCELED');

    const row = await db.appointment.findUnique({ where: { id: appt.id } });
    expect(row?.status).toBe('CANCELED');
    const audited = await db.auditEvent.findFirst({ where: { tenantId: t.id, action: 'portal.appointment.cancelled', resourceId: appt.id, actorUserId: null } });
    expect(audited).not.toBeNull();

    // idempotent: cancelling again is a no-op success
    const again = await app.inject({ method: 'POST', url: `/v1/portal/appointments/${appt.id}/cancel`, headers: phdr(t), payload: {} });
    expect(again.statusCode).toBe(200);
    expect(again.json().deduped).toBe(true);
  });

  it('cannot cancel ANOTHER patient\'s appointment (404, never touched)', async () => {
    const t = await makeTenant();
    // Second patient in the SAME tenant with their own appointment.
    const other = await db.patient.create({ data: { tenantId: t.id, branchId: t.branchId, firstName: 'Other', lastName: 'Person', lifecycleStage: 'ACTIVE' } });
    const otherAppt = await makeAppt(t, other.id, at('10:00'));
    const res = await app.inject({ method: 'POST', url: `/v1/portal/appointments/${otherAppt.id}/cancel`, headers: phdr(t), payload: {} });
    expect(res.statusCode).toBe(404);
    const row = await db.appointment.findUnique({ where: { id: otherAppt.id } });
    expect(row?.status).toBe('CONFIRMED'); // untouched
  });

  it('cannot reschedule ANOTHER patient\'s appointment (404, never touched)', async () => {
    const t = await makeTenant();
    const other = await db.patient.create({ data: { tenantId: t.id, branchId: t.branchId, firstName: 'Other', lastName: 'Person', lifecycleStage: 'ACTIVE' } });
    const otherAppt = await makeAppt(t, other.id, at('10:00'));
    const res = await app.inject({ method: 'POST', url: `/v1/portal/appointments/${otherAppt.id}/reschedule`, headers: phdr(t), payload: { startsAt: at('11:00').toISOString() } });
    expect(res.statusCode).toBe(404);
    const row = await db.appointment.findUnique({ where: { id: otherAppt.id } });
    expect(row?.startsAt.toISOString()).toBe(at('10:00').toISOString()); // untouched
  });

  it('reschedules own appointment to an open slot (200) and audits', async () => {
    const t = await makeTenant();
    const appt = await makeAppt(t, t.patientId, at('09:00'));
    const res = await app.inject({ method: 'POST', url: `/v1/portal/appointments/${appt.id}/reschedule`, headers: phdr(t), payload: { startsAt: at('11:00').toISOString(), durationMin: 30 } });
    expect(res.statusCode).toBe(200);
    expect(res.json().startsAt).toBe(at('11:00').toISOString());
    const row = await db.appointment.findUnique({ where: { id: appt.id } });
    expect(row?.startsAt.toISOString()).toBe(at('11:00').toISOString());
    const audited = await db.auditEvent.findFirst({ where: { tenantId: t.id, action: 'portal.appointment.rescheduled', resourceId: appt.id, actorUserId: null } });
    expect(audited).not.toBeNull();
  });

  it('reschedule onto a slot occupied by another appointment → 409', async () => {
    const t = await makeTenant();
    const mine = await makeAppt(t, t.patientId, at('09:00'));
    // A different patient occupies the 10:00 slot on the same provider.
    const other = await db.patient.create({ data: { tenantId: t.id, branchId: t.branchId, firstName: 'Occ', lastName: 'Upied', lifecycleStage: 'ACTIVE' } });
    await makeAppt(t, other.id, at('10:00'));

    const res = await app.inject({ method: 'POST', url: `/v1/portal/appointments/${mine.id}/reschedule`, headers: phdr(t), payload: { startsAt: at('10:00').toISOString(), durationMin: 30 } });
    expect(res.statusCode).toBe(409);
    expect(res.json().reason).toBe('already_booked');
    // mine is unchanged
    const row = await db.appointment.findUnique({ where: { id: mine.id } });
    expect(row?.startsAt.toISOString()).toBe(at('09:00').toISOString());
  });

  it('blocks a too-late cancel inside the clinic min-notice window (422)', async () => {
    const t = await makeTenant();
    await db.schedulingPolicy.create({ data: { tenantId: t.id, selfBookEnabled: true, minNoticeHours: 48, maxHorizonDays: 90 } });
    // Appointment starts in ~1 hour → well inside a 48-hour notice window.
    const soon = new Date(Date.now() + 60 * 60_000);
    const appt = await makeAppt(t, t.patientId, soon);
    const res = await app.inject({ method: 'POST', url: `/v1/portal/appointments/${appt.id}/cancel`, headers: phdr(t), payload: {} });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('too_late_to_cancel');
    const row = await db.appointment.findUnique({ where: { id: appt.id } });
    expect(row?.status).toBe('CONFIRMED'); // not cancelled
  });

  it('requires a portal session (401) and rejects a staff token', async () => {
    const t = await makeTenant();
    const appt = await makeAppt(t, t.patientId, at('09:00'));
    expect((await app.inject({ method: 'POST', url: `/v1/portal/appointments/${appt.id}/cancel` })).statusCode).toBe(401);
    const staff = app.jwt.sign({ userId: randomUUID(), tenantId: t.id, role: 'OWNER', type: 'access' });
    const res = await app.inject({ method: 'POST', url: `/v1/portal/appointments/${appt.id}/cancel`, headers: { authorization: `Bearer ${staff}` } });
    expect(res.statusCode).toBe(401);
  });
});

describe('portal pay-a-bill — surfaces the real provider checkout URL, honestly', () => {
  async function makePaymentRequest(t: { id: string; branchId: string; patientId: string }, opts: { status: string; paymentUrl?: string | null; linkExpiresAt?: Date | null }) {
    return db.paymentRequest.create({
      data: {
        tenantId: t.id, branchId: t.branchId, patientId: t.patientId, amount: 42.5, currency: 'USD',
        status: opts.status, reason: 'Deposit', mode: 'mock', paymentUrl: opts.paymentUrl ?? null, linkExpiresAt: opts.linkExpiresAt ?? null,
      },
    });
  }

  it('returns the provider paymentUrl as an absolute payLink when a live link exists', async () => {
    const t = await makeTenant();
    await makePaymentRequest(t, { status: 'link_sent', paymentUrl: 'https://checkout.example.com/session_abc' });
    const res = await app.inject({ method: 'GET', url: '/v1/portal/payments', headers: phdr(t) });
    expect(res.statusCode).toBe(200);
    const row = res.json().find((p: { reason: string }) => p.reason === 'Deposit');
    expect(row.payLink).toBe('https://checkout.example.com/session_abc');
    expect(row.payLinkUnavailable).toBe(false);
    // never a broken relative /public/checkout link
    expect(res.body).not.toContain('/public/checkout/');
  });

  it('honestly reports payLinkUnavailable when a balance is owed but no link exists', async () => {
    const t = await makeTenant();
    await makePaymentRequest(t, { status: 'pending', paymentUrl: null });
    const res = await app.inject({ method: 'GET', url: '/v1/portal/payments', headers: phdr(t) });
    const row = res.json()[0];
    expect(row.payLink).toBeNull();
    expect(row.payLinkUnavailable).toBe(true);
  });

  it('does not offer a pay link for an already-settled balance', async () => {
    const t = await makeTenant();
    await makePaymentRequest(t, { status: 'collected', paymentUrl: 'https://checkout.example.com/session_done' });
    const res = await app.inject({ method: 'GET', url: '/v1/portal/payments', headers: phdr(t) });
    const row = res.json()[0];
    expect(row.payLink).toBeNull();
    expect(row.payLinkUnavailable).toBe(false);
  });

  it('drops an expired provider link (null payLink, honest unavailable)', async () => {
    const t = await makeTenant();
    await makePaymentRequest(t, { status: 'link_sent', paymentUrl: 'https://checkout.example.com/session_old', linkExpiresAt: new Date(Date.now() - 3600_000) });
    const res = await app.inject({ method: 'GET', url: '/v1/portal/payments', headers: phdr(t) });
    const row = res.json()[0];
    expect(row.payLink).toBeNull();
    expect(row.payLinkUnavailable).toBe(true);
  });
});

describe('portal intake — patient fills and submits the packet in-portal', () => {
  async function makePacket(t: { id: string; patientId: string }) {
    return db.patientIntakePacket.create({
      data: {
        tenantId: t.id, patientId: t.patientId, status: 'sent', source: 'staff',
        sections: { create: [
          { tenantId: t.id, sectionType: 'demographics', status: 'pending' },
          { tenantId: t.id, sectionType: 'communication_consent', status: 'pending' },
          { tenantId: t.id, sectionType: 'pre_visit_checklist', status: 'pending' },
        ] },
      },
      include: { sections: true },
    });
  }

  it('renders the packet sections, accepts section submissions, and submits the packet', async () => {
    const t = await makeTenant();
    const packet = await makePacket(t);

    // GET the fillable packet view (patient-safe: sections + prompts).
    const view = await app.inject({ method: 'GET', url: `/v1/portal/intake/${packet.id}`, headers: phdr(t) });
    expect(view.statusCode).toBe(200);
    expect(view.json().sections.map((s: { sectionType: string }) => s.sectionType)).toEqual(
      expect.arrayContaining(['demographics', 'communication_consent', 'pre_visit_checklist']),
    );

    // Fill each required section from the portal.
    for (const [sectionType, data] of [
      ['demographics', { firstName: 'Pat', lastName: 'Roe', email: 'pat@ss.test', phone: '555' }],
      ['communication_consent', { sms: true, email: true }],
      ['pre_visit_checklist', { accepted: true }],
    ] as const) {
      const r = await app.inject({ method: 'POST', url: `/v1/portal/intake/${packet.id}/sections`, headers: phdr(t), payload: { sectionType, data } });
      expect(r.statusCode).toBe(200);
    }

    const sections = await db.patientIntakeSection.findMany({ where: { packetId: packet.id } });
    expect(sections.every(s => s.status === 'completed')).toBe(true);
    const audited = await db.auditEvent.findFirst({ where: { tenantId: t.id, action: 'portal.intake.updated', resourceId: packet.id, actorUserId: null } });
    expect(audited).not.toBeNull();

    // Submit the completed packet.
    const submit = await app.inject({ method: 'POST', url: `/v1/portal/intake/${packet.id}/submit`, headers: phdr(t) });
    expect(submit.statusCode).toBe(200);
    const after = await db.patientIntakePacket.findUnique({ where: { id: packet.id } });
    expect(['submitted', 'needs_review']).toContain(after?.status);
  });

  it('cannot read or edit another patient\'s packet (404)', async () => {
    const t = await makeTenant();
    const other = await db.patient.create({ data: { tenantId: t.id, branchId: t.branchId, firstName: 'Other', lastName: 'P', lifecycleStage: 'ACTIVE' } });
    const otherPacket = await db.patientIntakePacket.create({ data: { tenantId: t.id, patientId: other.id, status: 'sent', source: 'staff', sections: { create: [{ tenantId: t.id, sectionType: 'demographics', status: 'pending' }] } } });
    const view = await app.inject({ method: 'GET', url: `/v1/portal/intake/${otherPacket.id}`, headers: phdr(t) });
    expect(view.statusCode).toBe(404);
    const edit = await app.inject({ method: 'POST', url: `/v1/portal/intake/${otherPacket.id}/sections`, headers: phdr(t), payload: { sectionType: 'demographics', data: { firstName: 'X' } } });
    expect(edit.statusCode).toBe(404);
  });

  it('rolls section, packet, and consent mutations back when the critical intake audit fails', async () => {
    const t = await makeTenant();
    const packet = await makePacket(t);
    const section = packet.sections.find(row => row.sectionType === 'communication_consent')!;
    const originalTransaction = appDb.$transaction.bind(appDb);
    const transactionSpy = vi.spyOn(appDb, '$transaction').mockImplementation((async (callback: (tx: unknown) => unknown, options?: unknown) =>
      originalTransaction(async realTx => {
        const auditDelegate = new Proxy(realTx.auditEvent, {
          get(target, property, receiver) {
            if (property === 'create') return async (args: { data?: { action?: string } }) => {
              if (args.data?.action === 'intake.section.updated') throw new Error('injected intake section audit fault');
              return target.create(args as never);
            };
            return Reflect.get(target, property, receiver);
          },
        });
        const txProxy = new Proxy(realTx, {
          get(target, property, receiver) {
            if (property === 'auditEvent') return auditDelegate;
            return Reflect.get(target, property, receiver);
          },
        });
        return callback(txProxy);
      }, options as never)) as typeof appDb.$transaction);
    try {
      const failed = await app.inject({ method: 'POST', url: `/v1/portal/intake/${packet.id}/sections`, headers: phdr(t), payload: { sectionType: 'communication_consent', data: { sms: true } } });
      expect(failed.statusCode).toBe(500);
    } finally {
      transactionSpy.mockRestore();
    }

    expect((await db.patientIntakeSection.findUnique({ where: { id: section.id } }))?.status).toBe('pending');
    expect((await db.patientIntakePacket.findUnique({ where: { id: packet.id } }))?.status).toBe('sent');
    expect(await db.communicationConsent.count({ where: { tenantId: t.id, patientId: t.patientId, channel: 'sms' } })).toBe(0);
  });

  it('rolls packet submission back when the critical submission audit fails', async () => {
    const t = await makeTenant();
    const packet = await makePacket(t);
    const before = await db.patientIntakePacket.findUniqueOrThrow({ where: { id: packet.id } });
    const originalTransaction = appDb.$transaction.bind(appDb);
    const transactionSpy = vi.spyOn(appDb, '$transaction').mockImplementation((async (callback: (tx: unknown) => unknown, options?: unknown) =>
      originalTransaction(async realTx => {
        const auditDelegate = new Proxy(realTx.auditEvent, {
          get(target, property, receiver) {
            if (property === 'create') return async (args: { data?: { action?: string } }) => {
              if (args.data?.action === 'intake.packet.submitted') throw new Error('injected intake packet audit fault');
              return target.create(args as never);
            };
            return Reflect.get(target, property, receiver);
          },
        });
        const txProxy = new Proxy(realTx, {
          get(target, property, receiver) {
            if (property === 'auditEvent') return auditDelegate;
            return Reflect.get(target, property, receiver);
          },
        });
        return callback(txProxy);
      }, options as never)) as typeof appDb.$transaction);
    try {
      const failed = await app.inject({ method: 'POST', url: `/v1/portal/intake/${packet.id}/submit`, headers: phdr(t) });
      expect(failed.statusCode).toBe(500);
    } finally {
      transactionSpy.mockRestore();
    }

    const after = await db.patientIntakePacket.findUniqueOrThrow({ where: { id: packet.id } });
    expect(after.status).toBe(before.status);
    expect(after.submittedAt).toBeNull();
    expect(after.readinessScore).toBe(before.readinessScore);
  });
});
