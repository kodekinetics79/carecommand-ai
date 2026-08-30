import type { Prisma } from '../../generated/prisma/client';
import { isValidE164, toE164 } from '../campaigns';
import { recordWorkflowEvent } from '../intelligence';
import { runInTenantContext, runWithJobTenantContext } from '../tenantContext';
import { agentReadinessReason } from './agentReadiness';
import { clinicActivationState, type ClinicActivationBlocker } from './activationReadiness';
import { confirmationChannelStatus } from './confirmationOutbox';
import { campaignPromptConfig, deploymentChanges, planDeployment } from './retellDeploy';
import { remediationFor, READINESS_KEYS, type ReadinessKey } from './remediation';
import { mandatoryClosingDisclosure, mandatoryOpeningDisclosure } from '../../modules/receptionist/promptService';
import { transferReadiness } from './transferReadiness';
import { RETELL_AGENT_VERIFICATION_TTL_MS, retellConfigStatus } from '../retell';

// ===========================================================================
// Campaign readiness.
//
// The single gate on activation, and the single source of the Studio
// checklist. It is a pure read over the loaded graph: it never writes, so a
// screen can poll it, and activation and the badge can never disagree because
// they are the same evaluation.
//
// Every check says what is wrong, and where to go and fix it. A check that
// cannot be evaluated is `pending` and blocks — the receptionist does not go
// live on a question mark.
//
// THE GATE INVARIANT (day-2 §6): no check may pass on a value CareCommand
// itself wrote and never re-read. Check by check, what each one now reads:
//   number_bound          a deployment row that actually bound the number, and
//                         the number it bound. No deployment row, no pass —
//                         a hand-linked agent is a `fail`, never a warn (B1).
//   services_bookable     ServiceCatalogItem.bookableByVoice, the same column
//                         the voice tool reads before it agrees to book (B2).
//   provider_resolvable   the same "exactly one active provider at the branch"
//                         rule `resolveSoleProvider` applies at call time (B3).
//   test_call_completed   a call stamped with THIS deployment's agent and
//                         version, placed after it published, that connected —
//                         so it self-resets on every redeploy (B4).
//   clinic_*/locale_pack  the clinic rows `clinicActivationState` reads, so the
//                         activation 409s become guided checklist rows (B6).
// ===========================================================================

export type ReadinessStatus = 'pass' | 'fail' | 'warn' | 'pending';

export interface ReadinessCheck {
  key: ReadinessKey;
  label: string;
  status: ReadinessStatus;
  code: string | null;
  title: string;
  detail: string;
  fixHref: string | null;
  /**
   * Whether a failure of this row gates activation. Exactly one list decides
   * it (`NON_BLOCKING_READINESS_KEYS`), and `readiness.ready`,
   * `actions.activate.allowed` and `transitionCampaign` all read that one list
   * — so the badge, the button and the gate can no longer disagree (B5).
   */
  blocking: boolean;
}

/**
 * B5 — the one gate.
 *
 * `intake_attested` is reported but does not gate. The attestation performed
 * inside the ACTIVE transition IS that check, and it is strictly sharper: it
 * separates unattested from mismatched from not-strict, where readiness can
 * only say "not attested". It also cannot gate: the attested revision is
 * written BY activation, so a campaign that has never been activated can never
 * satisfy it, and counting it would make the first activation impossible.
 */
export const NON_BLOCKING_READINESS_KEYS: readonly ReadinessKey[] = ['intake_attested'];

function gates(key: ReadinessKey): boolean {
  return !NON_BLOCKING_READINESS_KEYS.includes(key);
}

export interface ReadinessActions {
  activate: { allowed: boolean; reasons: string[] };
  pause: { allowed: boolean; reasons: string[] };
  archive: { allowed: boolean; reasons: string[] };
}

export interface ReadinessResponse {
  campaignId: string;
  status: string;
  ready: boolean;
  providerMode: 'live' | 'mock' | 'unconfigured';
  checks: ReadinessCheck[];
  actions: ReadinessActions;
  evaluatedAt: string;
}

const LABELS: Record<ReadinessKey, string> = {
  clinic_country_set: 'The clinic has a country',
  clinic_hours_set: 'The clinic has opening hours',
  locale_pack_approved: 'An approved locale pack covers this clinic',
  agent_language_supported: 'The agent speaks a supported language',
  agent_linked: 'An agent is assigned',
  agent_verified: 'The agent is verified with Retell',
  deployment_current: 'The deployed prompt matches this campaign',
  number_bound: 'The phone number answers with this agent',
  location_mapped: 'A location is mapped to a scheduling branch',
  services_bookable: 'The appointment type is bookable',
  provider_availability: 'A provider has availability to offer',
  provider_resolvable: 'The agent can tell which provider to book',
  intake_attested: 'The booking tool matches the intake fields',
  placeholders_absent: 'No placeholder text remains',
  disclosure_composed: 'The opening disclosure is composed',
  closing_disclosure_present: 'The approved wording says goodbye as an AI',
  emergency_path_reachable: 'An emergency reaches a person, not a screen',
  confirmation_channels: 'Enabled confirmations can be delivered',
  transfer_target_distinct: 'Transfers reach a human, not the AI line',
  test_call_completed: 'A test call has reached this line',
  data_storage_setting: 'Provider storage policy',
};

