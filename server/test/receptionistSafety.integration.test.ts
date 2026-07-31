import 'dotenv/config';
import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fixtureDb as db } from './helpers/fixtureDb';
import { handleAgentTool } from '../lib/receptionist/liveTools';
import { runWithWebhookTenantContext } from '../lib/tenantContext';
import { buildRetellConfig, generateSystemPrompt, type PromptConfig } from '../modules/receptionist/promptService';

const tenantIds: string[] = [];

type ToolContext = Parameters<typeof handleAgentTool>[0];
function trustedTool(ctx: ToolContext, name: string, args: Record<string, unknown>) {
  return runWithWebhookTenantContext(ctx.tenantId, () => handleAgentTool(ctx, name, args), 'webhook:test-retell-safety');
}

async function makeTenant() {
  const id = randomUUID();
  tenantIds.push(id);
  await db.tenant.create({ data: { id, name: `safety-${id.slice(0, 6)}`, slug: `safety-${id.slice(0, 8)}` } });
  const branch = await db.branch.create({ data: { tenantId: id, name: 'Main', location: 'Test', active: true } });
  return { id, branchId: branch.id };
}

afterAll(async () => {
  await db.idempotencyKey.deleteMany({ where: { tenantId: { in: tenantIds }, scope: { in: ['receptionist.live-safety', 'receptionist.voice-identity', 'receptionist.voice-optout'] } } }).catch(() => {});
  for (const id of tenantIds) await db.tenant.delete({ where: { id } }).catch(() => {});
  await db.$disconnect();
});

