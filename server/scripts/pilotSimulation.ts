import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { db } from '../lib/db';
import { signPlatformToken } from '../lib/platformAuth';
import { generatePasswordHash } from '../lib/security';
import { buildPilotSimulationCases, type PilotSimulationCase } from './pilotSimulationFixtures';

type JsonResponse = { [key: string]: unknown };

function jsonHeaders(token: string) {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

function assertOk(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function statusMessage(label: string, statusCode: number, body: string): string {
  return `${label} status=${statusCode} body=${body.slice(0, 200)}`;
}

async function createPlatformSession(app: FastifyInstance) {
  const platformUserId = randomUUID();
  const email = `pilot-operator-${platformUserId.slice(0, 8)}@carecommand.test`;
  await db.platformUser.create({
    data: {
      id: platformUserId,
      email,
      name: 'Pilot Operator',
      passwordHash: await generatePasswordHash('pilot-password-123'),
      role: 'PLATFORM_ADMIN',
      status: 'active',
    },
  });
  return {
    platformUserId,
    token: signPlatformToken(app, { id: platformUserId, role: 'PLATFORM_ADMIN' }),
    cleanup: async () => {
      await db.platformUser.delete({ where: { id: platformUserId } }).catch(() => {});
    },
  };
}

async function createTenant(caseData: PilotSimulationCase) {
  const tenantId = randomUUID();
  await db.tenant.create({
    data: {
      id: tenantId,
      name: caseData.clinicName,
      slug: `${caseData.slug}-${tenantId.slice(0, 8)}`,
    },
  });
  return {
    tenantId,
    cleanup: async () => {
      await db.tenant.delete({ where: { id: tenantId } }).catch(() => {});
    },
  };
}

async function runImport(app: FastifyInstance, token: string, tenantId: string, entityType: 'patients' | 'appointments' | 'insurance', csvText: string) {
  const headers = jsonHeaders(token);
  const previewRes = await app.inject({
    method: 'POST',
    url: `/v1/platform/tenants/${tenantId}/pilot-import/${entityType}/preview`,
    headers,
    payload: JSON.stringify({ csvText, mapping: {} }),
  });
  assertOk(previewRes.statusCode === 200, statusMessage(`${entityType} preview`, previewRes.statusCode, previewRes.body));
  const preview = previewRes.json() as JsonResponse;

  const commitRes = await app.inject({
    method: 'POST',
    url: `/v1/platform/tenants/${tenantId}/pilot-import/${entityType}/commit`,
    headers,
    payload: JSON.stringify({ csvText, mapping: {} }),
  });
  assertOk(commitRes.statusCode === 200, statusMessage(`${entityType} commit`, commitRes.statusCode, commitRes.body));
  const commit = commitRes.json() as JsonResponse;

  return { preview, commit };
}

async function runClinicSimulation(app: FastifyInstance, token: string, caseData: PilotSimulationCase) {
  const { tenantId, cleanup } = await createTenant(caseData);
  const headers = jsonHeaders(token);

  try {
    const patient = await runImport(app, token, tenantId, 'patients', caseData.patientCsv);
    const appointment = await runImport(app, token, tenantId, 'appointments', caseData.appointmentCsv);
    const insurance = await runImport(app, token, tenantId, 'insurance', caseData.insuranceCsv);

    const patientPreview = patient.preview as { summary: { invalid: number; warnings: number }; canCommit: boolean };
    const patientCommit = patient.commit as { summary: { created: number; warnings: number; skipped: number; invalidRows: number; validRows: number; updated: number } };
    const appointmentPreview = appointment.preview as { summary: { invalid: number; warnings: number }; canCommit: boolean };
    const appointmentCommit = appointment.commit as { summary: { created: number; warnings: number; skipped: number; invalidRows: number; validRows: number; updated: number } };
    const insurancePreview = insurance.preview as { summary: { invalid: number; warnings: number }; canCommit: boolean };
    const insuranceCommit = insurance.commit as { summary: { created: number; warnings: number; skipped: number; invalidRows: number; validRows: number; updated: number } };

    assertOk(patientPreview.summary.invalid === caseData.expected.patientInvalid, `${caseData.clinicName} patient preview invalid=${patientPreview.summary.invalid}`);
    assertOk(patientPreview.summary.warnings === caseData.expected.patientWarnings, `${caseData.clinicName} patient preview warnings=${patientPreview.summary.warnings}`);
    assertOk(patientCommit.summary.created === caseData.expected.patientCreated, `${caseData.clinicName} patient commit created=${patientCommit.summary.created}`);
    assertOk(patientCommit.summary.invalidRows === caseData.expected.patientInvalid, `${caseData.clinicName} patient commit invalidRows=${patientCommit.summary.invalidRows}`);
    if (caseData.expected.patientUpdated != null) assertOk(patientCommit.summary.updated === caseData.expected.patientUpdated, `${caseData.clinicName} patient commit updated=${patientCommit.summary.updated}`);
    if (caseData.expected.patientSkipped != null) assertOk(patientCommit.summary.skipped === caseData.expected.patientSkipped, `${caseData.clinicName} patient commit skipped=${patientCommit.summary.skipped}`);

    assertOk(appointmentPreview.summary.invalid === caseData.expected.appointmentInvalid, `${caseData.clinicName} appointment preview invalid=${appointmentPreview.summary.invalid}`);
    assertOk(appointmentPreview.summary.warnings === caseData.expected.appointmentWarnings, `${caseData.clinicName} appointment preview warnings=${appointmentPreview.summary.warnings}`);
    assertOk(appointmentCommit.summary.created === caseData.expected.appointmentCreated, `${caseData.clinicName} appointment commit created=${appointmentCommit.summary.created}`);
    assertOk(appointmentCommit.summary.invalidRows === caseData.expected.appointmentInvalid, `${caseData.clinicName} appointment commit invalidRows=${appointmentCommit.summary.invalidRows}`);
    if (caseData.expected.appointmentUpdated != null) assertOk(appointmentCommit.summary.updated === caseData.expected.appointmentUpdated, `${caseData.clinicName} appointment commit updated=${appointmentCommit.summary.updated}`);
    if (caseData.expected.appointmentSkipped != null) assertOk(appointmentCommit.summary.skipped === caseData.expected.appointmentSkipped, `${caseData.clinicName} appointment commit skipped=${appointmentCommit.summary.skipped}`);

    assertOk(insurancePreview.summary.invalid === caseData.expected.insuranceInvalid, `${caseData.clinicName} insurance preview invalid=${insurancePreview.summary.invalid}`);
    assertOk(insurancePreview.summary.warnings === caseData.expected.insuranceWarnings, `${caseData.clinicName} insurance preview warnings=${insurancePreview.summary.warnings}`);
    assertOk(insuranceCommit.summary.created === caseData.expected.insuranceCreated, `${caseData.clinicName} insurance commit created=${insuranceCommit.summary.created}`);
    assertOk(insuranceCommit.summary.invalidRows === caseData.expected.insuranceInvalid, `${caseData.clinicName} insurance commit invalidRows=${insuranceCommit.summary.invalidRows}`);
    if (caseData.expected.insuranceUpdated != null) assertOk(insuranceCommit.summary.updated === caseData.expected.insuranceUpdated, `${caseData.clinicName} insurance commit updated=${insuranceCommit.summary.updated}`);
    if (caseData.expected.insuranceSkipped != null) assertOk(insuranceCommit.summary.skipped === caseData.expected.insuranceSkipped, `${caseData.clinicName} insurance commit skipped=${insuranceCommit.summary.skipped}`);

    const presetName = `${caseData.clinicName} import preset`;
    const savePresetRes = await app.inject({
      method: 'POST',
      url: `/v1/platform/tenants/${tenantId}/pilot-import/presets`,
      headers,
      payload: JSON.stringify({
        entityType: 'patients',
        name: presetName,
        mapping: {
          externalRef: 'external_ref',
          firstName: 'first_name',
          lastName: 'last_name',
          email: 'email',
          phone: 'phone',
          lifecycleStage: 'lifecycle_stage',
          branchName: 'branch_name',
          tags: 'tags',
        },
        isDefault: true,
      }),
    });
    assertOk(savePresetRes.statusCode === 201, statusMessage('preset save', savePresetRes.statusCode, savePresetRes.body));

    const presetPreviewRes = await app.inject({
      method: 'POST',
      url: `/v1/platform/tenants/${tenantId}/pilot-import/patients/preview`,
      headers,
      payload: JSON.stringify({ csvText: caseData.patientCsv, mapping: {} }),
    });
    assertOk(presetPreviewRes.statusCode === 200, statusMessage('preset preview', presetPreviewRes.statusCode, presetPreviewRes.body));
    const presetPreview = presetPreviewRes.json() as { preset: { name: string } | null; mapping: Record<string, string> };
    assertOk(presetPreview.preset?.name === presetName, `${caseData.clinicName} preset not loaded on preview`);
    assertOk(presetPreview.mapping.firstName === 'first_name', `${caseData.clinicName} preset mapping not applied`);

    const templateRes = await app.inject({
      method: 'GET',
      url: `/v1/platform/tenants/${tenantId}/pilot-import/patients/template.csv`,
      headers,
    });
    assertOk(templateRes.statusCode === 200, statusMessage('template', templateRes.statusCode, templateRes.body));
    assertOk(Boolean(templateRes.headers['content-type']?.includes('text/csv')), `${caseData.clinicName} template content-type missing`);

    const checklistRes = await app.inject({
      method: 'GET',
      url: `/v1/platform/tenants/${tenantId}/pilot-checklist`,
      headers,
    });
    assertOk(checklistRes.statusCode === 200, statusMessage('checklist', checklistRes.statusCode, checklistRes.body));
    const checklist = checklistRes.json() as { readinessScore: number; counts: { branches: number; users: number; patients: number; appointments: number; policies: number; imports: number } };
    assertOk(checklist.counts.branches >= caseData.branchNames.length, `${caseData.clinicName} branch count too low`);
    assertOk(checklist.counts.patients >= caseData.expected.patientCreated, `${caseData.clinicName} patient count too low`);
    assertOk(checklist.counts.appointments >= caseData.expected.appointmentCreated, `${caseData.clinicName} appointment count too low`);
    assertOk(checklist.counts.policies >= caseData.expected.insuranceCreated, `${caseData.clinicName} policy count too low`);
    assertOk(checklist.counts.imports >= 3, `${caseData.clinicName} import audit count too low`);
    assertOk(checklist.readinessScore >= 62, `${caseData.clinicName} readiness score too low: ${checklist.readinessScore}`);

    const shareRes = await app.inject({
      method: 'POST',
      url: `/v1/platform/tenants/${tenantId}/pilot-status-links`,
      headers,
      payload: JSON.stringify({ label: `${caseData.clinicName} pilot share`, expiresInDays: 14 }),
    });
    assertOk(shareRes.statusCode === 201, statusMessage('share create', shareRes.statusCode, shareRes.body));
    const share = shareRes.json() as { token: string; url: string };
    assertOk(Boolean(share.token), `${caseData.clinicName} share token missing`);
    assertOk(share.url.includes('/pilot/'), `${caseData.clinicName} share URL missing /pilot/`);

    const publicRes = await app.inject({ method: 'GET', url: `/v1/pilot/share/${share.token}` });
    assertOk(publicRes.statusCode === 200, statusMessage('public share', publicRes.statusCode, publicRes.body));
    const publicPayload = publicRes.json() as { clinic: { name: string }; checklist: { readinessScore: number } };
    assertOk(publicPayload.clinic.name === caseData.clinicName, `${caseData.clinicName} public share clinic mismatch`);
    assertOk(publicPayload.checklist.readinessScore === checklist.readinessScore, `${caseData.clinicName} public checklist mismatch`);

    console.log(
      `[pilot:simulate] ${caseData.clinicName}: patients ${patientCommit.summary.created}/${caseData.expected.patientCreated}, ` +
      `appointments ${appointmentCommit.summary.created}/${caseData.expected.appointmentCreated}, ` +
      `insurance ${insuranceCommit.summary.created}/${caseData.expected.insuranceCreated}, ` +
      `readiness ${checklist.readinessScore}%`,
    );
  } finally {
    await cleanup();
  }
}

async function main() {
  const app = await buildApp();
  const session = await createPlatformSession(app);
  const cases = buildPilotSimulationCases();
  const cleanup: Array<() => Promise<void>> = [session.cleanup];

  try {
    console.log(`[pilot:simulate] platform session created for ${session.platformUserId}`);
    for (const caseData of cases) {
      await runClinicSimulation(app, session.token, caseData);
    }
    console.log(`[pilot:simulate] completed ${cases.length} clinic simulations successfully.`);
  } finally {
    for (const fn of cleanup.reverse()) await fn().catch(() => {});
    await app.close();
    await db.$disconnect();
  }
  process.exit(0);
}

main().catch(async err => {
  console.error('[pilot:simulate] failed');
  console.error(err);
  await db.$disconnect().catch(() => {});
  process.exit(1);
});