function check(
  key: ReadinessKey,
  status: ReadinessStatus,
  detail: string,
  ctx: { clinicId?: string | null; campaignId?: string | null; agentId?: string | null },
  code: string | null = null,
): ReadinessCheck {
  const remediation = remediationFor(code ?? key, ctx);
  return {
    key,
    label: LABELS[key],
    status,
    code: status === 'pass' ? null : code ?? key,
    title: status === 'pass' ? LABELS[key] : remediation.title,
    detail,
    fixHref: status === 'pass' ? null : remediation.fixHref,
    blocking: gates(key),
  };
}

// ---------------------------------------------------------------------------
// `number_bound`, the check the gate invariant is named after (A2).
//
// It used to pass off `deployment.numberBound` — a column CareCommand wrote at
// deploy time and then read back to itself. So anybody editing the number in
// the Retell console, and every second deploy, could unbind the line while the
// checklist stayed green. That is REC-P0-001: patients called the advertised
// number and reached nothing, and nothing in the product disagreed.
//
// Verification now re-reads the binding from the provider and records what it
// said, and only that answer may make this row pass. Three states, because the
// three are genuinely different and an operator is sent somewhere different by
// each one:
//
//   pass     the provider named this exact published agent and version, within
//            the same 24h TTL `agent_verified` uses.
//   fail     the provider answered, and named something else. The line is
//            really not ours; there is a fix and it is a redeploy.
//   pending  we could not ask, or have not asked since this deployment
//            published. Blocking, and NOT a failure: telling an operator their
//            number is wrong during a provider outage sends them to fix
//            something that is not broken.
// ---------------------------------------------------------------------------

/** The line a clinic answers on: its assigned inbound number, else its advertised one. */
function clinicInboundLine(clinic: { inboundNumber: string | null; phone: string }): string | null {
  return clinic.inboundNumber?.trim() || clinic.phone?.trim() || null;
}

/** An attestation ages out on the same TTL as the agent's own verification. */
function attestationIsFresh(at: Date | null, now: Date): boolean {
  return at !== null && now.getTime() - at.getTime() < RETELL_AGENT_VERIFICATION_TTL_MS;
}

function deployedNumberBoundCheck(
  deployment: { numberBound: boolean; boundPhoneNumber: string | null; providerAgentVersion: number | null; numberBindingVerifiedAt: Date | null; numberBindingErrorCode: string | null; numberBindingAgentId: string | null },
  ctx: { clinicId?: string | null; campaignId?: string | null; agentId?: string | null },
  now: Date,
): ReadinessCheck {
  if (deployment.numberBindingErrorCode === 'number_bound_elsewhere') {
    return check('number_bound', 'fail',
      `Retell reports ${deployment.boundPhoneNumber ?? 'this number'} answering with ${deployment.numberBindingAgentId ? 'a different agent' : 'no agent at all'}, not this deployment. A caller would not reach this campaign. Deploy again to bind it back.`,
      ctx, 'number_bound_elsewhere');
  }
  if (attestationIsFresh(deployment.numberBindingVerifiedAt, now) && deployment.boundPhoneNumber) {
    return check('number_bound', 'pass',
      `Retell confirms ${deployment.boundPhoneNumber} answers with version ${deployment.providerAgentVersion}.`, ctx);
  }
  // A binding is proved by the provider's answer, never by the column we wrote.
  // A deploy that claimed the bind but has not been re-read is exactly the
  // stored claim this check stopped trusting.
  if (deployment.numberBound && deployment.boundPhoneNumber) {
    return check('number_bound', 'pending',
      deployment.numberBindingErrorCode
        ? `CareCommand could not ask Retell who answers ${deployment.boundPhoneNumber} (${deployment.numberBindingErrorCode}), so the binding is unproven. Verify the agent again.`
        : `The deployment bound ${deployment.boundPhoneNumber}, but nothing has re-read that from Retell yet. Verify the agent to prove it.`,
      ctx, 'number_bound');
  }
  return check('number_bound', 'fail',
    'The Retell number is not bound to this deployment, so a caller would not reach this agent. Deploy again.', ctx, 'number_bound');
}

function byoNumberBoundCheck(
  agent: { providerInboundNumber: string | null; providerInboundNumberVerifiedAt: Date | null; providerInboundNumberErrorCode: string | null },
  clinicLine: string | null,
  ctx: { clinicId?: string | null; campaignId?: string | null; agentId?: string | null },
  now: Date,
): ReadinessCheck {
  if (agent.providerInboundNumberErrorCode === 'number_bound_elsewhere') {
    return check('number_bound', 'fail',
      `Retell reports ${clinicLine ?? 'this clinic’s line'} answering with a different agent. A caller would not reach this campaign.`,
      ctx, 'number_bound_elsewhere');
  }
  if (attestationIsFresh(agent.providerInboundNumberVerifiedAt, now)
    && agent.providerInboundNumber
    && agent.providerInboundNumber === clinicLine) {
    return check('number_bound', 'pass',
      `Retell confirms ${agent.providerInboundNumber} answers with this hand-linked agent.`, ctx);
  }
  if (agent.providerInboundNumberErrorCode) {
    return check('number_bound', 'pending',
      `CareCommand could not ask Retell who answers ${clinicLine ?? 'this clinic’s line'} (${agent.providerInboundNumberErrorCode}), so the binding is unproven. Verify the agent again.`,
      ctx, 'number_bound');
  }
  return check('number_bound', 'fail',
    'This agent was linked by hand and nothing has read back what its clinic’s line answers with. Verify the agent, or deploy from Studio, which binds the number itself.',
    ctx, 'number_binding_unattested');
}

