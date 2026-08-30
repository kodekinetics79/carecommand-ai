import type { Prisma } from '../../generated/prisma/client';
import type { db as DbClient } from '../db';
import { partsAt } from '../scheduling';
import { addDays, hoursConfigured, isOpenAt, parseWeeklyHours, type ClosureRule, type HoursSource, type WeeklyHours } from './clinicHours';

type Client = typeof DbClient | Prisma.TransactionClient;

// The one database access the hours engine needs: a clinic, its locations
// (timezone derived from the branch; legacy branchless rows fall back to the
// clinic timezone) and the closures in a -1..+60 day window.

export interface LocationHours {
  id: string;
  name: string;
  address: string;
  phone: string | null;
  accessNotes: string | null;
  branchId: string | null;
  timezone: string;
  active: boolean;
  workingHours: WeeklyHours | null;
  source: HoursSource;
}

export interface ClinicHoursBundle {
  clinic: {
    id: string;
    name: string;
    phone: string;
    timezone: string;
    country: string | null;
    defaultLanguage: string;
    workingHours: WeeklyHours | null;
  };
  source: HoursSource;
  closures: ClosureRule[];
  locations: LocationHours[];
}

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export async function loadHoursSource(
  client: Client,
  input: { tenantId: string; clinicId: string; now?: Date; closureWindowDays?: number },
): Promise<ClinicHoursBundle | null> {
  const now = input.now ?? new Date();
  const clinic = await client.receptionistClinic.findFirst({
    where: { id: input.clinicId, tenantId: input.tenantId },
    select: {
      id: true, name: true, phone: true, timezone: true, country: true, defaultLanguage: true, workingHours: true,
      locations: {
        orderBy: { createdAt: 'asc' },
        select: { id: true, name: true, address: true, phone: true, accessNotes: true, branchId: true, active: true, workingHours: true, branch: { select: { timezone: true } } },
      },
    },
  });
  if (!clinic) return null;
  const today = partsAt(now, clinic.timezone).dateISO;
  const rows = await client.receptionistClosure.findMany({
    where: {
      tenantId: input.tenantId,
      clinicId: clinic.id,
      endsOn: { gte: new Date(addDays(today, -1)) },
      startsOn: { lte: new Date(addDays(today, input.closureWindowDays ?? 60)) },
    },
    orderBy: [{ startsOn: 'asc' }, { id: 'asc' }],
    select: { id: true, locationId: true, startsOn: true, endsOn: true, startTime: true, endTime: true, reason: true },
  });
  const closures: ClosureRule[] = rows.map(row => ({
    id: row.id, locationId: row.locationId, startsOn: dateOnly(row.startsOn), endsOn: dateOnly(row.endsOn),
    startTime: row.startTime, endTime: row.endTime, reason: row.reason,
  }));
  const clinicHours = parseWeeklyHours(clinic.workingHours);
  const source: HoursSource = { timezone: clinic.timezone, clinicHours, locationId: null, closures };
  const locations: LocationHours[] = clinic.locations.map(location => {
    const timezone = location.branch?.timezone ?? clinic.timezone;
    const workingHours = parseWeeklyHours(location.workingHours);
    return {
      id: location.id, name: location.name, address: location.address, phone: location.phone, accessNotes: location.accessNotes,
      branchId: location.branchId, timezone, active: location.active, workingHours,
      source: { timezone, clinicHours, locationHours: workingHours, locationId: location.id, closures },
    };
  });
  return {
    clinic: { id: clinic.id, name: clinic.name, phone: clinic.phone, timezone: clinic.timezone, country: clinic.country, defaultLanguage: clinic.defaultLanguage, workingHours: clinicHours },
    source,
    closures,
    locations,
  };
}

/** True when any eligible location or the clinic itself has weekly hours. */
export function bundleHoursConfigured(bundle: ClinicHoursBundle): boolean {
  return hoursConfigured(bundle.source) || bundle.locations.some(location => location.active && hoursConfigured(location.source));
}

/**
 * Stamp for a call log: `true`/`false` from the clinic hours at `at`, or
 * `null` when hours are not configured (never a fabricated "false").
 */
export async function callHoursStamp(client: Client, input: { tenantId: string; clinicId: string | null | undefined; at: Date }): Promise<{ outsideHours: boolean | null }> {
  if (!input.clinicId) return { outsideHours: null };
  const bundle = await loadHoursSource(client, { tenantId: input.tenantId, clinicId: input.clinicId, now: input.at });
  if (!bundle || !hoursConfigured(bundle.source)) return { outsideHours: null };
  return { outsideHours: !isOpenAt(bundle.source, input.at).open };
}
