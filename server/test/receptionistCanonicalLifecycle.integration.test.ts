import 'dotenv/config';
import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fixtureDb as db } from './helpers/fixtureDb';
import { bookAppointment } from '../lib/receptionist/liveTools';
import { parseSlot } from '../lib/receptionist/availability';
import { runWithWebhookTenantContext } from '../lib/tenantContext';

const tenantIds: string[] = [];

async function createTenant() {
  const id = randomUUID();
  const branch = await db.tenant.create({
    data: {
      id,
      name: `receptionist-lifecycle-${id.slice(0, 8)}`,
      slug: `receptionist-lifecycle-${id.slice(0, 8)}`,
      branches: { create: { name: 'Main', location: 'Test', timezone: 'UTC' } },
    },
    select: { branches: { select: { id: true }, take: 1 } },
  });
  tenantIds.push(id);
  const branchId = branch.branches[0].id;
  const user = await db.user.create({ data: { tenantId: id, role: 'PROVIDER', active: true, email: `provider-${id.slice(0, 8)}@test.local`, displayName: 'Provider' } });
  const provider = await db.providerProfile.create({ data: { tenantId: id, branchId, userId: user.id, specialty: 'General' } });
  await db.providerAvailability.createMany({ data: Array.from({ length: 7 }, (_, dayOfWeek) => ({ tenantId: id, branchId, providerProfileId: provider.id, dayOfWeek, startMinute: 540, endMinute: 1020, slotMinutes: 30 })) });
  return { tenantId: id, branchId };
}

afterAll(async () => {
  for (const tenantId of tenantIds) {
    await db.tenant.delete({ where: { id: tenantId } }).catch(() => {});
  }
  await db.$disconnect();
});

describe('receptionist canonical booking lifecycle', () => {
  it('never treats a stale idempotency claim as proof of an appointment', async () => {
    const { tenantId, branchId } = await createTenant();
    const callId = `call-${randomUUID()}`;
    const date = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    const time = '10:00';
    const startsAt = parseSlot(date, time);
    expect(startsAt).not.toBeNull();
    const key = `${callId}:${branchId}:${startsAt!.toISOString()}`;

    // Reproduces the legacy failure mode: a claim existed even though the
    // appointment transaction never committed.
    await db.idempotencyKey.create({
      data: { tenantId, scope: 'receptionist.live-booking', key, resultId: null },
    });

    const first = await runWithWebhookTenantContext(tenantId, () => bookAppointment(
      { tenantId, callId },
      { first_name: 'Jordan', last_name: 'Lee', appointment_date: date, appointment_time: time },
    ), 'webhook:test-retell-booking') as { booked: boolean; needs_human?: boolean };

    expect(first).toMatchObject({ booked: false, needs_human: true });
    expect(await db.appointment.count({ where: { tenantId } })).toBe(0);
    expect(await db.idempotencyKey.findUnique({
      where: { scope_key: { scope: 'receptionist.live-booking', key } },
      select: { resultId: true },
    })).toEqual({ resultId: null });

    const replay = await runWithWebhookTenantContext(tenantId, () => bookAppointment(
      { tenantId, callId },
      { first_name: 'Jordan', last_name: 'Lee', appointment_date: date, appointment_time: time },
    ), 'webhook:test-retell-booking') as { booked: boolean; needs_human?: boolean };

    expect(replay).toMatchObject({ booked: false, needs_human: true });
    expect(await db.appointment.count({ where: { tenantId } })).toBe(0);
  });
});
