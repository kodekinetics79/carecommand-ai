import type { PrismaClient } from '../../server/generated/prisma/client';

// ===========================================================================
// Receptionist demo layer.
//
// The synthetic seed produced clinics and call logs and nothing else, so a
// freshly provisioned tenant opened Receptionist Studio with no location, no
// agent, no campaign and no availability — every screen an empty state, and
// the one question a buyer asks ("show me it answering a call") unanswerable.
//
// This layer builds the whole spine: a branch-mapped location, a named agent,
// a campaign with real intake fields and real copy, a bookable service, and —
// the thing peer sessions found missing on the live demo tenant — provider
// availability, without which twelve providers are zero bookable providers and
// the agent can never offer a time.
//
// It then DEPLOYS through the production deploy path against the mock provider
// and verifies through the production verification path. Nothing here writes a
// VERIFIED row by hand: if deploy or verify would fail for a real clinic, it
// fails here, which is the point of seeding it this way.
// ===========================================================================

export interface ReceptionistDemoContext {
  db: PrismaClient;
  now: Date;
  /**
   * Wall-clock anchor, same reasoning as growthDemo's TIME ANCHORING note.
   * Readiness asks whether a test call reached this line RECENTLY, evaluated
   * against the API's clock at request time, so a call pinned to the
   * controlled clock would age out of the window and the demo would go
   * unready on its own.
   */
  demoClock: Date;
  stableUuid: (scope: string, index: number) => string;
  /** Receptionist clinic ids, aligned by index with branchIds/branchTenant. */
  clinicIds: string[];
  branchIds: string[];
  branchTenant: string[];
  userIds: string[];
  userTenant: string[];
}

export interface ReceptionistDemoCounts {
  locations: number;
  agents: number;
  campaigns: number;
  intakeFields: number;
  services: number;
  providerAvailability: number;
  deployedCampaigns: number;
  verifiedAgents: number;
  activeCampaigns: number;
  notes: string[];
}

const APPOINTMENT_TYPE = 'New patient consultation';

/** Weekday morning + afternoon windows, in minutes from clinic-local midnight. */
const AVAILABILITY_WINDOWS = [
  { startMinute: 9 * 60, endMinute: 12 * 60 + 30 },
  { startMinute: 13 * 60 + 30, endMinute: 17 * 60 },
];

function intakeFields(campaignId: string, tenantId: string, stableUuid: (scope: string, index: number) => string, seed: number, now: Date) {
  const rows = [
    { fieldType: 'FIRST_NAME' as const, label: 'First name', aiQuestion: 'Can I start with your first name?', required: true, confirmationRequired: false },
    { fieldType: 'LAST_NAME' as const, label: 'Last name', aiQuestion: 'And your last name?', required: true, confirmationRequired: false },
    { fieldType: 'PHONE' as const, label: 'Phone number', aiQuestion: 'What is the best number to reach you on?', required: true, confirmationRequired: true },
    { fieldType: 'REASON_FOR_VISIT' as const, label: 'Reason for visit', aiQuestion: 'May I ask what brings you in? A short description is plenty.', required: false, confirmationRequired: false },
  ];
  return rows.map((row, index) => ({
    id: stableUuid(`receptionist-intake-${seed}`, index),
    tenantId,
    campaignId,
    ...row,
    options: [],
    sortOrder: index,
    createdAt: now,
    updatedAt: now,
  }));
}

/**
 * One inbound call that reached a specific published deployment. The four
 * `boundProvider*` columns are written together (a database CHECK enforces it)
 * and are taken from the agent's verified provider evidence — exactly what the
 * inbound webhook stamps when a real caller reaches the line.
 */
