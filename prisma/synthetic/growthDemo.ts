import { createHash } from 'node:crypto';
import { Prisma } from '../../server/generated/prisma/client';
import type { PrismaClient } from '../../server/generated/prisma/client';
import type { SyntheticProfileManifest } from './profileManifest';

// ===========================================================================
// Growth demo layer for the synthetic seed.
//
// WHY THIS FILE EXISTS
// --------------------
// The synthetic seed produced a tenant that could not demonstrate the Growth
// module at all:
//
//   * No `TenantSubscription`, so `recomputeEntitlements` resolved NOTHING and
//     every `/v1/crm/*` route answered `feature_locked`. The whole campaigns
//     module was dark on a fresh tenant.
//   * No `Lead`, `Campaign`, `Review`, `ReputationCase`, `ReviewRequest`,
//     `Competitor`, `AutopilotPlaybook`, `AutomationRule` or
//     `CommunicationConsent` rows, so CRM, Reviews, ClinicRadar and Autopilot
//     rendered empty states on a "working" clinic.
//   * `Patient.lastVisitAt` was never written, and that is the ONE column every
//     inactive-patient segment and the `inactive_patients` audience filter on.
//     Every segment counted zero.
//
// WHAT IT DELIBERATELY DOES NOT DO
// --------------------------------
//   * It never writes `TenantFeatureEntitlement` by hand. It writes ONE
//     `TenantSubscription` against the catalog plan and calls the production
//     `recomputeEntitlements`, so what a demo tenant can open is decided by the
//     same resolver a paying tenant is decided by.
//   * It never writes `CampaignLiveDispatchActivation`. Absence means live
//     regulated dispatch is OFF, and that is the honest state for a demo: the
//     dev mock provider path is what gets shown.
//   * It never writes `Campaign.opened/responded/booked/revenue`. Those four are
//     a database-enforced rollup of `CampaignAttribution`. This file seeds the
//     delivery -> appointment -> payment evidence and then runs the REAL
//     attribution job, so every number on a campaign card traces back to a row.
//   * It never fabricates a display value. Pipeline stages, lead scores, review
//     averages, segment counts and consent badges are all computed by the
//     product from records written here.
//
// TIME ANCHORING
// --------------
// The rest of the seed runs on `profile.controlledClock` so ids and history are
// reproducible. Inactivity windows cannot: the segments are evaluated against
// the API's wall clock at request time, so a `lastVisitAt` pinned to a fixed
// 2026-07-15 would drift out of the 30-60 / 60-90 / 90-180 bands the moment the
// clock moved past it, and the demo would be empty again. Window-relative
// timestamps are therefore anchored to `demoClock`, which defaults to the
// moment the seed runs (set `SYNTHETIC_DEMO_CLOCK` to pin it). Rebuilding
// before a call is what keeps the bands true, which is exactly what the
// one-command provisioning path is for.
// ===========================================================================

export interface GrowthDemoContext {
  db: PrismaClient;
  profile: SyntheticProfileManifest;
  /** Deterministic controlled clock shared with the rest of the seed. */
  now: Date;
  /** Wall-clock anchor for inactivity windows (see TIME ANCHORING above). */
  demoClock: Date;
  stableUuid: (scope: string, index: number) => string;
  tenantIds: string[];
  tenantStatuses: string[];
  branchIds: string[];
  branchTenant: string[];
  userIds: string[];
  userTenant: string[];
  patientIds: string[];
  patientTenant: string[];
  patientBranch: string[];
}

export interface GrowthDemoCounts {
  subscriptions: number;
  entitlementsEnabledForDemoTenant: string[];
  patientsDated: number;
  leads: number;
  leadActivities: number;
  campaigns: number;
  campaignDeliveries: number;
  campaignAttributions: number;
  attributionAppointments: number;
  paymentTransactions: number;
  communicationConsents: number;
  consentEvents: number;
  campaignSuppressions: number;
  reviews: number;
  reviewRequests: number;
  reputationCases: number;
  competitors: number;
  competitorInsights: number;
  autopilotPlaybooks: number;
  autopilotApprovals: number;
  automationRules: number;
  growthPolicies: number;
  liveDispatchActivations: number;
}

const DAY = 86_400_000;

/**
 * Plan per tenant slot. Slot 0 is THE demo tenant and gets the full catalogue so
 * every Growth screen is openable; the others deliberately spread across the
 * catalog so a demo can also show a genuine entitlement lock rather than
 * claiming locks do not exist.
 */
export function demoPlanForTenant(index: number, status: string): { planKey: string; status: 'ACTIVE' | 'TRIAL' | 'PAST_DUE' | 'SUSPENDED' | 'CANCELLED' } {
  if (status !== 'active') return { planKey: 'starter', status: 'SUSPENDED' };
  if (index === 0) return { planKey: 'enterprise', status: 'ACTIVE' };
  if (index === 1) return { planKey: 'growth', status: 'ACTIVE' };
  if (index === 2) return { planKey: 'command', status: 'TRIAL' };
  return { planKey: 'starter', status: 'ACTIVE' };
}

/**
 * Inactivity band per patient ordinal WITHIN a tenant. Ordering matters: the
 * three bounded windows and the >180d audience population come first, so even a
 * five-patient FUNCTIONAL tenant has a real member in each of them instead of
 * whichever bands a global modulo happened to land on.
 */
