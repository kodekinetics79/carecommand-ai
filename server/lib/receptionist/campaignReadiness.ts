import type { Prisma } from '../../generated/prisma/client';
import { isValidE164, toE164 } from '../campaigns';
import { agentReadinessReason } from './agentReadiness';
import { confirmationChannelStatus } from './confirmationOutbox';
import { campaignPromptConfig, deploymentChanges, planDeployment } from './retellDeploy';
import { remediationFor, type ReadinessKey } from './remediation';
import { mandatoryOpeningDisclosure } from '../../modules/receptionist/promptService';
import { retellConfigStatus } from '../retell';

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
  agent_linked: 'An agent is assigned',
  agent_verified: 'The agent is verified with Retell',
  deployment_current: 'The deployed prompt matches this campaign',
  number_bound: 'The phone number answers with this agent',
  location_mapped: 'A location is mapped to a scheduling branch',
  services_bookable: 'The appointment type is bookable',
  provider_availability: 'A provider has availability to offer',
  intake_attested: 'The booking tool matches the intake fields',
  placeholders_absent: 'No placeholder text remains',
  disclosure_composed: 'The opening disclosure is composed',
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
  };
}

export interface ReadinessInput {
  tenantId: string;
  campaignId: string;
  now?: Date;
}

const TEST_CALL_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;

export async function evaluateCampaignReadiness(
  tx: Prisma.TransactionClient,
  input: ReadinessInput,
): Promise<ReadinessResponse | null> {
  const now = input.now ?? new Date();
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
  // One assembly, shared with preview and deployment. Null means no locale
  // pack exists for the clinic's country and language, so nothing the caller
  // would hear can be rendered — the affected checks say exactly that rather
  // than passing on an unrenderable configuration.
  const promptConfig = await campaignPromptConfig(tx, campaign, input.tenantId);
  const NO_LOCALE_PACK = 'No locale pack is available for this clinic’s country and language, so the prompt cannot be rendered. Approve a locale pack for the clinic.';

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

    const deployment = agent.currentDeploymentId
      ? await tx.receptionistAgentDeployment.findFirst({ where: { id: agent.currentDeploymentId, tenantId: input.tenantId } })
      : null;
    if (!deployment) {
      // A manually linked agent is honest about what CareCommand can and
      // cannot prove: the prompt was authored elsewhere.
      checks.push(agent.providerAgentId
        ? check('deployment_current', 'warn', 'This agent was linked manually, so CareCommand cannot prove which prompt it runs. Deploy from Studio to take ownership of it.', ctx, 'deployment_current')
        : check('deployment_current', 'fail', 'This campaign has never been deployed to Retell.', ctx, 'deployment_current'));
      checks.push(check('number_bound', agent.providerAgentId ? 'warn' : 'fail',
        'Deploy from Studio so the receptionist number answers with this campaign’s agent.', ctx, 'number_bound'));
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
      checks.push(deployment.numberBound
        ? check('number_bound', 'pass', `${deployment.boundPhoneNumber} answers with version ${deployment.providerAgentVersion}.`, ctx)
        : check('number_bound', 'fail', 'The Retell number is not bound to this deployment, so a caller would not reach this agent. Deploy again.', ctx, 'number_bound'));
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
  const service = await tx.serviceCatalogItem.findFirst({
    where: { tenantId: input.tenantId, active: true, name: { equals: campaign.appointmentType, mode: 'insensitive' } },
    select: { id: true, name: true },
  });
  checks.push(service
    ? check('services_bookable', 'pass', `“${service.name}” is in the service catalogue.`, ctx)
    : check('services_bookable', 'fail', `“${campaign.appointmentType}” is not an active service in the catalogue, so the agent cannot book it.`, ctx));

  // Contract §15: the demo tenant had twelve providers and zero availability
  // rows, so every slot search returned nothing. A count is enough here; slot
  // search stays a runtime concern.
  const availability = branchIds.length
    ? await tx.providerAvailability.count({ where: { tenantId: input.tenantId, active: true, branchId: { in: branchIds } } })
    : 0;
  checks.push(availability > 0
    ? check('provider_availability', 'pass', `${availability} availability window(s) at the mapped branches.`, ctx)
    : check('provider_availability', 'fail', 'No provider has working hours at a mapped branch, so the agent could never offer an appointment time.', ctx));

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

  // ---- Proof it works on a real phone --------------------------------------
  const testCall = await tx.receptionistCallLog.count({
    where: {
      tenantId: input.tenantId,
      clinicId: campaign.clinicId,
      direction: 'inbound',
      createdAt: { gt: new Date(now.getTime() - TEST_CALL_WINDOW_MS) },
    },
  });
  checks.push(testCall > 0
    ? check('test_call_completed', 'pass', `${testCall} inbound call(s) recorded on this line in the last 30 days.`, ctx)
    : check('test_call_completed', 'fail', 'No inbound call has reached this clinic’s line yet. Call it once from a staff phone before going live.', ctx));

  // Contract §6: the expected provider storage setting comes from the tenant
  // policy table. Until C3 ships it there is nothing to read, so the setting is
  // fixed at metadata-only and reported read-only rather than pretended about.
  checks.push(check('data_storage_setting', 'warn', 'No tenant transcript-retention policy exists yet, so the provider stores basic attributes only. This is read-only for the pilot.', ctx));

  const blocking = checks.filter(item => item.status === 'fail' || item.status === 'pending');
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