describe('AI receptionist safety workflows', () => {
  it('creates one acknowledgment-required handoff task per call and keeps PHI out of audit metadata', async () => {
    const tenant = await makeTenant();
    const ctx = { tenantId: tenant.id, callId: `call-${randomUUID()}`, callerPhone: '+12125550177' };
    const args = {
      caller_name: 'Taylor Secret',
      callback_phone: '+12125550999',
      reason_category: 'human_requested',
      message: 'Please discuss a private billing issue.',
    };

    const first = await trustedTool(ctx, 'request_human_handoff', args) as Record<string, unknown>;
    const replay = await trustedTool(ctx, 'request_human_handoff', args) as Record<string, unknown>;

    expect(first.handoff_recorded).toBe(true);
    expect(first.transfer_completed).toBe(false);
    expect(first.message).toMatch(/not acknowledged/i);
    expect(first.message).toMatch(/no transfer has occurred/i);
    expect(replay).toMatchObject({ duplicate: true, task_id: first.task_id });
    expect(await db.staffTask.count({ where: { tenantId: tenant.id } })).toBe(1);

    const task = await db.staffTask.findUniqueOrThrow({ where: { id: String(first.task_id) } });
    expect(task).toMatchObject({ branchId: tenant.branchId, priority: 'high', status: 'OPEN' });
    expect(task.metadata).toMatchObject({
      kind: 'human_handoff',
      callbackPhone: '+12125550177', // verified caller wins over tool input
      requiresAcknowledgement: true,
    });

    const audit = await db.auditEvent.findFirstOrThrow({
      where: { tenantId: tenant.id, action: 'receptionist.safety.human_handoff.created' },
    });
    const serializedAudit = JSON.stringify(audit.metadata);
    expect(serializedAudit).not.toContain('Taylor Secret');
    expect(serializedAudit).not.toContain('+12125550177');
    expect(serializedAudit).not.toContain('private billing');
    expect(audit.resourceId).toBe(first.task_id);
  });

  it('uses a PHI-free fallback idempotency key when call_id is absent and sanitizes callback messages', async () => {
    const tenant = await makeTenant();
    const ctx = { tenantId: tenant.id, callId: null, callerPhone: '+12125550188' };
    const args = {
      caller_name: 'Jordan\u0000 Caller',
      reason_category: 'transfer_failed',
      message: 'Please call me. https://malicious.example/path\nThank you.',
    };

    const first = await trustedTool(ctx, 'take_message', args) as Record<string, unknown>;
    const replay = await trustedTool(ctx, 'take_message', args) as Record<string, unknown>;

    expect(first).toMatchObject({ message_recorded: true, acknowledgment_pending: true });
    expect(replay).toMatchObject({ duplicate: true, task_id: first.task_id });
    expect(await db.staffTask.count({ where: { tenantId: tenant.id } })).toBe(1);
    const task = await db.staffTask.findUniqueOrThrow({ where: { id: String(first.task_id) } });
    const metadata = task.metadata as Record<string, unknown>;
    expect(metadata.message).toBe('Please call me. Thank you.');
    expect(metadata.callerName).toBe('Jordan Caller');

    const claim = await db.idempotencyKey.findFirstOrThrow({ where: { tenantId: tenant.id, scope: 'receptionist.live-safety' } });
    expect(claim.key).not.toContain('+12125550188');
    expect(claim.key).not.toContain('Jordan');
    expect(claim.key).not.toContain('Please call');
  });

  it('creates a critical operational signal and directs an emergency caller not to wait for staff', async () => {
    const tenant = await makeTenant();
    const result = await trustedTool(
      { tenantId: tenant.id, callId: `call-${randomUUID()}`, callerPhone: '+12125550166' },
      'report_emergency',
      { reason_category: 'possible_emergency', message: 'Caller described possible emergency symptoms.' },
    ) as Record<string, unknown>;

    expect(result).toMatchObject({ emergency_recorded: true, acknowledgment_pending: true });
    expect(result.message).toMatch(/call 911 now/i);
    expect(result.message).toMatch(/do not wait/i);
    const signal = await db.operationalSignal.findFirstOrThrow({
      where: { tenantId: tenant.id, signalType: 'receptionist_emergency_mention', entityId: String(result.task_id) },
    });
    expect(signal).toMatchObject({ severity: 'critical', score: 100, status: 'open' });
    const task = await db.staffTask.findUniqueOrThrow({ where: { id: String(result.task_id) } });
    expect(task).toMatchObject({ priority: 'high', status: 'OPEN' });
  });

  it('keeps voice identity proof server-side, records failures, and locks after three attempts', async () => {
    const tenant = await makeTenant();
    const patient = await db.patient.create({
      data: { tenantId: tenant.id, branchId: tenant.branchId, firstName: 'Verified', lastName: 'Patient', phone: '+12125550144', dateOfBirth: new Date('1985-04-03T00:00:00.000Z') },
    });
    const unverifiedCtx = { tenantId: tenant.id, callId: `call-${randomUUID()}`, callerPhone: '+12125550144' };
    await expect(trustedTool(unverifiedCtx, 'book_appointment', {
      first_name: 'Verified', last_name: 'Patient', appointment_date: 'invalid', appointment_time: '10:00', service: 'Consultation',
    })).resolves.toMatchObject({ booked: false, needs_human: true });
    expect(await db.appointmentRequest.count({ where: { tenantId: tenant.id } })).toBe(0);

    const goodCtx = { tenantId: tenant.id, callId: `call-${randomUUID()}`, callerPhone: '+12125550144' };
    await expect(trustedTool(goodCtx, 'verify_patient_identity', { date_of_birth: '1985-04-03' })).resolves.toMatchObject({ verified: true });
    const proof = await db.idempotencyKey.findUniqueOrThrow({ where: { scope_key: { scope: 'receptionist.voice-identity', key: `${tenant.id}:${goodCtx.callId}` } } });
    expect(proof.resultId).toBe(patient.id);

    const badCtx = { tenantId: tenant.id, callId: `call-${randomUUID()}`, callerPhone: '+12125550144' };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(trustedTool(badCtx, 'verify_patient_identity', { date_of_birth: '1985-04-04' })).resolves.toMatchObject({ verified: false });
    }
    await expect(trustedTool(badCtx, 'verify_patient_identity', { date_of_birth: '1985-04-03' })).resolves.toMatchObject({ verified: false, locked: true, needs_human: true });
    expect(await db.auditEvent.count({ where: { tenantId: tenant.id, action: 'receptionist.identity.failed', resourceId: badCtx.callId } })).toBe(3);
    expect(await db.auditEvent.count({ where: { tenantId: tenant.id, action: 'receptionist.identity.locked', resourceId: badCtx.callId } })).toBe(1);
  });

  it('persists an immediate replay-safe DNC suppression without putting the phone in audit metadata', async () => {
    const tenant = await makeTenant();
    const ctx = { tenantId: tenant.id, callId: `call-${randomUUID()}`, callerPhone: '+12125550133' };
    const first = await trustedTool(ctx, 'record_do_not_call', {}) as Record<string, unknown>;
    const replay = await trustedTool(ctx, 'record_do_not_call', {}) as Record<string, unknown>;
    expect(first).toMatchObject({ recorded: true, duplicate: false });
    expect(replay).toMatchObject({ recorded: true, duplicate: true, opt_out_id: first.opt_out_id });
    expect(await db.receptionistOptOut.count({ where: { tenantId: tenant.id, contactPhone: '+12125550133', channel: 'ALL' } })).toBe(1);
    const audit = await db.auditEvent.findFirstOrThrow({ where: { tenantId: tenant.id, action: 'receptionist.optout.recorded' } });
    expect(JSON.stringify(audit.metadata)).not.toContain('+12125550133');
  });

  it('lists, collision-checks, reschedules, and cancels only after server-held identity verification', async () => {
    const tenant = await makeTenant();
    await db.branch.update({ where: { id: tenant.branchId }, data: { timezone: 'UTC' } });
    const providerUser = await db.user.create({ data: { tenantId: tenant.id, branchId: tenant.branchId, role: 'PROVIDER', active: true, email: `provider-${tenant.id}@test.invalid`, displayName: 'Provider' } });
    const provider = await db.providerProfile.create({ data: { tenantId: tenant.id, branchId: tenant.branchId, userId: providerUser.id, specialty: 'Primary Care' } });
    await db.providerAvailability.createMany({ data: Array.from({ length: 7 }, (_, dayOfWeek) => ({ tenantId: tenant.id, branchId: tenant.branchId, providerProfileId: provider.id, dayOfWeek, startMinute: 540, endMinute: 1020, slotMinutes: 30 })) });
    const service = await db.serviceCatalogItem.create({ data: { tenantId: tenant.id, name: 'Consultation', category: 'general', defaultDurationMinutes: 30, active: true } });
    const patient = await db.patient.create({ data: { tenantId: tenant.id, branchId: tenant.branchId, firstName: 'Voice', lastName: 'Patient', phone: '+12125550122', dateOfBirth: new Date('1980-01-02T00:00:00.000Z') } });
    const originalStart = new Date(`${new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10)}T09:00:00.000Z`);
    const appointment = await db.appointment.create({ data: { tenantId: tenant.id, branchId: tenant.branchId, patientId: patient.id, providerProfileId: provider.id, providerRef: provider.id, service: service.name, serviceCatalogItemId: service.id, startsAt: originalStart, endsAt: new Date(originalStart.getTime() + 30 * 60_000), status: 'CONFIRMED', channel: 'CALL' } });
    const ctx = { tenantId: tenant.id, callId: `call-${randomUUID()}`, callerPhone: '+12125550122' };

    await expect(trustedTool(ctx, 'list_upcoming_appointments', {})).resolves.toMatchObject({ verified: false, appointments: [] });
    await expect(trustedTool(ctx, 'verify_patient_identity', { date_of_birth: '1980-01-02' })).resolves.toMatchObject({ verified: true });
    await expect(trustedTool(ctx, 'list_upcoming_appointments', {})).resolves.toMatchObject({ verified: true, appointments: [expect.objectContaining({ appointment_id: appointment.id })] });

    const moveDate = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    await expect(trustedTool(ctx, 'reschedule_appointment', { appointment_id: appointment.id, appointment_date: moveDate, appointment_time: '10:00' })).resolves.toMatchObject({ rescheduled: false, confirmation_required: true });
    const preparedMove = await trustedTool(ctx, 'prepare_appointment_change', { action: 'reschedule', appointment_id: appointment.id, appointment_date: moveDate, appointment_time: '10:00' }) as { confirmation_token: string };
    await expect(trustedTool(ctx, 'reschedule_appointment', { appointment_id: appointment.id, appointment_date: moveDate, appointment_time: '10:00', confirmation_token: preparedMove.confirmation_token, confirmed: true })).resolves.toMatchObject({ rescheduled: true, appointment_id: appointment.id });
    expect((await db.appointment.findUniqueOrThrow({ where: { id: appointment.id } })).startsAt.toISOString()).toBe(`${moveDate}T10:00:00.000Z`);

    await expect(trustedTool(ctx, 'cancel_appointment', { appointment_id: appointment.id, reason: 'Schedule changed' })).resolves.toMatchObject({ cancelled: false, confirmation_required: true });
    const preparedCancel = await trustedTool(ctx, 'prepare_appointment_change', { action: 'cancel', appointment_id: appointment.id }) as { confirmation_token: string };
    await expect(trustedTool(ctx, 'cancel_appointment', { appointment_id: appointment.id, reason: 'Schedule changed', confirmation_token: preparedCancel.confirmation_token, confirmed: true })).resolves.toMatchObject({ cancelled: true, appointment_id: appointment.id });
    expect((await db.appointment.findUniqueOrThrow({ where: { id: appointment.id } })).status).toBe('CANCELED');
    expect(await db.auditEvent.count({ where: { tenantId: tenant.id, action: { in: ['receptionist.appointment.rescheduled', 'receptionist.appointment.cancelled'] }, resourceId: appointment.id } })).toBe(2);
  });
});

