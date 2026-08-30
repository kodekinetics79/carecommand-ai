import { db } from '../db';
import type { Prisma } from '../../generated/prisma/client';
import { computeProviderSlots, findSlotConflict, parseClinicSlot, resolveProviderSchedulingContext } from '../scheduling';

type Client = typeof db | Prisma.TransactionClient;
export const SLOT_MIN = 30;
export interface Slot { time: string; startsAt: Date; endsAt: Date }

/** A slot always knows WHOSE calendar it came from. */
export interface ProviderSlot extends Slot { providerProfileId: string }

/** Cap on how many clinicians one availability sweep will fan out across. */
export const MAX_BOOKABLE_PROVIDERS = 25;

export interface BookableProvider {
  id: string;
  /** Display name, used to honour a caller's named-clinician request. */
  displayName: string;
}

/**
 * Every clinician a caller could be booked with at this branch.
 *
 * The live tools used to demand exactly ONE active provider and refuse
 * everything otherwise, so every real multi-clinician practice heard "I need a
 * team member to confirm the provider" on every single call. Ambiguity is not a
 * reason to refuse: it is a reason to search all of them and book whoever is
 * actually free at the time the caller picked.
 */
export async function listBookableProviders(
  tenantId: string, branchId: string, client: Client = db,
): Promise<BookableProvider[]> {
  const rows = await client.providerProfile.findMany({
    where: { tenantId, branchId, active: true, user: { active: true } },
    select: { id: true, user: { select: { displayName: true } } },
    orderBy: { id: 'asc' },
    take: MAX_BOOKABLE_PROVIDERS,
  });
  return rows.map(row => ({ id: row.id, displayName: row.user.displayName.trim() }));
}

/**
 * Match a caller's spoken clinician name against the branch roster.
 *
 * Deliberately forgiving in one direction only: a caller says "Dr Patel", the
 * roster says "Dr. Anita Patel". A single containment match wins; anything
 * ambiguous returns null so the caller is asked rather than guessed at.
 */
export function matchPreferredProvider(
  providers: BookableProvider[], requested: unknown,
): BookableProvider | null {
  const wanted = typeof requested === 'string' ? requested.trim().toLocaleLowerCase() : '';
  if (wanted.length < 2) return null;
  const exact = providers.filter(provider => provider.displayName.toLocaleLowerCase() === wanted);
  if (exact.length === 1) return exact[0];
  const tokens = wanted.split(/[^\p{L}\p{N}]+/u).filter(token => token.length > 2 && !['dr', 'doctor', 'mr', 'mrs', 'ms'].includes(token));
  if (!tokens.length) return null;
  const partial = providers.filter(provider => {
    const name = provider.displayName.toLocaleLowerCase();
    return tokens.every(token => name.includes(token));
  });
  return partial.length === 1 ? partial[0] : null;
}

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

/**
 * The union of open slots across several clinicians, as one merged offer.
 *
 * Each returned slot carries the provider whose calendar it came from, so the
 * booking that follows is made against that exact provider — the advisory lock
 * in the booking transaction is already per-provider. When two clinicians are
 * free at the same wall-clock time the caller hears it once; the earlier
 * provider in roster order owns it, deterministically.
 */
export async function getOpenSlotsAcrossProviders(
  args: {
    tenantId: string;
    branchId: string;
    dateISO: string;
    durationMin?: number;
    limit?: number;
    providerProfileIds: string[];
  },
  client: Client = db,
): Promise<ProviderSlot[]> {
  const { tenantId, branchId, dateISO, durationMin = SLOT_MIN, limit = 8, providerProfileIds } = args;
  if (!providerProfileIds.length) return [];
  const merged = new Map<string, ProviderSlot>();
  for (const providerProfileId of providerProfileIds.slice(0, MAX_BOOKABLE_PROVIDERS)) {
    const provider = await resolveProviderSchedulingContext(tenantId, providerProfileId, branchId, client);
    if (!provider) continue;
    const slots = await computeProviderSlots({ tenantId, providerProfileId, dateISO, durationMin }, client);
    for (const slot of slots) {
      const time = localTime(slot.startsAt, provider.timezone);
      if (!merged.has(time)) merged.set(time, { ...slot, time, providerProfileId });
    }
  }
  return [...merged.values()]
    .sort((left, right) => left.startsAt.getTime() - right.startsAt.getTime())
    .slice(0, limit);
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
