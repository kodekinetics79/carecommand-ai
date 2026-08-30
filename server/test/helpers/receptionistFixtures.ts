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
// Services — the fixture that certified a false pass (F1 ⇄ B2).
//
// `ServiceCatalogItem.bookableByVoice` defaults to FALSE in the schema
// (prisma/schema.prisma), because a practice has to say out loud which of its
// services a machine may book. A fixture that quietly created services the
// column says are NOT voice-bookable, and then asserted the campaign was
// ready, is how 1699 server tests came to certify a receptionist that refuses
// every booking and only takes messages.
//
// So the DEFAULT here matches the column: false. A suite that wants a service
// the agent may actually book asks for it, in the same words the operator
// would use.
// ===========================================================================

type ServiceClient = Pick<PrismaClient, 'serviceCatalogItem'>;

export interface ServiceFixtureInput {
  tenantId: string;
  name: string;
  /** Matches the schema default. Say `true` and mean it. */
  bookableByVoice?: boolean;
  category?: string;
  defaultDurationMinutes?: number;
  voiceDurationMinutes?: number | null;
  spokenDescription?: string | null;
  active?: boolean;
}

export function serviceFixtureData(input: ServiceFixtureInput) {
  return {
    tenantId: input.tenantId,
    name: input.name,
    category: input.category ?? 'general',
    defaultDurationMinutes: input.defaultDurationMinutes ?? 30,
    voiceDurationMinutes: input.voiceDurationMinutes ?? null,
    spokenDescription: input.spokenDescription ?? null,
    bookableByVoice: input.bookableByVoice ?? false,
    active: input.active ?? true,
  };
}

export async function createServiceFixture<T extends ServiceClient>(db: T, input: ServiceFixtureInput) {
  return db.serviceCatalogItem.create({ data: serviceFixtureData(input) as never });
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
//
// WHAT THIS FIXTURE DELIBERATELY DOES NOT DO (F1/F3)
// -------------------------------------------------
// It does not create an inbound call log. `test_call_completed` is the one
// check that proves a patient can reach the line, and the fixture used to
// satisfy it with a bare 30-day-old inbound row scoped to nothing — the same
// shape the clinics' historical zero-second `not_connected` rows have. That
// made the check pre-satisfied for every suite and permanently green across
// every redeploy, which is exactly defect B4. Evidence that a call reached
// THIS deployment is a separate, explicit act: `proveTestCall`.
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
  /**
   * Whether the catalogue service the campaign books may be booked by voice.
   * Default true — this fixture's job is a campaign that is genuinely ready.
   * Pass `false` for the negative case B2 must catch: a service that exists,
   * is active, matches by name, and that the agent is still forbidden to book.
   */
  bookableByVoice?: boolean;
  /**
   * How many active providers with availability the mapped branch gets.
   * Default 1, because `resolveSoleProvider` (liveTools.ts) refuses to offer a
   * time on any branch with more than one. Pass 2+ for the honest multi-
   * clinician practice C1/B3 exist for.
   */
  providers?: number;
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
  /** The first provider, kept for suites written before multi-provider branches existed. */
  providerProfileId: string;
  providerProfileIds: string[];
  availabilityIds: string[];
  localePackId: string;
}

const WEEKDAYS = [1, 2, 3, 4, 5];

/**
 * One active provider at `branchId`, with weekday availability, created only
 * when the branch does not already have `count` of them. Returned newest-last
 * so a suite can name "the second clinician".
 *
 * This is the fixture C1 and B3 are invisible without: `resolveSoleProvider`
 * (`liveTools.ts`) returns null for any branch with 2+ active providers, and
 * `provider_availability` readiness counts rows and calls that ready. Every
 * real practice is this shape; no fixture was.
 */
