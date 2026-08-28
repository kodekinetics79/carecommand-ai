import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

// Stub the BullMQ queues module so no Redis connection opens (rate-limiter
// falls back to its in-memory store) and the test process exits cleanly.
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
const { db } = await import('../lib/db');
const { recomputeEntitlements } = await import('../lib/entitlements');

let app: FastifyInstance;
const createdTenantIds: string[] = [];

async function makeTenant(planKey: 'enterprise' | 'starter') {
  const id = randomUUID();
  await db.tenant.create({ data: { id, name: `it-${id.slice(0, 6)}`, slug: `it-${id.slice(0, 8)}` } });
  createdTenantIds.push(id);
  const plan = await db.subscriptionPlan.findUnique({ where: { key: planKey } });
  await db.tenantSubscription.create({ data: { tenantId: id, planId: plan!.id, status: 'ACTIVE', startedAt: new Date() } });
  await recomputeEntitlements(id);
  const branch = await db.branch.create({ data: { tenantId: id, name: 'b', location: 'x' } });
  const patient = await db.patient.create({ data: { tenantId: id, branchId: branch.id, firstName: 'IT', lastName: 'Patient', lifecycleStage: 'NEW' } });
  // Real users — the auth plugin derives the role from the DB user, not the token.
  const adminUser = await db.user.create({ data: { tenantId: id, role: 'ADMIN', active: true, email: `a-${id.slice(0, 8)}@it.test`, displayName: 'Admin' } });
  const providerUser = await db.user.create({ data: { tenantId: id, role: 'PROVIDER', active: true, email: `p-${id.slice(0, 8)}@it.test`, displayName: 'Provider' } });
  return { id, branchId: branch.id, patientId: patient.id, adminUserId: adminUser.id, providerUserId: providerUser.id };
}
const tok = (tenantId: string, userId: string) => app.jwt.sign({ userId, tenantId, type: 'access' });
const auth = (t: string, ip = '203.0.113.1') => ({ authorization: `Bearer ${t}`, 'x-forwarded-for': ip });

beforeAll(async () => {
  app = await buildApp();
}, 60_000);

afterAll(async () => {
  for (const id of createdTenantIds) await db.tenant.delete({ where: { id } }).catch(() => {});
  await app?.close();
  await db.$disconnect();
});

describe('insurance provider registry + eligibility (integration)', () => {
  it('configures Stedi sandbox, runs a health check, and never returns config', async () => {
    const t = await makeTenant('enterprise');
    const admin = tok(t.id, t.adminUserId);

    const cfg = await app.inject({ method: 'POST', url: '/v1/insurance/providers/stedi/configure', headers: auth(admin), payload: { mode: 'sandbox', config: {} } });
    expect(cfg.statusCode).toBe(200);
    const cfgBody = JSON.parse(cfg.body);
    expect(cfgBody.status).toBe('SANDBOX');
    expect(cfgBody).not.toHaveProperty('encryptedConfig');

    const health = await app.inject({ method: 'POST', url: '/v1/insurance/providers/stedi/health-check', headers: auth(admin) });
    expect(health.statusCode).toBe(200);
    expect(JSON.parse(health.body).lastHealthStatus).toBe('healthy');

    // Optum stays NOT_CONFIGURED (no fake active integration).
    const list = JSON.parse((await app.inject({ method: 'GET', url: '/v1/insurance/providers', headers: auth(admin) })).body);
    expect(list.find((p: { key: string }) => p.key === 'optum').status).toBe('NOT_CONFIGURED');
  });

  it('runs ACTIVE + INACTIVE eligibility checks and masks the member id', async () => {
    const t = await makeTenant('enterprise');
    const admin = tok(t.id, t.adminUserId);
    await app.inject({ method: 'POST', url: '/v1/insurance/providers/stedi/configure', headers: auth(admin), payload: { mode: 'sandbox', config: {} } });

    const active = JSON.parse((await app.inject({ method: 'POST', url: '/v1/insurance/eligibility/check', headers: auth(admin), payload: { patientId: t.patientId, payerName: 'Aetna', memberId: 'AET-110293' } })).body);
    expect(active.status).toBe('ACTIVE');
    expect(active.maskedMemberId).toBe('••••0293');

    const inactive = JSON.parse((await app.inject({ method: 'POST', url: '/v1/insurance/eligibility/check', headers: auth(admin), payload: { patientId: t.patientId, payerName: 'Aetna', memberId: 'AET-1100' } })).body);
    expect(inactive.status).toBe('INACTIVE');

    const history = JSON.parse((await app.inject({ method: 'GET', url: '/v1/insurance/eligibility/history', headers: auth(admin) })).body);
    expect(history.length).toBe(2);
  });

  it('enforces RBAC — a PROVIDER cannot configure providers', async () => {
    const t = await makeTenant('enterprise');
    const res = await app.inject({ method: 'POST', url: '/v1/insurance/providers/stedi/configure', headers: auth(tok(t.id, t.providerUserId)), payload: { mode: 'sandbox', config: {} } });
    expect(res.statusCode).toBe(403);
  });

  it('enforces feature gating — a starter plan has no eligibility surface', async () => {
    const t = await makeTenant('starter');
    const res = await app.inject({ method: 'GET', url: '/v1/insurance/providers', headers: auth(tok(t.id, t.adminUserId)) });
    expect(res.statusCode).toBe(403);
  });

  it('enforces tenant isolation — one tenant cannot see another tenant’s history', async () => {
    const a = await makeTenant('enterprise');
    const b = await makeTenant('enterprise');
    const aAdmin = tok(a.id, a.adminUserId);
    await app.inject({ method: 'POST', url: '/v1/insurance/providers/stedi/configure', headers: auth(aAdmin), payload: { mode: 'sandbox', config: {} } });
    await app.inject({ method: 'POST', url: '/v1/insurance/eligibility/check', headers: auth(aAdmin), payload: { patientId: a.patientId, payerName: 'Aetna', memberId: 'AET-110293' } });

    const aHistory = JSON.parse((await app.inject({ method: 'GET', url: '/v1/insurance/eligibility/history', headers: auth(aAdmin) })).body);
    expect(aHistory.length).toBe(1);
    const bHistory = JSON.parse((await app.inject({ method: 'GET', url: '/v1/insurance/eligibility/history', headers: auth(tok(b.id, b.adminUserId)) })).body);
    expect(bHistory.length).toBe(0);
  });
});

