import { db } from './db';
import type { Prisma } from '../generated/prisma/client';

// Canonical provider scheduling. Appointments are UTC instants; recurring
// availability is interpreted as clinic-local wall-clock minutes using the
// provider branch's validated IANA timezone.

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

type Client = typeof db | Prisma.TransactionClient;

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

export interface SchedulingService {
  id: string | null;
  name: string;
  durationMin: number;
  catalogConfigured: boolean;
}

export interface ProviderSchedulingContext {
  providerProfileId: string;
  branchId: string;
  timezone: string;
}

export const DOUBLE_BOOK_CONSTRAINT = 'appointment_no_double_book';

export function isDoubleBookConflictError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const anyErr = error as { code?: string; meta?: { code?: string; constraint?: unknown }; message?: string };
  const dbCode = anyErr.meta?.code ?? anyErr.code;
  if (dbCode === '23P01') return true;
  const constraint = anyErr.meta?.constraint;
  if (typeof constraint === 'string' && constraint === DOUBLE_BOOK_CONSTRAINT) return true;
  return typeof anyErr.message === 'string' && anyErr.message.includes(DOUBLE_BOOK_CONSTRAINT);
}

const BLOCKING_STATUSES = ['CONFIRMED', 'RISKY', 'ARRIVED', 'COMPLETED', 'WAITLIST'] as const;
const overlaps = (aStart: Date, aEnd: Date, bStart: Date, bEnd: Date) => aStart < bEnd && bStart < aEnd;

interface ParsedDate { year: number; month: number; day: number; dayOfWeek: number }
interface LocalParts { dateISO: string; minuteOfDay: number; dayOfWeek: number }

function parseDateISO(dateISO: string): ParsedDate {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateISO);
  if (!match) throw new Error('invalid local date');
  const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) throw new Error('invalid local date');
  return { year, month, day, dayOfWeek: probe.getUTCDay() };
}

export function validateIanaTimezone(timezone: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date(0));
    return timezone;
  } catch {
    throw new Error(`Invalid branch timezone: ${timezone}`);
  }
}

function partsAt(instant: Date, timezone: string): LocalParts {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find(p => p.type === type)?.value);
  const year = value('year'); const month = value('month'); const day = value('day');
  const hour = value('hour'); const minute = value('minute');
  const dateISO = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return { dateISO, minuteOfDay: hour * 60 + minute, dayOfWeek: new Date(Date.UTC(year, month - 1, day)).getUTCDay() };
}

/**
 * Convert a clinic-local date/minute to UTC. DST gaps return null. DST folds
 * choose the earlier matching instant, deterministically, so duplicate
 * wall-clock slots are neither advertised nor accepted through another path.
 */
export function clinicLocalMinuteToUtc(dateISO: string, minuteOfDay: number, timezone: string): Date | null {
  const { year, month, day } = parseDateISO(dateISO);
  validateIanaTimezone(timezone);
  if (!Number.isInteger(minuteOfDay) || minuteOfDay < 0 || minuteOfDay >= 1440) return null;
  const localEpoch = Date.UTC(year, month - 1, day, Math.floor(minuteOfDay / 60), minuteOfDay % 60);
  const offsets = new Set<number>();
  for (let h = -36; h <= 36; h += 1) {
    const sampleMs = localEpoch + h * 3_600_000;
    const local = partsAt(new Date(sampleMs), timezone);
    const parsed = parseDateISO(local.dateISO);
    const representedLocal = Date.UTC(parsed.year, parsed.month - 1, parsed.day, Math.floor(local.minuteOfDay / 60), local.minuteOfDay % 60);
    offsets.add(representedLocal - sampleMs);
  }
  const candidates = [...offsets]
    .map(offset => new Date(localEpoch - offset))
    .filter(candidate => {
      const local = partsAt(candidate, timezone);
      return local.dateISO === dateISO && local.minuteOfDay === minuteOfDay;
    })
    .sort((a, b) => a.getTime() - b.getTime());
  return candidates[0] ?? null;
}