export interface ReadinessInput {
  tenantId: string;
  campaignId: string;
  now?: Date;
  /**
   * What the live voice tools can actually do. Readiness must describe the
   * agent that exists today, not the one we intend to ship.
   */
  capabilities?: VoiceBookingCapabilities;
}

export interface VoiceBookingCapabilities {
  /**
   * True once the booking tool can choose between several providers at one
   * branch. `resolveSoleProvider` (`liveTools.ts`) returns null unless the
   * branch has EXACTLY one active provider, and the agent then refuses to
   * offer any time — so today this is false and `provider_resolvable` says so.
   *
   * Package C1 replaces that resolver with a slot union carrying
   * `providerProfileId`. Flipping this one constant is the whole handover:
   * the check keeps running, it just stops failing.
   */
  multiProviderBooking: boolean;
}

export const VOICE_BOOKING_CAPABILITIES: VoiceBookingCapabilities = {
  multiProviderBooking: false,
};

/**
 * B6 — the clinic prerequisites `transitionCampaign` used to throw AFTER
 * readiness had already returned "ready". Each one is a checklist row now, so
 * the first-run owner is guided instead of being handed a bare code.
 * `transfer_loops_to_agent` is deliberately absent: `transfer_target_distinct`
 * below is the same fact, and two rows for one problem is worse than one.
 */
const CLINIC_BLOCKER_KEYS = {
  clinic_country_missing: 'clinic_country_set',
  clinic_hours_missing: 'clinic_hours_set',
  locale_pack_unapproved: 'locale_pack_approved',
  agent_language_unsupported: 'agent_language_supported',
} satisfies Record<Exclude<ClinicActivationBlocker, 'transfer_loops_to_agent'>, ReadinessKey>;

type ClinicState = Awaited<ReturnType<typeof clinicActivationState>>;

type ClinicReadinessKey = (typeof CLINIC_BLOCKER_KEYS)[keyof typeof CLINIC_BLOCKER_KEYS];

/** A passing clinic row still says what it read, so nothing passes silently. */
const CLINIC_PASS_DETAIL: Record<ClinicReadinessKey, (state: ClinicState) => string> = {
  clinic_country_set: state => `The clinic is set to ${state.country}.`,
  clinic_hours_set: () => 'Opening hours are configured, so the agent can say whether you are open.',
  locale_pack_approved: state => state.localePack
    ? `Approved ${state.localePack.language}/${state.localePack.country} pack, version ${state.localePack.version}.`
    : 'An approved locale pack covers this clinic.',
  agent_language_supported: state => `${state.language} is supported.`,
};

