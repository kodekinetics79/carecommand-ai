import 'dotenv/config';
// Enforce signed Stripe webhooks for the payments leg (set before app/env import).
process.env.STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_sim_secret';

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID, createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

// End-to-end, MULTI-TENANT, CONCURRENT simulation. Drives many modules together
// in one realistic clinic journey — insurance eligibility, provider scheduling,
// patient portal self-booking, intake, a deposit payment collected via a signed
// Stripe webhook, and connected-care/RPM device ingest, plus the HIPAA data
// export — for several tenants AT ONCE (Promise.all). Then verifies the shared
// audit trail captured the cross-module activity and that tenant isolation holds
// under concurrent load. This is the "all modules together" proof on top of the
// per-module unit tests. Scale with SIM_CLINICS (default 6).
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
const { recomputeEntitlements } = await import('../lib/entitlements');
const { encryptSecret } = await import('../lib/security');
const { issuePortalSession } = await import('../lib/portalAuth');

let app: FastifyInstance;
const createdTenantIds: string[] = [];
const SECRET = process.env.STRIPE_WEBHOOK_SECRET!;
const N = Math.min(Math.max(Number(process.env.SIM_CLINICS) || 6, 1), 24);

function nextMondayISO(): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  do { d.setUTCDate(d.getUTCDate() + 1); } while (d.getUTCDay() !== 1);
  d.setUTCDate(d.getUTCDate() + 7);
  return d.toISOString().slice(0, 10);
}
const MONDAY = nextMondayISO();
const at = (hhmm: string) => `${MONDAY}T${hhmm}:00.000Z`;

const staffTok = (tenantId: string, userId: string) => app.jwt.sign({ userId, tenantId, role: 'OWNER', type: 'access' });
const bearer = (t: string, ip: string) => ({ authorization: `Bearer ${t}`, 'x-forwarded-for': ip });
function stripeSig(body: string) {
  const ts = Math.floor(Date.now() / 1000);
  return `t=${ts},v1=${createHmac('sha256', SECRET).update(`${ts}.${body}`).digest('hex')}`;
}

interface Clinic {
  id: string; branchId: string; providerId: string; patientId: string; accountId: string; deviceId: string;
  adminId: string; payerId: string; policyId: string; externalRef: string; ip: string; portalToken: string;
}

async function provisionClinic(seq: number): Promise<Clinic> {
  const id = randomUUID();
  await db.tenant.create({ data: { id, name: `sim-${id.slice(0, 6)}`, slug: `sim-${id.slice(0, 8)}` } });
  createdTenantIds.push(id);
  const plan = await db.subscriptionPlan.findUnique({ where: { key: 'enterprise' } });
  await db.tenantSubscription.create({ data: { tenantId: id, planId: plan!.id, status: 'ACTIVE', startedAt: new Date() } });
  await recomputeEntitlements(id, db);
  const branch = await db.branch.create({ data: { tenantId: id, name: 'Main', location: 'City', timezone: 'UTC' } });
  const provUser = await db.user.create({ data: { tenantId: id, role: 'PROVIDER', active: true, email: `pv-${id.slice(0, 8)}@sim.test`, displayName: 'Dr Sim' } });
  const provider = await db.providerProfile.create({ data: { tenantId: id, branchId: branch.id, userId: provUser.id, specialty: 'Primary Care', rating: 4.7, reviewCount: 9 } });
  const patient = await db.patient.create({ data: { tenantId: id, branchId: branch.id, firstName: 'Sim', lastName: `Patient${seq}`, lifecycleStage: 'NEW' } });
  const device = await db.device.create({ data: { tenantId: id, branchId: branch.id, name: 'Sim glucose meter', deviceType: 'glucose_meter', active: true, status: 'online' } });
  const payer = await db.insurancePayer.create({ data: { tenantId: id, name: 'Aetna', sourceProvider: 'stedi', active: true } });
  const policy = await db.patientInsurancePolicy.create({ data: { tenantId: id, branchId: branch.id, patientId: patient.id, payerId: payer.id, planName: 'Aetna PPO', memberId: 'AET-110293', coverageOrder: 1, active: true } });
  const account = await db.patientPortalAccount.create({ data: { tenantId: id, patientId: patient.id, status: 'active', email: `sp-${id.slice(0, 8)}@sim.test` } });
  const admin = await db.user.create({ data: { tenantId: id, role: 'ADMIN', active: true, email: `ad-${id.slice(0, 8)}@sim.test`, displayName: 'Admin' } });
  const portalToken = await issuePortalSession(app, account, db);
  return { id, branchId: branch.id, providerId: provider.id, patientId: patient.id, accountId: account.id, deviceId: device.id, adminId: admin.id, payerId: payer.id, policyId: policy.id, externalRef: `EXT-${id.slice(0, 8)}`, ip: `203.0.113.${(seq % 240) + 10}`, portalToken };
}

