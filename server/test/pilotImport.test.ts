import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
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
const { db } = await import('../lib/db');
const { signPlatformToken } = await import('../lib/platformAuth');
const { generatePasswordHash } = await import('../lib/security');

let app: FastifyInstance;
const cleanup: Array<() => Promise<void>> = [];

beforeAll(async () => { app = await buildApp(); }, 60_000);

afterAll(async () => {
  for (const fn of cleanup.reverse()) await fn().catch(() => {});
  await app?.close();
  await db.$disconnect();
});

describe('pilot import flow', () => {
  it('previews and commits patient, appointment, and insurance CSV imports', async () => {
    const tenantId = randomUUID();
    const branchId = randomUUID();
    const platformUserId = randomUUID();
    const tenantSlug = `pilot-${tenantId.slice(0, 8)}`;
    const token = signPlatformToken(app, { id: platformUserId, role: 'PLATFORM_ADMIN' });

    await db.platformUser.create({
      data: {
        id: platformUserId,
        email: `ops-${tenantId.slice(0, 8)}@carecommand.test`,
        name: 'Pilot Operator',
        passwordHash: await generatePasswordHash('pilot-password-123'),
        role: 'PLATFORM_ADMIN',
        status: 'active',
      },
    });
    cleanup.push(async () => { await db.platformUser.delete({ where: { id: platformUserId } }).catch(() => {}); });

    await db.tenant.create({ data: { id: tenantId, name: 'Pilot Clinic', slug: tenantSlug } });
    cleanup.push(async () => { await db.platformAuditEvent.deleteMany({ where: { tenantId } }).catch(() => {}); });
    cleanup.push(async () => { await db.tenant.delete({ where: { id: tenantId } }).catch(() => {}); });

    await db.branch.create({ data: { id: branchId, tenantId, name: 'Main', location: 'Main' } });

    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

    const patientCsv = [
      'external_ref,first_name,last_name,email,phone,branch_name,tags',
      'PAT-1,Maya,Lopez,maya@example.com,555-1111,Main,vip;follow-up',
      'PAT-2,Jon,Adams,jon@example.com,555-2222,Main,new-patient',
    ].join('\n');

    const patientPreview = await app.inject({
      method: 'POST',
      url: `/v1/platform/tenants/${tenantId}/pilot-import/patients/preview`,
      headers,
      payload: JSON.stringify({ csvText: patientCsv, mapping: {} }),
    });
    expect(patientPreview.statusCode).toBe(200);
    const previewBody = patientPreview.json() as { summary: { invalid: number; valid: number }; canCommit: boolean };
    expect(previewBody.summary.invalid).toBe(0);
    expect(previewBody.canCommit).toBe(true);

    const patientCommit = await app.inject({
      method: 'POST',
      url: `/v1/platform/tenants/${tenantId}/pilot-import/patients/commit`,
      headers,
      payload: JSON.stringify({ csvText: patientCsv, mapping: {} }),
    });
    expect(patientCommit.statusCode).toBe(200);
    expect(await db.patient.count({ where: { tenantId } })).toBe(2);

    const appointmentCsv = [
      'patient_external_ref,service,starts_at,ends_at,status,channel,branch_name',
      'PAT-1,Annual exam,2026-07-10T09:00:00.000Z,2026-07-10T09:30:00.000Z,CONFIRMED,EMAIL,Main',
      'PAT-2,Blood pressure follow-up,2026-07-10T10:00:00.000Z,2026-07-10T10:30:00.000Z,CONFIRMED,SMS,Main',
    ].join('\n');

    const appointmentPreview = await app.inject({
      method: 'POST',
      url: `/v1/platform/tenants/${tenantId}/pilot-import/appointments/preview`,
      headers,
      payload: JSON.stringify({ csvText: appointmentCsv, mapping: {} }),
    });
    expect(appointmentPreview.statusCode).toBe(200);
    expect((appointmentPreview.json() as { summary: { invalid: number } }).summary.invalid).toBe(0);

    const appointmentCommit = await app.inject({
      method: 'POST',
      url: `/v1/platform/tenants/${tenantId}/pilot-import/appointments/commit`,
      headers,
      payload: JSON.stringify({ csvText: appointmentCsv, mapping: {} }),
    });
    expect(appointmentCommit.statusCode).toBe(200);
    expect(await db.appointment.count({ where: { tenantId } })).toBe(2);

    const insuranceCsv = [
      'patient_external_ref,payer_name,plan_name,member_id,group_number,relationship,subscriber_name,verification_status,active,branch_name',
      'PAT-1,Blue Cross,Silver PPO,A12345,GRP-1,Self,Maya Lopez,verified,true,Main',
      'PAT-2,Blue Cross,Silver PPO,A67890,GRP-1,Self,Jon Adams,pending,true,Main',
    ].join('\n');

    const insurancePreview = await app.inject({
      method: 'POST',
      url: `/v1/platform/tenants/${tenantId}/pilot-import/insurance/preview`,
      headers,
      payload: JSON.stringify({ csvText: insuranceCsv, mapping: {} }),
    });
    expect(insurancePreview.statusCode).toBe(200);
    expect((insurancePreview.json() as { summary: { invalid: number } }).summary.invalid).toBe(0);

    const insuranceCommit = await app.inject({
      method: 'POST',
      url: `/v1/platform/tenants/${tenantId}/pilot-import/insurance/commit`,
      headers,
      payload: JSON.stringify({ csvText: insuranceCsv, mapping: {} }),
    });
    expect(insuranceCommit.statusCode).toBe(200);
    expect(await db.patientInsurancePolicy.count({ where: { tenantId } })).toBe(2);

    const checklist = await app.inject({
      method: 'GET',
      url: `/v1/platform/tenants/${tenantId}/pilot-checklist`,
      headers,
    });
    expect(checklist.statusCode).toBe(200);
    const checklistBody = checklist.json() as { readinessScore: number; items: Array<{ done: boolean }> };
    expect(checklistBody.readinessScore).toBeGreaterThan(0);
    expect(checklistBody.items.some(item => item.done)).toBe(true);

    const template = await app.inject({
      method: 'GET',
      url: `/v1/platform/tenants/${tenantId}/pilot-import/patients/template.csv`,
      headers,
    });
    expect(template.statusCode).toBe(200);
    expect(template.headers['content-type']).toContain('text/csv');
    expect(template.body).toContain('first_name');

    const savedPreset = await app.inject({
      method: 'POST',
      url: `/v1/platform/tenants/${tenantId}/pilot-import/presets`,
      headers,
      payload: JSON.stringify({
        entityType: 'patients',
        name: 'EHR export',
        mapping: {
          externalRef: 'external_ref',
          firstName: 'first_name',
          lastName: 'last_name',
          email: 'email',
          phone: 'phone',
          branchName: 'branch_name',
        },
        isDefault: true,
      }),
    });
    expect(savedPreset.statusCode).toBe(201);

    const presetPreview = await app.inject({
      method: 'POST',
      url: `/v1/platform/tenants/${tenantId}/pilot-import/patients/preview`,
      headers,
      payload: JSON.stringify({
        csvText: patientCsv,
        mapping: {},
      }),
    });
    expect(presetPreview.statusCode).toBe(200);
    const presetPreviewBody = presetPreview.json() as { preset: { name: string } | null; mapping: Record<string, string> };
    expect(presetPreviewBody.preset?.name).toBe('EHR export');
    expect(presetPreviewBody.mapping.firstName).toBe('first_name');

    const shareLink = await app.inject({
      method: 'POST',
      url: `/v1/platform/tenants/${tenantId}/pilot-status-links`,
      headers,
      payload: JSON.stringify({ label: 'Prospect status', expiresInDays: 7 }),
    });
    expect(shareLink.statusCode).toBe(201);
    const shareBody = shareLink.json() as { token: string; url: string };
    expect(shareBody.token).toBeTruthy();
    expect(shareBody.url).toContain('/pilot/');

    const publicStatus = await app.inject({
      method: 'GET',
      url: `/v1/pilot/share/${shareBody.token}`,
    });
    expect(publicStatus.statusCode).toBe(200);
    const publicStatusBody = publicStatus.json() as { checklist: { readinessScore: number } };
    expect(publicStatusBody.checklist.readinessScore).toBeGreaterThan(0);
  });
});
