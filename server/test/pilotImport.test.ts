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
const { fixtureDb: db } = await import('./helpers/fixtureDb');
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

    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': `pilot-flow-${tenantId}` };
    const operationHeaders = (operation: string) => ({ ...headers, 'idempotency-key': `pilot-${operation}-${tenantId}` });

    // Pilot routes read and write clinic data, so they now require a live
    // break-glass session. Opening one is part of the operator flow.
    const supportOpened = await app.inject({ method: 'POST', url: `/v1/platform/tenants/${tenantId}/support-session`, headers: { authorization: headers.authorization, 'content-type': 'application/json' }, payload: { reason: 'Pilot onboarding import', minutes: 60 } });
    expect(supportOpened.statusCode).toBe(200);

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
      headers: operationHeaders('patients'),
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
      headers: operationHeaders('appointments'),
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
      headers: operationHeaders('insurance'),
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

    const presetPayload = {
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
    };
    const savedPreset = await app.inject({
      method: 'POST',
      url: `/v1/platform/tenants/${tenantId}/pilot-import/presets`,
      headers: operationHeaders('preset'),
      payload: JSON.stringify(presetPayload),
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

    const originalPresetResponse = savedPreset.json();
    await db.pilotImportPreset.update({
      where: { id: originalPresetResponse.id },
      data: { name: 'Later edited preset', mapping: { firstName: 'later_first_name' }, isDefault: false },
    });
    const presetReplay = await app.inject({
      method: 'POST', url: `/v1/platform/tenants/${tenantId}/pilot-import/presets`,
      headers: operationHeaders('preset'), payload: JSON.stringify(presetPayload),
    });
    expect(presetReplay.statusCode).toBe(201);
    expect(presetReplay.json()).toEqual(originalPresetResponse);
    const differentKeyPreset = await app.inject({
      method: 'POST', url: `/v1/platform/tenants/${tenantId}/pilot-import/presets`,
      headers: operationHeaders('preset-new-key'), payload: JSON.stringify(presetPayload),
    });
    expect(differentKeyPreset.statusCode).toBe(201);
    expect(differentKeyPreset.json().id).not.toBe(originalPresetResponse.id);

    const receiptCsv = ['external_ref,first_name,last_name,branch_name', 'RECEIPT-1,Original,Response,Main'].join('\n');
    const receiptRequest = { csvText: receiptCsv, mapping: {} };
    const firstImport = await app.inject({
      method: 'POST', url: `/v1/platform/tenants/${tenantId}/pilot-import/patients/commit`,
      headers: operationHeaders('import-receipt'), payload: JSON.stringify(receiptRequest),
    });
    expect(firstImport.statusCode).toBe(200);
    const originalImportResponse = firstImport.json();
    const receiptPatient = await db.patient.findUniqueOrThrow({ where: { tenantId_externalRef: { tenantId, externalRef: 'RECEIPT-1' } } });
    const importAuditCount = await db.auditEvent.count({ where: { tenantId, action: 'pilot.import.committed' } });
    await db.pilotImportPreset.update({
      where: { id: differentKeyPreset.json().id },
      data: { mapping: { firstName: 'missing_first_name', lastName: 'missing_last_name' } },
    });
    const importReplay = await app.inject({
      method: 'POST', url: `/v1/platform/tenants/${tenantId}/pilot-import/patients/commit`,
      headers: operationHeaders('import-receipt'), payload: JSON.stringify(receiptRequest),
    });
    expect(importReplay.statusCode).toBe(200);
    expect(importReplay.json()).toEqual(originalImportResponse);
    expect((await db.patient.findUniqueOrThrow({ where: { id: receiptPatient.id } })).updatedAt.toISOString()).toBe(receiptPatient.updatedAt.toISOString());
    expect(await db.auditEvent.count({ where: { tenantId, action: 'pilot.import.committed' } })).toBe(importAuditCount);

    const changedImportPayload = await app.inject({
      method: 'POST', url: `/v1/platform/tenants/${tenantId}/pilot-import/patients/commit`,
      headers: operationHeaders('import-receipt'),
      payload: JSON.stringify({ csvText: `${receiptCsv}\nRECEIPT-2,Changed,Payload,Main`, mapping: {} }),
    });
    expect(changedImportPayload.statusCode).toBe(409);
    await db.pilotImportPreset.update({ where: { id: differentKeyPreset.json().id }, data: { mapping: presetPayload.mapping } });
    const differentKeyImport = await app.inject({
      method: 'POST', url: `/v1/platform/tenants/${tenantId}/pilot-import/patients/commit`,
      headers: operationHeaders('import-new-key'), payload: JSON.stringify(receiptRequest),
    });
    expect(differentKeyImport.statusCode).toBe(200);
    expect(differentKeyImport.json().summary).toMatchObject({ created: 0, updated: 1 });

    const shareLink = await app.inject({
      method: 'POST',
      url: `/v1/platform/tenants/${tenantId}/pilot-status-links`,
      headers: operationHeaders('share'),
      payload: JSON.stringify({ label: 'Prospect status', expiresInDays: 7 }),
    });
    expect(shareLink.statusCode).toBe(201);
    const shareBody = shareLink.json() as { id: string; token: string; url: string; [key: string]: unknown };
    expect(shareBody.token).toBeTruthy();
    expect(shareBody.url).toContain('/pilot/');

    await db.tenant.update({ where: { id: tenantId }, data: { name: 'Later Tenant Name', slug: `later-${tenantId.slice(0, 8)}` } });
    await db.pilotStatusShare.update({ where: { id: shareBody.id }, data: { label: 'Later link label', expiresAt: new Date(Date.now() + 40 * 86400000) } });

    const shareReplay = await app.inject({
      method: 'POST',
      url: `/v1/platform/tenants/${tenantId}/pilot-status-links`,
      headers: operationHeaders('share'),
      payload: JSON.stringify({ label: 'Prospect status', expiresInDays: 7 }),
    });
    expect(shareReplay.statusCode).toBe(201);
    expect(shareReplay.json()).toEqual(shareBody);

    const keyReuseConflict = await app.inject({
      method: 'POST',
      url: `/v1/platform/tenants/${tenantId}/pilot-status-links`,
      headers: operationHeaders('share'),
      payload: JSON.stringify({ label: 'Different status payload', expiresInDays: 30 }),
    });
    expect(keyReuseConflict.statusCode).toBe(409);
    expect(keyReuseConflict.json()).toMatchObject({ error: 'pilot_idempotency_conflict' });
    expect(await db.pilotStatusShare.count({ where: { tenantId } })).toBe(1);
    expect(await db.platformAuditEvent.count({ where: { tenantId, action: 'pilot.status_link.created.requested' } })).toBe(1);

    const listedShares = await app.inject({
      method: 'GET',
      url: `/v1/platform/tenants/${tenantId}/pilot-status-links`,
      headers,
    });
    expect(listedShares.statusCode).toBe(200);
    expect(listedShares.json()).toEqual([
      expect.objectContaining({ id: shareReplay.json().id, publicUrlAvailable: false, url: null }),
    ]);

    const publicStatus = await app.inject({
      method: 'GET',
      url: `/v1/pilot/share/${shareBody.token}`,
    });
    expect(publicStatus.statusCode).toBe(200);
    const publicStatusBody = publicStatus.json() as { checklist: { readinessScore: number } };
    expect(publicStatusBody.checklist.readinessScore).toBeGreaterThan(0);

    const revoked = await app.inject({
      method: 'DELETE',
      url: `/v1/platform/tenants/${tenantId}/pilot-status-links/${shareBody.id}`,
      headers: operationHeaders('revoke-share'),
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toMatchObject({ id: shareBody.id, active: false, alreadyInactive: false });
    expect((await app.inject({ method: 'GET', url: `/v1/pilot/share/${shareBody.token}` })).statusCode).toBe(404);
    expect(await db.auditEvent.count({ where: { tenantId, action: 'pilot.status_link.revoked', resourceId: shareBody.id } })).toBe(1);

    const revokeRetry = await app.inject({
      method: 'DELETE',
      url: `/v1/platform/tenants/${tenantId}/pilot-status-links/${shareBody.id}`,
      headers: operationHeaders('revoke-share-retry'),
    });
    expect(revokeRetry.statusCode).toBe(200);
    expect(revokeRetry.json()).toMatchObject({ id: shareBody.id, active: false, alreadyInactive: true });
    expect(await db.auditEvent.count({ where: { tenantId, action: 'pilot.status_link.revoked', resourceId: shareBody.id } })).toBe(1);
  });

  it('does not disclose or mark a public pilot share viewed when durable platform intent fails', async () => {
    const tenantId = randomUUID();
    const platformUserId = randomUUID();
    await db.platformUser.create({
      data: {
        id: platformUserId,
        email: `share-audit-${platformUserId.slice(0, 8)}@carecommand.test`,
        name: 'Pilot Share Audit Operator',
        passwordHash: await generatePasswordHash('pilot-share-audit-password-2026!'),
        role: 'PLATFORM_ADMIN',
        status: 'active',
      },
    });
    await db.tenant.create({ data: { id: tenantId, name: 'Pilot Share Audit Clinic', slug: `pilot-share-audit-${tenantId.slice(0, 8)}` } });
    cleanup.push(async () => { await db.platformAuditEvent.deleteMany({ where: { tenantId } }); });
    cleanup.push(async () => { await db.tenant.delete({ where: { id: tenantId } }); });
    cleanup.push(async () => { await db.platformUser.delete({ where: { id: platformUserId } }); });

    const headers = {
      authorization: `Bearer ${signPlatformToken(app, { id: platformUserId, role: 'PLATFORM_ADMIN' })}`,
      'content-type': 'application/json',
      'idempotency-key': `pilot-share-${tenantId}`,
    };

    // Pilot routes read and write clinic data, so they now require a live
    // break-glass session. Opening one is part of the operator flow.
    const supportOpened = await app.inject({ method: 'POST', url: `/v1/platform/tenants/${tenantId}/support-session`, headers: { authorization: headers.authorization, 'content-type': 'application/json' }, payload: { reason: 'Pilot onboarding import', minutes: 60 } });
    expect(supportOpened.statusCode).toBe(200);
    const created = await app.inject({
      method: 'POST',
      url: `/v1/platform/tenants/${tenantId}/pilot-status-links`,
      headers,
      payload: JSON.stringify({ label: 'Durable public share', expiresInDays: 7 }),
    });
    expect(created.statusCode).toBe(201);
    const share = created.json() as { id: string; token: string };

    const suffix = randomUUID().replaceAll('-', '');
    const functionName = `test_pilot_share_audit_fail_fn_${suffix}`;
    const triggerName = `test_pilot_share_audit_fail_trg_${suffix}`;
    await db.$executeRawUnsafe(`
      CREATE FUNCTION public."${functionName}"() RETURNS trigger
      LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW."tenantId" = '${tenantId}'::uuid AND NEW.action = 'pilot.status_link.view.requested' THEN
          RAISE EXCEPTION 'injected mandatory pilot share audit failure';
        END IF;
        RETURN NEW;
      END
      $fn$
    `);
    await db.$executeRawUnsafe(`CREATE TRIGGER "${triggerName}" BEFORE INSERT ON public."PlatformAuditEvent" FOR EACH ROW EXECUTE FUNCTION public."${functionName}"()`);
    const removeFault = async () => {
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON public."PlatformAuditEvent"`);
      await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS public."${functionName}"()`);
    };
    cleanup.push(removeFault);

    const failed = await app.inject({ method: 'GET', url: `/v1/pilot/share/${share.token}` });
    expect(failed.statusCode).toBe(500);
    expect((await db.pilotStatusShare.findUniqueOrThrow({ where: { id: share.id } })).lastViewedAt).toBeNull();
    expect(await db.auditEvent.count({ where: { tenantId, action: 'pilot.status_link.viewed', resourceId: share.id } })).toBe(0);

    await removeFault();
    cleanup.pop();
    const tenantFunctionName = `test_pilot_share_tenant_audit_fail_fn_${suffix}`;
    const tenantTriggerName = `test_pilot_share_tenant_audit_fail_trg_${suffix}`;
    await db.$executeRawUnsafe(`
      CREATE FUNCTION public."${tenantFunctionName}"() RETURNS trigger
      LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW."tenantId" = '${tenantId}'::uuid AND NEW.action = 'pilot.status_link.viewed' THEN
          RAISE EXCEPTION 'injected mandatory tenant share audit failure';
        END IF;
        RETURN NEW;
      END
      $fn$
    `);
    await db.$executeRawUnsafe(`CREATE TRIGGER "${tenantTriggerName}" BEFORE INSERT ON public."AuditEvent" FOR EACH ROW EXECUTE FUNCTION public."${tenantFunctionName}"()`);
    const removeTenantFault = async () => {
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${tenantTriggerName}" ON public."AuditEvent"`);
      await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS public."${tenantFunctionName}"()`);
    };
    cleanup.push(removeTenantFault);
    const tenantAuditFailed = await app.inject({ method: 'GET', url: `/v1/pilot/share/${share.token}` });
    expect(tenantAuditFailed.statusCode).toBe(500);
    expect((await db.pilotStatusShare.findUniqueOrThrow({ where: { id: share.id } })).lastViewedAt).toBeNull();
    expect(await db.platformAuditEvent.count({ where: { tenantId, action: 'pilot.status_link.view.requested' } })).toBe(1);
    expect(await db.auditEvent.count({ where: { tenantId, action: 'pilot.status_link.viewed', resourceId: share.id } })).toBe(0);

    await removeTenantFault();
    cleanup.pop();
    const retry = await app.inject({ method: 'GET', url: `/v1/pilot/share/${share.token}` });
    expect(retry.statusCode).toBe(200);
    expect((await db.pilotStatusShare.findUniqueOrThrow({ where: { id: share.id } })).lastViewedAt).not.toBeNull();
    expect(await db.platformAuditEvent.count({ where: { tenantId, action: 'pilot.status_link.view.requested' } })).toBe(2);
    expect(await db.auditEvent.count({ where: { tenantId, action: 'pilot.status_link.viewed', resourceId: share.id } })).toBe(1);
  });

  it('rolls back a cross-plane pilot import when its tenant audit evidence fails', async () => {
    const tenantId = randomUUID();
    const platformUserId = randomUUID();
    await db.platformUser.create({
      data: {
        id: platformUserId,
        email: `audit-${platformUserId.slice(0, 8)}@carecommand.test`,
        name: 'Pilot Audit Operator',
        passwordHash: await generatePasswordHash('pilot-audit-password-2026!'),
        role: 'PLATFORM_ADMIN',
        status: 'active',
      },
    });
    await db.tenant.create({ data: { id: tenantId, name: 'Pilot Audit Clinic', slug: `pilot-audit-${tenantId.slice(0, 8)}` } });
    await db.branch.create({ data: { tenantId, name: 'Main', location: 'Main' } });
    cleanup.push(async () => { await db.platformAuditEvent.deleteMany({ where: { tenantId } }); });
    cleanup.push(async () => { await db.tenant.delete({ where: { id: tenantId } }); });
    cleanup.push(async () => { await db.platformUser.delete({ where: { id: platformUserId } }); });

    const suffix = randomUUID().replaceAll('-', '');
    const functionName = `test_pilot_audit_fail_fn_${suffix}`;
    const triggerName = `test_pilot_audit_fail_trg_${suffix}`;
    await db.$executeRawUnsafe(`
      CREATE FUNCTION public."${functionName}"() RETURNS trigger
      LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW."tenantId" = '${tenantId}'::uuid AND NEW.action = 'pilot.import.committed' THEN
          RAISE EXCEPTION 'injected mandatory pilot audit failure';
        END IF;
        RETURN NEW;
      END
      $fn$
    `);
    await db.$executeRawUnsafe(`CREATE TRIGGER "${triggerName}" BEFORE INSERT ON public."AuditEvent" FOR EACH ROW EXECUTE FUNCTION public."${functionName}"()`);
    const removeFault = async () => {
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON public."AuditEvent"`);
      await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS public."${functionName}"()`);
    };
    cleanup.push(removeFault);

    const headers = { authorization: `Bearer ${signPlatformToken(app, { id: platformUserId, role: 'PLATFORM_ADMIN' })}`, 'content-type': 'application/json', 'idempotency-key': `pilot-audit-${tenantId}` };
    // Break-glass first: pilot routes refuse clinic data without a live session.
    const supportOpened = await app.inject({ method: 'POST', url: `/v1/platform/tenants/${tenantId}/support-session`, headers: { authorization: headers.authorization, 'content-type': 'application/json' }, payload: { reason: 'Pilot onboarding import', minutes: 60 } });
    expect(supportOpened.statusCode).toBe(200);

    const csvText = ['external_ref,first_name,last_name,branch_name', 'AUD-1,Audit,Rollback,Main'].join('\n');
    const failed = await app.inject({
      method: 'POST', url: `/v1/platform/tenants/${tenantId}/pilot-import/patients/commit`, headers,
      payload: JSON.stringify({ csvText, mapping: {} }),
    });
    expect(failed.statusCode).toBe(500);
    expect(await db.patient.count({ where: { tenantId } })).toBe(0);

    await removeFault();
    cleanup.pop();
    const retry = await app.inject({
      method: 'POST', url: `/v1/platform/tenants/${tenantId}/pilot-import/patients/commit`, headers,
      payload: JSON.stringify({ csvText, mapping: {} }),
    });
    expect(retry.statusCode).toBe(200);
    expect(await db.patient.count({ where: { tenantId } })).toBe(1);
    expect(await db.auditEvent.count({ where: { tenantId, action: 'pilot.import.committed' } })).toBe(1);
    expect(await db.platformAuditEvent.count({ where: { tenantId, action: 'pilot.import.committed.requested' } })).toBe(1);
    expect(await db.platformAuditEvent.count({ where: { tenantId, action: 'pilot.import.committed' } })).toBe(0);

    const imported = await db.patient.findFirstOrThrow({ where: { tenantId, externalRef: 'AUD-1' } });
    const replay = await app.inject({
      method: 'POST', url: `/v1/platform/tenants/${tenantId}/pilot-import/patients/commit`, headers,
      payload: JSON.stringify({ csvText, mapping: {} }),
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().summary).toMatchObject({ created: 1, updated: 0 });
    expect((await db.patient.findUniqueOrThrow({ where: { id: imported.id } })).updatedAt.toISOString()).toBe(imported.updatedAt.toISOString());
    expect(await db.auditEvent.count({ where: { tenantId, action: 'pilot.import.committed' } })).toBe(1);
    expect(await db.platformAuditEvent.count({ where: { tenantId, action: 'pilot.import.committed.requested' } })).toBe(1);
  });
});
