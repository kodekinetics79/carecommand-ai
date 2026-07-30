import 'dotenv/config';
import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';

const { fixtureDb: db } = await import('./helpers/fixtureDb');
const { handleAgentTool } = await import('../lib/receptionist/liveTools');
const { runWithWebhookTenantContext } = await import('../lib/tenantContext');

type ToolContext = Parameters<typeof handleAgentTool>[0];
function trustedTool(ctx: ToolContext, name: string, args: Record<string, unknown>) {
  return runWithWebhookTenantContext(ctx.tenantId, () => handleAgentTool(ctx, name, args), 'webhook:test-retell-tool');
}

const tenants: string[] = [];
async function makeTenant() {
  const id = randomUUID();
  await db.tenant.create({ data: { id, name: `rt-${id.slice(0, 6)}`, slug: `rt-${id.slice(0, 8)}` } });
  tenants.push(id);
  const branch = await db.branch.create({ data: { tenantId: id, name: 'Main', location: 'X', timezone: 'UTC' } });
  const user = await db.user.create({ data: { tenantId: id, role: 'PROVIDER', active: true, email: `pv-${id.slice(0, 8)}@rt.test`, displayName: 'Provider' } });
  const provider = await db.providerProfile.create({ data: { tenantId: id, branchId: branch.id, userId: user.id, specialty: 'General' } });
  await db.providerAvailability.createMany({ data: Array.from({ length: 7 }, (_, dayOfWeek) => ({ tenantId: id, branchId: branch.id, providerProfileId: provider.id, dayOfWeek, startMinute: 540, endMinute: 1020, slotMinutes: 30 })) });
  return id;
}
const futureDate = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

afterAll(async () => {
  for (const id of tenants) await db.tenant.delete({ where: { id } }).catch(() => {});
  await db.$disconnect();
});

describe('AI receptionist — real-time tools', () => {
  it('checks live availability then books, and texts back a confirmation message', async () => {
    const tenantId = await makeTenant();
    const date = futureDate(3);
    const ctx = { tenantId, callId: 'call-A', callerPhone: '+15551230000' };

    const avail = await trustedTool(ctx, 'check_availability', { appointment_date: date }) as { available: boolean; slots: { time: string }[]; message: string };
    expect(avail.available).toBe(true);
    expect(avail.slots.length).toBeGreaterThan(0);
    expect(avail.message).toMatch(/which works/i);

    const slot = avail.slots[0].time;
    const book = await trustedTool(ctx, 'book_appointment', { first_name: 'Jane', last_name: 'Doe', phone: '+15551230000', appointment_date: date, appointment_time: slot, service: 'Cleaning' }) as { booked: boolean; appointment_id: string; message: string };
    expect(book.booked).toBe(true);
    expect(book.message).toMatch(/booked/i);

    // Exactly one appointment, and the slot is gone from availability.
    expect(await db.appointment.count({ where: { tenantId } })).toBe(1);
    const avail2 = await trustedTool(ctx, 'check_availability', { appointment_date: date }) as { slots: { time: string }[] };
    expect(avail2.slots.some(s => s.time === slot)).toBe(false);
  });

  it('is idempotent — the same call cannot double-book the same slot', async () => {
    const tenantId = await makeTenant();
    const date = futureDate(4);
    const ctx = { tenantId, callId: 'call-B' };
    const avail = await trustedTool(ctx, 'check_availability', { appointment_date: date }) as { slots: { time: string }[] };
    const slot = avail.slots[0].time;
    const args = { first_name: 'Sam', last_name: 'Lee', appointment_date: date, appointment_time: slot };
    await trustedTool(ctx, 'book_appointment', args);
    const dup = await trustedTool(ctx, 'book_appointment', args) as { booked: boolean; duplicate?: boolean };
    expect(dup.duplicate).toBe(true);
    expect(await db.appointment.count({ where: { tenantId } })).toBe(1);
  });

  it('rejects an unparseable time and requires a name', async () => {
    const tenantId = await makeTenant();
    const ctx = { tenantId, callId: 'call-C' };
    const bad = await trustedTool(ctx, 'book_appointment', { first_name: 'No', last_name: 'Time', appointment_date: 'tomorrow', appointment_time: 'soon' }) as { booked: boolean };
    expect(bad.booked).toBe(false);
    const noName = await trustedTool(ctx, 'book_appointment', { appointment_date: futureDate(2), appointment_time: '10:00' }) as { booked: boolean };
    expect(noName.booked).toBe(false);
    expect(await db.appointment.count({ where: { tenantId } })).toBe(0);
  });

  it('isolates tenants — two clinics can book the same slot independently', async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    const date = futureDate(5);
    const slot = ((await trustedTool({ tenantId: a, callId: 'a' }, 'check_availability', { appointment_date: date })) as { slots: { time: string }[] }).slots[0].time;
    const bookA = await trustedTool({ tenantId: a, callId: 'a' }, 'book_appointment', { first_name: 'A', last_name: 'A', appointment_date: date, appointment_time: slot }) as { booked: boolean };
    const bookB = await trustedTool({ tenantId: b, callId: 'b' }, 'book_appointment', { first_name: 'B', last_name: 'B', appointment_date: date, appointment_time: slot }) as { booked: boolean };
    expect(bookA.booked).toBe(true);
    expect(bookB.booked).toBe(true);
    expect(await db.appointment.count({ where: { tenantId: a } })).toBe(1);
    expect(await db.appointment.count({ where: { tenantId: b } })).toBe(1);
  });
});