const promptConfig: PromptConfig = {
  clinic: {
    id: 'clinic-1', name: 'Example Clinic', phone: '+12125550100', timezone: 'America/New_York',
    defaultLanguage: 'en-US', complianceDisclosure: '', humanFallbackNumber: '+12125550200',
    doNotContactPolicy: 'Record the opt-out and end the call.',
  },
  agent: { name: 'Avery', voice: 'voice-1', tone: 'warm', language: 'en-US' },
  campaign: {
    id: 'campaign-1', name: 'Scheduling', campaignType: 'inbound', offerTitle: 'Appointment',
    offerDescription: 'Schedule an appointment.', offerScript: 'How can I help?', appointmentType: 'Consultation',
    eligibleLocationIds: ['branch-1'], smsConfirmation: true, emailConfirmation: false,
  },
  locations: [{ id: 'branch-1', name: 'Main', address: '1 Main St' }],
  intakeFields: [],
};

describe('Retell safety configuration', () => {
  it('exposes executable task tools and provider-native transfer in the required order', () => {
    const config = buildRetellConfig(promptConfig, { webhookBaseUrl: 'https://api.example.test' });
    const names = config.tools.map(tool => tool.name);
    expect(names).toEqual(expect.arrayContaining(['verify_patient_identity', 'list_upcoming_appointments', 'prepare_appointment_change', 'cancel_appointment', 'reschedule_appointment', 'record_do_not_call', 'request_human_handoff', 'take_message', 'report_emergency', 'transfer_to_staff']));
    const transfer = config.tools.find(tool => tool.name === 'transfer_to_staff');
    expect(transfer).toMatchObject({
      type: 'transfer_call',
      transfer_destination: { type: 'predefined', number: '+12125550200', ignore_e164_validation: false },
      transfer_option: { type: 'cold_transfer', show_transferee_as_caller: false },
    });
    expect(String(transfer?.description)).toMatch(/after request_human_handoff succeeds/i);
  });

  it('omits transfer for an invalid fallback and routes emergencies/unsupported intents explicitly', () => {
    const invalid = { ...promptConfig, clinic: { ...promptConfig.clinic, humanFallbackNumber: 'front desk' } };
    expect(buildRetellConfig(invalid, { webhookBaseUrl: 'https://api.example.test' }).tools.some(tool => tool.name === 'transfer_to_staff')).toBe(false);
    const prompt = generateSystemPrompt(invalid);
    expect(prompt).toMatch(/immediately tell them to hang up and call 911/i);
    expect(prompt).toMatch(/Never delay the 911 instruction/i);
    expect(prompt).toMatch(/Never merely say that someone will follow up without a successful tool result and task ID/i);
    expect(prompt).toMatch(/proxy, guardian, or minor/i);
  });
});