export const INACTIVITY_BANDS = [
  { key: 'inactive-30-60', minDays: 42, spread: 8 },
  { key: 'inactive-60-90', minDays: 72, spread: 8 },
  { key: 'inactive-90-180', minDays: 112, spread: 40 },
  { key: 'beyond-180', minDays: 220, spread: 90 },
  { key: 'never-visited', minDays: null, spread: 0 },
  { key: 'inactive-30-60', minDays: 46, spread: 8 },
  { key: 'inactive-60-90', minDays: 78, spread: 8 },
  { key: 'inactive-90-180', minDays: 150, spread: 25 },
  { key: 'recent', minDays: 4, spread: 12 },
  { key: 'recent', minDays: 12, spread: 14 },
] as const;

const LEAD_STAGES = ['new-inquiry', 'contacted', 'booked', 'visited', 'follow-up', 'retained', 'lost'] as const;
const LEAD_CHANNELS = ['SMS', 'EMAIL', 'WHATSAPP', 'CALL', 'PUSH'] as const;
const LEAD_SOURCES = ['Google Business Profile', 'Website form', 'Referral', 'Walk-in', 'Missed call callback', 'Instagram'] as const;
const LEAD_SERVICES = ['New patient consult', 'Hygiene recall', 'Implant consult', 'Annual wellness', 'Aesthetic consult'] as const;
const LOST_REASONS = [
  'Chose a competitor closer to home',
  'No availability inside the requested week',
  'Out-of-pocket estimate above the patient budget',
] as const;

const REVIEW_PLATFORMS = ['google', 'yelp', 'facebook', 'healthgrades'] as const;

/** Ratings chosen so the tenant average is a real, defensible mixed number. */
const REVIEW_RATINGS = [5, 5, 4, 5, 3, 5, 4, 2, 5, 4, 5, 1, 4, 5, 3] as const;

const REVIEW_TEXT: Record<number, string> = {
  5: 'Front desk got me in the same week and the visit ran on time.',
  4: 'Good visit overall; the wait was a little longer than booked.',
  3: 'Care was fine but the billing explanation took two calls to sort out.',
  2: 'Appointment was moved twice and nobody called to tell me.',
  1: 'Waited forty minutes past my slot and left without being seen.',
};

