import { randomUUID } from 'node:crypto';
import { env } from '../config/env';
import { runWithTenantContext } from './tenantContext';
import { isFeatureEnabled } from './entitlements';
import { recordWorkflowEvent } from './intelligence';
import type { Prisma } from '../generated/prisma/client';

// ===========================================================================
// Appointment Checkout — deposit evaluation, linkage, and payment-status
// derivation. Reuses the existing DepositRule / DepositRequirement / Payment*
// models. No card data; no fake payments. DepositRule is RLS-forced, so reads
// go through runWithTenantContext.
// ===========================================================================

export const PAYMENTS_FEATURE = 'payments_deposits';
const HIGH_NO_SHOW_RISK = 50; // noShowRisk is an integer 0–100

export function toAmount(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') { const n = Number(value); return Number.isFinite(n) ? n : 0; }
  if (value && typeof value === 'object' && 'toNumber' in value && typeof (value as { toNumber: () => number }).toNumber === 'function') {
    return (value as { toNumber: () => number }).toNumber();
  }
  return 0;
}

async function writeAudit(tenantId: string, actorUserId: string | null, action: string, resource: string, resourceId: string, metadata: Prisma.InputJsonObject) {
  await runWithTenantContext(tenantId, tx => tx.auditEvent.create({ data: { tenantId, actorUserId: actorUserId ?? undefined, action, resource, resourceId, metadata } })).catch(() => {});
}

// --- Provider configuration status (truthful; never fakes success) ---------
export interface PaymentProviderStatus { provider: string; mode: string; configured: boolean; mock: boolean; setupRequired: boolean }

export function paymentProviderStatus(): PaymentProviderStatus {
  const provider = env.PAYMENT_PROVIDER;
  if (provider === 'mock') {
    return { provider, mode: 'mock', configured: true, mock: true, setupRequired: false };
  }
  if (provider === 'stripe') {
    const configured = Boolean(env.STRIPE_SECRET_KEY);
    const mode = !configured ? 'unconfigured' : env.STRIPE_SECRET_KEY!.startsWith('sk_test_') || env.NODE_ENV !== 'production' ? 'sandbox' : 'live';
    return { provider, mode, configured, mock: false, setupRequired: !configured };
  }
  // square / authorize_net / clover / paypal: not implemented → setup required.
  return { provider, mode: 'unconfigured', configured: false, mock: false, setupRequired: true };
}

// --- Deposit rule matching --------------------------------------------------
type RuleRow = {
  id: string; branchId: string | null; name: string; amountType: string; amountValue: Prisma.Decimal | number;
  depositRequired: boolean; dueTiming: string; cancellationWindowHours: number;
  appliesToNewPatients: boolean; appliesToHighNoShowRisk: boolean; appliesToPremiumServices: boolean;
  appliesToSameDayAppointments: boolean; appliesToExemptPatients: boolean; sortOrder: number;
};

interface ApptCtx { branchId: string; startsAt: Date; value: number; noShowRisk: number; lifecycleStage: string | null }

function ruleApplies(rule: RuleRow, ctx: ApptCtx): boolean {
  const isNew = ctx.lifecycleStage === 'NEW';
  const isSameDay = new Date(ctx.startsAt).toDateString() === new Date().toDateString();
  const isHighRisk = ctx.noShowRisk >= HIGH_NO_SHOW_RISK;
  const anyFlag = rule.appliesToNewPatients || rule.appliesToHighNoShowRisk || rule.appliesToPremiumServices || rule.appliesToSameDayAppointments;
  if (!anyFlag) return true; // general rule applies to all appointments
  if (rule.appliesToNewPatients && isNew) return true;
  if (rule.appliesToSameDayAppointments && isSameDay) return true;
  if (rule.appliesToHighNoShowRisk && isHighRisk) return true;
  // appliesToPremiumServices is not auto-detectable without a service catalog; a
  // premium-only rule is not applied automatically (truthful, no guessing).
  return false;
}

export function computeRequiredAmount(rule: RuleRow, appointmentValue: number): number {
  const amt = toAmount(rule.amountValue);
  if (rule.amountType === 'percentage') return Math.round(appointmentValue * (amt / 100) * 100) / 100;
  if (rule.amountType === 'none') return 0;
  return amt; // fixed / fixed_amount
}

function depositDueAt(rule: RuleRow, startsAt: Date): Date | null {
  if (rule.dueTiming === 'manual') return null;
  if (rule.dueTiming === 'before_visit') {
    const due = new Date(startsAt.getTime() - rule.cancellationWindowHours * 3600 * 1000);
    return due.getTime() > Date.now() ? due : new Date();
  }
  return new Date(); // at_booking
}

export interface DepositEvalResult {
  applied: boolean; created: boolean; requirementId?: string; ruleId?: string;
  requiredAmount?: number; dueAt?: string | null; reason: string;
}