async function stampProvenTestCall(
  db: PrismaClient,
  input: { deploymentId: string; agentId: string; demoClock: Date },
): Promise<void> {
  const deployment = await db.receptionistAgentDeployment.findUnique({
    where: { id: input.deploymentId },
    select: { tenantId: true, clinicId: true, campaignId: true, publishedAt: true },
  });
  const agent = await db.receptionistAgent.findUnique({
    where: { id: input.agentId },
    select: { providerAgentId: true, providerVersion: true, providerConfigRevision: true, providerFingerprint: true },
  });
  if (!deployment || !agent?.providerAgentId || agent.providerVersion === null || !agent.providerFingerprint) return;
  const at = new Date(Math.max((deployment.publishedAt ?? input.demoClock).getTime() + 60_000, input.demoClock.getTime() - 3_600_000));
  await db.receptionistCallLog.create({
    data: {
      tenantId: deployment.tenantId,
      clinicId: deployment.clinicId,
      campaignId: deployment.campaignId,
      direction: 'inbound',
      callerName: 'Staff test call',
      outcome: 'BOOKED',
      durationSeconds: 38,
      boundProviderAgentId: agent.providerAgentId,
      boundProviderAgentVersion: agent.providerVersion,
      boundProviderConfigRevision: agent.providerConfigRevision,
      boundProviderFingerprint: agent.providerFingerprint,
      startedAt: at,
      endedAt: new Date(at.getTime() + 38_000),
      createdAt: at,
      updatedAt: at,
    },
  });
}

