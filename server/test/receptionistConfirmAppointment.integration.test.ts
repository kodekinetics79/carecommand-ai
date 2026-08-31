import 'dotenv/config';
import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fixtureDb as db } from './helpers/fixtureDb';
import { handleAgentTool } from '../lib/receptionist/liveTools';
import { runWithWebhookTenantContext } from '../lib/tenantContext';

/**
 * A reminder call asks the patient to CONFIRM or CANCEL. Cancelling always had
 * somewhere to go — `cancel_appointment`, and a status to move to. Confirming
 * had neither a tool nor a column, so a patient's "yes" survived only as a
 * sentence inside an LLM call summary and no clinic could answer which
 * appointments were confirmed.
 *
 * These pin the half that was missing. The load-bearing assertion is not that
 * a confirmation is recorded, but that recording one changes NOTHING ELSE:
 * `status` is untouched, because `CONFIRMED` is the default a row is created
 * with and already means "the clinic booked this". Collapsing the two would
 * destroy the only distinction a reminder campaign exists to produce.
 */

const tenantIds: string[] = [];

type ToolContext = Parameters<typeof handleAgentTool>[0];
function trustedTool(ctx: ToolContext, name: string, args: Record<string, unknown>) {
  return runWithWebhookTenantContext(ctx.tenantId, () => handleAgentTool(ctx, name, args), 'webhook:test-confirm');
}

async function makeTenant() {
  const id = randomUUID();
  tenantIds.push(id);
  await db.tenant.create({ data: { id, name: `confirm-${id.slice(0, 6)}`, slug: `confirm-${id.slice(0, 8)}` } });
  const branch = await db.branch.create({ data: { tenantId: id, name: 'Main', location: 'Test', active: true } });
  return { id, branchId: branch.id };
}

async function makeAppointment(tenant: { id: string; branchId: string }, opts: { phone: string; dob: string; startsAt: Date; status?: 'CONFIRMED' | 'CANCELED' | 'COMPLETED' }) {
  const patient = await db.patient.create({
    data: { tenantId: tenant.id, branchId: tenant.branchId, firstName: 'Reminder', lastName: 'Patient', phone: opts.phone, dateOfBirth: new Date(`${opts.dob}T00:00:00.000Z`) },
  });
  const appointment = await db.appointment.create({
    data: {
      tenantId: tenant.id, branchId: tenant.branchId, patientId: patient.id, service: 'Cleaning',
      startsAt: opts.startsAt, endsAt: new Date(opts.startsAt.getTime() + 30 * 60_000),
      status: opts.status ?? 'CONFIRMED', channel: 'CALL',
    },
  });
  return { patient, appointment };
}

/** A verified call context: identity is server-held, exactly as the real path requires. */
async function verifiedCtx(tenantId: string, phone: string, dob: string) {
  const ctx = { tenantId, callId: `call-${randomUUID()}`, callerPhone: phone, providerInvocationId: randomUUID() };
  await expect(trustedTool(ctx, 'verify_patient_identity', { date_of_birth: dob })).resolves.toMatchObject({ verified: true });
  return ctx;
}

afterAll(async () => {
  for (const id of tenantIds) await db.tenant.delete({ where: { id } }).catch(() => undefined);
  await db.$disconnect();
});