export async function evaluateCampaignReadiness(
  tx: Prisma.TransactionClient,
  input: ReadinessInput,
): Promise<ReadinessResponse | null> {
  const now = input.now ?? new Date();
  const capabilities = input.capabilities ?? VOICE_BOOKING_CAPABILITIES;
  const campaign = await tx.receptionistCampaign.findFirst({
    where: { id: input.campaignId, tenantId: input.tenantId },
    include: {
      clinic: { include: { locations: { orderBy: { createdAt: 'asc' } } } },
      agent: true,
      intakeFields: { orderBy: { sortOrder: 'asc' } },
    },
  });
  if (!campaign) return null;

  const ctx = { clinicId: campaign.clinicId, campaignId: campaign.id, agentId: campaign.agentId };
  const checks: ReadinessCheck[] = [];
  const agent = campaign.agent;
  // Hoisted: `test_call_completed` is scoped to this exact deployment (B4).
  let deployment: Awaited<ReturnType<typeof tx.receptionistAgentDeployment.findFirst>> = null;
  // One assembly, shared with preview and deployment. Null means no locale
  // pack exists for the clinic's country and language, so nothing the caller
  // would hear can be rendered — the affected checks say exactly that rather
  // than passing on an unrenderable configuration.
  const promptConfig = await campaignPromptConfig(tx, campaign, input.tenantId);
  const NO_LOCALE_PACK = 'No locale pack is available for this clinic’s country and language, so the prompt cannot be rendered. Approve a locale pack for the clinic.';

  // ---- Clinic prerequisites (B6) -------------------------------------------
  // These were 409s thrown by `transitionCampaign` after readiness had already
  // said "ready", so the owner's first activation produced "Something went
  // wrong — report the code". Contract §6 always wanted them here.
  const clinicState = await clinicActivationState(tx, {
    tenantId: input.tenantId, clinicId: campaign.clinicId, agent,
  }).catch(() => null);
  const blockers = new Set<ClinicActivationBlocker>(clinicState?.blockers ?? []);
  const CLINIC_UNREADABLE = 'The clinic record could not be read, so this cannot be evaluated.';
  for (const [blocker, key] of Object.entries(CLINIC_BLOCKER_KEYS) as Array<[ClinicActivationBlocker, ClinicReadinessKey]>) {
    if (!clinicState) { checks.push(check(key, 'pending', CLINIC_UNREADABLE, ctx)); continue; }
    checks.push(blockers.has(blocker)
      ? check(key, 'fail', remediationFor(blocker, ctx).action, ctx, blocker)
      : check(key, 'pass', CLINIC_PASS_DETAIL[key](clinicState), ctx));
  }

  // ---- Agent and deployment ------------------------------------------------
  if (!agent) {
    checks.push(check('agent_linked', 'fail', 'This campaign has no agent, so nothing can answer a call for it.', ctx));
    checks.push(check('agent_verified', 'pending', 'Assign an agent first.', ctx, 'agent_unlinked'));
    checks.push(check('deployment_current', 'pending', 'Assign an agent first.', ctx, 'deployment_current'));
    checks.push(check('number_bound', 'pending', 'Assign an agent first.', ctx, 'number_bound'));
  } else {
    checks.push(check('agent_linked', 'pass', `${agent.name} answers for this campaign.`, ctx));
    const reason = agentReadinessReason(agent, now);
    checks.push(reason
      ? check('agent_verified', 'fail', remediationFor(reason, ctx).action, ctx, reason)
      : check('agent_verified', 'pass', agent.providerVerificationExpiresAt
        ? `Verified with Retell; the attestation is valid until ${agent.providerVerificationExpiresAt.toISOString()}.`
        : 'Verified with Retell.', ctx));

    deployment = agent.currentDeploymentId
      ? await tx.receptionistAgentDeployment.findFirst({ where: { id: agent.currentDeploymentId, tenantId: input.tenantId } })
      : null;
    if (!deployment) {
      // A manually linked agent is honest about what CareCommand can and
      // cannot prove: the prompt was authored elsewhere.
      checks.push(agent.providerAgentId
        ? check('deployment_current', 'warn', 'This agent was linked manually, so CareCommand cannot prove which prompt it runs. Deploy from Studio to take ownership of it.', ctx, 'deployment_current')
        : check('deployment_current', 'fail', 'This campaign has never been deployed to Retell.', ctx, 'deployment_current'));
      // B1 — contract §16 froze this as BLOCKING. It used to warn for a
      // hand-linked agent, and a warn does not block, so a campaign went ACTIVE
      // with the Retell number's inbound agent still None: patients called the
      // advertised line and reached nothing, with the checklist green.
      //
      // A2 keeps that blocking and gives the hand-linked agent something it can
      // honestly present. Not an operator attestation — a box somebody ticks is
      // a value we wrote and never re-read, which is the exact shape of the
      // defect this check exists to remove. Verification asks Retell who
      // answers the clinic's line and stamps the agent with the answer, so BYO
      // is judged on the provider's word like everything else. What BYO still
      // cannot prove is the PROMPT, and that is `deployment_current`'s question
      // above, not this one.
      checks.push(agent.providerAgentId
        ? byoNumberBoundCheck(agent, clinicInboundLine(campaign.clinic), ctx, now)
        : check('number_bound', 'fail', 'Deploy from Studio so the receptionist number answers with this campaign’s agent.', ctx, 'number_bound'));
    } else {
      const plan = promptConfig ? planDeployment(promptConfig, { mock: deployment.mock }) : null;
      const changed = plan ? deploymentChanges(plan, deployment) : [];
      checks.push(!plan
        ? check('deployment_current', 'fail', NO_LOCALE_PACK, ctx, 'deployment_current')
        : changed.length
        ? check('deployment_current', 'fail', `Changed since the last deployment: ${changed.join(', ')}. Deploy so callers hear the current configuration.`, ctx, 'deployment_current')
        : check('deployment_current', deployment.status === 'VERIFIED' ? 'pass' : 'fail',
          deployment.status === 'VERIFIED'
            ? `Version ${deployment.providerAgentVersion} is deployed and matches this campaign.`
            : 'The latest deployment published but has not been verified. Verify the agent.', ctx, 'deployment_current'));
      checks.push(deployedNumberBoundCheck(deployment, ctx, now));
    }
  }

  // ---- Where a booking can actually land -----------------------------------
  const eligible = new Set(campaign.eligibleLocationIds);
  const mappedLocations = campaign.clinic.locations.filter(location =>
    location.active && location.branchId && (eligible.size === 0 || eligible.has(location.id)));
  checks.push(mappedLocations.length
    ? check('location_mapped', 'pass', `${mappedLocations.length} mapped location(s) can take a booking.`, ctx)
    : check('location_mapped', 'fail', 'No active location for this campaign is mapped to a scheduling branch, so a booking would have nowhere to land.', ctx));

  const branchIds = mappedLocations.map(location => location.branchId!).filter(Boolean);
  // B2 — the check used to match on name + active and never read
  // `bookableByVoice`, which defaults to FALSE. A green campaign therefore went
  // live with a receptionist whose own prompt says "Not bookable on this call:
  // take a message instead" for every request it receives. That column is what
  // the voice tool reads before it agrees to book, so it is what readiness reads.
  const namedService = await tx.serviceCatalogItem.findFirst({
    where: { tenantId: input.tenantId, active: true, name: { equals: campaign.appointmentType, mode: 'insensitive' } },
    select: { id: true, name: true, bookableByVoice: true },
  });
  checks.push(!namedService
    ? check('services_bookable', 'fail', `“${campaign.appointmentType}” is not an active service in the catalogue, so the agent cannot book it.`, ctx)
    : !namedService.bookableByVoice
      ? check('services_bookable', 'fail', `“${namedService.name}” is in the catalogue but is not marked bookable by voice, so the agent would refuse every booking for it and take a message instead.`, ctx)
      : check('services_bookable', 'pass', `“${namedService.name}” is in the service catalogue and is bookable by voice.`, ctx));

  // Contract §15: the demo tenant had twelve providers and zero availability
  // rows, so every slot search returned nothing. A count is enough here; slot
  // search stays a runtime concern.
  const availability = branchIds.length
    ? await tx.providerAvailability.count({ where: { tenantId: input.tenantId, active: true, branchId: { in: branchIds } } })
    : 0;
  checks.push(availability > 0
    ? check('provider_availability', 'pass', `${availability} availability window(s) at the mapped branches.`, ctx)
    : check('provider_availability', 'fail', 'No provider has working hours at a mapped branch, so the agent could never offer an appointment time.', ctx));

  // B3 — availability counts rows; the live tool needs a provider it can NAME.
  // `resolveSoleProvider` (`liveTools.ts`) returns null unless a branch has
  // exactly one active provider, and the agent then answers every booking
  // request with "I need a team member to confirm the provider or service".
  // A two-dentist practice went live fully green and silently degraded to
  // message-taking. This says so until Package C1 removes the constraint.
  const providersByBranch = branchIds.length
    ? await tx.providerProfile.groupBy({
      by: ['branchId'],
      where: { tenantId: input.tenantId, active: true, branchId: { in: branchIds } },
      _count: { _all: true },
    })
    : [];
  const providerCount = new Map(providersByBranch.map(row => [row.branchId, row._count._all]));
  const branchLabel = (branchId: string) =>
    mappedLocations.find(location => location.branchId === branchId)?.name ?? 'a mapped branch';
  const emptyBranches = branchIds.filter(branchId => (providerCount.get(branchId) ?? 0) === 0);
  const ambiguousBranches = capabilities.multiProviderBooking
    ? []
    : branchIds.filter(branchId => (providerCount.get(branchId) ?? 0) > 1);
  checks.push(!branchIds.length
    ? check('provider_resolvable', 'pending', 'No location is mapped to a branch yet, so there is no provider to resolve.', ctx)
    : emptyBranches.length
      ? check('provider_resolvable', 'fail', `No active provider at ${emptyBranches.map(branchLabel).join(', ')}, so the agent has nobody to book with.`, ctx)
      : ambiguousBranches.length
        ? check('provider_resolvable', 'fail', `${ambiguousBranches
          .map(branchId => `${branchLabel(branchId)} has ${providerCount.get(branchId)} active providers`)
          .join('; ')}. The voice agent books only when a branch has exactly one active provider, so it would take a message instead of offering a time.`, ctx)
        : check('provider_resolvable', 'pass', capabilities.multiProviderBooking
          ? 'The agent can resolve a provider at every mapped branch.'
          : 'Every mapped branch has exactly one active provider, so the agent knows who to book with.', ctx));

  // ---- Intake attestation ---------------------------------------------------
  const attested = campaign.intakeSchemaAttestedRevision === campaign.intakeSchemaRevision
    && Boolean(campaign.intakeSchemaFingerprint)
    && Boolean(campaign.intakeToolFingerprint);
  checks.push(attested
    ? check('intake_attested', 'pass', `Attested at intake revision ${campaign.intakeSchemaRevision}.`, ctx)
    : check('intake_attested', 'fail', 'The booking tool published to Retell has not been attested against these intake fields. Deploy, then verify.', ctx, 'intake_schema_unattested'));

  // ---- What the caller hears ------------------------------------------------
  const placeholders = promptConfig ? planDeployment(promptConfig, { mock: retellConfigStatus().mock }).placeholders : [];
  checks.push(!promptConfig
    ? check('placeholders_absent', 'fail', NO_LOCALE_PACK, ctx)
    : placeholders.length
      ? check('placeholders_absent', 'fail', `Still pre-filled: ${placeholders.map(item => item.label).join(', ')}.`, ctx)
      : check('placeholders_absent', 'pass', 'No pre-filled example text remains.', ctx));

  const clinicDisclosure = (campaign.clinic.complianceDisclosure ?? '').trim();
  checks.push(!promptConfig
    ? check('disclosure_composed', 'fail', NO_LOCALE_PACK, ctx)
    : clinicDisclosure
      ? check('disclosure_composed', 'pass', 'The clinic’s wording is appended to the baseline AI and recording disclosure.', ctx)
      : check('disclosure_composed', 'warn', `Using the product baseline only: “${mandatoryOpeningDisclosure(promptConfig)}”`, ctx));

  // California AB 3030 requires the AI disclaimer on an audio clinical
  // interaction at the START *and* AT THE END. Every pack shipped an opening
  // key and none at all for the close, so a US clinic answering with this
  // product was out of compliance on every completed call.
  //
  // The bar is not "the agent will say something". `resolve.ts` backfills a
  // missing key from the platform default, so the agent would say a closing
  // line either way — and that is exactly the state this check exists to
  // refuse. The pack's `evidenceHash` is the hash of what a named person
  // APPROVED; a key that arrived by backfill was never in it, so the clinic has
  // attested to wording that does not include its closing disclosure. Approving
  // the current version is a thirty-second act and it is the difference between
  // a compliance artefact and a plausible-looking one.
  const closingBackfilled = promptConfig?.localePack.backfilledKeys.includes('disclosure.closing') ?? false;
  checks.push(!promptConfig
    ? check('closing_disclosure_present', 'fail', NO_LOCALE_PACK, ctx, 'closing_disclosure_present')
    : closingBackfilled
      ? check('closing_disclosure_present', 'fail', 'The approved wording pack carries no closing AI disclosure, so its evidence hash does not cover the words this clinic is required to end a call with. Approve the current version of the pack.', ctx, 'closing_disclosure_present')
      : check('closing_disclosure_present', 'pass', `Every call ends with: “${mandatoryClosingDisclosure(promptConfig)}”`, ctx));

  // ---- Delivery and escalation ---------------------------------------------
  const enabledChannels: Array<'sms' | 'email'> = [
    ...(campaign.smsConfirmation ? ['sms' as const] : []),
    ...(campaign.emailConfirmation ? ['email' as const] : []),
  ];
  const undeliverable = enabledChannels
    .map(channel => confirmationChannelStatus(channel))
    .filter(status => status.status === 'unconfigured' || status.status === 'configured_pending');
  checks.push(undeliverable.length
    ? check('confirmation_channels', 'fail', undeliverable.map(status => `${status.channel}: ${status.detail}`).join(' '), ctx)
    : check('confirmation_channels', 'pass', enabledChannels.length
      ? `${enabledChannels.join(' and ')} confirmations can be delivered.`
      : 'No confirmation channel is enabled, so none is promised.', ctx));

  // A fallback that dials the AI line returns the caller to the agent they
  // asked to escape (CX-R04 / contract §5).
  const fallback = campaign.clinic.humanFallbackNumber ? toE164(campaign.clinic.humanFallbackNumber) : null;
  const clinicLine = toE164(campaign.clinic.phone);
  const locationLines = campaign.clinic.locations.map(location => (location.phone ? toE164(location.phone) : null)).filter(Boolean);
  const loops = Boolean(fallback && (fallback === clinicLine || locationLines.includes(fallback)));
  checks.push(!fallback
    ? check('transfer_target_distinct', 'warn', 'No human fallback number is set, so the agent takes a message instead of transferring.', ctx, 'transfer_target_distinct')
    : !isValidE164(fallback)
      ? check('transfer_target_distinct', 'fail', 'The human fallback number is not a valid E.164 number, so a transfer could never connect.', ctx, 'transfer_target_distinct')
      : loops
        ? check('transfer_target_distinct', 'fail', 'The human fallback number is the same line the AI answers, so a transfer would loop back to the agent.', ctx, 'transfer_target_distinct')
        : check('transfer_target_distinct', 'pass', 'Transfers reach a number distinct from the AI line.', ctx));

  // The compensating control for the single biggest gap in the product: there
  // is no notification channel. Alerts are in-app only, on a twenty-second
  // poll, and nobody is alerted if no tab is open — so an emergency task can
  // sit overnight behind a masked number.
  //
  // `report_emergency` now places the transfer or promises the callback DURING
  // the call, which closes that gap — but only if there is somewhere to
  // transfer to. Without a usable fallback the emergency path degrades back to
  // "a card appears on a board somebody may not be watching", and that is not a
  // warning. A clinic whose emergency path is a screen nobody is watching
  // should not be answering patient calls, so this blocks.
  //
  // It is deliberately a separate row from `transfer_target_distinct` rather
  // than a change to it: that check answers "would a transfer loop back to the
  // agent", which is a configuration question, and this one answers "can an
  // emergency reach a human being today", which is a clinical one. They happen
  // to read the same field. They are not the same promise, and an operator
  // reading a checklist deserves to see the second one stated.
  const emergencyTransfer = transferReadiness(campaign.clinic, {
    inboundLineNumbers: campaign.clinic.locations.map(location => location.phone),
  });
  checks.push(emergencyTransfer.ready
    ? check('emergency_path_reachable', 'pass', 'An emergency caller is put through to a person during the call, and the Front Desk card is the record of it.', ctx)
    : check('emergency_path_reachable', 'fail', emergencyTransfer.reason === 'missing'
      ? 'No human fallback number is set, so an emergency caller cannot be put through to anyone during the call. The alert would wait on the Front Desk board — in-app only, on a 20-second poll — for somebody to look at it.'
      : emergencyTransfer.reason === 'loops_to_agent'
        ? 'The human fallback number is the line the AI answers, so an emergency transfer would return the caller to the agent.'
        : 'The human fallback number is not a valid E.164 number, so an emergency transfer could never connect.', ctx, 'emergency_path_reachable'));

  // ---- Proof it works on a real phone --------------------------------------
  // B4 — this used to count ANY inbound row for the clinic in 30 days. Clinics
  // already hold historical zero-second `not_connected` inbound rows, so the
  // one check that proves the line works was pre-satisfied and stayed green
  // across every redeploy for a month. A test call now has to be a call that
  // reached THIS deployment: stamped with its agent and version, placed after
  // it published, and connected for longer than zero seconds. Redeploying
  // resets it, which is exactly what the Go-live card promises.
  //
  // A hand-linked agent has no deployment to scope the call to, but it does
  // have a verified provider version, and the webhook stamps every inbound call
  // with exactly that. So the same proof is available: a connected call carrying
  // this agent's currently verified provider id and version. It self-resets the
  // same way — the moment the version at Retell changes, no existing call
  // matches it any more.
  const byoAgent = !deployment && agent?.providerAgentId && agent.providerVersion !== null ? agent : null;
  if (byoAgent) {
    const testCall = await tx.receptionistCallLog.count({
      where: {
        tenantId: input.tenantId,
        clinicId: campaign.clinicId,
        direction: 'inbound',
        boundProviderAgentId: byoAgent.providerAgentId,
        boundProviderAgentVersion: byoAgent.providerVersion,
        durationSeconds: { gt: 0 },
      },
    });
    checks.push(testCall > 0
      ? check('test_call_completed', 'pass', `${testCall} connected inbound call(s) reached version ${byoAgent.providerVersion} of this hand-linked agent.`, ctx)
      : check('test_call_completed', 'fail', `No connected inbound call has reached version ${byoAgent.providerVersion} of this agent. Call the receptionist number once from a staff phone.`, ctx));
  } else if (!deployment || !deployment.publishedAt || deployment.providerAgentVersion === null || !deployment.providerAgentId) {
    checks.push(check('test_call_completed', 'fail',
      'Deploy the campaign first. A test call only counts when it reaches the deployment that is live.', ctx));
  } else {
    const testCall = await tx.receptionistCallLog.count({
      where: {
        tenantId: input.tenantId,
        clinicId: campaign.clinicId,
        direction: 'inbound',
        boundProviderAgentId: deployment.providerAgentId,
        boundProviderAgentVersion: deployment.providerAgentVersion,
        durationSeconds: { gt: 0 },
        createdAt: { gt: deployment.publishedAt },
      },
    });
    checks.push(testCall > 0
      ? check('test_call_completed', 'pass', `${testCall} connected inbound call(s) reached version ${deployment.providerAgentVersion} since it was deployed.`, ctx)
      : check('test_call_completed', 'fail', `No connected inbound call has reached version ${deployment.providerAgentVersion} since it was deployed. Call the receptionist number once from a staff phone.`, ctx));
  }

  // Contract §6: the expected provider storage setting comes from the tenant
  // policy table. Until C3 ships it there is nothing to read, so the setting is
  // fixed at metadata-only and reported read-only rather than pretended about.
  checks.push(check('data_storage_setting', 'warn', 'No tenant transcript-retention policy exists yet, so the provider stores basic attributes only. This is read-only for the pilot.', ctx));

  // B5 — one gate. `ready`, `actions.activate.allowed` and `transitionCampaign`
  // all read `activationBlockers`, so the badge, the button and the gate are
  // the same evaluation rather than three that drifted apart.
  const blocking = checks.filter(isActivationBlocker);
  const ready = blocking.length === 0;
  const blockingCodes = blocking.map(item => item.code ?? item.key);

  const outboundReferences = await tx.receptionistOutboundCampaign.findMany({
    where: { tenantId: input.tenantId, receptionistCampaignId: campaign.id, status: { in: ['SCHEDULED', 'RUNNING'] } },
    select: { id: true, name: true },
  });

  return {
    campaignId: campaign.id,
    status: campaign.status,
    ready,
    providerMode: retellConfigStatus().configured ? (retellConfigStatus().mock ? 'mock' : 'live') : 'unconfigured',
    checks,
    actions: {
      activate: {
        allowed: ready && campaign.status !== 'ARCHIVED' && campaign.status !== 'ACTIVE',
        reasons: campaign.status === 'ARCHIVED' ? ['campaign_archived'] : campaign.status === 'ACTIVE' ? [] : blockingCodes,
      },
      pause: { allowed: campaign.status === 'ACTIVE', reasons: campaign.status === 'ACTIVE' ? [] : ['campaign_not_active'] },
      archive: {
        allowed: campaign.status !== 'ACTIVE' && campaign.status !== 'ARCHIVED' && outboundReferences.length === 0,
        reasons: [
          ...(campaign.status === 'ACTIVE' ? ['campaign_active_pause_first'] : []),
          ...(outboundReferences.length ? ['campaign_referenced_by_outbound'] : []),
        ],
      },
    },
    evaluatedAt: now.toISOString(),
  };
}

