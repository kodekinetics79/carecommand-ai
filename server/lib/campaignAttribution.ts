import type { Prisma } from '../generated/prisma/client';
import { db } from './db';
import { forEachActiveJobTenant } from './jobTenantResolver';

// ===========================================================================
// Closed-loop campaign attribution.
//
// THE DEFECT THIS EXISTS TO FIX
// -----------------------------
// Campaign.opened / .responded / .booked / .revenue have been in the schema
// since 20260602003000 and no application code path has ever written one of
// them. The only mutation anywhere was `sent`, in campaignDispatch.ts. They were
// still rendered as "Attributed Revenue", "Recorded Bookings", "Open Rate" and
// "Booking / accepted", so a clinic could run a campaign end to end and be shown
// $0 — and nothing stopped a future caller from typing any number into them.
// There was no join anywhere from CampaignDelivery to Appointment or to money.
//
// WHY THE ARITHMETIC IS THE PRODUCT
// ---------------------------------
// Having a revenue number is not the differentiator; being able to defend one
// is. The two vendors who ship this publish arithmetic that does not survive a
// practice manager asking "which message earned that dollar?":
//   * Tebra multiplies volume by hardcoded constants — $3 per reminder sent,
//     $150 per recall-resulting appointment — so 5,000 reminders display
//     $15,000 of "ROI" against zero production.
//   * RevenueWell credits itself with ALL revenue from any appointment inside 60
//     days of an UNMATCHED new-patient request, plus flat $5/$10 imputed values.
// Both are volume dressed as money. Every number this module produces traces to
// the CampaignAttribution rows that produced it, and every row names the exact
// delivery, the exact outcome record, the timestamps, and the window that was in
// force when the link was made.
//
// THE RULES, IN PLAIN LANGUAGE
// ----------------------------
//  1. A delivery is attributable only if the provider actually ACCEPTED it —
//     status accepted/delivered AND a real acceptance timestamp
//     (providerAcceptedAt, else deliveredAt). `sentAt` is explicitly not used:
//     the schema keeps it only for backward compatibility. A suppressed,
//     skipped, failed, queued, setup_required or delivery_unknown recipient
//     never received the message, so nothing they do is ever attributed.
//  2. An appointment is linked to a delivery only if it was BOOKED
//     (Appointment.createdAt — the moment the booking act happened, not the
//     moment of the visit) strictly AFTER that delivery was accepted and no
//     later than acceptance + the configured window.
//  3. TIE-BREAK — LAST ACCEPTED DELIVERY BEFORE THE OUTCOME. When several
//     deliveries to the same patient are eligible for one booking, the ONE whose
//     acceptance is closest in time to the booking wins; an exact timestamp tie
//     is broken by the lexicographically smallest delivery id so a re-run is
//     deterministic. The unique index (tenantId, outcomeType, appointmentId)
//     makes double-claiming impossible at the database, not just in this file,
//     so two campaigns can never both book the same booking.
//  4. Branch authority is respected: a branch-scoped campaign can only ever
//     attribute an outcome that happened in its own branch.
//  5. `booked` and `attended` carry attributedValue 0. A booking is not revenue
//     and an attendance is not revenue. Money is attributed ONLY as `paid`, and
//     only as the net of PaymentTransactions actually recorded against the
//     attributed appointment (succeeded minus refunded). No constant is ever
//     imputed, anywhere.
//  6. `engaged` is in the vocabulary and is DELIBERATELY NEVER WRITTEN. This
//     platform has no truthful engagement receipt: normalizeProviderDeliveryStatus
//     in campaignIntegrity.ts refuses a provider "opened" event on purpose. An
//     open rate we cannot evidence is not reported as a small number; it is
//     reported as unavailable, with the reason.
//
// IDEMPOTENCE. Every insert goes through createMany({ skipDuplicates: true })
// against two unique indexes, so re-running the job inserts what is missing and
// changes nothing else. A claim already recorded is never re-assigned, even if a
// closer delivery is discovered later — attribution is evidence, not a view.
// ===========================================================================

