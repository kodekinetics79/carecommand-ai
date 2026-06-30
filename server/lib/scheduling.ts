import { db } from './db';
import type { Prisma } from '../generated/prisma/client';

// ===========================================================================
// Provider scheduling: turn recurring availability + time-off + existing
// appointments into concrete open slots, and validate a single slot for booking.
//
// Backend-owned (never trust client-computed availability). Appointments are
// associated to a provider via Appointment.providerRef = ProviderProfile.id.
//
// Timezone note: minutes are measured from the date's UTC midnight — i.e. clinic
// time is treated as UTC for this slice. Per-clinic timezones are a follow-up;
// the model already carries everything needed to apply an offset later.
// ===========================================================================

export interface Slot { startsAt: Date; endsAt: Date }

export interface SchedulingPolicy {
  selfBookEnabled: boolean;
  requireEligibilityForSelfBook: boolean;
  requireIntakeForSelfBook: boolean;
  maxHorizonDays: number;
  minNoticeHours: number;
}

export const DEFAULT_SCHEDULING_POLICY: SchedulingPolicy = {
  selfBookEnabled: true,
  requireEligibilityForSelfBook: false,
  requireIntakeForSelfBook: false,
  maxHorizonDays: 90,
  minNoticeHours: 0,
};

/** The tenant's self-scheduling policy, or safe defaults when none is set. */
export async function getSchedulingPolicy(tenantId: string, client: Client = db): Promise<SchedulingPolicy> {
  const row = await client.schedulingPolicy.findUnique({ where: { tenantId } });
  if (!row) return DEFAULT_SCHEDULING_POLICY;
  return {
    selfBookEnabled: row.selfBookEnabled,
    requireEligibilityForSelfBook: row.requireEligibilityForSelfBook,
    requireIntakeForSelfBook: row.requireIntakeForSelfBook,
    maxHorizonDays: row.maxHorizonDays,
    minNoticeHours: row.minNoticeHours,
  };
}

export type PreVisitRequirement = 'eligibility' | 'intake';

/**
 * Pre-visit requirements the patient has NOT yet satisfied, per the tenant policy.
 * Empty array = clear to self-book. Eligibility = an active (coverageActive)
 * verification on file; intake = a submitted/approved intake packet.
 */
export async function unmetPreVisitRequirements(
  tenantId: string, patientId: string, policy: SchedulingPolicy, client: Client = db,
): Promise<PreVisitRequirement[]> {
  const unmet: PreVisitRequirement[] = [];
  if (policy.requireEligibilityForSelfBook) {
    const elig = await client.eligibilityVerification.findFirst({ where: { tenantId, patientId, coverageActive: true }, select: { id: true } });
    if (!elig) unmet.push('eligibility');
  }
  if (policy.requireIntakeForSelfBook) {
    const intake = await client.patientIntakePacket.findFirst({ where: { tenantId, patientId, status: { in: ['submitted', 'approved'] } }, select: { id: true } });
    if (!intake) unmet.push('intake');
  }
  return unmet;
}

export type SlotConflict = 'in_past' | 'outside_availability' | 'time_off' | 'already_booked';

// Appointment statuses that still occupy the provider's calendar.
const BLOCKING_STATUSES = ['CONFIRMED', 'RISKY', 'ARRIVED', 'COMPLETED', 'WAITLIST'] as const;

type Client = typeof db | Prisma.TransactionClient;

const overlaps = (aStart: Date, aEnd: Date, bStart: Date, bEnd: Date) => aStart < bEnd && bStart < aEnd;

function dayBounds(dateISO: string) {
  const dayStart = new Date(`${dateISO}T00:00:00.000Z`);
  if (Number.isNaN(dayStart.getTime())) throw new Error('invalid date');
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  return { dayStart, dayEnd, dayOfWeek: dayStart.getUTCDay() };
}

interface ProviderDayContext {
  windows: Array<{ startMinute: number; endMinute: number; slotMinutes: number }>;
  timeOff: Array<{ startsAt: Date; endsAt: Date }>;
  appts: Array<{ startsAt: Date; endsAt: Date }>;
  dayStart: Date;
  dayEnd: Date;
}