export function parseClinicSlot(dateISO: string, time: string, timezone: string): Date | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!match) return null;
  const hour = Number(match[1]); const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  try { return clinicLocalMinuteToUtc(dateISO, hour * 60 + minute, timezone); }
  catch { return null; }
}

/**
 * The one place a provider is decided to be schedulable. A deactivated profile,
 * or one in a closed branch, resolves to null — so every caller (open slots,
 * conflict checks, the receptionist adapter, the patient portal) fails closed on
 * it without each having to remember the rule.
 */
export async function resolveProviderSchedulingContext(
  tenantId: string, providerProfileId: string, branchId?: string, client: Client = db,
): Promise<ProviderSchedulingContext | null> {
  const provider = await client.providerProfile.findFirst({
    where: { id: providerProfileId, tenantId, branchId, active: true },
    select: { id: true, branchId: true, branch: { select: { timezone: true, active: true } } },
  });
  if (!provider || !provider.branch.active) return null;
  return { providerProfileId: provider.id, branchId: provider.branchId, timezone: validateIanaTimezone(provider.branch.timezone) };
}

/** Active catalog configuration is fail-closed; caller duration is ignored. */
export async function resolveSchedulingService(
  args: { tenantId: string; serviceCatalogItemId?: string | null; service?: string | null; fallbackDurationMin?: number },
  client: Client = db,
): Promise<SchedulingService | null> {
  const catalog = await client.serviceCatalogItem.findMany({
    where: { tenantId: args.tenantId, active: true },
    select: { id: true, name: true, defaultDurationMinutes: true },
    orderBy: { createdAt: 'asc' },
  });
  if (catalog.length > 0) {
    const normalized = args.service?.trim().toLocaleLowerCase();
    const matches = catalog.filter(item => args.serviceCatalogItemId
      ? item.id === args.serviceCatalogItemId
      : Boolean(normalized) && item.name.trim().toLocaleLowerCase() === normalized);
    if (matches.length !== 1) return null;
    const item = matches[0];
    return { id: item.id, name: item.name, durationMin: item.defaultDurationMinutes, catalogConfigured: true };
  }
  const name = args.service?.trim() || 'Consultation';
  const durationMin = args.fallbackDurationMin ?? 30;
  if (!Number.isInteger(durationMin) || durationMin < 5 || durationMin > 480) return null;
  return { id: null, name, durationMin, catalogConfigured: false };
}

interface ProviderDayContext {
  windows: Array<{ startMinute: number; endMinute: number; slotMinutes: number }>;
  timeOff: Array<{ startsAt: Date; endsAt: Date }>;
  appts: Array<{ startsAt: Date; endsAt: Date }>;
  timezone: string;
}

async function loadProviderDay(client: Client, tenantId: string, providerProfileId: string, dateISO: string): Promise<ProviderDayContext> {
  const { dayOfWeek } = parseDateISO(dateISO);
  const provider = await resolveProviderSchedulingContext(tenantId, providerProfileId, undefined, client);
  if (!provider) throw new Error('Provider does not belong to an active branch in this tenant');
  const utcAnchor = new Date(`${dateISO}T00:00:00.000Z`);
  const rangeStart = new Date(utcAnchor.getTime() - 18 * 3_600_000);
  const rangeEnd = new Date(utcAnchor.getTime() + 42 * 3_600_000);
  const [windows, timeOff, appts] = await Promise.all([
    client.providerAvailability.findMany({
      where: { tenantId, providerProfileId, dayOfWeek, active: true },
      select: { startMinute: true, endMinute: true, slotMinutes: true }, orderBy: { startMinute: 'asc' },
    }),
    client.providerTimeOff.findMany({
      where: { tenantId, providerProfileId, startsAt: { lt: rangeEnd }, endsAt: { gt: rangeStart } },
      select: { startsAt: true, endsAt: true },
    }),
    client.appointment.findMany({
      where: { tenantId, providerProfileId, deletedAt: null, status: { in: [...BLOCKING_STATUSES] }, startsAt: { lt: rangeEnd }, endsAt: { gt: rangeStart } },
      select: { startsAt: true, endsAt: true },
    }),
  ]);
  return { windows, timeOff, appts, timezone: provider.timezone };
}