type StepResult = { ok: boolean; detail: string };

async function runJourney(c: Clinic): Promise<Record<string, StepResult>> {
  const steps: Record<string, StepResult> = {};
  const admin = bearer(staffTok(c.id, c.adminId), c.ip);
  const portal = bearer(c.portalToken, c.ip);
  const ok = (cond: boolean, detail: string): StepResult => ({ ok: cond, detail });

  // 1) Insurance: configure Stedi sandbox + run an eligibility check.
  await app.inject({ method: 'POST', url: '/v1/insurance/providers/stedi/configure', headers: admin, payload: { mode: 'sandbox', config: {} } });
  const elig = await app.inject({ method: 'POST', url: '/v1/insurance/eligibility/check', headers: { ...admin, 'idempotency-key': 'e2e-simulation-eligibility' }, payload: { patientId: c.patientId, policyId: c.policyId, payerName: 'Aetna', memberId: 'AET-110293' } });
  steps.eligibility = ok(elig.statusCode === 201 && elig.json().status === 'ACTIVE', `status=${elig.statusCode}`);

  // 2) Revenue policy: a new-patient deposit rule (so a deposit applies below).
  await app.inject({ method: 'POST', url: '/v1/revenue-protection/deposit-rules', headers: admin, payload: { name: 'New patient deposit', ruleType: 'new_patient', description: 'Collect a deposit from new patients', depositRequired: true, amountType: 'fixed', amountValue: 50, appliesToNewPatients: true } });

  // 3) Scheduling: provider availability (Mon 09:00–12:00).
  const avail = await app.inject({ method: 'PUT', url: `/v1/scheduling/providers/${c.providerId}/availability`, headers: admin, payload: { windows: [{ dayOfWeek: 1, startMinute: 540, endMinute: 720, slotMinutes: 30 }] } });
  steps.availability = ok(avail.statusCode === 200, `status=${avail.statusCode}`);

  // 4) Portal self-book: patient views slots and books 09:00 for themselves.
  const slots = await app.inject({ method: 'GET', url: `/v1/portal/booking/providers/${c.providerId}/slots?date=${MONDAY}`, headers: portal });
  const book = await app.inject({ method: 'POST', url: `/v1/portal/booking/providers/${c.providerId}/book`, headers: portal, payload: { startsAt: at('09:00'), durationMin: 30, reason: 'Annual physical' } });
  const appointmentId = book.statusCode === 201 ? (book.json().id as string) : null;
  steps.selfBook = ok(Boolean(appointmentId) && (slots.json().slots ?? []).length === 6, `slots=${(slots.json().slots ?? []).length} book=${book.statusCode}`);

  // 5) Intake: staff create a packet, patient fills the demographics section.
  const packet = await app.inject({ method: 'POST', url: '/v1/intake/packets', headers: admin, payload: { patientId: c.patientId, issueToken: false } });
  const packetId = (packet.statusCode === 201 || packet.statusCode === 200) ? (packet.json().intakePacketId as string) : null;
  let intakeOk = false; let intakeDetail = `packet=${packet.statusCode}`;
  if (packetId) {
    const section = await app.inject({ method: 'POST', url: `/v1/portal/intake/${packetId}/sections`, headers: portal, payload: { sectionType: 'demographics', data: { confirmed: true } } });
    intakeOk = section.statusCode === 200;
    intakeDetail += ` section=${section.statusCode}:${section.body.slice(0, 90)}`;
  }
  steps.intake = ok(intakeOk, intakeDetail);

  // 6) Payments: generate the deposit link, then collect it via a signed webhook.
  let paymentsOk = false; let payDetail = '';
  if (appointmentId) {
    const link = await app.inject({ method: 'POST', url: `/v1/payments/appointments/${appointmentId}/payment-link`, headers: admin, payload: {} });
    const pr = await db.paymentRequest.findFirst({ where: { tenantId: c.id, appointmentId }, orderBy: { createdAt: 'desc' }, select: { id: true, providerReference: true } });
    payDetail = `link=${link.statusCode} ref=${pr?.providerReference ? 'y' : 'n'}`;
    if (pr?.providerReference) {
      const evt = JSON.stringify({ id: `evt_${randomUUID()}`, type: 'checkout.session.completed', data: { object: { id: pr.providerReference } } });
      const hook = await app.inject({ method: 'POST', url: '/v1/revenue-protection/webhooks/stripe', headers: { 'content-type': 'application/json', 'stripe-signature': stripeSig(evt) }, payload: evt });
      const after = await db.paymentRequest.findUnique({ where: { id: pr.id }, select: { status: true } });
      paymentsOk = hook.statusCode === 200 && after?.status === 'collected';
      payDetail += ` hook=${hook.statusCode} status=${after?.status}`;
    }
  }
  steps.paymentCollected = ok(paymentsOk, payDetail);

  // 7) Connected care / RPM: enroll + ingest a critical reading via a SIGNED webhook.
  // The device webhook fails closed — it ingests only when the per-provider secret
  // verifies the request, so configure that secret, enroll, and sign the payload.
  const deviceSecret = `whsec-dev-${c.id}`;
  await db.deviceProvider.upsert({
    where: { tenantId_providerKey: { tenantId: c.id, providerKey: 'withings' } },
    create: { tenantId: c.id, providerKey: 'withings', displayName: 'Withings', category: 'DIRECT_API', mode: 'sandbox', status: 'SANDBOX', encryptedConfig: encryptSecret(JSON.stringify({ webhookSecret: deviceSecret })), webhookConfigured: true },
    update: { encryptedConfig: encryptSecret(JSON.stringify({ webhookSecret: deviceSecret })), webhookConfigured: true },
  });
  await app.inject({ method: 'POST', url: '/v1/connected-care/enrollments', headers: admin, payload: { patientId: c.patientId, providerKey: 'withings', externalRef: c.externalRef, deviceId: c.deviceId } });
  const deviceRaw = JSON.stringify({ readings: [{ patientExternalRef: c.externalRef, readingType: 'glucose', value: '330', numericValue: 330, unit: 'mg/dL' }] });
  const deviceSig = createHmac('sha256', deviceSecret).update(deviceRaw).digest('hex');
  const hook = await app.inject({ method: 'POST', url: `/v1/connected-care/${c.id}/providers/withings/webhook`, headers: { 'content-type': 'application/json', 'x-cc-signature': deviceSig }, payload: deviceRaw });
  steps.deviceAlert = ok(hook.statusCode === 200 && hook.json().alertsCreated === 1, `ingested=${hook.json().ingested} alerts=${hook.json().alertsCreated}`);

  // 8) Compliance: HIPAA data-access export compiles the cross-module record.
  const exp = await app.inject({ method: 'GET', url: `/v1/patients/${c.patientId}/data-export`, headers: admin });
  const body = exp.statusCode === 200 ? exp.json() : { counts: {} };
  steps.dataExport = ok(exp.statusCode === 200 && body.counts.appointments >= 1 && body.counts.eligibilityVerifications >= 1 && body.counts.paymentRequests >= 1, `status=${exp.statusCode}`);

  // 9) Intelligence: the morning briefing reacted to this activity — its LIVE
  // counts surface the backend-decided critical reading, today's eligibility
  // check, and the open device alert (all produced above, not seeded).
  const brief = await app.inject({ method: 'GET', url: '/v1/monitoring/morning-briefing', headers: admin });
  const bc = brief.statusCode === 200 ? brief.json().counts : {};
  steps.briefingReacted = ok(brief.statusCode === 200 && bc.criticalOpen >= 1 && bc.insuranceChecksToday >= 1 && bc.unresolvedDeviceAlerts >= 1, `critical=${bc.criticalOpen} elig=${bc.insuranceChecksToday} alerts=${bc.unresolvedDeviceAlerts}`);

  return steps;
}