async function loadProviderDay(client: Client, tenantId: string, providerProfileId: string, dateISO: string): Promise<ProviderDayContext> {
  const { dayStart, dayEnd, dayOfWeek } = dayBounds(dateISO);
  const [windows, timeOff, appts] = await Promise.all([
    client.providerAvailability.findMany({
      where: { tenantId, providerProfileId, dayOfWeek, active: true },
      select: { startMinute: true, endMinute: true, slotMinutes: true },
      orderBy: { startMinute: 'asc' },
    }),
    client.providerTimeOff.findMany({
      where: { tenantId, providerProfileId, startsAt: { lt: dayEnd }, endsAt: { gt: dayStart } },
      select: { startsAt: true, endsAt: true },
    }),
    client.appointment.findMany({
      where: { tenantId, providerRef: providerProfileId, deletedAt: null, status: { in: [...BLOCKING_STATUSES] }, startsAt: { lt: dayEnd, gte: new Date(dayStart.getTime() - 12 * 60 * 60 * 1000) } },
      select: { startsAt: true, endsAt: true },
    }),
  ]);
  return { windows, timeOff, appts, dayStart, dayEnd };
}

/** Open slots for a provider on a date, excluding past times, time-off, and booked appointments. */
export async function computeProviderSlots(
  args: { tenantId: string; providerProfileId: string; dateISO: string; durationMin?: number; now?: Date },
  client: Client = db,
): Promise<Slot[]> {
  const { tenantId, providerProfileId, dateISO, durationMin, now = new Date() } = args;
  const { windows, timeOff, appts, dayStart } = await loadProviderDay(client, tenantId, providerProfileId, dateISO);

  const slots: Slot[] = [];
  for (const window of windows) {
    const step = durationMin ?? window.slotMinutes;
    for (let m = window.startMinute; m + step <= window.endMinute; m += window.slotMinutes) {
      const startsAt = new Date(dayStart.getTime() + m * 60_000);
      const endsAt = new Date(startsAt.getTime() + step * 60_000);
      if (startsAt < now) continue; // no past slots
      if (timeOff.some(t => overlaps(startsAt, endsAt, t.startsAt, t.endsAt))) continue;
      if (appts.some(a => overlaps(startsAt, endsAt, a.startsAt, a.endsAt))) continue;
      slots.push({ startsAt, endsAt });
    }
  }
  return slots.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}

/**
 * Validate a concrete slot for booking. Returns null when bookable, else the
 * first conflict reason. Run inside the booking transaction for the appointment
 * conflict check to hold against concurrent bookings.
 */
export async function findSlotConflict(
  args: { tenantId: string; providerProfileId: string; startsAt: Date; durationMin: number; now?: Date },
  client: Client = db,
): Promise<SlotConflict | null> {
  const { tenantId, providerProfileId, startsAt, durationMin, now = new Date() } = args;
  const endsAt = new Date(startsAt.getTime() + durationMin * 60_000);
  if (startsAt < now) return 'in_past';

  const dateISO = startsAt.toISOString().slice(0, 10);
  const { dayStart } = dayBounds(dateISO);
  const minuteOfDay = Math.round((startsAt.getTime() - dayStart.getTime()) / 60_000);
  const endMinuteOfDay = minuteOfDay + durationMin;
  const dayOfWeek = startsAt.getUTCDay();

  const windows = await client.providerAvailability.findMany({
    where: { tenantId, providerProfileId, dayOfWeek, active: true },
    select: { startMinute: true, endMinute: true },
  });
  const withinWindow = windows.some(w => w.startMinute <= minuteOfDay && endMinuteOfDay <= w.endMinute);
  if (!withinWindow) return 'outside_availability';

  const timeOff = await client.providerTimeOff.findFirst({
    where: { tenantId, providerProfileId, startsAt: { lt: endsAt }, endsAt: { gt: startsAt } },
    select: { id: true },
  });
  if (timeOff) return 'time_off';

  const clash = await client.appointment.findFirst({
    where: { tenantId, providerRef: providerProfileId, deletedAt: null, status: { in: [...BLOCKING_STATUSES] }, startsAt: { lt: endsAt }, endsAt: { gt: startsAt } },
    select: { id: true },
  });
  if (clash) return 'already_booked';

  return null;
}