/** The outcome vocabulary. Owned here; the column is deliberately not a CHECK. */
export const CAMPAIGN_ATTRIBUTION_OUTCOMES = ['engaged', 'booked', 'attended', 'paid'] as const;
export type CampaignAttributionOutcome = typeof CAMPAIGN_ATTRIBUTION_OUTCOMES[number];

/**
 * Outcomes this job is able to evidence today. `engaged` is absent on purpose —
 * see rule 6 above. Keeping it out of THIS list, rather than out of the
 * vocabulary, is what makes the omission a stated decision instead of a gap.
 */
export const EVIDENCEABLE_OUTCOMES: readonly CampaignAttributionOutcome[] = ['booked', 'attended', 'paid'];

/**
 * Mirrors GrowthPolicy.campaignAttributionWindowDays' @default and is used ONLY
 * for a tenant with no stored GrowthPolicy row — the same resolution contract
 * getEffectiveGrowthPolicy() uses (absence resolves to the code default; the
 * first write materialises the row and the table becomes the truth).
 * campaignAttribution.policy.unit.test.ts pins this to the schema default so the
 * two cannot drift.
 */
export const CAMPAIGN_ATTRIBUTION_WINDOW_DAYS_DEFAULT = 30;

/** Provider states that mean the message really was handed over and accepted. */
export const ATTRIBUTABLE_DELIVERY_STATUSES = ['accepted', 'delivered'] as const;

/** Appointment states that are a booking. WAITLIST is not a booked appointment. */
export const NON_BOOKING_APPOINTMENT_STATUSES = ['WAITLIST'] as const;
/** Appointment states that evidence the patient actually turned up. */
export const ATTENDED_APPOINTMENT_STATUSES = ['ARRIVED', 'COMPLETED'] as const;

export const SUCCEEDED_PAYMENT_STATUS = 'succeeded';
export const REFUNDED_PAYMENT_STATUS = 'refunded';

/** Named rules, so a figure on a screen can be argued back to one sentence. */
export const CAMPAIGN_ATTRIBUTION_RULES = {
  booked: 'last-accepted-delivery-before-booking@v1',
  attended: 'attendance-on-attributed-appointment@v1',
  paid: 'net-payment-on-attributed-appointment@v1',
} as const;

const DAY_MS = 86_400_000;

type AttributionClient = Pick<typeof db,
  'growthPolicy' | 'campaignDelivery' | 'appointment' | 'paymentTransaction' | 'campaignAttribution' | 'auditEvent'>;

/**
 * The configured window, from the tenant's GrowthPolicy. There is deliberately
 * no literal window in the matching code below.
 */
export async function resolveAttributionWindowDays(tenantId: string, client: AttributionClient = db): Promise<number> {
  const policy = await client.growthPolicy.findUnique({
    where: { tenantId },
    select: { campaignAttributionWindowDays: true },
  });
  return policy?.campaignAttributionWindowDays ?? CAMPAIGN_ATTRIBUTION_WINDOW_DAYS_DEFAULT;
}

export interface CampaignAttributionTenantSummary {
  tenantId: string;
  windowDays: number;
  attributableDeliveries: number;
  candidateAppointments: number;
  /** Appointments that could not be tied to any accepted delivery in window. */
  unattributedAppointments: number;
  created: Record<CampaignAttributionOutcome, number>;
}

export interface CampaignAttributionRunSummary {
  tenants: number;
  created: number;
  tenantSummaries: CampaignAttributionTenantSummary[];
}

type DeliveryCandidate = {
  id: string;
  campaignId: string;
  campaignBranchId: string | null;
  patientId: string;
  leadId: string | null;
  channel: string;
  acceptedAt: Date;
};

type AppointmentCandidate = {
  id: string;
  patientId: string;
  branchId: string;
  status: string;
  createdAt: Date;
  startsAt: Date;
};

/**
 * The tie-break, isolated so it can be tested on its own: the eligible delivery
 * whose provider acceptance is CLOSEST BEFORE the outcome wins; an exact tie
 * goes to the lexicographically smallest delivery id, which makes a re-run
 * deterministic rather than dependent on row order.
 */