beforeAll(async () => { app = await buildApp(); }, 60_000);
afterAll(async () => {
  for (const id of createdTenantIds) await db.tenant.delete({ where: { id } }).catch(() => {});
  await app?.close();
  await db.$disconnect();
});

describe('e2e simulation — many modules, many tenants, concurrently', () => {
  it(`runs ${N} clinic journeys in parallel and every cross-module step succeeds`, async () => {
    const start = Date.now();
    const clinics = await Promise.all(Array.from({ length: N }, (_, i) => provisionClinic(i)));
    const reports = await Promise.all(clinics.map(runJourney));

    reports.forEach((r, i) => {
      const line = Object.entries(r).map(([k, v]) => `${k}:${v.ok ? 'ok' : `FAIL(${v.detail})`}`).join('  ');
      console.info(`[sim] clinic ${i}: ${line}`);
    });
    console.info(`[sim] ${N} clinics × ${Object.keys(reports[0]).length} module steps in ${Date.now() - start}ms`);

    for (const r of reports) {
      for (const [step, result] of Object.entries(r)) {
        expect(result.ok, `${step} → ${result.detail}`).toBe(true);
      }
    }
  }, 120_000);

  it('captured cross-module audit activity and kept tenants isolated under concurrency', async () => {
    const clinics = await Promise.all(Array.from({ length: N }, (_, i) => provisionClinic(100 + i)));
    await Promise.all(clinics.map(runJourney));

    for (const c of clinics) {
      const appts = await db.appointment.findMany({ where: { tenantId: c.id }, select: { patientId: true, providerRef: true } });
      expect(appts).toHaveLength(1);
      expect(appts[0].patientId).toBe(c.patientId);
      expect(appts[0].providerRef).toBe(c.providerId);

      const actions = new Set((await db.auditEvent.findMany({ where: { tenantId: c.id }, select: { action: true } })).map(a => a.action));
      for (const expected of ['schedule.availability.updated', 'portal.appointment.booked', 'portal.intake.updated', 'payment.succeeded', 'patient.data_exported']) {
        expect(actions.has(expected), `missing audit action ${expected}`).toBe(true);
      }

      expect(await db.eligibilityVerification.count({ where: { tenantId: c.id } })).toBe(1);
      // exactly one deposit collected per tenant — no cross-tenant double-collect
      expect(await db.paymentTransaction.count({ where: { tenantId: c.id, status: 'succeeded' } })).toBe(1);

      // Intelligence layer reacted to this tenant's activity:
      // (a) revenue intelligence recorded the money movement as a BusinessEvent,
      const bizTypes = new Set((await db.businessEvent.findMany({ where: { tenantId: c.id }, select: { eventType: true } })).map(e => e.eventType));
      expect(bizTypes.has('payment.succeeded'), 'no payment.succeeded BusinessEvent').toBe(true);
      // (b) monitoring decided exactly one critical reading alert (glucose 330),
      expect(await db.readingAlert.count({ where: { tenantId: c.id, severity: 'critical', status: 'open' } })).toBe(1);
    }
  }, 120_000);
});
