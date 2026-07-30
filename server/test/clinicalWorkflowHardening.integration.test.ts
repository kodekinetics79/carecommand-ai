import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

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
const { readingTrendMap } = await import('../modules/monitoring/routes');
const { insuranceCardState } = await import('../modules/portal/routes');
const { issuePortalSession } = await import('../lib/portalAuth');

let app: FastifyInstance;
const tenantIds: string[] = [];

async function fixture() {
  const tenantId = randomUUID();
  tenantIds.push(tenantId);
  const slug = `clinical-${tenantId.slice(0, 8)}`;
  await db.tenant.create({ data: { id: tenantId, name: 'Clinical hardening', slug } });
  const plan = await db.subscriptionPlan.findUniqueOrThrow({ where: { key: 'enterprise' } });
  await db.tenantSubscription.create({ data: { tenantId, planId: plan.id, status: 'ACTIVE', startedAt: new Date() } });
  await recomputeEntitlements(tenantId, db);
  const [branchA, branchB] = await Promise.all([
    db.branch.create({ data: { tenantId, name: 'A', location: 'A' } }),
    db.branch.create({ data: { tenantId, name: 'B', location: 'B' } }),
  ]);
  const [patientA, patientB] = await Promise.all([
    db.patient.create({ data: { tenantId, branchId: branchA.id, firstName: 'Alice', lastName: 'A', email: `victim-${tenantId}@test.invalid`, phone: '+15550100001', dateOfBirth: new Date('1990-01-01T00:00:00.000Z') } }),
    db.patient.create({ data: { tenantId, branchId: branchB.id, firstName: 'Bob', lastName: 'B', email: `b-${tenantId}@test.invalid`, phone: '+15550100002' } }),
  ]);
  const admin = await db.user.create({ data: { tenantId, branchId: branchA.id, email: `admin-${tenantId}@test.invalid`, displayName: 'Branch A Admin', role: 'ADMIN' } });
  const portalReviewer = await db.user.create({ data: { tenantId, email: `reviewer-${tenantId}@test.invalid`, displayName: 'Tenant Reviewer', role: 'OWNER' } });
  const account = await db.patientPortalAccount.create({ data: { tenantId, patientId: patientA.id, email: patientA.email, phone: patientA.phone, status: 'active' } });
  return { tenantId, slug, branchA, branchB, patientA, patientB, admin, portalReviewer, account };
}

const staff = (t: Awaited<ReturnType<typeof fixture>>) => ({
  authorization: `Bearer ${app.jwt.sign({ tenantId: t.tenantId, userId: t.admin.id, role: 'ADMIN', type: 'access' })}`,
  'x-forwarded-for': `198.51.100.${Math.floor(Math.random() * 200) + 1}`,
});
const reviewStaff = (t: Awaited<ReturnType<typeof fixture>>) => ({
  authorization: `Bearer ${app.jwt.sign({ tenantId: t.tenantId, userId: t.portalReviewer.id, role: 'OWNER', type: 'access' })}`,
  'x-forwarded-for': `198.51.100.${Math.floor(Math.random() * 200) + 1}`,
});

beforeAll(async () => { app = await buildApp(); }, 60_000);
afterAll(async () => {
  for (const tenantId of tenantIds) await db.tenant.delete({ where: { id: tenantId } }).catch(() => {});
  await app.close();
  await db.$disconnect();
});