function sentimentFor(rating: number): string {
  return rating >= 4 ? 'positive' : rating === 3 ? 'neutral' : 'negative';
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * The exact metadata shape `validAuthorityMetadata` in server/lib/campaigns.ts
 * requires. Written out in full rather than stubbed: a consent badge that says
 * "affirmative authority on file" must be backed by a record that the live
 * outreach fence would actually accept, or the badge is a lie.
 */
function outreachAuthorityMetadata(outreachPurpose: string, evidenceReference: string): Prisma.InputJsonValue {
  return {
    authorityVersion: 1,
    outreachPurpose,
    policyVersion: 'synthetic-outreach-policy-2026.1',
    disclosureTextHash: sha256(`synthetic-disclosure:${outreachPurpose}`),
    evidenceReference,
    captureMethod: 'web_form_checkbox',
    evidenceSource: 'patient_portal',
    jurisdiction: 'US-NY',
  };
}

export async function seedGrowthDemo(ctx: GrowthDemoContext): Promise<GrowthDemoCounts> {
  const { db, profile, now, demoClock, stableUuid, tenantIds, tenantStatuses } = ctx;
  const uuid = (scope: string, index: number): string => stableUuid(`growth:${scope}`, index);

  // Bound to the synthetic connection by the caller before this import, so the
  // production singleton in server/lib/db can never be the client that is used.
  const { recomputeEntitlements } = await import('../../server/lib/entitlements');
  const { attributeTenantCampaignOutcomes } = await import('../../server/lib/campaignAttribution');

  const counts: GrowthDemoCounts = {
    subscriptions: 0, entitlementsEnabledForDemoTenant: [], patientsDated: 0, leads: 0, leadActivities: 0,
    campaigns: 0, campaignDeliveries: 0, campaignAttributions: 0, attributionAppointments: 0,
    paymentTransactions: 0, communicationConsents: 0, consentEvents: 0, campaignSuppressions: 0,
    reviews: 0, reviewRequests: 0, reputationCases: 0, competitors: 0, competitorInsights: 0,
    autopilotPlaybooks: 0, autopilotApprovals: 0, automationRules: 0, growthPolicies: 0,
    liveDispatchActivations: 0,
  };

  // -------------------------------------------------------------------------
  // 1. Subscriptions -> entitlements, through the production resolver.
  // -------------------------------------------------------------------------
  const plans = await db.subscriptionPlan.findMany({ select: { id: true, key: true } });
  const planByKey = new Map(plans.map(plan => [plan.key, plan.id]));
  if (planByKey.size === 0) {
    throw new Error('Subscription plan catalog is empty; run `prisma migrate deploy` (20260828120000_subscription_catalog_reference_data) before seeding');
  }

  for (const [index, tenantId] of tenantIds.entries()) {
    const choice = demoPlanForTenant(index, tenantStatuses[index] ?? 'active');
    const planId = planByKey.get(choice.planKey);
    if (!planId) throw new Error(`Subscription plan "${choice.planKey}" is missing from the catalog`);
    await db.tenantSubscription.create({
      data: {
        id: uuid('subscription', index),
        tenantId,
        planId,
        status: choice.status,
        trialEndsAt: choice.status === 'TRIAL' ? new Date(demoClock.getTime() + 21 * DAY) : null,
        currentPeriodEnd: new Date(demoClock.getTime() + 30 * DAY),
        startedAt: new Date(demoClock.getTime() - 120 * DAY),
        createdAt: now,
        updatedAt: now,
      },
    });
    counts.subscriptions += 1;
    const resolved = await recomputeEntitlements(tenantId, db);
    if (index === 0) {
      counts.entitlementsEnabledForDemoTenant = resolved.filter(row => row.enabled).map(row => row.featureKey).sort();
    }
  }

  // Tenants that can actually run Growth demos: active, and entitled to
  // campaign_automation. Everything below is seeded only for these, so a locked
  // tenant stays honestly locked and empty.
  const growthTenants: Array<{ tenantId: string; index: number }> = [];
  for (const [index, tenantId] of tenantIds.entries()) {
    const entitled = await db.tenantFeatureEntitlement.findFirst({
      where: { tenantId, featureKey: 'campaign_automation', enabled: true },
      select: { id: true },
    });
    if (entitled) growthTenants.push({ tenantId, index });
  }

  // -------------------------------------------------------------------------
  // 2. Patient.lastVisitAt across a realistic spread.
  //
  // Grouped into one updateMany per distinct value set: a 2,000-patient PILOT
  // seed would otherwise be 2,000 round trips.
  // -------------------------------------------------------------------------
  const perTenantOrdinal = new Map<string, number>();
  type PatientPatch = { lastVisitAt: Date | null; highLtv: boolean; winback: boolean; churnRisk: number | null };
  const patchGroups = new Map<string, { patch: PatientPatch; ids: string[] }>();

  for (const [index, patientId] of ctx.patientIds.entries()) {
    const tenantId = ctx.patientTenant[index]!;
    const ordinal = perTenantOrdinal.get(tenantId) ?? 0;
    perTenantOrdinal.set(tenantId, ordinal + 1);
    const band = INACTIVITY_BANDS[ordinal % INACTIVITY_BANDS.length]!;
    const days = band.minDays === null ? null : band.minDays + (ordinal % Math.max(1, band.spread));
    // High-LTV inactive needs >= 4000 lifetime value AND >= 45 days quiet.
    // Pinned to the 90-180 and >180 bands so the segment is never empty by luck.
    const highLtv = band.key === 'inactive-90-180' || band.key === 'beyond-180';
    // The winback segment filters on a tag, so a tag has to exist on someone.
    const winback = band.key === 'beyond-180' || band.key === 'never-visited';
    // "Patients at risk" filters on churnRisk >= 50.
    const churnRisk = highLtv ? 55 + (ordinal % 35) : null;
    const patch: PatientPatch = {
      lastVisitAt: days === null ? null : new Date(demoClock.getTime() - days * DAY),
      highLtv, winback, churnRisk,
    };
    const key = `${patch.lastVisitAt?.toISOString() ?? 'null'}|${highLtv}|${winback}|${churnRisk ?? 'keep'}`;
    const group = patchGroups.get(key);
    if (group) group.ids.push(patientId);
    else patchGroups.set(key, { patch, ids: [patientId] });
  }

  for (const [groupIndex, { patch, ids }] of [...patchGroups.values()].entries()) {
    for (let offset = 0; offset < ids.length; offset += 1_000) {
      const slice = ids.slice(offset, offset + 1_000);
      const updated = await db.patient.updateMany({
        where: { id: { in: slice } },
        data: {
          lastVisitAt: patch.lastVisitAt,
          ...(patch.highLtv ? { lifetimeValue: new Prisma.Decimal(4_200 + (groupIndex % 12) * 175) } : {}),
          ...(patch.winback ? { tags: { push: 'winback' } } : {}),
          ...(patch.churnRisk === null ? {} : { churnRisk: patch.churnRisk }),
        },
      });
      counts.patientsDated += updated.count;
    }
  }

  // -------------------------------------------------------------------------
  // 3. Per-tenant Growth records.
  // -------------------------------------------------------------------------
  let leadSeq = 0, activitySeq = 0, campaignSeq = 0, deliverySeq = 0, apptSeq = 0, paymentSeq = 0;
  let consentSeq = 0, eventSeq = 0, suppressionSeq = 0, reviewSeq = 0, requestSeq = 0, caseSeq = 0;
  let competitorSeq = 0, insightSeq = 0, playbookSeq = 0, approvalSeq = 0, ruleSeq = 0;

  for (const { tenantId, index: tenantIndex } of growthTenants) {
    const branchIds = ctx.branchIds.filter((_, i) => ctx.branchTenant[i] === tenantId);
    if (branchIds.length === 0) continue;
    const userIds = ctx.userIds.filter((_, i) => ctx.userTenant[i] === tenantId);
    const patients = ctx.patientIds
      .map((id, i) => ({ id, tenantId: ctx.patientTenant[i]!, branchId: ctx.patientBranch[i]! }))
      .filter(row => row.tenantId === tenantId);
    if (patients.length === 0) continue;

    // --- GrowthPolicy: the tenant owns its own thresholds ------------------
    await db.growthPolicy.create({
      data: { id: uuid('growth-policy', tenantIndex), tenantId, createdAt: now, updatedAt: now },
    });
    counts.growthPolicies += 1;

    // --- Leads across every stage, with the transition history ------------
    // Sized so each of the seven stages has real members and the pipeline board
    // is a pipeline rather than one column.
    const leadCount = Math.min(140, Math.max(28, Math.round(patients.length * 0.08)));
    const leads: Prisma.LeadCreateManyInput[] = [];
    const activities: Prisma.LeadActivityCreateManyInput[] = [];
    for (let i = 0; i < leadCount; i += 1) {
      const stage = LEAD_STAGES[i % LEAD_STAGES.length]!;
      const leadId = uuid('lead', leadSeq);
      // Lead age drives the score and the "going cold" flag, so it is anchored
      // to the demo clock like the inactivity bands are.
      const ageDays = 1 + (i % 34);
      const createdAt = new Date(demoClock.getTime() - ageDays * DAY);
      const patient = i % 3 === 0 ? patients[i % patients.length]! : null;
      leads.push({
        id: leadId,
        tenantId,
        patientId: patient?.id ?? null,
        name: `Synthetic Lead ${i + 1}`,
        phone: `+1555${String(70 + (i % 10)).padStart(2, '0')}${String(i).padStart(5, '0')}`,
        email: `synthetic.lead.${tenantIndex + 1}.${i + 1}@example.test`,
        channel: LEAD_CHANNELS[i % LEAD_CHANNELS.length]!,
        service: LEAD_SERVICES[i % LEAD_SERVICES.length]!,
        stage,
        source: LEAD_SOURCES[i % LEAD_SOURCES.length]!,
        estimatedValue: new Prisma.Decimal(180 + (i % 17) * 145),
        lostReason: stage === 'lost' ? LOST_REASONS[i % LOST_REASONS.length]! : null,
        createdAt,
        updatedAt: new Date(createdAt.getTime() + Math.min(ageDays, 3) * DAY),
      });
      // Every stage past new-inquiry is reached BY a transition. Without these
      // rows "why are we losing leads?" has no answer on the screen that asks it.
      const path = LEAD_STAGES.slice(0, LEAD_STAGES.indexOf(stage) + 1);
      for (let step = 1; step < path.length; step += 1) {
        activities.push({
          id: uuid('lead-activity', activitySeq),
          tenantId,
          leadId,
          activityType: 'stage_change',
          fromStage: path[step - 1]!,
          toStage: path[step]!,
          reason: path[step] === 'lost' ? LOST_REASONS[i % LOST_REASONS.length]! : null,
          actorUserId: userIds.length ? userIds[(i + step) % userIds.length]! : null,
          occurredAt: new Date(createdAt.getTime() + step * Math.max(1, Math.floor(ageDays / path.length)) * DAY),
        });
        activitySeq += 1;
      }
      leadSeq += 1;
    }
    for (let offset = 0; offset < leads.length; offset += 500) {
      await db.lead.createMany({ data: leads.slice(offset, offset + 500) });
    }
    for (let offset = 0; offset < activities.length; offset += 500) {
      await db.leadActivity.createMany({ data: activities.slice(offset, offset + 500) });
    }
    counts.leads += leads.length;
    counts.leadActivities += activities.length;

    // --- Consent evidence -------------------------------------------------
    // Both directions on purpose. An audience preview where everybody is
    // contactable proves nothing; one that shows genuinely eligible AND
    // genuinely suppressed recipients demonstrates the fence doing its job.
    const consentPatients = patients.slice(0, 400);
    const consents: Prisma.CommunicationConsentCreateManyInput[] = [];
    const consentEvents: Prisma.ConsentEventCreateManyInput[] = [];
    const suppressions: Prisma.CampaignSuppressionCreateManyInput[] = [];
    for (const [i, patient] of consentPatients.entries()) {
      const optedOut = i % 7 === 0;
      const unknown = i % 7 === 1;
      const capturedAt = new Date(demoClock.getTime() - (5 + (i % 90)) * DAY);
      for (const channel of ['sms', 'email'] as const) {
        consents.push({
          id: uuid('consent', consentSeq),
          tenantId,
          patientId: patient.id,
          leadId: null,
          channel,
          status: optedOut ? 'opted_out' : unknown ? 'unknown' : 'opted_in',
          source: optedOut ? 'patient_reply_stop' : 'intake_form',
          capturedAt,
          revokedAt: optedOut ? capturedAt : null,
          metadata: { synthetic: true, capturedVia: optedOut ? 'inbound_stop_keyword' : 'digital_intake' },
          createdAt: capturedAt,
          updatedAt: capturedAt,
        });
        consentSeq += 1;
      }
      if (unknown) continue;
      // The append-only authority trail the live-outreach fence actually reads.
      for (const purpose of ['SMS', 'EMAIL'] as const) {
        consentEvents.push({
          id: uuid('consent-event', eventSeq),
          tenantId,
          patientId: patient.id,
          purpose,
          granted: !optedOut,
          source: optedOut ? 'patient_reply_stop' : 'patient_portal',
          occurredAt: capturedAt,
          metadata: optedOut
            ? { synthetic: true, revocationKeyword: 'STOP' }
            : outreachAuthorityMetadata('inactive_patient_reactivation', `synthetic-intake-${tenantIndex + 1}-${i + 1}`),
        });
        eventSeq += 1;
      }
      // A marketing-wide revocation for a few: suppresses EVERY channel, which
      // is the strongest suppression story on the screen.
      if (i % 29 === 3) {
        consentEvents.push({
          id: uuid('consent-event', eventSeq),
          tenantId, patientId: patient.id, purpose: 'MARKETING', granted: false,
          source: 'front_desk_request',
          occurredAt: new Date(capturedAt.getTime() + DAY),
          metadata: { synthetic: true, note: 'Patient asked to be removed from all marketing.' },
        });
        eventSeq += 1;
      }
      if (i % 23 === 5) {
        suppressions.push({
          id: uuid('suppression', suppressionSeq),
          tenantId, patientId: patient.id, leadId: null, channel: 'sms',
          reason: 'Manual do-not-contact request recorded at the front desk',
          active: true, createdAt: capturedAt, updatedAt: capturedAt,
        });
        suppressionSeq += 1;
      }
    }
    for (let offset = 0; offset < consents.length; offset += 500) {
      await db.communicationConsent.createMany({ data: consents.slice(offset, offset + 500) });
    }
    for (let offset = 0; offset < consentEvents.length; offset += 500) {
      await db.consentEvent.createMany({ data: consentEvents.slice(offset, offset + 500) });
    }
    if (suppressions.length) await db.campaignSuppression.createMany({ data: suppressions });
    counts.communicationConsents += consents.length;
    counts.consentEvents += consentEvents.length;
    counts.campaignSuppressions += suppressions.length;

    // --- Campaigns, deliveries, and the outcome evidence behind them ------
    const campaignSpecs = [
      { name: 'Winter reactivation — 90 day quiet list', goal: 'Bring quiet patients back in', status: 'COMPLETED' as const, campaignType: 'inactive_patient_reactivation', audienceType: 'inactive_patients', channel: 'sms' as const, branchId: null, attributed: true },
      { name: 'No-show recovery — last 30 days', goal: 'Rebook missed appointments', status: 'ACTIVE' as const, campaignType: 'no_show_recovery', audienceType: 'no_show_recovery', channel: 'sms' as const, branchId: null, attributed: true },
      { name: 'Failed payment recovery', goal: 'Recover declined balances', status: 'ACTIVE' as const, campaignType: 'failed_payment_recovery', audienceType: 'failed_payment_recovery', channel: 'email' as const, branchId: null, attributed: false },
      { name: 'Post-visit review request', goal: 'Ask happy patients for a review', status: 'SCHEDULED' as const, campaignType: 'review_request', audienceType: 'review_request', channel: 'email' as const, branchId: null, attributed: false },
      { name: `${'Clinic'} 1 reactivation pilot`, goal: 'Branch-scoped reactivation test', status: 'APPROVAL_REQUIRED' as const, campaignType: 'inactive_patient_reactivation', audienceType: 'inactive_patients', channel: 'sms' as const, branchId: branchIds[0]!, attributed: false },
      { name: 'Unpaid deposit follow-up', goal: 'Chase unpaid deposits', status: 'DRAFT' as const, campaignType: 'unpaid_deposit_followup', audienceType: 'unpaid_deposit_followup', channel: 'sms' as const, branchId: null, attributed: false },
    ];

    const attributionAppointments: Prisma.AppointmentCreateManyInput[] = [];
    const attributionPayments: Prisma.PaymentTransactionCreateManyInput[] = [];
    const deliveries: Prisma.CampaignDeliveryCreateManyInput[] = [];
    // One patient is claimed by at most one campaign, because
    // CampaignAttribution enforces exactly that at the database.
    let attributionCursor = 0;

    for (const [i, spec] of campaignSpecs.entries()) {
      const campaignId = uuid('campaign', campaignSeq);
      const createdAt = new Date(demoClock.getTime() - (40 - i * 3) * DAY);
      const approver = userIds.length ? userIds[i % userIds.length]! : null;
      const dispatched = spec.status === 'COMPLETED' || spec.status === 'ACTIVE';
      const recipients = dispatched ? Math.min(24, Math.max(6, Math.floor(patients.length / 6))) : 0;
      await db.campaign.create({
        data: {
          id: campaignId,
          tenantId,
          name: spec.name,
          goal: spec.goal,
          status: spec.status,
          channels: spec.channel === 'email' ? ['EMAIL'] : ['SMS'],
          audienceSize: dispatched ? recipients : 0,
          sent: recipients,
          // opened/responded/booked/revenue are deliberately absent. They are a
          // trigger-maintained rollup of CampaignAttribution; any value written
          // here that the evidence does not produce is refused with P0001.
          aiGenerated: false,
          startsAt: createdAt,
          endsAt: spec.status === 'COMPLETED' ? new Date(createdAt.getTime() + 21 * DAY) : null,
          branchId: spec.branchId,
          campaignType: spec.campaignType,
          audienceType: spec.audienceType,
          campaignChannel: spec.channel,
          messageSubject: spec.channel === 'email' ? spec.name : null,
          messageTemplate: 'Hi {{first_name}}, it has been a while since your last visit at {{clinic_name}}. Reply BOOK to see open times, or STOP to opt out.',
          draftSource: 'rule_based',
          requiresApproval: true,
          approvedByUserId: spec.status === 'DRAFT' || spec.status === 'APPROVAL_REQUIRED' ? null : approver,
          approvedAt: spec.status === 'DRAFT' || spec.status === 'APPROVAL_REQUIRED' ? null : new Date(createdAt.getTime() + DAY),
          scheduledAt: spec.status === 'SCHEDULED' ? new Date(demoClock.getTime() + 3 * DAY) : null,
          createdByUserId: approver,
          createdAt,
          updatedAt: createdAt,
        },
      });
      campaignSeq += 1;
      counts.campaigns += 1;

      for (let r = 0; r < recipients; r += 1) {
        const patient = patients[(attributionCursor + r) % patients.length]!;
        // Accepted well inside the 30-day attribution window so the outcome
        // below is linkable; `providerAcceptedAt` is provider ACCEPTANCE, which
        // is the only milestone the attribution job treats as evidence.
        const acceptedAt = new Date(createdAt.getTime() + (1 + (r % 3)) * DAY);
        const deliveryId = uuid('delivery', deliverySeq);
        deliveries.push({
          id: deliveryId,
          tenantId,
          campaignId,
          patientId: patient.id,
          leadId: null,
          channel: spec.channel,
          destinationMasked: spec.channel === 'email' ? 'sy***@example.test' : '***0001',
          status: r % 5 === 4 ? 'failed' : 'delivered',
          provider: spec.channel === 'email' ? 'smtp' : 'twilio',
          providerMessageId: `syn-${spec.channel}-${deliverySeq}`,
          failureReason: r % 5 === 4 ? 'provider reported an unreachable destination' : null,
          sentAt: r % 5 === 4 ? null : acceptedAt,
          providerAcceptedAt: r % 5 === 4 ? null : acceptedAt,
          deliveredAt: r % 5 === 4 ? null : new Date(acceptedAt.getTime() + 60_000),
          statusUpdatedAt: acceptedAt,
          createdAt: acceptedAt,
          updatedAt: acceptedAt,
        });
        deliverySeq += 1;

        // Real outcome records for a slice of the accepted deliveries. The
        // attribution job — not this file — decides which of them count.
        if (spec.attributed && r % 5 !== 4 && r % 3 === 0) {
          const appointmentId = uuid('attribution-appointment', apptSeq);
          const bookedAt = new Date(acceptedAt.getTime() + 4 * DAY);
          const startsAt = new Date(acceptedAt.getTime() + 11 * DAY);
          if (bookedAt.getTime() < demoClock.getTime() && startsAt.getTime() < demoClock.getTime()) {
            attributionAppointments.push({
              id: appointmentId,
              tenantId,
              branchId: patient.branchId,
              patientId: patient.id,
              providerRef: `SYN-PROVIDER-${(r % 4) + 1}`,
              service: 'Reactivation visit',
              startsAt,
              endsAt: new Date(startsAt.getTime() + 30 * 60_000),
              status: 'COMPLETED',
              channel: spec.channel === 'email' ? 'EMAIL' : 'SMS',
              value: new Prisma.Decimal(140 + (r % 6) * 35),
              noShowRisk: 10 + (r % 20),
              notes: 'Synthetic scenario data; booked from a campaign message.',
              createdAt: bookedAt,
              updatedAt: startsAt,
            });
            apptSeq += 1;
            attributionPayments.push({
              id: uuid('attribution-payment', paymentSeq),
              tenantId,
              branchId: patient.branchId,
              patientId: patient.id,
              appointmentId,
              amount: new Prisma.Decimal(140 + (r % 6) * 35),
              currency: 'USD',
              status: 'succeeded',
              mode: 'simulator',
              providerReference: `syn_txn_${paymentSeq}`,
              receivedAt: new Date(startsAt.getTime() + 3_600_000),
              createdAt: new Date(startsAt.getTime() + 3_600_000),
              updatedAt: new Date(startsAt.getTime() + 3_600_000),
            });
            paymentSeq += 1;
          }
        }
      }
      attributionCursor += recipients;
    }

    for (let offset = 0; offset < deliveries.length; offset += 500) {
      await db.campaignDelivery.createMany({ data: deliveries.slice(offset, offset + 500) });
    }
    counts.campaignDeliveries += deliveries.length;
    if (attributionAppointments.length) {
      await db.appointment.createMany({ data: attributionAppointments });
      counts.attributionAppointments += attributionAppointments.length;
    }
    if (attributionPayments.length) {
      await db.paymentTransaction.createMany({ data: attributionPayments });
      counts.paymentTransactions += attributionPayments.length;
    }

    // --- Reviews, review requests, reputation cases -----------------------
    const reviewCount = Math.min(160, Math.max(24, Math.round(patients.length * 0.06)));
    const reviews: Prisma.ReviewCreateManyInput[] = [];
    for (let i = 0; i < reviewCount; i += 1) {
      const rating = REVIEW_RATINGS[i % REVIEW_RATINGS.length]!;
      const patient = patients[i % patients.length]!;
      const createdAt = new Date(demoClock.getTime() - (2 + (i % 210)) * DAY);
      reviews.push({
        id: uuid('review', reviewSeq),
        tenantId,
        patientId: patient.id,
        branchId: patient.branchId,
        rating,
        text: REVIEW_TEXT[rating]!,
        platform: REVIEW_PLATFORMS[i % REVIEW_PLATFORMS.length]!,
        sentiment: sentimentFor(rating),
        responded: rating >= 4 ? i % 2 === 0 : i % 3 === 0,
        aiDraftResponse: rating <= 3
          ? 'Thank you for telling us. We would like to understand what happened — please contact the practice manager so we can look into your visit.'
          : null,
        createdAt,
        updatedAt: createdAt,
      });
      reviewSeq += 1;
    }
    for (let offset = 0; offset < reviews.length; offset += 500) {
      await db.review.createMany({ data: reviews.slice(offset, offset + 500) });
    }
    counts.reviews += reviews.length;

    const requestCount = Math.min(80, Math.max(18, Math.round(patients.length * 0.04)));
    const reviewRequests: Prisma.ReviewRequestCreateManyInput[] = [];
    for (let i = 0; i < requestCount; i += 1) {
      const patient = patients[i % patients.length]!;
      const status = ['PENDING', 'SENT', 'DELIVERED', 'RESPONDED'][i % 4]!;
      const createdAt = new Date(demoClock.getTime() - (1 + (i % 60)) * DAY);
      reviewRequests.push({
        id: uuid('review-request', requestSeq),
        tenantId,
        branchId: patient.branchId,
        patientId: patient.id,
        channel: i % 2 === 0 ? 'SMS' : 'EMAIL',
        requestType: 'post_visit',
        status,
        message: 'Thanks for visiting. If you have a moment, a short review helps other patients find us.',
        sentAt: status === 'PENDING' ? null : createdAt,
        respondedAt: status === 'RESPONDED' ? new Date(createdAt.getTime() + 2 * DAY) : null,
        ratingReceived: status === 'RESPONDED' ? 4 + (i % 2) : null,
        createdAt,
        updatedAt: createdAt,
      });
      requestSeq += 1;
    }
    await db.reviewRequest.createMany({ data: reviewRequests });
    counts.reviewRequests += reviewRequests.length;

    const caseCount = Math.min(24, Math.max(6, branchIds.length * 4));
    const cases: Prisma.ReputationCaseCreateManyInput[] = [];
    for (let i = 0; i < caseCount; i += 1) {
      const patient = patients[(i * 5) % patients.length]!;
      const risk = 35 + ((i * 17) % 60);
      const createdAt = new Date(demoClock.getTime() - (1 + (i % 45)) * DAY);
      cases.push({
        id: uuid('reputation-case', caseSeq),
        tenantId,
        branchId: patient.branchId,
        patientId: patient.id,
        badReviewRisk: risk,
        complaintCategory: ['wait_time', 'billing_clarity', 'communication', 'scheduling'][i % 4]!,
        unresolvedComplaint: 'Patient reported waiting past the booked slot without an update.',
        workflowStatus: ['open', 'in_progress', 'resolved'][i % 3]!,
        recoveryWorkflow: 'Practice manager call-back within one business day, then a written summary.',
        suggestedReply: 'We are sorry your visit ran late. We would like to make it right — please call the practice manager directly.',
        npsScore: risk > 70 ? 10 + (i % 20) : 45 + (i % 40),
        publicTrend: risk > 70 ? 'declining' : 'stable',
        staffComplaintDetected: i % 6 === 0,
        createdAt,
        updatedAt: createdAt,
      });
      caseSeq += 1;
    }
    await db.reputationCase.createMany({ data: cases });
    counts.reputationCases += cases.length;

    // --- Competitor radar --------------------------------------------------
    const competitors: Prisma.CompetitorCreateManyInput[] = [];
    const insights: Prisma.CompetitorReviewInsightCreateManyInput[] = [];
    for (const [b, branchId] of branchIds.entries()) {
      for (let i = 0; i < 3; i += 1) {
        const competitorId = uuid('competitor', competitorSeq);
        const rating = [3.9, 4.3, 4.6][i]!;
        const volume = [180, 420, 620][i]!;
        competitors.push({
          id: competitorId,
          tenantId,
          branchId,
          name: `Nearby Practice ${b + 1}${String.fromCharCode(65 + i)}`,
          distanceKm: new Prisma.Decimal(0.8 + i * 1.4),
          googleRating: new Prisma.Decimal(rating),
          reviewVolume: volume,
          complaintThemes: ['long waits', 'billing surprises', 'phone never answered'].slice(0, i + 1),
          activeOffers: i === 0 ? ['$99 new patient exam'] : ['Free consult', 'Weekend hours'],
          localRankTrend: i === 2 ? 'rising' : i === 1 ? 'flat' : 'falling',
          weaknessSummary: 'Reviews repeatedly mention unanswered phones during working hours.',
          opportunityAlert: 'Answer rate is the differentiator this postcode complains about most.',
          marketOpeningRecommendation: 'Lead with same-week availability and a guaranteed call-back window.',
          createdAt: now,
          updatedAt: now,
        });
        competitorSeq += 1;
        for (const [t, theme] of ['long waits', 'billing surprises', 'phone never answered'].entries()) {
          insights.push({
            id: uuid('competitor-insight', insightSeq),
            tenantId,
            competitorId,
            theme,
            complaintCount: 4 + ((i + t) * 7) % 40,
            summary: `Recurring "${theme}" complaints in the last 90 days of public reviews.`,
            createdAt: now,
            updatedAt: now,
          });
          insightSeq += 1;
        }
      }
    }
    await db.competitor.createMany({ data: competitors });
    await db.competitorReviewInsight.createMany({ data: insights });
    counts.competitors += competitors.length;
    counts.competitorInsights += insights.length;

    // --- Autopilot playbooks + a real pending approval queue --------------
    const playbookSpecs = [
      { key: 'reactivate_quiet_patients', name: 'Reactivate quiet patients', description: 'Propose a reactivation campaign when the 90-180 day segment grows.', status: 'LIVE' as const, config: { segmentKey: 'inactive-90-180', minMembers: 5, channel: 'sms' } },
      { key: 'fill_cancelled_slots', name: 'Fill cancelled slots', description: 'Propose a slot-fill message when an appointment is cancelled inside 7 days.', status: 'LIVE' as const, config: { horizonDays: 7, channel: 'sms' } },
      { key: 'recover_no_shows', name: 'Recover no-shows', description: 'Propose a rebooking outreach after a no-show.', status: 'PAUSED' as const, config: { lookbackDays: 30 } },
      { key: 'request_reviews', name: 'Request reviews after a good visit', description: 'Propose a review request after a completed visit with no open complaint.', status: 'DRAFT' as const, config: { delayHours: 24 } },
    ];
    for (const [i, spec] of playbookSpecs.entries()) {
      const playbookId = uuid('playbook', playbookSeq);
      await db.autopilotPlaybook.create({
        data: { id: playbookId, tenantId, key: spec.key, name: spec.name, description: spec.description, status: spec.status, config: spec.config, createdAt: now, updatedAt: now },
      });
      playbookSeq += 1;
      counts.autopilotPlaybooks += 1;
      if (spec.status !== 'LIVE') continue;
      for (let a = 0; a < 2; a += 1) {
        await db.autopilotApproval.create({
          data: {
            id: uuid('approval', approvalSeq),
            tenantId,
            playbookId,
            title: `${spec.name} — proposal ${a + 1}`,
            reason: 'Rule matched on current tenant data; a human decides whether it runs.',
            payload: { synthetic: true, playbookKey: spec.key, proposedChannel: 'sms', requiresHumanReview: true },
            confidence: 62 + ((i + a) * 9) % 30,
            status: 'PENDING',
            createdAt: new Date(demoClock.getTime() - (1 + a) * DAY),
            updatedAt: new Date(demoClock.getTime() - (1 + a) * DAY),
          },
        });
        approvalSeq += 1;
        counts.autopilotApprovals += 1;
      }
    }

    // --- Automation rules, from the shipped catalog keys -------------------
    const ruleSpecs = [
      { templateKey: 'hot_lead_not_booked', name: 'Hot lead not booked in 2h → assign callback', triggerType: 'hot_lead_not_booked', actionType: 'assign_callback_task', config: { hours: 2 }, enabled: true },
      { templateKey: 'patient_inactive_90', name: 'Patient inactive 90 days → reactivation segment', triggerType: 'patient_inactive', actionType: 'add_to_reactivation_segment', config: { days: 90 }, enabled: true },
      { templateKey: 'appointment_cancelled_slotfill', name: 'Appointment cancelled → slot-fill campaign', triggerType: 'appointment_cancelled', actionType: 'trigger_slot_fill_campaign', config: { days: 7 }, enabled: false },
      { templateKey: 'deposit_unpaid_reminder', name: 'Deposit unpaid → payment reminder', triggerType: 'deposit_unpaid', actionType: 'send_payment_reminder', config: {}, enabled: true },
    ];
    for (const spec of ruleSpecs) {
      await db.automationRule.create({
        data: {
          id: uuid('automation-rule', ruleSeq),
          tenantId,
          templateKey: spec.templateKey,
          name: spec.name,
          triggerType: spec.triggerType,
          actionType: spec.actionType,
          config: spec.config,
          enabled: spec.enabled,
          // lastRunAt/lastMatchCount/runCount stay at their defaults: this seed
          // has not run these rules, and claiming it did would be a fabricated
          // display value.
          createdById: userIds.length ? userIds[0]! : null,
          createdAt: now,
          updatedAt: now,
        },
      });
      ruleSeq += 1;
      counts.automationRules += 1;
    }
  }

  // -------------------------------------------------------------------------
  // 4. Run the REAL attribution job so the campaign rollup is evidence-derived.
  // -------------------------------------------------------------------------
  for (const { tenantId } of growthTenants) {
    const summary = await attributeTenantCampaignOutcomes(tenantId, demoClock, db);
    counts.campaignAttributions += Object.values(summary.created).reduce((sum, value) => sum + value, 0);
  }

  // The demo runs on the dev mock provider path. Absence of this row is what
  // keeps live regulated dispatch off, and it is asserted, not assumed.
  counts.liveDispatchActivations = await db.campaignLiveDispatchActivation.count();
  if (counts.liveDispatchActivations !== 0) {
    throw new Error('Synthetic seed must never activate live campaign dispatch');
  }

  void profile;
  return counts;
}
