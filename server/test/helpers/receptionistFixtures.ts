import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '../../generated/prisma/client';
import { fixtureDb } from './fixtureDb';
import { PLATFORM_LOCALE_PACKS, platformLocalePackHash } from '../../lib/receptionist/localePacks/defaults';

// ===========================================================================
// One place that knows what a receptionist clinic minimally needs. Since C2,
// country + timezone + defaultLanguage are required columns (no Prisma
// defaults), so a suite that creates a clinic by hand must supply them.
// ===========================================================================

type Client = Pick<PrismaClient, 'receptionistClinic'>;

export interface ClinicFixtureInput {
  tenantId: string;
  name?: string;
  phone?: string;
  country?: string;
  timezone?: string;
  defaultLanguage?: string;
  [key: string]: unknown;
}

export function fixturePhone(seed = randomUUID()): string {
  const digits = (BigInt(`0x${seed.replace(/-/g, '').slice(0, 14)}`) % 10_000_000_000n).toString().padStart(10, '0');
  return `+1${digits}`;
}

/** Defaults for a US/en-US clinic; every field stays overridable per suite. */
export function clinicFixtureData(input: ClinicFixtureInput) {
  const { tenantId, name, phone, country, timezone, defaultLanguage, ...rest } = input;
  return {
    tenantId,
    name: name ?? `Clinic ${randomUUID().slice(0, 8)}`,
    phone: phone ?? fixturePhone(),
    country: country ?? 'US',
    timezone: timezone ?? 'America/New_York',
    defaultLanguage: defaultLanguage ?? 'en-US',
    ...rest,
  };
}

export async function createClinicFixture<T extends Client>(db: T, input: ClinicFixtureInput) {
  return db.receptionistClinic.create({ data: clinicFixtureData(input) as never });
}

// ===========================================================================
// Receptionist test fixtures.
//
// `evaluateCampaignReadiness` is the single activation gate, and it asks for
// everything a real clinic needs before it answers a patient call: somewhere a
// booking can land, a service to book, a provider with hours, no placeholder
// text, and one inbound call already proven on the line.
//
// A suite that wants to test something ELSE — attestation, drift, lifecycle —
// should not have to know that list. `readyCampaignFixture` supplies it, so
// those suites keep testing their own subject and every readiness rule stays
// genuinely enforced instead of being softened to keep fixtures alive.
//
// Merged with C2's clinic fixtures above: contract §12 gives this file to C2
// for `createClinicFixture`, C5 adds `readyCampaignFixture`. Both live here.
// ===========================================================================

export interface ReadyCampaignInput {
  tenantId: string;
  clinicId: string;
  campaignId: string;
  branchId: string;
  /** Must match the campaign's appointmentType, or `services_bookable` fails. */
  appointmentType: string;
  /** Set a non-placeholder voice; the stock default is treated as unconfigured. */
  agentId?: string | null;
}

/** Weekday hours: enough for C2's clinic activation gate to see hours configured. */
export const ACTIVATION_READY_HOURS = {
  monday: { open: true, start: '09:00', end: '17:00' },
  tuesday: { open: true, start: '09:00', end: '17:00' },
  wednesday: { open: true, start: '09:00', end: '17:00' },
  thursday: { open: true, start: '09:00', end: '17:00' },
  friday: { open: true, start: '09:00', end: '17:00' },
};

/**
 * An APPROVED tenant locale pack seeded from the platform default. C2 refuses
 * activation without one, because every caller-facing string is rendered from
 * the pack rather than invented.
 */
export async function approveLocalePack(input: { tenantId: string; language?: string; country?: string; approvedByUserId?: string | null }) {
  const language = input.language ?? 'en-US';
  const country = input.country ?? 'US';
  const db = fixtureDb;
  const existing = await db.receptionistLocalePack.findFirst({
    where: { tenantId: input.tenantId, language, country, status: 'APPROVED' },
    select: { id: true },
  });
  if (existing) return existing.id;
  const platform = PLATFORM_LOCALE_PACKS.find(pack => pack.language === language && pack.country === country);
  if (!platform) throw new Error(`No platform locale pack for ${language}/${country}`);
  const approver = input.approvedByUserId
    ?? (await db.user.findFirst({ where: { tenantId: input.tenantId }, select: { id: true } }))?.id
    ?? null;
  const row = await db.receptionistLocalePack.create({
    data: {
      tenantId: input.tenantId, language, country, version: 1, status: 'APPROVED', source: 'platform_default',
      baseDefaultVersion: platform.version, strings: platform.strings as never,
      evidenceHash: platformLocalePackHash(platform), approvedByUserId: approver, approvedAt: new Date(),
    },
    select: { id: true },
  });
  return row.id;
}

export interface ReadyCampaignFixture {
  locationId: string;
  serviceId: string;
  providerProfileId: string;
  availabilityIds: string[];
  callLogId: string;
  localePackId: string;
}

