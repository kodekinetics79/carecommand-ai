import { db } from '../db';
import type { Prisma } from '../../generated/prisma/client';
import { computeProviderSlots, findSlotConflict, parseClinicSlot, resolveProviderSchedulingContext } from '../scheduling';
import type { LocaleFormat } from './localePacks/types';

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

/**
 * How a slot is said out loud. The clock is a property of the caller's locale
 * pack, not of this file: an en-GB caller offered "2:30 PM" is being read a
 * foreign clock by their own practice. With no resolved locale the caller's
 * pack is unknown, so the pre-C10 12-hour form is kept rather than guessing.
 */
export function speakTime(time: string, locale?: LocaleFormat | null): string {
  const tm = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!tm) return time;
  const h24 = Number(tm[1]); const m = tm[2];
  if (locale?.timeStyle === '24h') return `${String(h24).padStart(2, '0')}:${m}`;
  const ap = h24 >= 12 ? 'PM' : 'AM';
  return `${h24 % 12 || 12}:${m} ${ap}`;
}
