import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClinicFixture } from './helpers/receptionistFixtures';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

// ===========================================================================
// Package D — "The board is true", the numbers half.
//
// D6 — `/overview` kept the pre-C4 scalars beside the honest kpi-v2 block.
//      They divided BOOKED by every call in BOTH directions, including the
//      zero-second NO_ANSWER rows the live audit found, and collapsed null to
//      0 — so a clinic that had answered nothing read "0% booking rate" and
//      "0m 0s" instead of "no data yet". That is the "7 calls handled / 14%
//      booking rate" the contract froze as not-capability. They are gone.
//
// D11 — the appointment-request detail handed patient phone and email, plus the
//      caller's unmasked number, to AUDITOR and COMPLIANCE_OFFICER: two roles
//      whose grants deliberately exclude `patient:read`. The sibling surface
//      (`projectTaskRow`) has always gated that block correctly.
// ===========================================================================

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

let app: FastifyInstance;
const tenantIds: string[] = [];

let phoneCounter = 0;
const uniquePhone = () => `+1${String(process.pid % 100).padStart(2, '0')}${String(Date.now() % 100_000).padStart(5, '0')}${String(phoneCounter++ % 1_000).padStart(3, '0')}`;

const CALLER = '+12125550155';

interface Fixture {
  tenantId: string;
  branchId: string;
  clinicId: string;
  patientId: string;
  callLogId: string;
  requestId: string;
  owner: string;
  frontDesk: string;
  auditor: string;
  compliance: string;
}

async function makeFixture(): Promise<Fixture> {
  const tenantId = randomUUID();
  tenantIds.push(tenantId);
  const tag = tenantId.slice(0, 8);
  await db.tenant.create({ data: { id: tenantId, name: `rot-${tag}`, slug: `rot-${tag}` } });
  await db.tenantFeatureEntitlement.create({ data: { tenantId, featureKey: 'ai_receptionist', enabled: true, source: 'test' } });
  const branch = await db.branch.create({ data: { tenantId, name: 'Main', location: 'x', timezone: 'UTC' } });
  const clinic = await createClinicFixture(db, { tenantId, name: `Clinic ${tag}`, phone: uniquePhone(), timezone: 'UTC' });
  await db.receptionistLocation.create({
    data: { tenantId, clinicId: clinic.id, branchId: branch.id, name: 'Main', address: '1 Test St', active: true },
  });
  const mkUser = (role: string, label: string) => db.user.create({
    data: { tenantId, role: role as never, active: true, email: `${label}-${tag}@rot.test`, displayName: `${role} ${label}` },
  });
  const [owner, frontDesk, auditor, compliance] = await Promise.all([
    mkUser('OWNER', 'owner'), mkUser('FRONT_DESK', 'fd'),
    mkUser('AUDITOR', 'aud'), mkUser('COMPLIANCE_OFFICER', 'co'),
  ]);
  const patient = await db.patient.create({
    data: {
      tenantId, branchId: branch.id, firstName: 'Pat', lastName: 'Roe',
      phone: '+12125550144', email: 'pat.roe@example.test', lifecycleStage: 'ACTIVE',
    },
  });
  const callLog = await db.receptionistCallLog.create({
    data: { tenantId, clinicId: clinic.id, retellCallId: `call-${randomUUID()}`, direction: 'inbound', callerPhone: CALLER, outcome: 'IN_PROGRESS' },
  });
  const requestRow = await db.appointmentRequest.create({
    data: {
      tenantId, callLogId: callLog.id, patientId: patient.id, requestedService: 'Checkup',
      collectedName: 'Pat Roe', collectedPhone: '+12125550143', status: 'PENDING_REVIEW',
      source: 'ai_receptionist', missingFields: [],
    },
  });
  return {
    tenantId, branchId: branch.id, clinicId: clinic.id, patientId: patient.id,
    callLogId: callLog.id, requestId: requestRow.id,
    owner: owner.id, frontDesk: frontDesk.id, auditor: auditor.id, compliance: compliance.id,
  };
}

const auth = (f: Fixture, userId: string, role: string) => ({
  authorization: `Bearer ${app.jwt.sign({ userId, tenantId: f.tenantId, role, type: 'access' })}`,
});

beforeAll(async () => { app = await buildApp(); }, 60_000);

afterAll(async () => {
  for (const tenantId of tenantIds) await db.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
  await app?.close();
  await db.$disconnect();
});