/** Failing checks only — what a 409 carries so the screen can render the fix list. */
export function failingChecks(readiness: ReadinessResponse): ReadinessCheck[] {
  return readiness.checks.filter(item => item.status === 'fail' || item.status === 'pending');
}

function isActivationBlocker(item: ReadinessCheck): boolean {
  return item.blocking && (item.status === 'fail' || item.status === 'pending');
}

/**
 * The single activation gate. `evaluateCampaignReadiness` uses it for `ready`
 * and `actions.activate.allowed`; `transitionCampaign` uses it to refuse the
 * ACTIVE transition. There is no second list (B5).
 */
export function activationBlockers(readiness: ReadinessResponse): ReadinessCheck[] {
  return readiness.checks.filter(isActivationBlocker);
}

/**
 * Every readiness key the evaluator emits, in checklist order. This is the
 * published contract: Package E's client union must equal it exactly, and the
 * assertion below keeps the label table from drifting out of it.
 */
export const READINESS_CHECK_KEYS = READINESS_KEYS;

if (READINESS_CHECK_KEYS.some(key => !LABELS[key]) || Object.keys(LABELS).length !== READINESS_CHECK_KEYS.length) {
  throw new Error('campaignReadiness: LABELS and READINESS_KEYS disagree');
}

// ===========================================================================
// B8 — re-gating a live campaign.
//
// A campaign was gated once, on the ACTIVE transition, and never again. Unmap a
// branch, deactivate the service, retire the locale pack and the campaign stays
// ACTIVE with a checklist nobody re-runs: green to unable-to-book with no event
// anywhere.
//
// These are pure functions so the hourly worker can call them: Package A owns
// `server/workers/compliance.worker.ts` and `agentReverification.ts`, so B
// exposes the work rather than scheduling it. Nothing here writes to the
// campaign — an automatic pause would silence a line without a human deciding
// to. It emits a business event, and `intelligence.ts` turns that into an
// OperationalSignal that reaches /v1/briefing and the Front Desk banner.
// ===========================================================================