export function selectAttributingDelivery(candidates: readonly DeliveryCandidate[]): DeliveryCandidate | null {
  let winner: DeliveryCandidate | null = null;
  for (const candidate of candidates) {
    if (!winner) { winner = candidate; continue; }
    if (candidate.acceptedAt.getTime() > winner.acceptedAt.getTime()) { winner = candidate; continue; }
    if (candidate.acceptedAt.getTime() === winner.acceptedAt.getTime() && candidate.id < winner.id) winner = candidate;
  }
  return winner;
}

/** Is this booking linkable to this delivery under this window? */
export function bookingIsInWindow(acceptedAt: Date, bookedAt: Date, windowDays: number): boolean {
  const accepted = acceptedAt.getTime();
  const booked = bookedAt.getTime();
  return booked > accepted && booked <= accepted + windowDays * DAY_MS;
}

function decimalToNumber(value: Prisma.Decimal | number): number {
  return typeof value === 'number' ? value : value.toNumber();
}

/**
 * Attribute one tenant's outcomes. Safe to re-run: nothing is updated and
 * nothing is deleted, and both unique indexes turn a repeat into a no-op.
 *
 * Must be called inside a tenant context (the worker wrapper below does this);
 * every read and write is tenant-scoped in SQL as well, so a missing context
 * fails closed at RLS rather than reading another tenant.
 */
