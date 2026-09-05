import type { FastifyRequest } from 'fastify';
import { db } from '../../lib/db';
import { env } from '../../config/env';
import { branchScope, assertBranchAccess } from '../../lib/scope';
import { runWithTenantContext } from '../../lib/tenantContext';
import { aiGateway } from '../../lib/ai/gateway';
import { getEffectiveGrowthPolicy } from '../growth/service';
import { isHighNoShowRisk, isHighReputationRisk, isLowRatedReview, LOW_RATED_REVIEW_MAX, reputationBandProvenance } from './thresholds';
import { MockAdvisorProvider } from './providers';
import type {
  AdvisorAnalysis,
  AdvisorPromptInput,
  AdvisorResponse,
  AdvisorType,
  AdvisoryBriefResponse,
  AdvisoryDateRange,
  AdvisoryRequestInput,
  AdvisoryAction,
} from './types';

// Deterministic, network-free formatter. Used verbatim as the honest fallback
// whenever the governed gateway is unavailable (mock provider, PHI-blocked,
// budget-capped, or provider error) so an advisory answer is never fabricated.
const advisoryFallback = new MockAdvisorProvider();

const ADVISORY_SYSTEM_PROMPT =
  'You are a clinic operations advisor. Business operations only. No medical advice, no diagnosis, no treatment. Write a concise owner-facing advisory response.';

// Honest provenance for the templated numbers surfaced on every advisor.
const RULE_BASED_METHODOLOGY =
  'Rule-based heuristic estimate: expected-impact ($) and confidence (%) are templated arithmetic over real backend counts, not AI-model reasoning.';

function formatCurrency(value: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value);
}

function clampConfidence(value: number) {
  return Math.max(40, Math.min(98, Math.round(value)));
}

function branchFilter(request: FastifyRequest, clinicId?: string) {
  if (clinicId) {
    assertBranchAccess(request, clinicId);
    return clinicId;
  }
  return request.auth.branchId ?? undefined;
}

function dateWindow(range?: AdvisoryDateRange) {
  if (!range?.from && !range?.to) return undefined;
  return {
    gte: range.from ? new Date(range.from) : undefined,
    lte: range.to ? new Date(range.to) : undefined,
  };
}

function clinicGuardrail(question?: string) {
  const blockedTerms = ['diagnos', 'treat', 'symptom', 'medication', 'prescription', 'clinical'];
  const lowerQuestion = question?.toLowerCase() ?? '';
  return blockedTerms.some(term => lowerQuestion.includes(term));
}