const WEEKDAYS = [1, 2, 3, 4, 5];

/**
 * Give an existing campaign everything readiness requires, using the same rows
 * the product reads. Idempotent per campaign so a suite can call it twice.
 */
export async function readyCampaignFixture(input: ReadyCampaignInput): Promise<ReadyCampaignFixture> {
  const db = fixtureDb;

  // Somewhere a booking can land: an active location mapped to a branch.
  const existingLocation = await db.receptionistLocation.findFirst({
    where: { tenantId: input.tenantId, clinicId: input.clinicId, active: true, branchId: input.branchId },
    select: { id: true },
  });
  const locationId = existingLocation?.id ?? (await db.receptionistLocation.create({
    data: {
      tenantId: input.tenantId, clinicId: input.clinicId, branchId: input.branchId,
      name: 'Readiness fixture location', address: '1 Readiness Way', active: true,
    },
    select: { id: true },
  })).id;

  // Something to book: the appointment type has to be a real catalogue service.
  const existingService = await db.serviceCatalogItem.findFirst({
    where: { tenantId: input.tenantId, name: input.appointmentType },
    select: { id: true },
  });
  const serviceId = existingService?.id ?? (await db.serviceCatalogItem.create({
    data: { tenantId: input.tenantId, name: input.appointmentType, category: 'general', defaultDurationMinutes: 30, active: true },
    select: { id: true },
  })).id;

  // Somebody to book WITH. A branch with twelve providers and no availability
  // rows is a branch where the agent can never offer a time — the exact state
  // the live demo tenant was found in.
  const existingProvider = await db.providerProfile.findFirst({
    where: { tenantId: input.tenantId, branchId: input.branchId, active: true },
    select: { id: true },
  });
  let providerProfileId = existingProvider?.id;
  if (!providerProfileId) {
    const user = await db.user.create({
      data: {
        tenantId: input.tenantId, role: 'PROVIDER', active: true,
        email: `provider-${randomUUID().slice(0, 8)}@readiness.test`, displayName: 'Readiness fixture provider',
      },
      select: { id: true },
    });
    providerProfileId = (await db.providerProfile.create({
      data: { tenantId: input.tenantId, branchId: input.branchId, userId: user.id, specialty: 'General', active: true },
      select: { id: true },
    })).id;
  }

  const availabilityIds: string[] = [];
  for (const dayOfWeek of WEEKDAYS) {
    const row = await db.providerAvailability.upsert({
      where: { providerProfileId_dayOfWeek_startMinute: { providerProfileId, dayOfWeek, startMinute: 9 * 60 } },
      create: {
        tenantId: input.tenantId, branchId: input.branchId, providerProfileId,
        dayOfWeek, startMinute: 9 * 60, endMinute: 17 * 60, slotMinutes: 30, active: true,
      },
      update: { active: true },
      select: { id: true },
    });
    availabilityIds.push(row.id);
  }

  // A voice the clinic chose. The stock default reads as placeholder text, and
  // deploying placeholder text is exactly what readiness is there to stop.
  if (input.agentId) {
    await db.receptionistAgent.update({ where: { id: input.agentId }, data: { voice: 'mock-voice-nova' } });
  }

  // Proof the line actually works: one inbound call already recorded.
  const existingCall = await db.receptionistCallLog.findFirst({
    where: { tenantId: input.tenantId, clinicId: input.clinicId, direction: 'inbound' },
    select: { id: true },
  });
  const callLogId = existingCall?.id ?? (await db.receptionistCallLog.create({
    data: {
      tenantId: input.tenantId, clinicId: input.clinicId, direction: 'inbound',
      outcome: 'BOOKED', durationSeconds: 42, startedAt: new Date(), endedAt: new Date(),
    },
    select: { id: true },
  })).id;

  // C2's clinic activation gate: a country, usable hours and an APPROVED
  // locale pack for the agent's language. Activation runs this alongside
  // readiness, so the fixture supplies it the way a real clinic would.
  const clinic = await db.receptionistClinic.findUniqueOrThrow({
    where: { id: input.clinicId },
    select: { country: true, defaultLanguage: true, workingHours: true },
  });
  if (clinic.workingHours === null) {
    await db.receptionistClinic.update({ where: { id: input.clinicId }, data: { workingHours: ACTIVATION_READY_HOURS } });
  }
  const agentLanguage = input.agentId
    ? (await db.receptionistAgent.findUniqueOrThrow({ where: { id: input.agentId }, select: { language: true } })).language
    : clinic.defaultLanguage;
  const localePackId = await approveLocalePack({
    tenantId: input.tenantId, language: agentLanguage, country: clinic.country ?? 'US',
  });

  return { locationId, serviceId, providerProfileId, availabilityIds, callLogId, localePackId };
}