export async function attributeTenantCampaignOutcomes(
  tenantId: string,
  now: Date = new Date(),
  client: AttributionClient = db,
): Promise<CampaignAttributionTenantSummary> {
  const windowDays = await resolveAttributionWindowDays(tenantId, client);
  const created: Record<CampaignAttributionOutcome, number> = { engaged: 0, booked: 0, attended: 0, paid: 0 };
  const empty: CampaignAttributionTenantSummary = {
    tenantId, windowDays, attributableDeliveries: 0, candidateAppointments: 0, unattributedAppointments: 0, created,
  };

  const deliveryRows = await client.campaignDelivery.findMany({
    where: {
      tenantId,
      status: { in: [...ATTRIBUTABLE_DELIVERY_STATUSES] },
      patientId: { not: null },
      // A delivery with no truthful acceptance milestone is not evidence that
      // anything reached anyone, whatever its status column says.
      OR: [{ providerAcceptedAt: { not: null } }, { deliveredAt: { not: null } }],
    },
    select: {
      id: true, campaignId: true, patientId: true, leadId: true, channel: true,
      providerAcceptedAt: true, deliveredAt: true,
      campaign: { select: { branchId: true } },
    },
  });

  const deliveries: DeliveryCandidate[] = [];
  for (const row of deliveryRows) {
    const acceptedAt = row.providerAcceptedAt ?? row.deliveredAt;
    if (!acceptedAt || !row.patientId) continue;
    deliveries.push({
      id: row.id,
      campaignId: row.campaignId,
      campaignBranchId: row.campaign.branchId,
      patientId: row.patientId,
      leadId: row.leadId,
      channel: row.channel,
      acceptedAt,
    });
  }
  if (deliveries.length === 0) return empty;

  const byPatient = new Map<string, DeliveryCandidate[]>();
  let earliestAccepted = deliveries[0]!.acceptedAt;
  let latestAccepted = deliveries[0]!.acceptedAt;
  for (const delivery of deliveries) {
    const bucket = byPatient.get(delivery.patientId);
    if (bucket) bucket.push(delivery); else byPatient.set(delivery.patientId, [delivery]);
    if (delivery.acceptedAt < earliestAccepted) earliestAccepted = delivery.acceptedAt;
    if (delivery.acceptedAt > latestAccepted) latestAccepted = delivery.acceptedAt;
  }

  // Only bookings that could possibly fall in SOME delivery's window are loaded.
  const horizon = new Date(Math.min(latestAccepted.getTime() + windowDays * DAY_MS, now.getTime()));
  const appointments: AppointmentCandidate[] = await client.appointment.findMany({
    where: {
      tenantId,
      patientId: { in: [...byPatient.keys()] },
      deletedAt: null,
      status: { notIn: [...NON_BOOKING_APPOINTMENT_STATUSES] as never },
      createdAt: { gt: earliestAccepted, lte: horizon },
    },
    select: { id: true, patientId: true, branchId: true, status: true, createdAt: true, startsAt: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  if (appointments.length === 0) {
    return { ...empty, attributableDeliveries: deliveries.length };
  }

  // Money is read once, for the whole candidate set, and only ever as recorded
  // transactions. Nothing here invents an amount.
  const payments = await client.paymentTransaction.findMany({
    where: {
      tenantId,
      appointmentId: { in: appointments.map(appointment => appointment.id) },
      status: { in: [SUCCEEDED_PAYMENT_STATUS, REFUNDED_PAYMENT_STATUS] },
    },
    select: { id: true, appointmentId: true, amount: true, currency: true, status: true, receivedAt: true, createdAt: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const paymentsByAppointment = new Map<string, typeof payments>();
  for (const payment of payments) {
    if (!payment.appointmentId) continue;
    const bucket = paymentsByAppointment.get(payment.appointmentId);
    if (bucket) bucket.push(payment); else paymentsByAppointment.set(payment.appointmentId, [payment]);
  }

  const rows: Prisma.CampaignAttributionCreateManyInput[] = [];
  let unattributed = 0;

  for (const appointment of appointments) {
    const eligible = (byPatient.get(appointment.patientId) ?? []).filter(delivery =>
      bookingIsInWindow(delivery.acceptedAt, appointment.createdAt, windowDays)
      // Branch authority. A tenant-wide campaign may attribute any branch's
      // outcome; a branch-scoped campaign may only attribute its own branch's.
      && (delivery.campaignBranchId === null || delivery.campaignBranchId === appointment.branchId),
    );
    const winner = selectAttributingDelivery(eligible);
    if (!winner) {
      // Deliberate: a booking we cannot tie to an accepted delivery inside the
      // window is NOT ours. Under-claiming is the correct failure direction.
      unattributed++;
      continue;
    }

    const windowStartsAt = winner.acceptedAt;
    const windowEndsAt = new Date(winner.acceptedAt.getTime() + windowDays * DAY_MS);
    const base = {
      tenantId,
      branchId: appointment.branchId,
      campaignId: winner.campaignId,
      campaignDeliveryId: winner.id,
      patientId: winner.patientId,
      leadId: winner.leadId,
      appointmentId: appointment.id,
      windowDays,
      windowStartsAt,
      windowEndsAt,
    };
    const sharedEvidence = {
      deliveryAcceptedAt: winner.acceptedAt.toISOString(),
      deliveryChannel: winner.channel,
      appointmentBookedAt: appointment.createdAt.toISOString(),
      appointmentStartsAt: appointment.startsAt.toISOString(),
      appointmentStatusAtAttribution: appointment.status,
      windowDays,
      windowStartsAt: windowStartsAt.toISOString(),
      windowEndsAt: windowEndsAt.toISOString(),
      tieBreak: eligible.length > 1
        ? { rule: 'last_accepted_delivery_before_outcome', consideredDeliveryIds: eligible.map(d => d.id).sort(), chosenDeliveryId: winner.id }
        : { rule: 'sole_eligible_delivery', consideredDeliveryIds: [winner.id], chosenDeliveryId: winner.id },
      attributionRunAt: now.toISOString(),
    };

    rows.push({
      ...base,
      outcomeType: 'booked',
      attributedValue: 0,
      rule: CAMPAIGN_ATTRIBUTION_RULES.booked,
      evidence: {
        ...sharedEvidence,
        rule: CAMPAIGN_ATTRIBUTION_RULES.booked,
        outcomeTimestamp: appointment.createdAt.toISOString(),
        valueBasis: 'none — a booking is an outcome, not revenue',
      },
    });

    if ((ATTENDED_APPOINTMENT_STATUSES as readonly string[]).includes(appointment.status)) {
      rows.push({
        ...base,
        outcomeType: 'attended',
        attributedValue: 0,
        rule: CAMPAIGN_ATTRIBUTION_RULES.attended,
        evidence: {
          ...sharedEvidence,
          rule: CAMPAIGN_ATTRIBUTION_RULES.attended,
          outcomeTimestamp: appointment.startsAt.toISOString(),
          valueBasis: 'none — an attendance is an outcome, not revenue',
        },
      });
    }

    const appointmentPayments = paymentsByAppointment.get(appointment.id) ?? [];
    const succeeded = appointmentPayments.filter(payment => payment.status === SUCCEEDED_PAYMENT_STATUS);
    const refunded = appointmentPayments.filter(payment => payment.status === REFUNDED_PAYMENT_STATUS);
    if (succeeded.length > 0) {
      const currencies = new Set(appointmentPayments.map(payment => payment.currency));
      if (currencies.size === 1) {
        const gross = succeeded.reduce((sum, payment) => sum + decimalToNumber(payment.amount), 0);
        const refundedTotal = refunded.reduce((sum, payment) => sum + decimalToNumber(payment.amount), 0);
        const net = Number((gross - refundedTotal).toFixed(2));
        if (net > 0) {
          const lastSucceeded = succeeded[succeeded.length - 1]!;
          rows.push({
            ...base,
            outcomeType: 'paid',
            // The link that needed a window was the booking. The money is then
            // traced THROUGH that attributed appointment rather than through a
            // second window guess, so the row carries the same window it was
            // justified by.
            paymentTransactionId: succeeded.length === 1 && refunded.length === 0 ? succeeded[0]!.id : null,
            attributedValue: net,
            currency: [...currencies][0]!,
            rule: CAMPAIGN_ATTRIBUTION_RULES.paid,
            evidence: {
              ...sharedEvidence,
              rule: CAMPAIGN_ATTRIBUTION_RULES.paid,
              outcomeTimestamp: (lastSucceeded.receivedAt ?? lastSucceeded.createdAt).toISOString(),
              valueBasis: 'net of recorded PaymentTransactions on the attributed appointment (succeeded minus refunded)',
              succeededPaymentTransactionIds: succeeded.map(payment => payment.id),
              refundedPaymentTransactionIds: refunded.map(payment => payment.id),
              grossAttributed: gross.toFixed(2),
              refundedTotal: refundedTotal.toFixed(2),
              netAttributed: net.toFixed(2),
            },
          });
        }
      }
    }
  }

  if (rows.length === 0) {
    return { ...empty, attributableDeliveries: deliveries.length, candidateAppointments: appointments.length, unattributedAppointments: unattributed };
  }

  // Both unique indexes are load-bearing here: (tenantId, campaignDeliveryId,
  // outcomeType) makes a re-run a no-op, and (tenantId, outcomeType,
  // appointmentId) makes a second campaign's claim on the same appointment
  // impossible rather than merely unlikely.
  const before = await client.campaignAttribution.groupBy({
    by: ['outcomeType'], where: { tenantId }, _count: { _all: true },
  });
  await client.campaignAttribution.createMany({ data: rows, skipDuplicates: true });
  const after = await client.campaignAttribution.groupBy({
    by: ['outcomeType'], where: { tenantId }, _count: { _all: true },
  });
  const priorCounts = new Map(before.map(row => [row.outcomeType, row._count._all]));
  for (const row of after) {
    const delta = row._count._all - (priorCounts.get(row.outcomeType) ?? 0);
    if (delta > 0 && (CAMPAIGN_ATTRIBUTION_OUTCOMES as readonly string[]).includes(row.outcomeType)) {
      created[row.outcomeType as CampaignAttributionOutcome] += delta;
    }
  }

  const totalCreated = Object.values(created).reduce((sum, count) => sum + count, 0);
  if (totalCreated > 0) {
    // PHI-free: ids and counts only, never a destination or a name.
    await client.auditEvent.create({
      data: {
        tenantId,
        action: 'campaign.attribution.recorded',
        resource: 'campaignAttribution',
        userAgent: 'campaign-attribution',
        metadata: { windowDays, created, unattributedAppointments: unattributed, attributableDeliveries: deliveries.length },
      },
    });
  }

  return {
    tenantId,
    windowDays,
    attributableDeliveries: deliveries.length,
    candidateAppointments: appointments.length,
    unattributedAppointments: unattributed,
    created,
  };
}

/**
 * Worker entry point. Mirrors runScheduledCampaigns: iterate active tenants,
 * each inside its own tenant context, and never let one tenant's failure stop
 * the rest.
 */
export async function runCampaignAttribution(now: Date = new Date(), only?: string): Promise<CampaignAttributionRunSummary> {
  const tenantSummaries: CampaignAttributionTenantSummary[] = [];
  await forEachActiveJobTenant(only, 'worker:campaign-attribution', async tenantId => {
    tenantSummaries.push(await attributeTenantCampaignOutcomes(tenantId, now));
  });
  return {
    tenants: tenantSummaries.length,
    created: tenantSummaries.reduce((sum, summary) => sum + Object.values(summary.created).reduce((a, b) => a + b, 0), 0),
    tenantSummaries,
  };
}

// ---------------------------------------------------------------------------
// Read model. Derived from CampaignAttribution rows, never from the rollup
// columns — those exist only so the legacy screens that already read them stop
// lying, and they are themselves derived from these same rows.
// ---------------------------------------------------------------------------

export interface CampaignAttributionOutcomeSummary {
  campaignId: string;
  outcomes: Record<CampaignAttributionOutcome, number>;
  attributedValue: string;
  currency: string | null;
  windowDaysObserved: number[];
  firstAttributedAt: string | null;
  lastAttributedAt: string | null;
}

export interface CampaignAttributionEngagementDisclosure {
  openRate: null;
  responseRate: null;
  unavailableReason: string;
}

/**
 * What we say about engagement, always. An open rate this platform cannot
 * evidence is reported as unavailable with its reason — never as 0% dressed up
 * as a measurement, and never as a provider "opened" event we have decided not
 * to trust.
 */
export const CAMPAIGN_ENGAGEMENT_DISCLOSURE: CampaignAttributionEngagementDisclosure = Object.freeze({
  openRate: null,
  responseRate: null,
  unavailableReason: 'no_truthful_open_or_reply_receipt',
});

export async function summarizeCampaignAttribution(
  tenantId: string,
  campaignIds: readonly string[],
  client: Pick<typeof db, 'campaignAttribution'> = db,
): Promise<Map<string, CampaignAttributionOutcomeSummary>> {
  const summaries = new Map<string, CampaignAttributionOutcomeSummary>();
  if (campaignIds.length === 0) return summaries;
  const rows = await client.campaignAttribution.findMany({
    where: { tenantId, campaignId: { in: [...campaignIds] } },
    select: { campaignId: true, outcomeType: true, attributedValue: true, currency: true, windowDays: true, attributedAt: true },
  });
  for (const campaignId of campaignIds) {
    summaries.set(campaignId, {
      campaignId,
      outcomes: { engaged: 0, booked: 0, attended: 0, paid: 0 },
      attributedValue: '0.00',
      currency: null,
      windowDaysObserved: [],
      firstAttributedAt: null,
      lastAttributedAt: null,
    });
  }
  const values = new Map<string, number>();
  const windows = new Map<string, Set<number>>();
  for (const row of rows) {
    const summary = summaries.get(row.campaignId);
    if (!summary) continue;
    if ((CAMPAIGN_ATTRIBUTION_OUTCOMES as readonly string[]).includes(row.outcomeType)) {
      summary.outcomes[row.outcomeType as CampaignAttributionOutcome] += 1;
    }
    if (row.outcomeType === 'paid') {
      values.set(row.campaignId, (values.get(row.campaignId) ?? 0) + decimalToNumber(row.attributedValue));
      summary.currency = summary.currency ?? row.currency;
    }
    const observed = windows.get(row.campaignId) ?? new Set<number>();
    observed.add(row.windowDays);
    windows.set(row.campaignId, observed);
    const at = row.attributedAt.toISOString();
    if (!summary.firstAttributedAt || at < summary.firstAttributedAt) summary.firstAttributedAt = at;
    if (!summary.lastAttributedAt || at > summary.lastAttributedAt) summary.lastAttributedAt = at;
  }
  for (const [campaignId, summary] of summaries) {
    summary.attributedValue = (values.get(campaignId) ?? 0).toFixed(2);
    summary.windowDaysObserved = [...(windows.get(campaignId) ?? [])].sort((a, b) => a - b);
  }
  return summaries;
}