// Determine whether an appointment needs a deposit and create (once) the
// DepositRequirement. Idempotent: never duplicates on reschedule/repeat calls.
export async function evaluateDepositForAppointment(
  tenantId: string,
  appointmentId: string,
  opts: { actorUserId?: string | null } = {},
): Promise<DepositEvalResult> {
  if (!(await isFeatureEnabled(tenantId, PAYMENTS_FEATURE))) {
    return { applied: false, created: false, reason: 'feature_not_enabled' };
  }
  const appointment = await runWithTenantContext(tenantId, tx => tx.appointment.findFirst({
    where: { id: appointmentId, tenantId, deletedAt: null },
    include: { patient: { select: { id: true, lifecycleStage: true } } },
  }));
  if (!appointment) return { applied: false, created: false, reason: 'appointment_not_found' };

  // Idempotency: an active (non-cancelled, non-waived) requirement already exists.
  const existing = await runWithTenantContext(tenantId, tx => tx.depositRequirement.findFirst({
    where: { tenantId, appointmentId, status: { notIn: ['cancelled', 'waived'] } },
    select: { id: true, depositRuleId: true, requiredAmount: true, dueAt: true },
  }));
  if (existing) {
    return { applied: true, created: false, requirementId: existing.id, ruleId: existing.depositRuleId ?? undefined, requiredAmount: toAmount(existing.requiredAmount), dueAt: existing.dueAt?.toISOString() ?? null, reason: 'already_linked' };
  }

  // DepositRule is RLS-forced — read under tenant context.
  const rules = await runWithTenantContext(tenantId, tx => tx.depositRule.findMany({
    where: { tenantId, active: true, OR: [{ branchId: appointment.branchId }, { branchId: null }] },
    orderBy: { sortOrder: 'asc' },
  })) as unknown as RuleRow[];
  // Branch-specific rules take priority over tenant-default (null branch).
  rules.sort((a, b) => (a.branchId === appointment.branchId ? 0 : 1) - (b.branchId === appointment.branchId ? 0 : 1) || a.sortOrder - b.sortOrder);

  const ctx: ApptCtx = { branchId: appointment.branchId, startsAt: appointment.startsAt, value: toAmount(appointment.value), noShowRisk: appointment.noShowRisk, lifecycleStage: appointment.patient?.lifecycleStage ?? null };
  const rule = rules.find(r => ruleApplies(r, ctx));
  if (!rule || !rule.depositRequired || rule.amountType === 'none') {
    return { applied: false, created: false, reason: 'no_matching_rule' };
  }
  const requiredAmount = computeRequiredAmount(rule, ctx.value);
  if (requiredAmount <= 0) return { applied: false, created: false, reason: 'zero_amount' };

  const dueAt = depositDueAt(rule, appointment.startsAt);
  const requirement = await runWithTenantContext(tenantId, tx => tx.depositRequirement.create({
    data: {
      tenantId, branchId: appointment.branchId, patientId: appointment.patientId, appointmentId,
      depositRuleId: rule.id, status: 'required', requiredAmount, collectedAmount: 0,
      reason: rule.name, mode: paymentProviderStatus().mode, dueAt,
    },
  }));
  await writeAudit(tenantId, opts.actorUserId ?? null, 'deposit.required', 'depositRequirement', requirement.id, { appointmentId, ruleId: rule.id, requiredAmount });
  await recordWorkflowEvent(tenantId, { eventType: 'deposit.required', entityType: 'depositRequirement', entityId: requirement.id, sourceModule: 'deposits', payload: { appointmentId, requiredAmount } });
  return { applied: true, created: true, requirementId: requirement.id, ruleId: rule.id, requiredAmount, dueAt: dueAt?.toISOString() ?? null, reason: 'created' };
}

// On cancellation: void an unpaid requirement. Never fakes a refund — a paid
// deposit is left intact and flagged for manual review.
export async function handleAppointmentCancellationDeposit(tenantId: string, appointmentId: string, actorUserId?: string | null): Promise<{ updated: number; needsManualRefund: boolean }> {
  const requirements = await runWithTenantContext(tenantId, tx => tx.depositRequirement.findMany({ where: { tenantId, appointmentId, status: { notIn: ['cancelled', 'waived'] } }, select: { id: true, status: true } }));
  let updated = 0;
  let needsManualRefund = false;
  for (const req of requirements) {
    if (req.status === 'collected') { needsManualRefund = true; continue; }
    await runWithTenantContext(tenantId, tx => tx.depositRequirement.update({ where: { id: req.id }, data: { status: 'cancelled' } }));
    await writeAudit(tenantId, actorUserId ?? null, 'deposit.cancelled', 'depositRequirement', req.id, { appointmentId });
    updated += 1;
  }
  return { updated, needsManualRefund };
}

// --- Appointment payment status derivation ---------------------------------
export type AppointmentPaymentStatus =
  | 'not_required' | 'required_unpaid' | 'link_created' | 'paid' | 'failed' | 'expired' | 'waived' | 'refunded';