async function loadContext(request: FastifyRequest, clinicId?: string, range?: AdvisoryDateRange) {
  const branchId = branchFilter(request, clinicId);
  const rangeFilter = dateWindow(range);
  const branchWhere = branchId ? { branchId } : branchScope(request);
  const dateWhere = rangeFilter ? rangeFilter : undefined;

  const [branches, patients, campaigns, revenueLeaks, opportunities, staffProfiles, providerProfiles, competitors, competitorInsights, reputationCases, reviewRequests, conversations, appointments, tasks, reviews, growthPolicy] = await Promise.all([
    db.branch.findMany({
      where: { tenantId: request.auth.tenantId, active: true, ...(branchId ? { id: branchId } : {}) },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, location: true },
    }),
    db.patient.findMany({
      where: { tenantId: request.auth.tenantId, deletedAt: null, ...branchWhere },
      orderBy: { updatedAt: 'desc' },
      take: 25,
      select: { id: true, branchId: true, firstName: true, lastName: true, lifecycleStage: true, churnRisk: true, lifetimeValue: true, outstandingBalance: true, lastVisitAt: true, nextVisitAt: true, tags: true },
    }),
    db.campaign.findMany({
      // Campaign scope is part of dispatch authority. Advisory must read the
      // same branch-bound portfolio or its recommendations and revenue figures
      // disclose another clinic's activity to a restricted operator.
      where: { tenantId: request.auth.tenantId, ...branchWhere, ...(dateWhere ? { createdAt: dateWhere } : {}) },
      orderBy: { updatedAt: 'desc' },
      take: 20,
      select: { id: true, name: true, status: true, audienceSize: true, sent: true, opened: true, booked: true, revenue: true, aiGenerated: true },
    }),
    // RLS (B-3): RevenueLeak is tenant-isolated — wrap only this read in tenant
    // context; the other advisory reads (non-RLS tables) are left untouched.
    runWithTenantContext(request.auth.tenantId, tx => tx.revenueLeak.findMany({
      where: { tenantId: request.auth.tenantId, ...branchWhere, ...(dateWhere ? { createdAt: dateWhere } : {}) },
      orderBy: [{ confidence: 'desc' }, { estimatedValue: 'desc' }],
      take: 20,
      include: {
        branch: { select: { name: true } },
        patient: { select: { firstName: true, lastName: true } },
        ownerUser: { select: { displayName: true } },
      },
    })),
    db.opportunity.findMany({
      where: { tenantId: request.auth.tenantId, ...branchWhere, ...(dateWhere ? { createdAt: dateWhere } : {}) },
      orderBy: [{ confidence: 'desc' }, { expectedRevenue: 'desc' }],
      take: 20,
      include: {
        branch: { select: { name: true } },
        patient: { select: { firstName: true, lastName: true } },
        ownerUser: { select: { displayName: true } },
      },
    }),
    db.staffProfile.findMany({
      where: { tenantId: request.auth.tenantId, ...branchWhere },
      orderBy: [{ bookingConversionRate: 'desc' }, { responseTime: 'asc' }],
      take: 20,
      include: { branch: { select: { name: true } }, user: { select: { displayName: true } } },
    }),
    db.providerProfile.findMany({
      where: { tenantId: request.auth.tenantId, ...branchWhere },
      orderBy: [{ utilization: 'desc' }, { revenueThisMonth: 'desc' }],
      take: 20,
      include: { branch: { select: { name: true } }, user: { select: { displayName: true } } },
    }),
    db.competitor.findMany({
      where: { tenantId: request.auth.tenantId, ...branchWhere },
      orderBy: [{ reviewVolume: 'desc' }, { googleRating: 'asc' }],
      take: 10,
      include: { branch: { select: { name: true } }, insights: { orderBy: { complaintCount: 'desc' }, take: 3 } },
    }),
    db.competitorReviewInsight.findMany({
      where: { tenantId: request.auth.tenantId, ...(branchId ? { competitor: { branchId } } : {}) },
      orderBy: [{ complaintCount: 'desc' }, { createdAt: 'desc' }],
      take: 10,
    }),
    db.reputationCase.findMany({
      where: { tenantId: request.auth.tenantId, ...branchWhere },
      orderBy: [{ badReviewRisk: 'desc' }, { createdAt: 'desc' }],
      take: 20,
      include: { branch: { select: { name: true } } },
    }),
    db.reviewRequest.findMany({
      where: { tenantId: request.auth.tenantId, ...branchWhere, ...(dateWhere ? { createdAt: dateWhere } : {}) },
      orderBy: [{ createdAt: 'desc' }],
      take: 20,
      include: { branch: { select: { name: true } } },
    }),
    db.conversation.findMany({
      where: { tenantId: request.auth.tenantId, ...branchWhere, ...(dateWhere ? { createdAt: dateWhere } : {}) },
      orderBy: [{ updatedAt: 'desc' }],
      take: 20,
      include: { branch: { select: { name: true } }, patient: { select: { firstName: true, lastName: true } } },
    }),
    db.appointment.findMany({
      where: { tenantId: request.auth.tenantId, ...branchWhere, ...(dateWhere ? { startsAt: dateWhere } : {}) },
      orderBy: [{ startsAt: 'desc' }],
      take: 25,
      include: { branch: { select: { name: true } }, patient: { select: { firstName: true, lastName: true } } },
    }),
    db.staffTask.findMany({
      where: { tenantId: request.auth.tenantId, ...branchWhere },
      orderBy: [{ dueAt: 'asc' }, { updatedAt: 'desc' }],
      take: 20,
      include: { branch: { select: { name: true } }, assignedTo: { select: { displayName: true } } },
    }),
    db.review.findMany({
      where: { tenantId: request.auth.tenantId, ...branchWhere, ...(dateWhere ? { createdAt: dateWhere } : {}) },
      orderBy: [{ createdAt: 'desc' }],
      take: 20,
      include: { branch: { select: { name: true } } },
    }),
    // The tenant's effective Growth configuration, loaded ONCE per advisory
    // context rather than per call site, so every advisor built from this
    // context classifies with the same numbers the clinic configured.
    //
    // Read inside a tenant transaction, deliberately. GrowthPolicy is
    // RLS-enrolled (rls_growth_policy_select ... USING app_rls_tenant_allowed),
    // and `app_rls_tenant_allowed` returns false when no tenant GUC is set. A
    // read that escapes tenant context therefore returns NO ROW, and
    // `getEffectiveGrowthPolicy` resolves to the code defaults with
    // `source: 'default'` — a silent fail-open on the tenant's own
    // configuration that looks exactly like working code. Passing `tx` makes
    // the read fail closed instead of fail quiet, in every caller: request,
    // worker and job alike. server/test/advisoryThresholdRls.integration.test.ts
    // fails if this argument goes away.
    runWithTenantContext(request.auth.tenantId, tx => getEffectiveGrowthPolicy(request.auth.tenantId, tx)),
  ]);

  return {
    branchId,
    branches,
    patients,
    campaigns,
    revenueLeaks,
    opportunities,
    staffProfiles,
    providerProfiles,
    competitors,
    competitorInsights,
    reputationCases,
    reviewRequests,
    conversations,
    appointments,
    tasks,
    reviews,
    growthPolicy,
  };
}