export interface ReadinessRegression {
  campaignId: string;
  campaignName: string;
  clinicId: string;
  agentId: string | null;
  /** The blocking rows, so a banner can render the remediation copy verbatim. */
  blockers: ReadinessCheck[];
}

/**
 * Re-evaluate every ACTIVE campaign for the tenant and report the ones that no
 * longer pass their own gate. Read-only; emitting is `emitReadinessRegressions`.
 */
export async function findActiveCampaignRegressions(
  tx: Prisma.TransactionClient,
  input: { tenantId: string; now?: Date; capabilities?: VoiceBookingCapabilities },
): Promise<ReadinessRegression[]> {
  const active = await tx.receptionistCampaign.findMany({
    where: { tenantId: input.tenantId, status: 'ACTIVE' },
    select: { id: true, name: true, clinicId: true, agentId: true },
    orderBy: { createdAt: 'asc' },
  });
  const regressions: ReadinessRegression[] = [];
  for (const campaign of active) {
    const readiness = await evaluateCampaignReadiness(tx, {
      tenantId: input.tenantId, campaignId: campaign.id, now: input.now, capabilities: input.capabilities,
    });
    if (!readiness || readiness.ready) continue;
    regressions.push({
      campaignId: campaign.id,
      campaignName: campaign.name,
      clinicId: campaign.clinicId,
      agentId: campaign.agentId,
      blockers: activationBlockers(readiness),
    });
  }
  return regressions;
}