describe('D6 — the discredited KPI scalars are gone from /overview', () => {
  it('does not return them at all', async () => {
    const f = await makeFixture();
    const res = await app.inject({
      method: 'GET', url: `/v1/receptionist/overview?clinicId=${f.clinicId}`,
      headers: auth(f, f.owner, 'OWNER'),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    for (const key of ['totalCalls', 'bookingRate', 'avgDurationSeconds', 'booked', 'appointmentRequests', 'optOuts', 'clinics', 'activeCampaigns']) {
      expect(body).not.toHaveProperty(key);
    }
  });

  it('a clinic that has answered nothing reads "unknown", not 0%', async () => {
    const f = await makeFixture();
    // The exact shape the live audit found: zero-second unanswered inbound rows.
    for (let i = 0; i < 3; i += 1) {
      await db.receptionistCallLog.create({
        data: {
          tenantId: f.tenantId, clinicId: f.clinicId, retellCallId: `call-${randomUUID()}`,
          direction: 'inbound', outcome: 'NO_ANSWER', durationSeconds: 0,
        },
      });
    }
    const res = await app.inject({
      method: 'GET', url: `/v1/receptionist/overview?clinicId=${f.clinicId}`,
      headers: auth(f, f.owner, 'OWNER'),
    });
    const body = res.json();
    expect(body.counts.answeredInbound).toBe(0);
    expect(body.rates.bookingRate).toBeNull();
    expect(body.rates.containedPct).toBeNull();
    expect(body.aht).toBeNull();
    expect(body.definitions.version).toBe('kpi-v2');
  });

  it('still reports a rate once there is a denominator', async () => {
    const f = await makeFixture();
    await db.receptionistCallLog.create({
      data: {
        tenantId: f.tenantId, clinicId: f.clinicId, retellCallId: `call-${randomUUID()}`,
        direction: 'inbound', outcome: 'BOOKED', durationSeconds: 120,
      },
    });
    await db.receptionistCallLog.create({
      data: {
        tenantId: f.tenantId, clinicId: f.clinicId, retellCallId: `call-${randomUUID()}`,
        direction: 'inbound', outcome: 'ESCALATED', durationSeconds: 60,
      },
    });
    const body = (await app.inject({
      method: 'GET', url: `/v1/receptionist/overview?clinicId=${f.clinicId}`,
      headers: auth(f, f.owner, 'OWNER'),
    })).json();
    expect(body.counts.answeredInbound).toBe(2);
    expect(body.rates.bookingRate).toBeCloseTo(0.5, 5);
    expect(body.aht).toBe(90);
  });
});

describe('D11 — patient contact on the request detail needs patient:read', () => {
  it('gives the front desk, which holds patient:read, the real numbers', async () => {
    const f = await makeFixture();
    const res = await app.inject({
      method: 'GET', url: `/v1/receptionist/appointment-requests/${f.requestId}`,
      headers: auth(f, f.frontDesk, 'FRONT_DESK'),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.patient).toMatchObject({ phone: '+12125550144', email: 'pat.roe@example.test' });
    expect(body.callLog.callerPhone).toBe(CALLER);
    expect(body.collectedPhone).toBe('+12125550143');
  });

  for (const [label, role, userKey] of [
    ['AUDITOR', 'AUDITOR', 'auditor'],
    ['COMPLIANCE_OFFICER', 'COMPLIANCE_OFFICER', 'compliance'],
  ] as const) {
    it(`withholds patient phone, email and the caller number from ${label}`, async () => {
      const f = await makeFixture();
      const res = await app.inject({
        method: 'GET', url: `/v1/receptionist/appointment-requests/${f.requestId}`,
        headers: auth(f, f[userKey], role),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      // They still see the work exists and who it is about, as the queue does.
      expect(body.patient).toMatchObject({ id: f.patientId, firstName: 'Pat', lastName: 'Roe' });
      expect(body.patient.phone).toBeUndefined();
      expect(body.patient.email).toBeUndefined();
      expect(body.callLog.callerPhone).toBeUndefined();
      expect(body.collectedPhone).toBeUndefined();
      // Masked, so they can still tell two callers apart in an audit.
      expect(body.callLog.callerPhoneMasked).toBe('***0155');
      expect(body.collectedPhoneMasked).toBe('***0143');
      // No PHI leaks through the raw serialization either.
      expect(JSON.stringify(body)).not.toContain('pat.roe@example.test');
      expect(JSON.stringify(body)).not.toContain('+12125550144');
    });
  }

  it('records whether the disclosure actually happened', async () => {
    const f = await makeFixture();
    await app.inject({
      method: 'GET', url: `/v1/receptionist/appointment-requests/${f.requestId}`,
      headers: auth(f, f.auditor, 'AUDITOR'),
    });
    const event = await db.auditEvent.findFirstOrThrow({
      where: { tenantId: f.tenantId, action: 'receptionist.appointmentRequest.read', resourceId: f.requestId },
      orderBy: { occurredAt: 'desc' },
    });
    expect((event.metadata as { contactDisclosed: boolean }).contactDisclosed).toBe(false);
  });
});