function action(label: string, path: string, description: string, primary = false, context?: Record<string, unknown>): AdvisoryAction {
  return { label, path, description, primary, context };
}

function buildRevenueAdvisor(context: Awaited<ReturnType<typeof loadContext>>, question?: string): AdvisorAnalysis {
  const openLeaks = context.revenueLeaks.filter(leak => leak.status !== 'closed');
  const recoverableValue = openLeaks.reduce((sum, leak) => sum + Number(leak.estimatedValue), 0);
  const topLeak = openLeaks[0];
  const topOpportunity = context.opportunities[0];
  const inactivePatients = context.patients.filter(patient => patient.lifecycleStage === 'INACTIVE' || patient.lifecycleStage === 'AT_RISK').length;
  const topCampaign = context.campaigns.find(campaign => String(campaign.status).toLowerCase() === 'active') ?? context.campaigns[0];
  const summary = `Recoverable value is concentrated in ${openLeaks.length} open revenue leaks and ${inactivePatients} patients that need reactivation.`;
  const diagnosis = `The biggest revenue drag is unresolved follow-up on high-confidence leaks, with the strongest upside in ${topLeak?.branch.name ?? 'the highest-value branch'} and the largest opportunity queue still sitting idle.`;
  const recommendedAction = topOpportunity
    ? `Run the top opportunity in ${topOpportunity.branch.name} and pair it with a focused recovery campaign.`
    : 'Run a focused recovery campaign against the top leak cohorts and missed-call queue.';
  const expectedImpact = Math.round(recoverableValue * 0.45 + (topOpportunity ? Number(topOpportunity.expectedRevenue) * 0.25 : 0));
  return {
    advisorType: 'revenue',
    summary,
    diagnosis,
    recommendedAction,
    expectedImpact,
    confidence: clampConfidence(84 + (topLeak ? 4 : 0)),
    evidence: [
      topLeak ? `${topLeak.branch.name}: ${topLeak.source} at ${formatCurrency(Number(topLeak.estimatedValue))} (${topLeak.confidence}% confidence)` : 'No open revenue leaks returned for the selected clinic scope.',
      topOpportunity ? `Top opportunity: ${topOpportunity.title} in ${topOpportunity.branch.name} with ${formatCurrency(Number(topOpportunity.expectedRevenue))} expected revenue.` : 'No open opportunities returned.',
      topCampaign ? `Active campaign momentum: ${topCampaign.name} (${topCampaign.status.toLowerCase()}) with ${topCampaign.audienceSize} audience.` : 'No active campaigns were found in the selected scope.',
      `Inactive or at-risk patients in scope: ${inactivePatients}.`,
    ],
    recommendations: [
      'Prioritise the highest-confidence leak first.',
      'Launch a follow-up campaign on the same day.',
      'Send the recovery queue to the front desk with a clear owner.',
    ],
    actions: [
      action('Open Revenue Leaks', '/opportunities', 'Review leaks and opportunity queue', true, { clinicId: context.branchId }),
      action('Create Campaign', '/campaigner', 'Launch a recovery campaign', false, { advisorType: 'revenue', question }),
      action('Open CRM', '/crm', 'Inspect at-risk customers', false, { clinicId: context.branchId }),
    ],
  };
}