export async function multiProviderBranchFixture(input: {
  tenantId: string;
  branchId: string;
  providers: number;
}): Promise<{ providerProfileIds: string[]; availabilityIds: string[] }> {
  const db = fixtureDb;
  const existing = await db.providerProfile.findMany({
    where: { tenantId: input.tenantId, branchId: input.branchId, active: true },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  const providerProfileIds = existing.map(row => row.id);
  while (providerProfileIds.length < input.providers) {
    const user = await db.user.create({
      data: {
        tenantId: input.tenantId, role: 'PROVIDER', active: true,
        email: `provider-${randomUUID().slice(0, 8)}@readiness.test`,
        displayName: `Readiness fixture provider ${providerProfileIds.length + 1}`,
      },
      select: { id: true },
    });
    const created = await db.providerProfile.create({
      data: { tenantId: input.tenantId, branchId: input.branchId, userId: user.id, specialty: 'General', active: true },
      select: { id: true },
    });
    providerProfileIds.push(created.id);
  }

  const availabilityIds: string[] = [];
  for (const providerProfileId of providerProfileIds) {
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
  }
  return { providerProfileIds, availabilityIds };
}

export interface ProveTestCallInput {
  tenantId: string;
  clinicId: string;
  campaignId?: string | null;
  /**
   * The deployment this call is evidence FOR. When given, the call is stamped
   * with that deployment's provider agent + version and dated after it
   * published, which is what makes the evidence self-reset on the next deploy
   * (B4). Omitted only by suites deliberately building the historical,
   * unscoped row the check must stop accepting.
   */
  deploymentId?: string | null;
  /**
   * A hand-linked (BYO) agent, which has no deployment row. The call is stamped
   * from the agent's own verified provider evidence — the same columns the
   * webhook writes — so `test_call_completed` is provable for BYO without
   * inventing a deployment that never happened.
   */
  agentId?: string | null;
  durationSeconds?: number;
  /**
   * Terminal outcome. Defaults to BOOKED. The outcome and the binding are both
   * immutable once written (database triggers), so a suite building a negative
   * case creates the row it wants rather than editing one.
   */
  outcome?: 'BOOKED' | 'NO_ANSWER' | 'ESCALATED' | 'VOICEMAIL' | 'FAILED';
  /** Backdate the row relative to the deployment, for the negative cases. */
  createdAt?: Date;
  boundProviderAgentVersion?: number | null;
}

/**
 * Evidence that a real call reached THIS deployment: inbound, non-zero
 * duration, stamped with the bound provider agent and version, recorded after
 * the deployment published.
 *
 * The four properties above are the whole of the check `test_call_completed`
 * is supposed to be. A suite that wants a green go-live card calls this AFTER
 * deploying — the same order the operator does it in.
 */
export async function proveTestCall(input: ProveTestCallInput): Promise<string> {
  const db = fixtureDb;
  const deployment = input.deploymentId
    ? await db.receptionistAgentDeployment.findUniqueOrThrow({
      where: { id: input.deploymentId },
      select: { publishedAt: true, campaignId: true, agentId: true },
    })
    : null;
  // The four `boundProvider*` columns are stamped together or not at all
  // (`ReceptionistCallLog_provider_binding_complete_check`), and the webhook
  // takes them from the agent's verified provider evidence — so this fixture
  // reads exactly the same source rather than inventing a binding.
  const boundAgentId = deployment?.agentId ?? input.agentId ?? null;
  const agent = boundAgentId
    ? await db.receptionistAgent.findUniqueOrThrow({
      where: { id: boundAgentId },
      select: { providerAgentId: true, providerVersion: true, providerConfigRevision: true, providerFingerprint: true },
    })
    : null;
  const bindable = Boolean(agent?.providerAgentId && agent?.providerVersion !== null && agent?.providerFingerprint);
  const createdAt = input.createdAt
    ?? (deployment?.publishedAt ? new Date(deployment.publishedAt.getTime() + 60_000) : new Date());
  const durationSeconds = input.durationSeconds ?? 42;
  const row = await db.receptionistCallLog.create({
    data: {
      tenantId: input.tenantId,
      clinicId: input.clinicId,
      campaignId: input.campaignId ?? deployment?.campaignId ?? null,
      direction: 'inbound',
      outcome: (input.outcome ?? 'BOOKED') as never,
      durationSeconds,
      ...(bindable && agent ? {
        boundProviderAgentId: agent.providerAgentId,
        boundProviderAgentVersion: input.boundProviderAgentVersion !== undefined
          ? input.boundProviderAgentVersion
          : agent.providerVersion,
        boundProviderConfigRevision: agent.providerConfigRevision,
        boundProviderFingerprint: agent.providerFingerprint,
      } : {}),
      startedAt: createdAt,
      endedAt: new Date(createdAt.getTime() + durationSeconds * 1000),
      createdAt,
    },
    select: { id: true },
  });
  return row.id;
}

/**
 * The task that says "your receptionist is off the air" — the one task the
 * Front Desk board cannot show (D9 ⇄ X2-03 · X3-12).
 *
 * `agentReverification.ts` files it with `workflow: 'receptionist_deployment'`
 * and an UPPERCASE priority, while `parseReceptionistTask` accepts only
 * `receptionist_safety` and the critical banner looks for lowercase
 * `'critical'`. Badge, banner, header count and every lane therefore exclude
 * it. No fixture built one, so the suite could not see the gap.
 *
 * This mirrors that writer exactly — including the vocabulary defects — so a
 * test asserts what the product produces, not what it ought to.
 */
export async function deploymentAttentionTaskFixture(input: {
  tenantId: string;
  clinicId: string;
  agentId: string;
  branchId?: string | null;
  code?: string;
  priority?: string;
  title?: string;
  action?: string;
  fixHref?: string | null;
}): Promise<string> {
  const db = fixtureDb;
  const branchId = input.branchId ?? (await db.receptionistLocation.findFirst({
    where: { tenantId: input.tenantId, clinicId: input.clinicId, active: true, branchId: { not: null } },
    select: { branchId: true },
  }))?.branchId ?? null;
  const code = input.code ?? 'agent_verification_stale';
  const row = await db.staffTask.create({
    data: {
      tenantId: input.tenantId,
      branchId,
      title: 'AI receptionist deployment needs attention',
      priority: (input.priority ?? 'HIGH') as never,
      status: 'OPEN',
      dueAt: new Date(Date.now() + 60 * 60_000),
      metadata: {
        workflow: 'receptionist_deployment',
        agentId: input.agentId,
        clinicId: input.clinicId,
        code,
        title: input.title ?? 'The agent’s verification has expired',
        action: input.action ?? 'Verify the agent again. Verification is valid for 24 hours and normally renews itself hourly.',
        fixHref: input.fixHref ?? `/receptionist-studio?clinic=${input.clinicId}&agent=${input.agentId}&tab=deploy`,
      } as never,
    },
    select: { id: true },
  });
  return row.id;
}

/**
 * Give an existing campaign everything readiness requires, using the same rows
 * the product reads. Idempotent per campaign so a suite can call it twice.
 *
 * Everything except `test_call_completed` — see the note at the top of this
 * section. Call `proveTestCall` after deploying for that one.
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

  // Something to book: the appointment type has to be a real catalogue service
  // AND one the practice has marked bookable by voice. The prompt this
  // campaign deploys says "Not bookable on this call: take a message instead"
  // for everything else, so a fixture that skipped the flag was asserting the
  // agent could book a service it is written to refuse.
  const bookableByVoice = input.bookableByVoice ?? true;
  const existingService = await db.serviceCatalogItem.findFirst({
    where: { tenantId: input.tenantId, name: input.appointmentType },
    select: { id: true },
  });
  const serviceId = existingService
    ? (await db.serviceCatalogItem.update({
      where: { id: existingService.id },
      data: { active: true, bookableByVoice },
      select: { id: true },
    })).id
    : (await db.serviceCatalogItem.create({
      data: serviceFixtureData({
        tenantId: input.tenantId, name: input.appointmentType, bookableByVoice,
        voiceDurationMinutes: 30, spokenDescription: 'A first visit to talk through your options.',
      }) as never,
      select: { id: true },
    })).id;

  // Somebody to book WITH. A branch with twelve providers and no availability
  // rows is a branch where the agent can never offer a time — the exact state
  // the live demo tenant was found in.
  const { providerProfileIds, availabilityIds } = await multiProviderBranchFixture({
    tenantId: input.tenantId, branchId: input.branchId, providers: input.providers ?? 1,
  });

  // A voice the clinic chose. The stock default reads as placeholder text, and
  // deploying placeholder text is exactly what readiness is there to stop.
  if (input.agentId) {
    await db.receptionistAgent.update({ where: { id: input.agentId }, data: { voice: 'mock-voice-nova' } });
  }

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

  return { locationId, serviceId, providerProfileId: providerProfileIds[0], providerProfileIds, availabilityIds, localePackId };
}