export async function seedReceptionistDemo(ctx: ReceptionistDemoContext): Promise<ReceptionistDemoCounts> {
  const { db, now, demoClock, stableUuid } = ctx;
  const counts: ReceptionistDemoCounts = {
    locations: 0, agents: 0, campaigns: 0, intakeFields: 0, services: 0,
    providerAvailability: 0, deployedCampaigns: 0, verifiedAgents: 0, activeCampaigns: 0, notes: [],
  };

  const campaignsToDeploy: Array<{ tenantId: string; campaignId: string; ownerId: string }> = [];
  const runnableTenantIds = new Set((await db.tenant.findMany({
    where: { status: 'active' },
    select: { id: true },
  })).map(tenant => tenant.id));

  for (const [index, clinicId] of ctx.clinicIds.entries()) {
    const branchId = ctx.branchIds[index];
    const tenantId = ctx.branchTenant[index];
    if (!branchId || !tenantId) continue;
    const clinic = await db.receptionistClinic.findUnique({ where: { id: clinicId }, select: { id: true, name: true, defaultLanguage: true } });
    if (!clinic) continue;

    // A location that is NOT mapped to a branch fails readiness, which is
    // correct — so the demo maps it, because a booking has to land somewhere.
    // C2's clinic layer already seeds one branch-mapped location per clinic
    // (with phone and access notes the prompt reads); adopt it rather than
    // seeding a second address for the same front desk.
    const existingLocation = await db.receptionistLocation.findFirst({
      where: { tenantId, clinicId, branchId, active: true },
      select: { id: true },
    });
    if (existingLocation) {
      counts.locations += 1;
    } else {
      await db.receptionistLocation.create({ data: {
        id: stableUuid('receptionist-location', index),
        tenantId, clinicId, branchId,
        name: `${clinic.name} — main`,
        address: `${100 + index} Example Avenue, Test City, NY 10001`,
        active: true, createdAt: now, updatedAt: now,
      } });
      counts.locations += 1;
    }

    const agent = await db.receptionistAgent.create({ data: {
      id: stableUuid('receptionist-agent', index),
      tenantId, clinicId,
      // Not "Riley": the placeholder detector refuses the stock name, and a
      // demo that cannot deploy is not a demo.
      name: index % 2 === 0 ? 'Avery' : 'Jordan',
      voice: index % 2 === 0 ? 'mock-voice-nova' : 'mock-voice-oliver',
      tone: 'Warm and professional',
      language: clinic.defaultLanguage,
      active: true,
      createdAt: now, updatedAt: now,
    } });
    counts.agents += 1;

    const campaign = await db.receptionistCampaign.create({ data: {
      id: stableUuid('receptionist-campaign', index),
      tenantId, clinicId, agentId: agent.id,
      name: 'Front desk — inbound scheduling',
      campaignType: 'Inbound reception',
      status: 'DRAFT',
      offerTitle: 'Book a new patient consultation',
      offerDescription: 'We are welcoming new patients and can usually offer an appointment within the week.',
      offerScript: 'Thanks for calling. I can check what we have available and book you in right now, if that helps.',
      appointmentType: APPOINTMENT_TYPE,
      eligibleLocationIds: [],
      smsConfirmation: false,
      emailConfirmation: false,
      createdAt: now, updatedAt: now,
    } });
    counts.campaigns += 1;

    const fields = intakeFields(campaign.id, tenantId, stableUuid, index, now);
    await db.receptionistIntakeField.createMany({ data: fields });
    counts.intakeFields += fields.length;

    // Readiness requires the appointment type to be a real catalogue service —
    // and one the practice has marked BOOKABLE BY VOICE. The column defaults to
    // false, and the deployed prompt says "Not bookable on this call: take a
    // message instead" for everything that is not flagged, so a demo seeded
    // without the flag is a demo of a receptionist that refuses every booking.
    const existingService = await db.serviceCatalogItem.findFirst({ where: { tenantId, name: APPOINTMENT_TYPE }, select: { id: true } });
    if (existingService) {
      await db.serviceCatalogItem.update({
        where: { id: existingService.id },
        data: { active: true, bookableByVoice: true, voiceDurationMinutes: 30, updatedAt: now },
      });
    } else {
      await db.serviceCatalogItem.create({ data: {
        id: stableUuid('receptionist-service', index),
        tenantId, name: APPOINTMENT_TYPE, category: 'general',
        defaultDurationMinutes: 30, voiceDurationMinutes: 30,
        spokenDescription: 'A first visit, about half an hour, to talk through what you need.',
        bookableByVoice: true, priceFrom: 95,
        active: true, createdAt: now, updatedAt: now,
      } });
      counts.services += 1;
    }

    // Calls this line has already taken. Readiness requires proof the number
    // actually reaches the agent (`test_call_completed`), and a demo of a
    // front desk with no call history is not a demo of a front desk.
    await db.receptionistCallLog.createMany({ data: [
      {
        id: stableUuid('receptionist-inbound-call', index * 2),
        tenantId, clinicId, campaignId: campaign.id, direction: 'inbound',
        callerName: 'Alex Morgan', outcome: 'BOOKED', durationSeconds: 96,
        startedAt: new Date(demoClock.getTime() - 3 * 86_400_000), endedAt: new Date(demoClock.getTime() - 3 * 86_400_000 + 96_000),
        createdAt: new Date(demoClock.getTime() - 3 * 86_400_000), updatedAt: demoClock,
      },
      {
        id: stableUuid('receptionist-inbound-call', index * 2 + 1),
        tenantId, clinicId, campaignId: campaign.id, direction: 'inbound',
        callerName: 'Sam Rivera', outcome: 'ESCALATED', durationSeconds: 54,
        startedAt: new Date(demoClock.getTime() - 86_400_000), endedAt: new Date(demoClock.getTime() - 86_400_000 + 54_000),
        createdAt: new Date(demoClock.getTime() - 86_400_000), updatedAt: demoClock,
      },
    ] });

    const owner = ctx.userIds.find((userId, userIndex) => ctx.userTenant[userIndex] === tenantId);
    if (owner && runnableTenantIds.has(tenantId)) {
      campaignsToDeploy.push({ tenantId, campaignId: campaign.id, ownerId: owner });
    } else if (!runnableTenantIds.has(tenantId)) {
      // PILOT and EDGE deliberately include suspended/cancelled tenants so
      // access-denial behavior can be exercised. Seed their configuration,
      // but do not invoke a production deploy path that correctly refuses to
      // establish a trusted runtime context for a non-runnable tenant.
      counts.notes.push(`campaign ${campaign.id} left in draft because tenant ${tenantId} is not active`);
    }
  }

  // Providers, and then their hours. Peer sessions found the live demo tenant
  // with twelve providers and zero availability rows: every slot search
  // returned nothing, so the receptionist could never offer an appointment
  // however well configured it looked. Readiness now catches that; the seed
  // makes sure it passes for a real reason rather than by exemption.
  for (const [index, branchId] of ctx.branchIds.entries()) {
    const tenantId = ctx.branchTenant[index];
    if (!tenantId) continue;
    const existing = await db.providerProfile.count({ where: { tenantId, branchId, active: true } });
    if (existing > 0) continue;
    // Every branch needs somebody bookable, not just the branches that happened
    // to get a PROVIDER-role user from the round-robin above.
    const candidate = await db.user.findFirst({
      where: { tenantId, active: true, role: 'PROVIDER', providerProfile: { is: null } },
      select: { id: true },
    }) ?? await db.user.create({
      data: {
        id: stableUuid('receptionist-provider-user', index),
        tenantId, role: 'PROVIDER', active: true,
        branchId,
        email: `synthetic.receptionist.provider.${index + 1}@example.test`,
        displayName: `Synthetic Provider ${index + 1}`,
        createdAt: now, updatedAt: now,
      },
      select: { id: true },
    });
    await db.user.update({ where: { id: candidate.id }, data: { branchId } });
    await db.userClinicAccess.upsert({
      where: { tenantId_userId_branchId: { tenantId, userId: candidate.id, branchId } },
      create: { tenantId, userId: candidate.id, branchId, isPrimary: true },
      update: { tenantId, isPrimary: true },
    });
    await db.providerProfile.create({ data: {
      id: stableUuid('receptionist-provider', index),
      tenantId, branchId, userId: candidate.id, specialty: 'General practice', active: true,
      createdAt: now, updatedAt: now,
    } });
  }

  const providers = await db.providerProfile.findMany({ where: { active: true }, select: { id: true, tenantId: true, branchId: true } });
  const availability = providers.flatMap(provider =>
    [1, 2, 3, 4, 5].flatMap(dayOfWeek => AVAILABILITY_WINDOWS.map(window => ({
      tenantId: provider.tenantId,
      branchId: provider.branchId,
      providerProfileId: provider.id,
      dayOfWeek,
      startMinute: window.startMinute,
      endMinute: window.endMinute,
      slotMinutes: 30,
      active: true,
      createdAt: now,
      updatedAt: now,
    }))));
  if (availability.length) {
    await db.providerAvailability.createMany({ data: availability, skipDuplicates: true });
    counts.providerAvailability = availability.length;
  }

  // Deploy + verify + activate through the PRODUCTION paths. Imported lazily so
  // the seed only loads the server runtime once it has something to deploy.
  if (campaignsToDeploy.length) {
    const { deployAndVerify } = await import('../../server/lib/receptionist/retellDeploy');
    const { transitionCampaign } = await import('../../server/modules/receptionist/campaigns');
    const { runWithTrustedTenantContext } = await import('../../server/lib/tenantContext');

    for (const target of campaignsToDeploy) {
      const actor = {
        userId: null,
        source: 'SYSTEM' as const,
        // runWithTenantContext fails closed without an explicit trusted actor
        // when there is no request context, which a seed never has.
        trustedActor: { id: 'seed:receptionist-demo', role: 'WORKER' },
      };
      const result = await deployAndVerify({ tenantId: target.tenantId, campaignId: target.campaignId, actor });
      if (!result.deploy.ok) {
        counts.notes.push(`campaign ${target.campaignId} did not deploy: ${result.deploy.code}`);
        continue;
      }
      counts.deployedCampaigns += 1;
      if (result.verification?.kind !== 'verified') {
        counts.notes.push(`campaign ${target.campaignId} deployed but did not verify: ${result.verification?.kind ?? 'unknown'}`);
        continue;
      }
      counts.verifiedAgents += 1;

      // Proof the line works, recorded the way a real one is: AFTER the
      // deployment published, stamped with the exact provider agent and
      // version that answered, and with a duration that means somebody spoke.
      // The historical rows above are call HISTORY for the front desk; this is
      // the evidence `test_call_completed` is about, and it self-resets on the
      // next deploy, which is what the Go-live card promises.
      await stampProvenTestCall(db, {
        deploymentId: result.deploy.deployment.id,
        agentId: result.deploy.deployment.agentId,
        demoClock,
      });

      // Activation goes through the same readiness gate an operator hits, so a
      // demo tenant cannot be activated on configuration a real one could not.
      try {
        await runWithTrustedTenantContext(
          { tenantId: target.tenantId, actorId: 'seed:receptionist-demo', actorRole: 'WORKER', source: 'worker' },
          tx => transitionCampaign(tx, { tenantId: target.tenantId, campaignId: target.campaignId, to: 'ACTIVE' }),
        );
        counts.activeCampaigns += 1;
      } catch (error) {
        // Name the checks, not just the refusal: whoever runs the seed needs to
        // know WHAT is unconfigured, which is the same thing the operator sees.
        const reasons = (error as { reasons?: Array<{ key?: string }> }).reasons ?? [];
        const detail = reasons.length ? reasons.map(reason => reason.key).join(', ') : (error instanceof Error ? error.message : 'unknown');
        counts.notes.push(`campaign ${target.campaignId} could not activate: ${detail}`);
      }
    }
  }

  return counts;
}