function buildGrowthAdvisor(context: Awaited<ReturnType<typeof loadContext>>, question?: string): AdvisorAnalysis {
  const activeCampaigns = context.campaigns.filter(campaign => String(campaign.status).toLowerCase() === 'active');
  const inactivePatients = context.patients.filter(patient => patient.lifecycleStage === 'INACTIVE' || patient.lifecycleStage === 'AT_RISK');
  const totalCampaignRevenue = activeCampaigns.reduce((sum, campaign) => sum + Number(campaign.revenue), 0);
  const leadLikeMomentum = context.reviewRequests.filter(request => request.status !== 'completed').length + inactivePatients.length;
  const summary = `Growth is strongest where active campaigns can be paired with inactive-patient reactivation.`;
  const diagnosis = `The current growth engine has momentum, but the best upside comes from segmenting ${inactivePatients.length} at-risk customers and turning them into a new campaign audience.`;
  const recommendedAction = 'Launch a reactivation campaign and measure audience conversion against the live campaign library.';
  const expectedImpact = Math.round(totalCampaignRevenue * 0.35 + inactivePatients.length * 120);
  const topCampaign = activeCampaigns[0] ?? context.campaigns[0];
  return {
    advisorType: 'growth',
    summary,
    diagnosis,
    recommendedAction,
    expectedImpact,
    confidence: clampConfidence(80 + Math.min(inactivePatients.length, 8)),
    evidence: [
      topCampaign ? `Current campaign: ${topCampaign.name} (${topCampaign.status.toLowerCase()}) with ${topCampaign.audienceSize} audience.` : 'No campaigns were returned for this clinic scope.',
      `Inactive or at-risk customers available for growth: ${inactivePatients.length}.`,
      `Open review / conversion signals in play: ${leadLikeMomentum}.`,
      `Total active campaign revenue in scope: ${formatCurrency(totalCampaignRevenue)}.`,
    ],
    recommendations: [
      'Reuse the best-performing audience template.',
      'Pair reactivation with a booking deadline.',
      'Measure conversion by branch within 7 days.',
    ],
    actions: [
      action('Create Campaign', '/campaigner', 'Launch a growth campaign', true, { advisorType: 'growth', question }),
      action('Open CRM', '/crm', 'Review reactivation cohorts', false, { clinicId: context.branchId }),
      action('Open Opportunity Center', '/opportunities', 'Track follow-through value', false, { clinicId: context.branchId }),
    ],
  };
}

function buildFrontDeskAdvisor(context: Awaited<ReturnType<typeof loadContext>>): AdvisorAnalysis {
  const slowStaff = [...context.staffProfiles].sort((a, b) => Number(b.responseTime) - Number(a.responseTime));
  const totalMissedCalls = context.staffProfiles.reduce((sum, staff) => sum + staff.missedCalls, 0);
  const overdueTasks = context.tasks.filter(task => !task.dueAt || task.status !== 'COMPLETED').length;
  const unresolvedConversations = context.conversations.filter(conversation => conversation.status !== 'replied' && conversation.status !== 'ai-recovered').length;
  // The count is priced (× $120 into expectedImpact), so it is classified with
  // the tenant's configured rule — the SAME `noShowRiskHigh` the Scheduling
  // board flags with — never a private advisory band. See isHighNoShowRisk.
  const policy = context.growthPolicy;
  const noShowRiskAppointments = context.appointments.filter(appointment => isHighNoShowRisk(appointment.noShowRisk, policy)).length;
  const summary = `Front desk performance is driven by response time, missed calls, and unresolved tasks.`;
  const diagnosis = `The largest operational gain is in the slowest-response staff members and the missed-call queue, which is still leaving too much recoverable value on the table.`;
  const recommendedAction = 'Triage the missed-call queue, assign overdue tasks, and coach the slowest responders first.';
  const expectedImpact = Math.round(totalMissedCalls * 140 + overdueTasks * 95 + noShowRiskAppointments * 120);
  const topStaff = slowStaff[0];
  return {
    advisorType: 'front-desk',
    summary,
    diagnosis,
    recommendedAction,
    expectedImpact,
    confidence: clampConfidence(86),
    evidence: [
      topStaff ? `${topStaff.user.displayName}: ${Number(topStaff.responseTime).toFixed(1)} min response time, ${topStaff.missedCalls} missed calls.` : 'No staff profile data available.',
      `Missed calls across staff: ${totalMissedCalls}.`,
      `Overdue / open tasks: ${overdueTasks}.`,
      `High no-show risk appointments (stored risk ≥ ${policy.noShowRiskHigh}, ${reputationBandProvenance(policy)}): ${noShowRiskAppointments}.`,
      `Unresolved conversations in queue: ${unresolvedConversations}.`,
    ],
    recommendations: [
      'Push missed calls into the same-day callback queue.',
      'Convert overdue tasks into owner-assigned follow-ups.',
      'Coach response time before broadening campaign volume.',
    ],
    actions: [
      action('Review Staff Queue', '/staff', 'Open the task board and SLA view', true, { clinicId: context.branchId }),
      action('Open AI Front Desk', '/ai-receptionist', 'Handle missed calls and replies', false, { clinicId: context.branchId }),
      action('Open CRM', '/crm', 'Move follow-ups into the customer record', false, { clinicId: context.branchId }),
    ],
  };
}

