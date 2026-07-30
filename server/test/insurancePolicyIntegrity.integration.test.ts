import 'dotenv/config';

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../workers/queues', () => ({
  redisConnection: {}, autopilotQueue: { client: Promise.resolve(undefined), add: async () => undefined },
  enqueueAutopilotExecution: async () => undefined, complianceQueue: { add: async () => undefined },
  registerComplianceSchedules: async () => undefined, campaignQueue: { add: async () => undefined },
  registerCampaignSchedules: async () => undefined,
}));

const { buildApp } = await import('../app');
const { fixtureDb: db } = await import('./helpers/fixtureDb');
const { recomputeEntitlements } = await import('../lib/entitlements');

let app: FastifyInstance;
const tenantIds: string[] = [];

async function fixture(label: string) {
  const tenantId = randomUUID();
  tenantIds.push(tenantId);
  await db.tenant.create({ data: { id: tenantId, name: `insurance-${label}`, slug: `insurance-${label}-${tenantId.slice(0, 6)}` } });
  const plan = await db.subscriptionPlan.findUniqueOrThrow({ where: { key: 'enterprise' } });
  await db.tenantSubscription.create({ data: { tenantId, planId: plan.id, status: 'ACTIVE', startedAt: new Date() } });
  await recomputeEntitlements(tenantId, db);
  const branch = await db.branch.create({ data: { tenantId, name: 'Main', location: 'Test' } });
  const user = await db.user.create({ data: { tenantId, branchId: branch.id, email: `${label}-${tenantId.slice(0, 6)}@test.invalid`, displayName: 'Insurance SME', role: 'ADMIN' } });
  const patient = await db.patient.create({ data: { tenantId, branchId: branch.id, firstName: 'Policy', lastName: 'Patient' } });
  const payer = await db.insurancePayer.create({ data: { tenantId, name: `${label} Health`, sourceProvider: 'stedi', active: true } });
  const token = app.jwt.sign({ userId: user.id, tenantId, role: 'OWNER', type: 'access' });
  return { tenantId, branchId: branch.id, patientId: patient.id, payerId: payer.id, payerName: payer.name, headers: { authorization: `Bearer ${token}` } };
}

beforeAll(async () => { app = await buildApp(); }, 60_000);
afterAll(async () => {
  for (const id of tenantIds) await db.tenant.delete({ where: { id } }).catch(() => undefined);
  await app.close();
  await db.$disconnect();
});

describe('insurance policy integrity', () => {
  it('keeps primary and secondary coverage while rejecting same-order overlap and invalid intervals', async () => {
    const f = await fixture('multi');
    const base = { patientId: f.patientId, payerId: f.payerId, effectiveFrom: '2026-01-01T00:00:00.000Z', effectiveTo: '2027-01-01T00:00:00.000Z' };
    const primary = await app.inject({ method: 'POST', url: '/v1/insurance/policies', headers: f.headers, payload: { ...base, coverageOrder: 1, planName: 'Primary PPO', memberId: 'PRI-001' } });
    const secondary = await app.inject({ method: 'POST', url: '/v1/insurance/policies', headers: f.headers, payload: { ...base, coverageOrder: 2, planName: 'Secondary PPO', memberId: 'SEC-001' } });
    expect(primary.statusCode).toBe(201);
    expect(secondary.statusCode).toBe(201);
    expect(await db.patientInsurancePolicy.count({ where: { tenantId: f.tenantId, patientId: f.patientId, active: true } })).toBe(2);

    const overlap = await app.inject({ method: 'POST', url: '/v1/insurance/policies', headers: f.headers, payload: { ...base, coverageOrder: 1, planName: 'Duplicate Primary', memberId: 'PRI-002' } });
    expect(overlap.statusCode).toBe(409);
    const invalid = await app.inject({ method: 'POST', url: '/v1/insurance/policies', headers: f.headers, payload: { ...base, effectiveFrom: base.effectiveTo, effectiveTo: base.effectiveFrom, coverageOrder: 3, planName: 'Invalid', memberId: 'BAD-001' } });
    expect(invalid.statusCode).toBe(400);

    const concurrentPatient = await db.patient.create({ data: { tenantId: f.tenantId, branchId: f.branchId, firstName: 'Concurrent', lastName: 'Primary' } });
    const [first, second] = await Promise.all([
      app.inject({ method: 'POST', url: '/v1/insurance/policies', headers: f.headers, payload: { ...base, patientId: concurrentPatient.id, coverageOrder: 1, planName: 'Concurrent A', memberId: 'CON-A' } }),
      app.inject({ method: 'POST', url: '/v1/insurance/policies', headers: f.headers, payload: { ...base, patientId: concurrentPatient.id, coverageOrder: 1, planName: 'Concurrent B', memberId: 'CON-B' } }),
    ]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([201, 409]);
  });

  it('denies cross-tenant payer/policy references and binds eligibility to the exact policy payer', async () => {
    const a = await fixture('tenant-a');
    const b = await fixture('tenant-b');
    const wrongPayer = await app.inject({ method: 'POST', url: '/v1/insurance/policies', headers: a.headers, payload: { patientId: a.patientId, payerId: b.payerId, coverageOrder: 1, planName: 'Wrong', memberId: 'WRONG-1' } });
    expect(wrongPayer.statusCode).toBe(400);

    const created = await app.inject({ method: 'POST', url: '/v1/insurance/policies', headers: a.headers, payload: { patientId: a.patientId, payerId: a.payerId, coverageOrder: 1, planName: 'Exact PPO', memberId: 'EXACT-0293' } });
    expect(created.statusCode).toBe(201);
    const policyId = created.json().id as string;
    await db.insuranceProvider.create({ data: { tenantId: a.tenantId, providerKey: 'stedi', displayName: 'Stedi', mode: 'sandbox', status: 'SANDBOX' } });

    const mismatch = await app.inject({ method: 'POST', url: '/v1/insurance/eligibility/check', headers: a.headers, payload: { patientId: a.patientId, policyId, payerName: b.payerName, memberId: 'EXACT-0293' } });
    expect(mismatch.statusCode).toBe(400);
    const crossTenantPolicy = await app.inject({ method: 'POST', url: '/v1/insurance/eligibility/check', headers: b.headers, payload: { patientId: b.patientId, policyId, payerName: a.payerName, memberId: 'EXACT-0293' } });
    expect(crossTenantPolicy.statusCode).toBe(400);
    const exact = await app.inject({ method: 'POST', url: '/v1/insurance/eligibility/check', headers: a.headers, payload: { patientId: a.patientId, policyId, payerName: a.payerName, memberId: 'EXACT-0293' } });
    expect(exact.statusCode).toBe(201);
    const verification = await db.eligibilityVerification.findUniqueOrThrow({ where: { id: exact.json().verificationId as string } });
    expect(verification.policyId).toBe(policyId);
    expect(verification.payerId).toBe(a.payerId);
    expect(verification.patientId).toBe(a.patientId);
  });
});
