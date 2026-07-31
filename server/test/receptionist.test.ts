import 'dotenv/config';
import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';

const { fixtureDb: db } = await import('./helpers/fixtureDb');
const { handleAgentTool } = await import('../lib/receptionist/liveTools');
const { runWithWebhookTenantContext } = await import('../lib/tenantContext');
const { compileIntakeContract, fingerprintJson } = await import('../modules/receptionist/intakeContract');

type ToolContext = Parameters<typeof handleAgentTool>[0];
function trustedTool(ctx: ToolContext, name: string, args: Record<string, unknown>) {
  return runWithWebhookTenantContext(ctx.tenantId, () => handleAgentTool(ctx, name, args), 'webhook:test-retell-tool');
}

const tenants: string[] = [];
const phoneFor = (id: string) => `+1${(BigInt(`0x${id.replaceAll('-', '').slice(0, 14)}`) % 10_000_000_000n).toString().padStart(10, '0')}`;
async function makeTenant() {
  const id = randomUUID();
  await db.tenant.create({ data: { id, name: `rt-${id.slice(0, 6)}`, slug: `rt-${id.slice(0, 8)}` } });
  tenants.push(id);
  const branch = await db.branch.create({ data: { tenantId: id, name: 'Main', location: 'X', timezone: 'UTC', active: true } });
  const user = await db.user.create({ data: { tenantId: id, role: 'PROVIDER', active: true, email: `pv-${id.slice(0, 8)}@rt.test`, displayName: 'Provider' } });
  const provider = await db.providerProfile.create({ data: { tenantId: id, branchId: branch.id, userId: user.id, specialty: 'General' } });
  await db.providerAvailability.createMany({ data: Array.from({ length: 7 }, (_, dayOfWeek) => ({ tenantId: id, branchId: branch.id, providerProfileId: provider.id, dayOfWeek, startMinute: 540, endMinute: 1020, slotMinutes: 30 })) });
  const clinic = await db.receptionistClinic.create({ data: { tenantId: id, name: 'Clinic', phone: phoneFor(id) } });
  const location = await db.receptionistLocation.create({ data: { tenantId: id, clinicId: clinic.id, branchId: branch.id, name: 'Main location', address: '1 Test Way', active: true } });
  const campaignId = randomUUID();
  const appointmentType = 'Consultation';
  const contract = compileIntakeContract({
    campaignId, revision: 1, appointmentType, eligibleLocations: [{ id: location.id, name: location.name }], fields: [],
    toolUrl: 'https://example.test/v1/receptionist/webhooks/retell/fn',
  });
  const providerAgentId = `agent_${id.replaceAll('-', '')}`;
  await db.receptionistCampaign.create({ data: {
    id: campaignId, tenantId: id, clinicId: clinic.id, name: 'Trusted direct-tool fixture', status: 'ACTIVE',
    offerTitle: 'Appointment', offerDescription: 'Schedule care', offerScript: 'Would you like to schedule?',
    appointmentType, eligibleLocationIds: [location.id], intakeSchemaRevision: 1,
    intakeSchemaSnapshot: contract.snapshot as never, intakeSchemaFingerprint: fingerprintJson(contract.snapshot),
    intakeToolFingerprint: contract.snapshot.bookAppointmentToolFingerprint,
    intakeSchemaAttestedRevision: 1, intakeSchemaAttestedAt: new Date(),
    intakeSchemaProviderAgentId: providerAgentId, intakeSchemaProviderVersion: 1,
    intakeSchemaResponseEngineId: `llm_${id.replaceAll('-', '')}`, intakeSchemaResponseEngineVersion: 1,
  } });
  return { tenantId: id, branchId: branch.id, clinicId: clinic.id, locationId: location.id, campaignId, appointmentType, providerAgentId, snapshot: contract.snapshot };
}
const futureDate = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

type Fixture = Awaited<ReturnType<typeof makeTenant>>;
async function bookingContext(t: Fixture, callId: string, callerPhone: string | null = null): Promise<ToolContext> {
  const call = await db.receptionistCallLog.create({ data: {
    tenantId: t.tenantId, clinicId: t.clinicId, campaignId: t.campaignId, retellCallId: callId,
    callerPhone, direction: 'inbound', outcome: 'IN_PROGRESS', recordingConsentStatus: 'GRANTED', recordingConsentAt: new Date(),
  } });
  return {
    tenantId: t.tenantId, callId, callerPhone,
    trustedBooking: {
      callLogId: call.id, campaignId: t.campaignId, clinicId: t.clinicId, locationId: t.locationId,
      branchId: t.branchId, branchTimezone: 'UTC', observedPhone: callerPhone,
      providerAgentId: t.providerAgentId, providerAgentVersion: 1, intakeSnapshot: t.snapshot,
    },
  };
}