function buildCompetitorAdvisor(context: Awaited<ReturnType<typeof loadContext>>, question?: string): AdvisorAnalysis {
  const topCompetitor = context.competitors[0];
  const topInsight = context.competitorInsights[0];
  // Both counts below are multiplied into `expectedImpact`, a currency figure a
  // clinic acts on, so neither may be decided by a number the clinic cannot
  // see. The reputation band is the tenant's configured one — the SAME
  // `reputationRiskHigh` src/pages/ClinicRadar.tsx bands this exact field with.
  // The low-rating bound is a named product constant, recorded with its reason
  // in THRESHOLD_RESOLUTIONS (server/modules/growth/defaults.ts).
  const policy = context.growthPolicy;
  const reputationCases = context.reputationCases.filter(item => isHighReputationRisk(item.badReviewRisk, policy)).length;
  const reviews = context.reviews.filter(review => isLowRatedReview(review.rating)).length;
  const summary = `Competitor pressure is mostly about review velocity, response speed, and complaint themes.`;
  const diagnosis = `Competitors are creating openings where they miss response-time expectations or repeat complaint themes, and your clinic can win with a faster recovery motion.`;
  const recommendedAction = topCompetitor
    ? `Counter ${topCompetitor.name} on its weakest complaint theme and lead with a response-speed campaign.`
    : 'Counter the weakest competitor complaint theme with a fast-response recovery campaign.';
  const expectedImpact = Math.round((topCompetitor ? Number(topCompetitor.reviewVolume) * 18 : 0) + reputationCases * 250 + reviews * 120);
  return {
    advisorType: 'competitor',
    summary,
    diagnosis,
    recommendedAction,
    expectedImpact,
    confidence: clampConfidence(83),
    evidence: [
      topCompetitor ? `${topCompetitor.name}: ${Number(topCompetitor.googleRating).toFixed(1)} rating across ${topCompetitor.reviewVolume} reviews.` : 'No competitor data available for the selected clinic.',
      topInsight ? `Top complaint theme: ${topInsight.theme} (${topInsight.complaintCount} mentions).` : 'No competitor complaint insight available.',
      // A stated rule the clinic can check, not a bare count: an owner reading a
      // dollar figure is entitled to see which threshold produced it and whose
      // threshold it is.
      `High-risk reputation cases (recorded risk ≥ ${policy.reputationRiskHigh}, ${reputationBandProvenance(policy)}): ${reputationCases}.`,
      `Recent low-rated reviews (rating ≤ ${LOW_RATED_REVIEW_MAX}, product constant): ${reviews}.`,
    ],
    recommendations: [
      'Focus your next campaign on response speed and review recovery.',
      'Use the strongest competitor complaint theme as the opening message.',
      'Route reputation follow-up into the owner review queue.',
    ],
    actions: [
      action('Open Clinic Radar', '/clinic-radar', 'Inspect the competitor board', true, { clinicId: context.branchId }),
      action('Create Campaign', '/campaigner', 'Launch a counter-campaign', false, { advisorType: 'competitor', question }),
      action('Open Revenue Leaks', '/opportunities', 'Match the alert to revenue recovery', false, { clinicId: context.branchId }),
    ],
  };
}