export async function computeProviderSlots(
  args: { tenantId: string; providerProfileId: string; dateISO: string; durationMin?: number; now?: Date },
  client: Client = db,
): Promise<Slot[]> {
  const { tenantId, providerProfileId, dateISO, durationMin, now = new Date() } = args;
  const { windows, timeOff, appts, timezone } = await loadProviderDay(client, tenantId, providerProfileId, dateISO);
  const slots: Slot[] = [];
  for (const window of windows) {
    const duration = durationMin ?? window.slotMinutes;
    for (let minute = window.startMinute; minute + duration <= window.endMinute; minute += window.slotMinutes) {
      const startsAt = clinicLocalMinuteToUtc(dateISO, minute, timezone);
      if (!startsAt) continue;
      const endsAt = new Date(startsAt.getTime() + duration * 60_000);
      const localEnd = partsAt(endsAt, timezone);
      // Reject elapsed durations whose wall-clock end changes at a DST boundary.
      if (localEnd.dateISO !== dateISO || localEnd.minuteOfDay !== minute + duration) continue;
      if (startsAt < now) continue;
      if (timeOff.some(t => overlaps(startsAt, endsAt, t.startsAt, t.endsAt))) continue;
      if (appts.some(a => overlaps(startsAt, endsAt, a.startsAt, a.endsAt))) continue;
      slots.push({ startsAt, endsAt });
    }
  }
  return slots.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}

export async function findSlotConflict(
  args: { tenantId: string; providerProfileId: string; startsAt: Date; durationMin: number; now?: Date; excludeAppointmentId?: string },
  client: Client = db,
): Promise<SlotConflict | null> {
  const { tenantId, providerProfileId, startsAt, durationMin, now = new Date(), excludeAppointmentId } = args;
  const endsAt = new Date(startsAt.getTime() + durationMin * 60_000);
  if (startsAt < now) return 'in_past';
  const provider = await resolveProviderSchedulingContext(tenantId, providerProfileId, undefined, client);
  if (!provider) return 'outside_availability';
  const localStart = partsAt(startsAt, provider.timezone);
  const endMinuteOfDay = localStart.minuteOfDay + durationMin;
  const canonicalInstant = clinicLocalMinuteToUtc(localStart.dateISO, localStart.minuteOfDay, provider.timezone);
  const localEnd = partsAt(endsAt, provider.timezone);
  if (!canonicalInstant || canonicalInstant.getTime() !== startsAt.getTime()
    || localEnd.dateISO !== localStart.dateISO || localEnd.minuteOfDay !== endMinuteOfDay) return 'outside_availability';

  const windows = await client.providerAvailability.findMany({
    where: { tenantId, providerProfileId, dayOfWeek: localStart.dayOfWeek, active: true },
    select: { startMinute: true, endMinute: true },
  });
  if (!windows.some(w => w.startMinute <= localStart.minuteOfDay && endMinuteOfDay <= w.endMinute)) return 'outside_availability';

  const timeOff = await client.providerTimeOff.findFirst({
    where: { tenantId, providerProfileId, startsAt: { lt: endsAt }, endsAt: { gt: startsAt } }, select: { id: true },
  });
  if (timeOff) return 'time_off';
  const clash = await client.appointment.findFirst({
    where: { tenantId, providerProfileId, deletedAt: null, id: excludeAppointmentId ? { not: excludeAppointmentId } : undefined,
      status: { in: [...BLOCKING_STATUSES] }, startsAt: { lt: endsAt }, endsAt: { gt: startsAt } },
    select: { id: true },
  });
  return clash ? 'already_booked' : null;
}
