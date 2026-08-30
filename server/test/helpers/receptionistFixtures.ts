import { randomUUID } from 'node:crypto';
import { fixtureDb } from './fixtureDb';

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
// NOTE(merge C2): contract §12 gives this file to C2 for `createClinicFixture`.
// C5 adds `readyCampaignFixture` only; the two are additive.
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

export interface ReadyCampaignFixture {
  locationId: string;
  serviceId: string;
  providerProfileId: string;
  availabilityIds: string[];
  callLogId: string;
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

  return { locationId, serviceId, providerProfileId, availabilityIds, callLogId };
}