function buildOperationsAdvisor(context: Awaited<ReturnType<typeof loadContext>>): AdvisorAnalysis {
  const bestBranch = [...context.branches].map(branch => {
    const branchProviders = context.providerProfiles.filter(provider => provider.branchId === branch.id);
    const branchAppointments = context.appointments.filter(appointment => appointment.branchId === branch.id);
    const branchTasks = context.tasks.filter(task => task.branchId === branch.id);
    const utilization = branchProviders.reduce((sum, provider) => sum + provider.utilization, 0) / Math.max(branchProviders.length, 1);
    // Priced at × $150 into expectedImpact below — the tenant's configured
    // rule, same as the Scheduling board's flag. See isHighNoShowRisk.
    const risk = branchAppointments.filter(appointment => isHighNoShowRisk(appointment.noShowRisk, context.growthPolicy)).length;
    return { branch, utilization, risk, branchTasks };
  }).sort((left, right) => right.utilization - left.utilization)[0];

  const openSlots = context.appointments.filter(appointment => appointment.status === 'CONFIRMED' || appointment.status === 'WAITLIST').length;
  const tasksPending = context.tasks.filter(task => task.status !== 'COMPLETED').length;
  const summary = 'Operations are strongest when capacity, staffing, and task flow are aligned by clinic.';
  const diagnosis = bestBranch
    ? `The highest-leverage operations move is to tighten scheduling and task flow at ${bestBranch.branch.name}, where utilization and task load can be balanced more effectively.`
    : 'The highest-leverage operations move is to tighten scheduling and task flow across the clinic network.';
  const recommendedAction = 'Shift capacity into the busiest clinic, clear task bottlenecks, and reduce no-show risk with a tighter schedule review.';
  const expectedImpact = Math.round(openSlots * 110 + tasksPending * 75 + (bestBranch?.risk ?? 0) * 150);
  return {
    advisorType: 'operations',
    summary,
    diagnosis,
    recommendedAction,
    expectedImpact,
    confidence: clampConfidence(82),
    evidence: [
      bestBranch ? `${bestBranch.branch.name}: ${bestBranch.utilization.toFixed(0)}% utilization with ${bestBranch.branchTasks.length} open tasks.` : 'No branch data available for operations review.',
      `Open / active schedule items: ${openSlots}.`,
      `Pending tasks across the network: ${tasksPending}.`,
      // A stated rule the clinic can check, not a bare count — and the same
      // rule the Scheduling board and the front-desk advisor apply.
      `No-show risk appointments in scope (stored risk ≥ ${context.growthPolicy.noShowRiskHigh}, ${reputationBandProvenance(context.growthPolicy)}): ${context.appointments.filter(appointment => isHighNoShowRisk(appointment.noShowRisk, context.growthPolicy)).length}.`,
    ],
    recommendations: [
      'Use the busiest clinic as the capacity benchmark.',
      'Clear overdue tasks before increasing campaign volume.',
      'Use scheduling to balance network utilization.',
    ],
    actions: [
      action('Open Scheduling', '/scheduling', 'Review availability and no-show risk', true, { clinicId: context.branchId }),
      action('Review Staff Queue', '/staff', 'Triage open tasks and response SLAs', false, { clinicId: context.branchId }),
      action('Open Revenue Leaks', '/opportunities', 'See the revenue impact of operational gaps', false, { clinicId: context.branchId }),
    ],
  };
}

function buildGuardrailResponse(advisorType: AdvisorType, question: string): AdvisorAnalysis {
  return {
    advisorType,
    summary: 'The request looks clinical, so the advisor will stay on business operations only.',
    diagnosis: 'Clinical advice is out of scope for this room.',
    recommendedAction: 'Reframe the question around operations, revenue, staffing, or marketing.',
    expectedImpact: 0,
    confidence: 100,
    evidence: [`Blocked clinical terms detected in question: "${question}".`],
    recommendations: ['Ask about scheduling, revenue, staffing, marketing, reputation, or CRM workflows.'],
    actions: [
      action('Open Revenue Leaks', '/opportunities', 'Review operational leaks', true),
      action('Open CRM', '/crm', 'Check customer lifecycle data', false),
    ],
  };
}