describe('connected care — enrollment, webhook ingest, RPM readiness (integration)', () => {
  it('enrolls a patient, ingests a webhook reading, and creates a backend-decided alert', async () => {
    const t = await makeTenant('enterprise');
    const admin = tok(t.id, t.adminUserId);

    const enroll = await app.inject({ method: 'POST', url: '/v1/connected-care/enrollments', headers: auth(admin), payload: { patientId: t.patientId, providerKey: 'manual', externalRef: 'EXT-IT-1' } });
    expect(enroll.statusCode).toBe(201);

    const hook = await app.inject({ method: 'POST', url: `/v1/connected-care/${t.id}/providers/manual/webhook`, payload: { readings: [{ patientExternalRef: 'EXT-IT-1', readingType: 'glucose', value: '330', numericValue: 330, unit: 'mg/dL' }] } });
    expect(hook.statusCode).toBe(200);
    const hb = JSON.parse(hook.body);
    expect(hb.ingested).toBe(1);
    expect(hb.alertsCreated).toBe(1); // 330 mg/dL → critical, decided server-side

    const logs = JSON.parse((await app.inject({ method: 'GET', url: '/v1/connected-care/sync-logs', headers: auth(admin) })).body);
    expect(logs[0].readingsIngested).toBe(1);
  });

  it('computes RPM readiness with consent + signoff and exposes the requirement checklist', async () => {
    const t = await makeTenant('enterprise');
    const admin = tok(t.id, t.adminUserId);
    await app.inject({ method: 'POST', url: '/v1/connected-care/enrollments', headers: auth(admin), payload: { patientId: t.patientId, providerKey: 'manual' } });
    await app.inject({ method: 'POST', url: '/v1/connected-care/consent', headers: auth(admin), payload: { patientId: t.patientId, consentType: 'rpm', granted: true } });

    const readiness = JSON.parse((await app.inject({ method: 'GET', url: '/v1/connected-care/rpm-readiness', headers: auth(admin) })).body);
    expect(readiness.length).toBe(1);
    // Fresh patient has no device-days yet → not billable, requirement listed.
    expect(readiness[0].status).toBe('MISSING_REQUIREMENTS');
    expect(readiness[0].requirements.some((r: { key: string; met: boolean }) => r.key === 'reading_days' && !r.met)).toBe(true);

    // Signoff is recorded but does not make an under-qualified patient READY.
    const signed = JSON.parse((await app.inject({ method: 'POST', url: `/v1/connected-care/rpm-readiness/${t.patientId}/signoff`, headers: auth(admin) })).body);
    expect(signed.status).toBe('MISSING_REQUIREMENTS');
  });
});