describe('confirm_appointment', () => {
  it('records the confirmation with its source, and changes nothing else', async () => {
    const tenant = await makeTenant();
    const { appointment } = await makeAppointment(tenant, { phone: '+12125551201', dob: '1980-01-02', startsAt: new Date(Date.now() + 3 * 86_400_000) });
    const ctx = await verifiedCtx(tenant.id, '+12125551201', '1980-01-02');

    await expect(trustedTool(ctx, 'confirm_appointment', { appointment_id: appointment.id }))
      .resolves.toMatchObject({ confirmed: true, appointment_id: appointment.id });

    const row = await db.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
    expect(row.patientConfirmedAt).toBeInstanceOf(Date);
    expect(row.patientConfirmationSource).toBe('receptionist_call');
    // The point of the whole design: a patient confirmation is not a status.
    expect(row.status).toBe('CONFIRMED');
    expect(row.startsAt.toISOString()).toBe(appointment.startsAt.toISOString());

    await expect(db.auditEvent.count({ where: { tenantId: tenant.id, action: 'receptionist.appointment.patientConfirmed', resourceId: appointment.id } })).resolves.toBe(1);
    await expect(db.businessEvent.count({ where: { tenantId: tenant.id, eventType: 'appointment.patientConfirmed', entityId: appointment.id } })).resolves.toBe(1);
  });

  it('is idempotent, and a replay never overwrites the original evidence', async () => {
    const tenant = await makeTenant();
    const { appointment } = await makeAppointment(tenant, { phone: '+12125551202', dob: '1980-01-03', startsAt: new Date(Date.now() + 3 * 86_400_000) });
    const ctx = await verifiedCtx(tenant.id, '+12125551202', '1980-01-03');

    await trustedTool(ctx, 'confirm_appointment', { appointment_id: appointment.id });
    const first = await db.appointment.findUniqueOrThrow({ where: { id: appointment.id } });

    await expect(trustedTool(ctx, 'confirm_appointment', { appointment_id: appointment.id }))
      .resolves.toMatchObject({ confirmed: true, duplicate: true });

    const second = await db.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
    expect(second.patientConfirmedAt?.toISOString()).toBe(first.patientConfirmedAt?.toISOString());
    // One confirmation, one audit row — a replay is not a second piece of evidence.
    await expect(db.auditEvent.count({ where: { tenantId: tenant.id, action: 'receptionist.appointment.patientConfirmed', resourceId: appointment.id } })).resolves.toBe(1);
  });

  it('refuses an appointment that has already started', async () => {
    const tenant = await makeTenant();
    const { appointment } = await makeAppointment(tenant, { phone: '+12125551203', dob: '1980-01-04', startsAt: new Date(Date.now() - 3_600_000) });
    const ctx = await verifiedCtx(tenant.id, '+12125551203', '1980-01-04');

    await expect(trustedTool(ctx, 'confirm_appointment', { appointment_id: appointment.id }))
      .resolves.toMatchObject({ confirmed: false, needs_human: true });
    expect((await db.appointment.findUniqueOrThrow({ where: { id: appointment.id } })).patientConfirmedAt).toBeNull();
  });

  it('refuses a cancelled appointment rather than quietly resurrecting it', async () => {
    const tenant = await makeTenant();
    const { appointment } = await makeAppointment(tenant, { phone: '+12125551204', dob: '1980-01-05', startsAt: new Date(Date.now() + 3 * 86_400_000), status: 'CANCELED' });
    const ctx = await verifiedCtx(tenant.id, '+12125551204', '1980-01-05');

    await expect(trustedTool(ctx, 'confirm_appointment', { appointment_id: appointment.id }))
      .resolves.toMatchObject({ confirmed: false, needs_human: true });
    const row = await db.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
    expect(row.patientConfirmedAt).toBeNull();
    expect(row.status).toBe('CANCELED');
  });

  it('will not confirm an appointment belonging to someone else', async () => {
    const tenant = await makeTenant();
    const mine = await makeAppointment(tenant, { phone: '+12125551205', dob: '1980-01-06', startsAt: new Date(Date.now() + 3 * 86_400_000) });
    const theirs = await makeAppointment(tenant, { phone: '+12125551206', dob: '1980-01-07', startsAt: new Date(Date.now() + 3 * 86_400_000) });
    // Verified as the FIRST patient, then asked about the second one's appointment.
    const ctx = await verifiedCtx(tenant.id, '+12125551205', '1980-01-06');

    await expect(trustedTool(ctx, 'confirm_appointment', { appointment_id: theirs.appointment.id }))
      .resolves.toMatchObject({ confirmed: false, needs_human: true });
    expect((await db.appointment.findUniqueOrThrow({ where: { id: theirs.appointment.id } })).patientConfirmedAt).toBeNull();
    expect(mine.appointment.id).not.toBe(theirs.appointment.id);
  });

  it('records nothing when the caller was never identity-verified', async () => {
    const tenant = await makeTenant();
    const { appointment } = await makeAppointment(tenant, { phone: '+12125551207', dob: '1980-01-08', startsAt: new Date(Date.now() + 3 * 86_400_000) });
    const unverified = { tenantId: tenant.id, callId: `call-${randomUUID()}`, callerPhone: '+12125551207' };

    await expect(trustedTool(unverified, 'confirm_appointment', { appointment_id: appointment.id }))
      .resolves.toMatchObject({ confirmed: false, needs_human: true });
    expect((await db.appointment.findUniqueOrThrow({ where: { id: appointment.id } })).patientConfirmedAt).toBeNull();
  });
});