function bookingArgs(t: Fixture, args: Record<string, unknown>) {
  return {
    ...args, service: t.appointmentType, location_id: t.locationId,
    intake_contract_fingerprint: t.snapshot.semanticFingerprint, intake_schema_revision: 1, booking_confirmed: true,
  };
}

afterAll(async () => {
  for (const id of tenants) await db.tenant.delete({ where: { id } }).catch(() => {});
  await db.$disconnect();
});

describe('AI receptionist — real-time tools', () => {
  it('checks live availability then books, and texts back a confirmation message', async () => {
    const t = await makeTenant();
    const tenantId = t.tenantId;
    const date = futureDate(3);
    const ctx = await bookingContext(t, `call-A-${randomUUID()}`, '+15551230000');

    const avail = await trustedTool(ctx, 'check_availability', { appointment_date: date }) as { available: boolean; slots: { time: string }[]; message: string };
    expect(avail.available).toBe(true);
    expect(avail.slots.length).toBeGreaterThan(0);
    expect(avail.message).toMatch(/which works/i);

    const slot = avail.slots[0].time;
    const book = await trustedTool(ctx, 'book_appointment', bookingArgs(t, { first_name: 'Jane', last_name: 'Doe', appointment_date: date, appointment_time: slot })) as { booked: boolean; appointment_id: string; message: string };
    expect(book.booked).toBe(true);
    expect(book.message).toMatch(/booked/i);

    // Exactly one appointment, and the slot is gone from availability.
    expect(await db.appointment.count({ where: { tenantId } })).toBe(1);
    const avail2 = await trustedTool(ctx, 'check_availability', { appointment_date: date }) as { slots: { time: string }[] };
    expect(avail2.slots.some(s => s.time === slot)).toBe(false);
  });

  it('is idempotent — the same call cannot double-book the same slot', async () => {
    const t = await makeTenant();
    const tenantId = t.tenantId;
    const date = futureDate(4);
    const ctx = await bookingContext(t, `call-B-${randomUUID()}`);
    const avail = await trustedTool(ctx, 'check_availability', { appointment_date: date }) as { slots: { time: string }[] };
    const slot = avail.slots[0].time;
    const args = bookingArgs(t, { first_name: 'Sam', last_name: 'Lee', appointment_date: date, appointment_time: slot });
    await trustedTool(ctx, 'book_appointment', args);
    const dup = await trustedTool(ctx, 'book_appointment', args) as { booked: boolean; duplicate?: boolean };
    expect(dup.duplicate).toBe(true);
    expect(await db.appointment.count({ where: { tenantId } })).toBe(1);
  });

  it('rejects an unparseable time and requires a name', async () => {
    const t = await makeTenant();
    const tenantId = t.tenantId;
    const ctx = await bookingContext(t, `call-C-${randomUUID()}`);
    const bad = await trustedTool(ctx, 'book_appointment', bookingArgs(t, { first_name: 'No', last_name: 'Time', appointment_date: 'tomorrow', appointment_time: 'soon' })) as { booked: boolean };
    expect(bad.booked).toBe(false);
    const noName = await trustedTool(ctx, 'book_appointment', bookingArgs(t, { appointment_date: futureDate(2), appointment_time: '10:00' })) as { booked: boolean };
    expect(noName.booked).toBe(false);
    expect(await db.appointment.count({ where: { tenantId } })).toBe(0);
  });

  it('isolates tenants — two clinics can book the same slot independently', async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    const date = futureDate(5);
    const [ctxA, ctxB] = await Promise.all([bookingContext(a, `a-${randomUUID()}`), bookingContext(b, `b-${randomUUID()}`)]);
    const slot = ((await trustedTool(ctxA, 'check_availability', { appointment_date: date })) as { slots: { time: string }[] }).slots[0].time;
    const bookA = await trustedTool(ctxA, 'book_appointment', bookingArgs(a, { first_name: 'A', last_name: 'A', appointment_date: date, appointment_time: slot })) as { booked: boolean };
    const bookB = await trustedTool(ctxB, 'book_appointment', bookingArgs(b, { first_name: 'B', last_name: 'B', appointment_date: date, appointment_time: slot })) as { booked: boolean };
    expect(bookA.booked).toBe(true);
    expect(bookB.booked).toBe(true);
    expect(await db.appointment.count({ where: { tenantId: a.tenantId } })).toBe(1);
    expect(await db.appointment.count({ where: { tenantId: b.tenantId } })).toBe(1);
  });
});