interface StatusInputs {
  requirement?: { status: string } | null;
  paymentRequest?: { status: string; paymentUrl: string | null; linkExpiresAt: Date | null } | null;
  hasSucceededTxn?: boolean;
  hasRefundedTxn?: boolean;
}

export function deriveAppointmentPaymentStatus(i: StatusInputs): AppointmentPaymentStatus {
  if (i.hasRefundedTxn) return 'refunded';
  if (i.requirement?.status === 'waived') return 'waived';
  if (i.requirement?.status === 'collected' || i.hasSucceededTxn || i.paymentRequest?.status === 'collected') return 'paid';
  if (!i.requirement) return 'not_required';
  const pr = i.paymentRequest;
  if (pr) {
    if (pr.status === 'failed') return 'failed';
    if (pr.status === 'expired' || (pr.linkExpiresAt && pr.linkExpiresAt.getTime() < Date.now())) return 'expired';
    if (pr.paymentUrl) return 'link_created';
  }
  return 'required_unpaid';
}

// Actions allowed in the current state (drives UI + mobile clients).
export function allowedPaymentActions(status: AppointmentPaymentStatus): string[] {
  switch (status) {
    case 'not_required': return [];
    case 'required_unpaid': return ['generate_link', 'waive'];
    case 'link_created': return ['copy_link', 'resend_link', 'waive'];
    case 'failed': return ['generate_link', 'review_failed', 'waive'];
    case 'expired': return ['generate_link', 'waive'];
    case 'paid': return ['view_receipt'];
    case 'waived': return [];
    case 'refunded': return ['view_receipt'];
    default: return [];
  }
}

export function newPublicToken(): string { return randomUUID(); }

// Batch payment/deposit summary for a page of appointments (avoids N+1).
export interface AppointmentPaymentSummary {
  required: boolean; status: AppointmentPaymentStatus; amount: number; currency: string;
  paymentUrl: string | null; paymentRequestId: string | null; depositRequirementId: string | null;
  followUpNeeded: boolean;
}

export async function getAppointmentPaymentSummaries(tenantId: string, appointmentIds: string[]): Promise<Map<string, AppointmentPaymentSummary>> {
  const map = new Map<string, AppointmentPaymentSummary>();
  if (appointmentIds.length === 0) return map;
  const [requirements, paymentRequests, succeededTxns] = await runWithTenantContext(tenantId, async tx => {
    // A Prisma interactive transaction pins one pg client. Keep these queries
    // sequential: concurrent client.query calls are deprecated in pg and would
    // make transaction behavior adapter-version-dependent.
    const requirements = await tx.depositRequirement.findMany({ where: { tenantId, appointmentId: { in: appointmentIds }, status: { not: 'cancelled' } }, orderBy: { createdAt: 'desc' } });
    const paymentRequests = await tx.paymentRequest.findMany({ where: { tenantId, appointmentId: { in: appointmentIds } }, orderBy: { createdAt: 'desc' } });
    const succeededTxns = await tx.paymentTransaction.findMany({ where: { tenantId, appointmentId: { in: appointmentIds }, status: 'succeeded' }, select: { appointmentId: true } });
    return [requirements, paymentRequests, succeededTxns] as const;
  });
  const reqByAppt = new Map<string, (typeof requirements)[number]>();
  for (const r of requirements) if (r.appointmentId && !reqByAppt.has(r.appointmentId)) reqByAppt.set(r.appointmentId, r);
  const prByAppt = new Map<string, (typeof paymentRequests)[number]>();
  for (const p of paymentRequests) if (p.appointmentId && !prByAppt.has(p.appointmentId)) prByAppt.set(p.appointmentId, p);
  const paidAppts = new Set(succeededTxns.map(t => t.appointmentId).filter((x): x is string => Boolean(x)));

  for (const appointmentId of appointmentIds) {
    const requirement = reqByAppt.get(appointmentId) ?? null;
    const paymentRequest = prByAppt.get(appointmentId) ?? null;
    const status = deriveAppointmentPaymentStatus({
      requirement: requirement ? { status: requirement.status } : null,
      paymentRequest: paymentRequest ? { status: paymentRequest.status, paymentUrl: paymentRequest.paymentUrl, linkExpiresAt: paymentRequest.linkExpiresAt } : null,
      hasSucceededTxn: paidAppts.has(appointmentId),
    });
    map.set(appointmentId, {
      required: Boolean(requirement) && status !== 'not_required',
      status,
      amount: requirement ? toAmount(requirement.requiredAmount) : paymentRequest ? toAmount(paymentRequest.amount) : 0,
      currency: paymentRequest?.currency ?? 'USD',
      paymentUrl: paymentRequest?.paymentUrl ?? null,
      paymentRequestId: paymentRequest?.id ?? null,
      depositRequirementId: requirement?.id ?? null,
      followUpNeeded: status === 'failed' || status === 'expired',
    });
  }
  return map;
}