describe('portal identity and insurance truthfulness', () => {
  it('does not grant or deliver a token when valid victim phone is paired with attacker email', async () => {
    const t = await fixture();
    const attackerEmail = `attacker-${randomUUID()}@test.invalid`;
    const before = await db.patientPortalToken.count({ where: { tenantId: t.tenantId } });

    const signup = await app.inject({ method: 'POST', url: '/v1/portal/auth/signup', payload: { clinicSlug: t.slug, email: attackerEmail, phone: t.patientA.phone } });
    const requestLink = await app.inject({ method: 'POST', url: '/v1/portal/auth/request-link', payload: { clinicSlug: t.slug, email: attackerEmail, phone: t.patientA.phone } });

    expect(signup.statusCode).toBe(200);
    expect(signup.json()).not.toHaveProperty('devToken');
    expect(requestLink.statusCode).toBe(200);
    expect(requestLink.json()).not.toHaveProperty('devToken');
    expect(await db.patientPortalToken.count({ where: { tenantId: t.tenantId } })).toBe(before);
    expect(await db.portalAccessRequest.count({ where: { tenantId: t.tenantId, email: attackerEmail, status: 'pending' } })).toBe(1);
  });

  it('blocks an active portal JWT as soon as its patient is soft-deleted', async () => {
    const t = await fixture();
    const token = await issuePortalSession(app, t.account, db);
    await db.patient.update({ where: { id: t.patientA.id }, data: { deletedAt: new Date() } });
    const headers = { authorization: `Bearer ${token}` };
    expect((await app.inject({ method: 'GET', url: '/v1/portal/auth/me', headers })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/v1/portal/dashboard', headers })).statusCode).toBe(401);
  });

  it('allows exactly one concurrent access-request approval and one credential/audit', async () => {
    const t = await fixture();
    const accessRequest = await db.portalAccessRequest.create({ data: { tenantId: t.tenantId, email: t.patientA.email, status: 'pending', matchCount: 0 } });
    const beforeTokens = await db.patientPortalToken.count({ where: { tenantId: t.tenantId, accountId: t.account.id } });
    const approve = () => app.inject({ method: 'POST', url: `/v1/portal-admin/access-requests/${accessRequest.id}/approve`, headers: reviewStaff(t), payload: { patientId: t.patientA.id, authority: 'self', authorityConfirmed: true } });
    const responses = await Promise.all([approve(), approve()]);
    expect(responses.map(r => r.statusCode).sort()).toEqual([200, 409]);
    expect(await db.patientPortalToken.count({ where: { tenantId: t.tenantId, accountId: t.account.id } })).toBe(beforeTokens + 1);
    expect(await db.auditEvent.count({ where: { tenantId: t.tenantId, action: 'portal.access_request.approved', resourceId: accessRequest.id } })).toBe(1);
  });

  it('never labels pending, unknown, failed, or expired insurance as complete', () => {
    expect(insuranceCardState('verified_recently')).toBe('completed');
    expect(insuranceCardState('pending_review')).toBe('pending_review');
    expect(insuranceCardState('on_file')).toBe('pending_review');
    expect(insuranceCardState('unable_to_verify')).toBe('action_required');
    expect(insuranceCardState('expired')).toBe('action_required');
  });
});

describe('clinical workflow integrity', () => {
  it('rejects terminal-state creation, future DOB, spoofed provenance, and inconsistent readings', async () => {
    const t = await fixture();
    const headers = staff(t);
    const startsAt = new Date(Date.now() + 3_600_000);
    const appointment = await app.inject({ method: 'POST', url: '/v1/appointments', headers, payload: {
      branchId: t.branchA.id, patientId: t.patientA.id, service: 'Review', startsAt, endsAt: new Date(startsAt.getTime() + 1_800_000), channel: 'EMAIL', status: 'COMPLETED',
    } });
    const futureDob = await app.inject({ method: 'POST', url: '/v1/patients', headers, payload: {
      branchId: t.branchA.id, firstName: 'Future', lastName: 'Patient', dateOfBirth: '2999-01-01',
    } });
    const spoofed = await app.inject({ method: 'POST', url: '/v1/monitoring/readings/ingest', headers, payload: {
      patientId: t.patientA.id, readingType: 'glucose', value: '120', source: 'webhook',
    } });
    const inconsistent = await app.inject({ method: 'POST', url: '/v1/monitoring/readings/ingest', headers, payload: {
      patientId: t.patientA.id, readingType: 'glucose', value: '120', numericValue: 330, unit: 'mg/dL', source: 'manual',
    } });

    expect(appointment.statusCode).toBe(400);
    expect(futureDob.statusCode).toBe(400);
    expect(spoofed.statusCode).toBe(400);
    expect(inconsistent.statusCode).toBe(400);
  });

  it('blocks patient deactivation while a future active appointment still requires disposition', async () => {
    const t = await fixture();
    const startsAt = new Date(Date.now() + 86_400_000);
    await db.appointment.create({ data: { tenantId: t.tenantId, branchId: t.branchA.id, patientId: t.patientA.id, service: 'Future visit', startsAt, endsAt: new Date(startsAt.getTime() + 1_800_000), channel: 'EMAIL' } });
    const response = await app.inject({ method: 'DELETE', url: `/v1/patients/${t.patientA.id}`, headers: staff(t) });
    expect(response.statusCode).toBe(409);
    expect((await db.patient.findUniqueOrThrow({ where: { id: t.patientA.id } })).deletedAt).toBeNull();
    expect((await db.patientPortalAccount.findUniqueOrThrow({ where: { id: t.account.id } })).status).toBe('active');
  });

  it('atomically persists an abnormal reading with its alert, notification, and audit', async () => {
    const t = await fixture();
    const response = await app.inject({ method: 'POST', url: '/v1/monitoring/readings/ingest', headers: staff(t), payload: {
      patientId: t.patientA.id, readingType: 'glucose', value: '330', numericValue: 330, unit: 'mg/dL', source: 'manual',
    } });
    expect(response.statusCode).toBe(201);
    const result = response.json();
    expect(result.severity).toBe('critical');
    const [alert, notification, audit] = await Promise.all([
      db.readingAlert.findUnique({ where: { id: result.alertId } }),
      db.notificationEvent.findFirst({ where: { tenantId: t.tenantId, alertId: result.alertId } }),
      db.auditEvent.findFirst({ where: { tenantId: t.tenantId, action: 'monitoring.reading.ingested', resourceId: result.readingId } }),
    ]);
    expect(alert?.readingId).toBe(result.readingId);
    expect(notification).not.toBeNull();
    expect(audit).not.toBeNull();
  });

  it('enforces patient branch on manual ingestion and branch-scopes monitoring summaries', async () => {
    const t = await fixture();
    const headers = staff(t);
    const crossBranch = await app.inject({ method: 'POST', url: '/v1/monitoring/readings/ingest', headers, payload: {
      patientId: t.patientB.id, readingType: 'glucose', value: '120', unit: 'mg/dL', source: 'manual',
    } });
    expect(crossBranch.statusCode).toBe(403);

    const today = new Date(); today.setHours(8, 0, 0, 0);
    await Promise.all([
      db.morningBriefingSignal.create({ data: { tenantId: t.tenantId, branchId: t.branchA.id, patientId: t.patientA.id, signalType: 'review', title: 'A-only', forDate: today } }),
      db.morningBriefingSignal.create({ data: { tenantId: t.tenantId, branchId: t.branchB.id, patientId: t.patientB.id, signalType: 'review', title: 'B-secret', forDate: today } }),
      db.notificationEvent.create({ data: { tenantId: t.tenantId, patientId: t.patientA.id, recipientType: 'nurse', recipientLabel: 'A queue', channel: 'in_app', status: 'sent' } }),
      db.notificationEvent.create({ data: { tenantId: t.tenantId, patientId: t.patientB.id, recipientType: 'nurse', recipientLabel: 'B queue', channel: 'in_app', status: 'sent' } }),
    ]);
    const briefing = (await app.inject({ method: 'GET', url: '/v1/monitoring/morning-briefing', headers })).json();
    const overview = (await app.inject({ method: 'GET', url: '/v1/monitoring/overview', headers })).json();
    expect(briefing.signals.map((s: { title: string }) => s.title)).toContain('A-only');
    expect(briefing.signals.map((s: { title: string }) => s.title)).not.toContain('B-secret');
    expect(briefing.ai).toBeNull();
    expect(overview.notifications.map((n: { patientName: string | null }) => n.patientName)).toContain('Alice A');
    expect(overview.notifications.map((n: { patientName: string | null }) => n.patientName)).not.toContain('Bob B');
  });

  it('does not count ordinary valid readings as abnormal risk and computes trend direction chronologically', async () => {
    const t = await fixture();
    const now = new Date();
    await db.deviceReading.create({ data: { tenantId: t.tenantId, branchId: t.branchA.id, patientId: t.patientA.id, readingType: 'glucose', value: '110', numericValue: 110, capturedAt: now } });
    await db.readingAlert.create({ data: { tenantId: t.tenantId, branchId: t.branchA.id, patientId: t.patientA.id, severity: 'warning', alertType: 'device_offline', status: 'open' } });
    const atRisk = (await app.inject({ method: 'GET', url: '/v1/monitoring/patients-at-risk', headers: staff(t) })).json();
    expect(atRisk.map((p: { patientId: string }) => p.patientId)).not.toContain(t.patientA.id);

    const trends = readingTrendMap([
      { id: 'new', patientId: t.patientA.id, readingType: 'glucose', numericValue: 130, capturedAt: new Date('2026-01-02') },
      { id: 'old', patientId: t.patientA.id, readingType: 'glucose', numericValue: 100, capturedAt: new Date('2026-01-01') },
    ]);
    expect(trends.get('new')).toBe('up');
    expect(trends.get('old')).toBe('flat');
  });
});