function buildAdvisorAnalysis(advisorType: AdvisorType, context: Awaited<ReturnType<typeof loadContext>>, question?: string): AdvisorAnalysis {
  if (clinicGuardrail(question)) {
    return buildGuardrailResponse(advisorType, question ?? '');
  }
  switch (advisorType) {
    case 'revenue':
      return buildRevenueAdvisor(context, question);
    case 'growth':
      return buildGrowthAdvisor(context, question);
    case 'front-desk':
      return buildFrontDeskAdvisor(context);
    case 'competitor':
      return buildCompetitorAdvisor(context, question);
    case 'operations':
      return buildOperationsAdvisor(context);
  }
}

interface Actor { tenantId: string; userId?: string | null }

// Generate the free-text advisory `answer`. This is the SINGLE outbound AI seam
// for advisory and now runs through the governed gateway (PHI guard, daily
// budget cap, and AIUsageLog). It never bypasses the gateway to a raw provider.
//
// PHI posture: the structured evidence prompt carries no patient identifiers
// (branch/staff/campaign names + counts only), so the auto-brief is non-PHI. A
// user-supplied free-text `question` is unbounded and treated as possibly-PHI —
// the gateway then blocks it unless AI_ENABLE_PHI=true, and we degrade to the
// deterministic fallback rather than sending it ungoverned.
async function generateAnswer(
  actor: Actor,
  promptInput: AdvisorPromptInput,
  question?: string,
): Promise<{ answer: string; answerSource: 'model' | 'rule-based' }> {
  const deterministic = await advisoryFallback.generateAnswer(promptInput);

  // Clinical guardrail or the default mock provider → deterministic only, no
  // network call (identical to prior behaviour, minus the ungoverned bypass).
  if (clinicGuardrail(question) || env.AI_PROVIDER === 'mock') {
    return { answer: deterministic, answerSource: 'rule-based' };
  }

  try {
    const { result } = await aiGateway.generate({
      tenantId: actor.tenantId,
      actorUserId: actor.userId ?? null,
      operation: 'advisory',
      containsPhi: Boolean(question),
      // `deterministic` already embeds the question line (if any) + evidence.
      messages: [
        { role: 'system', content: ADVISORY_SYSTEM_PROMPT },
        { role: 'user', content: deterministic },
      ],
    });
    const text = result.text?.trim();
    return text ? { answer: text, answerSource: 'model' } : { answer: deterministic, answerSource: 'rule-based' };
  } catch {
    // Blocked (PHI/budget) or provider error → honest deterministic fallback.
    return { answer: deterministic, answerSource: 'rule-based' };
  }
}

async function materializeResponse(
  actor: Actor,
  advisorType: AdvisorType,
  context: Awaited<ReturnType<typeof loadContext>>,
  question?: string,
): Promise<AdvisorResponse> {
  const analysis = buildAdvisorAnalysis(advisorType, context, question);
  const promptInput: AdvisorPromptInput = {
    advisorType,
    question,
    analysis,
    clinicName: context.branches.length === 1 ? context.branches[0]?.name ?? null : null,
  };
  const { answer, answerSource } = await generateAnswer(actor, promptInput, question);

  return {
    ...analysis,
    answer,
    answerSource,
    methodology: RULE_BASED_METHODOLOGY,
    question,
    clinicId: context.branchId ?? null,
    generatedAt: new Date().toISOString(),
  };
}

export async function getAdvisoryBrief(request: FastifyRequest, clinicId?: string, range?: AdvisoryDateRange): Promise<AdvisoryBriefResponse> {
  const context = await loadContext(request, clinicId, range);
  const actor: Actor = { tenantId: request.auth.tenantId, userId: request.auth.userId };
  const advisors = await Promise.all([
    materializeResponse(actor, 'revenue', context),
    materializeResponse(actor, 'growth', context),
    materializeResponse(actor, 'front-desk', context),
    materializeResponse(actor, 'competitor', context),
    materializeResponse(actor, 'operations', context),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    clinicId: context.branchId ?? null,
    clinicName: context.branches.length === 1 ? context.branches[0]?.name ?? null : 'All clinics',
    advisors,
  };
}

export async function askAdvisor(request: FastifyRequest, input: AdvisoryRequestInput): Promise<AdvisorResponse> {
  const context = await loadContext(request, input.clinicId, input.dateRange);
  const actor: Actor = { tenantId: request.auth.tenantId, userId: request.auth.userId };
  return materializeResponse(actor, input.advisorType, context, input.question);
}
