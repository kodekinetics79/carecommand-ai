import { db } from '../db';
import type { Prisma } from '../../generated/prisma/client';

type Client = typeof db | Prisma.TransactionClient;

// Real-time appointment availability for the AI receptionist. No dedicated
// working-hours model exists yet, so we use sensible clinic defaults and
// subtract real booked appointments. Times are wall-clock (UTC-anchored) and
// compared consistently against stored appointment times.

const OPEN_HOUR = 9;
const CLOSE_HOUR = 17;
export const SLOT_MIN = 30;
const BLOCKING = ['CONFIRMED', 'RISKY', 'ARRIVED', 'COMPLETED', 'WAITLIST']; // not CANCELED / NO_SHOW

export interface Slot { time: string; startsAt: Date; endsAt: Date }

function isoDate(d: string): string | null {
  return /^\d{4}-\d{2}-\d{2}$/.test(d.trim()) ? d.trim() : null;
}
function at(dateISO: string, h: number, m: number): Date {
  return new Date(`${dateISO}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`);
}

/** Open slots for a branch on a date (defaults: 09:00–17:00, 30-min, future-only). */
export async function getOpenSlots(tenantId: string, branchId: string, dateISO: string, durationMin = SLOT_MIN, limit = 8): Promise<Slot[]> {
  const date = isoDate(dateISO);
  if (!date) return [];
  const dayStart = at(date, 0, 0);
  const dayEnd = new Date(dayStart.getTime() + 86_400_000);
  if (Number.isNaN(dayStart.getTime())) return [];

  const booked = await db.appointment.findMany({
    where: { tenantId, branchId, deletedAt: null, status: { in: BLOCKING as never }, startsAt: { gte: dayStart, lt: dayEnd } },
    select: { startsAt: true, endsAt: true },
  });
  const taken = booked.map(a => [a.startsAt.getTime(), a.endsAt.getTime()] as const);
  const now = Date.now();
  const slots: Slot[] = [];
  for (let h = OPEN_HOUR; h < CLOSE_HOUR; h++) {
    for (let m = 0; m < 60; m += durationMin) {
      const startsAt = at(date, h, m);
      const endsAt = new Date(startsAt.getTime() + durationMin * 60_000);
      if (startsAt.getTime() <= now) continue;
      const overlaps = taken.some(([s, e]) => startsAt.getTime() < e && endsAt.getTime() > s);
      if (!overlaps) {
        slots.push({ time: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`, startsAt, endsAt });
        if (slots.length >= limit) return slots;
      }
    }
  }
  return slots;
}

/**
 * Is a specific start time still free for the branch? Accepts an optional client
 * so the check can run INSIDE the booking transaction (holding the slot advisory
 * lock) and see other paths' committed appointments — this is what makes the
 * live agent participate in the shared Appointment double-booking guard.
 */
export async function isSlotOpen(tenantId: string, branchId: string, startsAt: Date, durationMin = SLOT_MIN, client: Client = db): Promise<boolean> {
  if (Number.isNaN(startsAt.getTime())) return false;
  const endsAt = new Date(startsAt.getTime() + durationMin * 60_000);
  const conflict = await client.appointment.findFirst({
    where: { tenantId, branchId, deletedAt: null, status: { in: BLOCKING as never }, startsAt: { lt: endsAt }, endsAt: { gt: startsAt } },
    select: { id: true },
  });
  return !conflict;
}

/** Parse "YYYY-MM-DD" + "HH:mm" into a UTC-anchored Date (matches getOpenSlots). */
export function parseSlot(dateISO: string, time: string): Date | null {
  const date = isoDate(dateISO);
  const tm = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!date || !tm) return null;
  const d = at(date, Number(tm[1]), Number(tm[2]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Friendly 12-hour label for speech, e.g. "2:30 PM". */
export function speakTime(time: string): string {
  const tm = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!tm) return time;
  let h = Number(tm[1]); const m = tm[2];
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m} ${ap}`;
}