/**
 * Emit one `receptionist.campaign.readiness_regressed` business event per
 * regressed campaign. `recordWorkflowEvent` is best-effort by design, so this
 * can never fail the job that calls it. The payload carries ids and codes only
 * — never PHI, never caller-facing copy.
 */
export async function emitReadinessRegressions(
  tenantId: string,
  regressions: ReadinessRegression[],
): Promise<void> {
  for (const regression of regressions) {
    await recordWorkflowEvent(tenantId, {
      eventType: 'receptionist.campaign.readiness_regressed',
      entityType: 'receptionistCampaign',
      entityId: regression.campaignId,
      sourceModule: 'receptionist',
      payload: {
        clinicId: regression.clinicId,
        agentId: regression.agentId,
        blockingCodes: regression.blockers.map(item => item.code ?? item.key),
        blockingCount: regression.blockers.length,
      },
    });
  }
}

/**
 * The one call the hourly per-tenant job needs. Package A owns the worker, so
 * B exposes the work rather than scheduling it; the wiring is one line inside
 * the existing per-tenant switch in `compliance.worker.ts`:
 *
 *   case 'receptionist-campaign-recheck':
 *     await recheckActiveCampaigns(tenantId);
 *     break;
 *
 * It establishes its own tenant scope and opens its own short read transaction
 * rather than borrowing the caller's, so it can never extend an interactive
 * transaction across provider round trips — defect A3's failure mode. Call it
 * from the job body, NOT from inside an already-open interactive transaction.
 */
export async function recheckActiveCampaigns(
  tenantId: string,
  options: { now?: Date; capabilities?: VoiceBookingCapabilities; actorId?: string } = {},
): Promise<ReadinessRegression[]> {
  const actorId = options.actorId ?? 'worker:receptionist-campaign-recheck';
  return runInTenantContext({ tenantId, actorId, actorRole: 'WORKER', source: 'worker' }, async () => {
    const regressions = await runWithJobTenantContext(
      tenantId,
      tx => findActiveCampaignRegressions(tx, { tenantId, now: options.now, capabilities: options.capabilities }),
      actorId,
    );
    // Emitted outside the read transaction: intelligence bookkeeping must never
    // hold a transaction open, and `recordWorkflowEvent` is best-effort anyway.
    await emitReadinessRegressions(tenantId, regressions);
    return regressions;
  });
}
