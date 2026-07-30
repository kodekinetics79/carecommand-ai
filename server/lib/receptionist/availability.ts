import { db } from '../db';
import type { Prisma } from '../../generated/prisma/client';
import { computeProviderSlots, findSlotConflict, parseClinicSlot, resolveProviderSchedulingContext } from '../scheduling';

type Client = typeof db | Prisma.TransactionClient;
export const SLOT_MIN = 30;
export interface Slot { time: string; startsAt: Date; endsAt: Date }

function localTime(instant: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(instant);
}

/** Receptionist adapter over the canonical provider scheduling engine. */
export async function getOpenSlots(
  tenantId: string, branchId: string, dateISO: string, durationMin = SLOT_MIN, limit = 8, providerProfileId?: string,
): Promise<Slot[]> {
  if (!providerProfileId) return [];
  const provider = await resolveProviderSchedulingContext(tenantId, providerProfileId, branchId);
  if (!provider) return [];
  const slots = await computeProviderSlots({ tenantId, providerProfileId, dateISO, durationMin });
  return slots.slice(0, limit).map(slot => ({ ...slot, time: localTime(slot.startsAt, provider.timezone) }));
}

export async function isSlotOpen(
  tenantId: string, branchId: string, startsAt: Date, durationMin = SLOT_MIN, client: Client = db, providerProfileId?: string,
): Promise<boolean> {
  if (!providerProfileId || Number.isNaN(startsAt.getTime())) return false;
  const provider = await resolveProviderSchedulingContext(tenantId, providerProfileId, branchId, client);
  if (!provider) return false;
  return (await findSlotConflict({ tenantId, providerProfileId, startsAt, durationMin }, client)) === null;
}

export function parseSlot(dateISO: string, time: string, timezone = 'UTC'): Date | null {
  return parseClinicSlot(dateISO, time, timezone);
}

export function speakTime(time: string): string {
  const tm = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!tm) return time;
  let h = Number(tm[1]); const m = tm[2];
  const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
  return `${h}:${m} ${ap}`;
}
