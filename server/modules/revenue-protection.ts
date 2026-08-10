import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { env } from '../config/env';
import { db } from '../lib/db';
import { audit } from '../lib/audit';
import { assertBranchAccess } from '../lib/scope';
import { requirePermission } from '../lib/permissions';
import { requireFeature } from '../lib/entitlements';
import { enterTenantContext, runWithTenantContext } from '../lib/tenantContext';
import { resolveIngressTenant } from '../lib/tenantIngressResolvers';
import { recordWorkflowEvent, emitBusinessEvent } from '../lib/intelligence';
import { eligibilityProviderStatus, runDenialPreventionForAppointment } from '../lib/insuranceIntelligence';
import { paymentProviderStatus } from '../lib/deposits';
import type { Prisma } from '../generated/prisma/client';
import {
  EligibilityExecutionConflictError,
  eligibilityIdempotencyKey,
  runEligibilityExecution,
} from '../lib/eligibilityExecution';

// --- Idempotency -----------------------------------------------------------
// Claims a unique (scope,key). Returns claimed=false on redelivery, exposing
// the original resultId so callers can return the first result instead of
// creating a duplicate record.
export async function claimIdempotency(scope: string, key: string, tenantId?: string): Promise<{ claimed: boolean; resultId: string | null }> {
  try {
    await db.idempotencyKey.create({ data: { scope, key, tenantId } });
    return { claimed: true, resultId: null };
  } catch (error) {
    if ((error as { code?: string }).code === 'P2002') {
      const existing = await db.idempotencyKey.findUnique({ where: { scope_key: { scope, key } } });
      return { claimed: false, resultId: existing?.resultId ?? null };
    }
    throw error;
  }
}

async function recordIdempotencyResult(scope: string, key: string, resultId: string) {
  await db.idempotencyKey.updateMany({ where: { scope, key }, data: { resultId } });
}

async function lockStripeReconciliation(
  tx: Prisma.TransactionClient,
  eventId: string,
  paymentRequestId: string,
): Promise<{ eventComplete: boolean; paymentStatus: string | null }> {
  // Event serialization prevents simultaneous delivery of the same Stripe event
  // from treating an in-progress claim as a crashed attempt. Request serialization
  // also collapses related Stripe event types (for example Checkout Session and
  // PaymentIntent success events) onto one payment state-machine transition.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'stripe.webhook:' + eventId}, 0))`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'payment.request:' + paymentRequestId}, 0))`;
  const claim = await tx.idempotencyKey.findUnique({
    where: { scope_key: { scope: 'stripe.webhook', key: eventId } },
    select: { resultId: true },
  });
  const payment = await tx.paymentRequest.findUnique({ where: { id: paymentRequestId }, select: { status: true } });
  return { eventComplete: Boolean(claim?.resultId), paymentStatus: payment?.status ?? null };
}

// --- Stripe signature verification (no SDK; manual HMAC per Stripe spec) ----
const STRIPE_SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

function verifyStripeSignature(rawBody: Buffer | undefined, signatureHeader: string | undefined, secret: string): boolean {
  if (!rawBody || !signatureHeader) return false;
  const parts = signatureHeader.split(',').reduce<Record<string, string>>((acc, part) => {
    const [name, value] = part.split('=');
    if (name && value) acc[name.trim()] = value.trim();
    return acc;
  }, {});
  const timestamp = parts.t;
  const signature = parts.v1;
  if (!timestamp || !signature) return false;
  // Reject replays outside the tolerance window.
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > STRIPE_SIGNATURE_TOLERANCE_SECONDS) return false;
  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody.toString('utf8')}`).digest('hex');
  const expectedBuffer = Buffer.from(expected);
  const signatureBuffer = Buffer.from(signature);
  if (expectedBuffer.length !== signatureBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, signatureBuffer);
}

export type ProviderMode = 'mock' | 'sandbox' | 'live';
export class ProviderOperationError extends Error {
  constructor(public readonly provider: string, operation: string) {
    super(`${provider} ${operation} is unavailable`);
    this.name = 'ProviderOperationError';
  }
}
type EligibilityPayload = {
  [key: string]: unknown;
  benefitsInformation?: Record<string, unknown> | Record<string, unknown>[];
  coverageStatus?: unknown;
  eligibilityStatus?: unknown;
  status?: unknown;
  authorizationRequired?: unknown;
  warnings?: unknown[];
  id?: unknown;
};
type StripePayload = {
  [key: string]: unknown;
  id?: unknown;
  url?: unknown;
  active?: unknown;
  payment_status?: unknown;
  amount_total?: unknown;
  amount_subtotal?: unknown;
  currency?: unknown;
  error?: unknown;
};

const uuid = z.string().uuid();
const listLimit = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  branchId: uuid.optional(),
  patientId: uuid.optional(),
  appointmentId: uuid.optional(),
});

const billingRead = requirePermission('billing:read');
const billingWrite = requirePermission('billing:write');
// Segregation of duties: marking money as COLLECTED (which mints a succeeded
// transaction / settles a deposit with no real money movement) is a controller
// action. FRONT_DESK may edit non-financial status but must NOT self-attest a
// collection — mirrors the deposit-waiver gate, which also excludes FRONT_DESK.
const COLLECT_PRIVILEGED_ROLES = ['OWNER', 'ADMIN', 'MANAGER', 'BILLING'] as const;
// Constrained, auditable status vocabularies (no unvalidated free-string status).
const PAYMENT_REQUEST_STATUSES = ['pending', 'link_sent', 'collected', 'failed', 'expired', 'cancelled', 'refunded'] as const;
const DEPOSIT_REQUIREMENT_STATUSES = ['required', 'requested', 'link_sent', 'collected', 'waived', 'cancelled', 'failed', 'expired', 'refunded'] as const;
// Payments & deposits routes additionally require the payments_deposits entitlement.
const paymentsFeature = requireFeature('payments_deposits');
// Insurance/eligibility routes require the insurance_eligibility entitlement.
const insuranceFeature = requireFeature('insurance_eligibility');

type RevenueContext = {
  tenantId: string;
  branchId?: string;
};

type EligibilityCheckContext = RevenueContext & {
  providerExecutionKey?: string;
  serviceType?: string;
  patient?: {
    id: string;
    firstName: string;
    lastName: string;
    branchId: string;
    lifecycleStage: string;
    churnRisk: number;
    outstandingBalance: number;
    lifetimeValue: number;
    email?: string | null;
    phone?: string | null;
  };
  appointment?: {
    id: string;
    branchId: string;
    service: string;
    startsAt: Date;
    value: number;
    noShowRisk: number;
    providerRef?: string | null;
  };
  payer?: {
    id: string;
    name: string;
    tradingPartnerServiceId?: string | null;
    sourceProvider: string;
  };
  policy?: {
    id: string;
    planName: string;
    memberId: string;
    groupNumber?: string | null;
    subscriberName?: string | null;
  };
};

export type PaymentRequestContext = RevenueContext & {
  amount: number;
  reason: string;
  patient?: {
    id: string;
    firstName: string;
    lastName: string;
    branchId: string;
    outstandingBalance: number;
    lifecycleStage: string;
    churnRisk: number;
  };
  appointment?: {
    id: string;
    branchId: string;
    service: string;
    startsAt: Date;
    value: number;
    noShowRisk: number;
  };
  eligibility?: {
    id: string;
    coverageStatus: string;
    planName: string;
    payerName: string;
    copay: number;
    deductibleRemaining: number;
    coinsurance: number;
    coverageActive: boolean;
    eligibilityMessage: string;
    payerReference?: string | null;
  };
  depositRule?: {
    id: string;
    name: string;
    ruleType: string;
    depositRequired: boolean;
    amountType: string;
    amountValue: number;
    refundable: boolean;
    cancellationWindowHours: number;
  };
  depositRequirement?: {
    id: string;
    status: string;
    requiredAmount: number;
    collectedAmount: number;
  };
};

type EligibilityOutcome = {
  coverageStatus: string;
  memberId: string;
  planName: string;
  payerName: string;
  copay: number;
  deductibleRemaining: number;
  coinsurance: number;
  coverageActive: boolean;
  eligibilityMessage: string;
  payerReference: string;
  checkedAt: string;
  effectiveFrom: string | null;
  expiresAt: string | null;
  providerMode: ProviderMode;
  providerName: string;
  needsPriorAuth: boolean;
  priorAuthRequired: boolean;
  benefitUncertainty: boolean;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  recommendedAction: string;
  revenueAtRisk: number;
  // Honesty flags: when the live payer 271 omits a benefit field we do NOT invent a
  // number. `missingBenefitFields` names the omitted fields and `benefitDataIncomplete`
  // marks the estimate as incomplete so no fabricated dollar figure is shown as real.
  benefitDataIncomplete: boolean;
  missingBenefitFields: string[];
  rawResponse?: unknown;
  storeRawResponse: boolean;
};

export type PaymentOutcome = {
  amount: number;
  currency: string;
  status: string;
  provider: string;
  providerMode: ProviderMode;
  providerReference: string;
  paymentUrl?: string;
  message: string;
  rawResponse?: unknown;
  storeRawResponse: boolean;
};

function toNumber(value: unknown) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (value && typeof value === 'object' && 'toNumber' in value && typeof (value as { toNumber: () => number }).toNumber === 'function') {
    return (value as { toNumber: () => number }).toNumber();
  }
  return 0;
}

function asRecord(value: unknown) {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

// --- Money helpers ---------------------------------------------------------
// Preserve cents. `Math.round(amount)` (whole dollars) silently overbills — a
// $45.50 charge became $46 and a 15%-of-$150 = $22.50 deposit became $23. Money
// amounts are rounded to 2 decimals; Stripe minor units are the exact integer
// cents (`Math.round(amount * 100)`), never `roundedDollars * 100`.
export function roundMoney(amount: number): number {
  const value = Number.isFinite(amount) ? amount : 0;
  return Math.max(0, Math.round(value * 100) / 100);
}
export function toMinorUnits(amount: number): string {
  const value = Number.isFinite(amount) ? amount : 0;
  return String(Math.max(0, Math.round(value * 100)));
}

// Decrement a patient's outstanding balance by a collected amount, clamped at 0
// (the column has a non-negative CHECK constraint). Tenant-scoped. Returns a
// Runs on the caller's transaction client when atomic with a collection.
function decrementOutstandingBalance(tenantId: string, patientId: string, amount: number, client: Prisma.TransactionClient = db) {
  return client.$executeRaw`UPDATE "Patient" SET "outstandingBalance" = GREATEST(0, "outstandingBalance" - ${amount}::numeric) WHERE "id" = ${patientId}::uuid AND "tenantId" = ${tenantId}::uuid`;
}

async function fetchJsonWithTimeout(url: string, init: RequestInit, timeoutMs = 6000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const body = await response.json().catch(async () => ({ error: await response.text() }));
    return { response, body };
  } finally {
    clearTimeout(timeout);
  }
}

function branchFilter(request: FastifyRequest, branchId?: string) {
  if (request.auth.branchId) {
    if (branchId && branchId !== request.auth.branchId) {
      throw request.server.httpErrors.forbidden('Your account is restricted to another branch');
    }
    return { branchId: request.auth.branchId };
  }
  return branchId ? { branchId } : {};
}

function branchIdForWrite(request: FastifyRequest, branchId?: string) {
  if (request.auth.branchId) {
    if (branchId && branchId !== request.auth.branchId) {
      throw request.server.httpErrors.forbidden('Your account is restricted to another branch');
    }
    return request.auth.branchId;
  }
  return branchId;
}

function todayRange() {
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

function numberFromDateDistance(base: number, modifier: number) {
  return Math.max(0, Math.round(base + modifier));
}

function inferPayerReference(input: { payerName: string; patientId?: string; appointmentId?: string }) {
  return `${input.payerName.replace(/\s+/g, '-').toUpperCase()}-${(input.patientId ?? input.appointmentId ?? randomUUID()).slice(0, 8)}`;
}

function deriveCoverageMessage(outcome: Pick<EligibilityOutcome, 'coverageActive' | 'copay' | 'deductibleRemaining' | 'needsPriorAuth' | 'benefitUncertainty'>) {
  if (!outcome.coverageActive) return 'Coverage inactive or not confirmed. Verify insurance before the visit.';
  if (outcome.needsPriorAuth) return 'Coverage is active but prior authorisation is recommended before treatment.';
  if (outcome.benefitUncertainty) return 'Benefits are active, but the response contains uncertainty and should be reviewed.';
  if (outcome.deductibleRemaining > 1000) return 'Coverage is active, but the deductible is still high enough to collect a deposit today.';
  if (outcome.copay > 0) return 'Coverage is active and a patient responsibility amount is available for collection.';
  return 'Coverage is active and no immediate insurance risk was detected.';
}

function buildEligibilityRiskLevel(outcome: Pick<EligibilityOutcome, 'coverageActive' | 'copay' | 'deductibleRemaining' | 'needsPriorAuth' | 'benefitUncertainty'>): 'LOW' | 'MEDIUM' | 'HIGH' {
  if (!outcome.coverageActive) return 'HIGH';
  if (outcome.needsPriorAuth || outcome.benefitUncertainty || outcome.deductibleRemaining > 1000) return 'MEDIUM';
  return 'LOW';
}

function buildRecommendedAction(outcome: Pick<EligibilityOutcome, 'coverageActive' | 'copay' | 'deductibleRemaining' | 'needsPriorAuth'>) {
  if (!outcome.coverageActive) return 'Request updated insurance before appointment.';
  if (outcome.needsPriorAuth) return 'Submit prior authorization before visit.';
  if (outcome.copay > 0) return `Collect $${Math.round(outcome.copay)} copay before visit.`;
  if (outcome.deductibleRemaining > 0) return 'Review deductible exposure with the patient before arrival.';
  return 'Coverage is active and no immediate action is required.';
}

function deriveEligibilityRisk(outcome: Pick<EligibilityOutcome, 'coverageActive' | 'deductibleRemaining' | 'needsPriorAuth' | 'benefitUncertainty'>) {
  const alerts: string[] = [];
  if (!outcome.coverageActive) alerts.push('Inactive coverage');
  if (outcome.deductibleRemaining > 1000) alerts.push('High deductible');
  if (outcome.needsPriorAuth) alerts.push('Prior authorisation required');
  if (outcome.benefitUncertainty) alerts.push('Benefit uncertainty');
  return alerts;
}

async function resolveBranchIdAndEntities(request: FastifyRequest, context: RevenueContext, input: { branchId?: string; patientId?: string; appointmentId?: string }) {
  if (input.branchId) {
    assertBranchAccess(request, input.branchId);
  }
  const branchId = request.auth.branchId ?? input.branchId ?? context.branchId;
  let patient = null as null | {
    id: string;
    firstName: string;
    lastName: string;
    branchId: string;
    lifecycleStage: string;
    churnRisk: number;
    outstandingBalance: number;
    lifetimeValue: number;
    email?: string | null;
    phone?: string | null;
  };
  let appointment = null as null | {
    id: string;
    branchId: string;
    service: string;
    startsAt: Date;
    value: number;
    noShowRisk: number;
    providerRef?: string | null;
  };
  let appointmentPatientId: string | null = null;

  if (input.patientId) {
    const row = await db.patient.findFirst({
      where: { id: input.patientId, tenantId: context.tenantId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        branchId: true,
        lifecycleStage: true,
        churnRisk: true,
        outstandingBalance: true,
        lifetimeValue: true,
        email: true,
        phone: true,
      },
    });
    if (row) {
      assertBranchAccess(request, row.branchId);
      patient = {
        ...row,
        outstandingBalance: toNumber(row.outstandingBalance),
        lifetimeValue: toNumber(row.lifetimeValue),
      };
    }
  }

  if (input.appointmentId) {
    const row = await db.appointment.findFirst({
      where: { id: input.appointmentId, tenantId: context.tenantId },
      select: {
        id: true,
        branchId: true,
        patientId: true,
        service: true,
        startsAt: true,
        value: true,
        noShowRisk: true,
        providerRef: true,
      },
    });
    if (row) {
      const { patientId: rowPatientId, ...rest } = row;
      assertBranchAccess(request, row.branchId);
      appointmentPatientId = rowPatientId;
      appointment = {
        ...rest,
        value: toNumber(row.value),
      };
      // Safe derivation: when only an appointment is given, resolve its patient
      // server-side (tenant-scoped — no IDOR) so eligibility/intake never needs
      // the caller to pass a patientId redundantly.
      if (!patient && rowPatientId) {
        const p = await db.patient.findFirst({
          where: { id: rowPatientId, tenantId: context.tenantId },
          select: { id: true, firstName: true, lastName: true, branchId: true, lifecycleStage: true, churnRisk: true, outstandingBalance: true, lifetimeValue: true, email: true, phone: true },
        });
        if (p) patient = { ...p, outstandingBalance: toNumber(p.outstandingBalance), lifetimeValue: toNumber(p.lifetimeValue) };
      }
    }
  }

  if (patient && appointment && appointmentPatientId && patient.id !== appointmentPatientId) {
    throw request.server.httpErrors.badRequest('Patient and appointment do not belong together');
  }
  if (patient && appointment && patient.branchId !== appointment.branchId) {
    throw request.server.httpErrors.badRequest('Patient and appointment must belong to the same branch');
  }
  if (input.branchId && patient && input.branchId !== patient.branchId) {
    throw request.server.httpErrors.badRequest('Patient does not belong to the selected branch');
  }
  if (input.branchId && appointment && input.branchId !== appointment.branchId) {
    throw request.server.httpErrors.badRequest('Appointment does not belong to the selected branch');
  }

  const resolvedBranchId = branchId ?? appointment?.branchId ?? patient?.branchId;
  if (!resolvedBranchId) {
    return { branchId: context.branchId ?? request.auth.branchId ?? input.branchId ?? '', patient, appointment };
  }
  assertBranchAccess(request, resolvedBranchId);
  return { branchId: resolvedBranchId, patient, appointment };
}

async function resolveDepositRuleForBranch(request: FastifyRequest, depositRuleId: string | undefined, branchId: string) {
  if (!depositRuleId) return null;
  const rule = await runWithTenantContext(request.auth.tenantId, tx => tx.depositRule.findFirst({
    where: { id: depositRuleId, tenantId: request.auth.tenantId },
  }));
  if (!rule) throw request.server.httpErrors.notFound('Deposit rule not found');
  if (rule.branchId) {
    assertBranchAccess(request, rule.branchId);
    if (rule.branchId !== branchId) {
      throw request.server.httpErrors.badRequest('Deposit rule does not belong to the selected branch');
    }
  }
  return rule;
}

async function ensurePolicy(context: RevenueContext, entities: Awaited<ReturnType<typeof resolveBranchIdAndEntities>>, payerId?: string, policyId?: string) {
  if (!entities.patient) return null;
  const now = new Date();
  const existing = await db.patientInsurancePolicy.findFirst({
    where: {
      tenantId: context.tenantId, branchId: entities.branchId, patientId: entities.patient.id, active: true,
      effectiveFrom: { lte: now }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
      ...(policyId ? { id: policyId } : payerId ? { payerId } : { coverageOrder: 1 }),
    },
    orderBy: [{ coverageOrder: 'asc' }, { effectiveFrom: 'desc' }],
    include: { payer: { select: { id: true, name: true, tradingPartnerServiceId: true, sourceProvider: true } } },
  });

  if (existing) {
    return {
      id: existing.id,
      planName: existing.planName,
      memberId: existing.memberId,
      groupNumber: existing.groupNumber,
      subscriberName: existing.subscriberName,
      payer: existing.payer,
    };
  }

  return null;
}

function mapPayer(row: {
  id: string;
  name: string;
  tradingPartnerServiceId?: string | null;
  sourceProvider: string;
  active: boolean;
  sortOrder: number;
}) {
  return {
    id: row.id,
    name: row.name,
    tradingPartnerServiceId: row.tradingPartnerServiceId ?? null,
    sourceProvider: row.sourceProvider,
    active: row.active,
    sortOrder: row.sortOrder,
  };
}

class MockEligibilityProvider {
  providerKey = 'mock';
  displayName = 'Mock Eligibility';
  mode: ProviderMode = 'mock';

  async getPayerList(context: RevenueContext) {
    const rows = await db.insurancePayer.findMany({
      where: { tenantId: context.tenantId, active: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      take: 20,
    });
    return rows.map(mapPayer);
  }

  normalizeEligibilityResponse(_response: unknown, context: EligibilityCheckContext): EligibilityOutcome {
    const patient = context.patient;
    const appointment = context.appointment;
    const serviceName = context.serviceType ?? appointment?.service ?? '';
    const payerName = context.payer?.name ?? 'Mock Payer';
    const planName = context.policy?.planName ?? `${payerName} Standard`;
    const memberId = context.policy?.memberId ?? `TEST-${(patient?.id ?? appointment?.id ?? randomUUID()).slice(0, 8).toUpperCase()}`;
    const highRisk = (patient?.churnRisk ?? appointment?.noShowRisk ?? 0) > 65;
    const coverageActive = !(patient?.lifecycleStage === 'LOST' || patient?.lifecycleStage === 'INACTIVE') || (patient?.churnRisk ?? 0) < 75;
    const deductibleRemaining = numberFromDateDistance(
      appointment?.value ?? 150,
      (patient?.outstandingBalance ?? 0) * 0.65 + (highRisk ? 650 : 220),
    );
    const copay = numberFromDateDistance((appointment?.value ?? 180) * 0.12, highRisk ? 18 : 12);
    const coinsurance = highRisk ? 0.25 : 0.15;
    const needsPriorAuth = (appointment?.value ?? 0) >= 250 || /surgery|injection|procedure|botox|laser|consultation/i.test(serviceName);
    const benefitUncertainty = coverageActive && deductibleRemaining > 1400;
    const riskLevel = buildEligibilityRiskLevel({ coverageActive, deductibleRemaining, needsPriorAuth, benefitUncertainty, copay });
    const recommendedAction = buildRecommendedAction({ coverageActive, copay, deductibleRemaining, needsPriorAuth });
    const revenueAtRisk = coverageActive ? 0 : Math.max(185, Math.round((patient?.outstandingBalance ?? 0) * 0.4 + copay));

    return {
      coverageStatus: coverageActive ? (benefitUncertainty ? 'uncertain' : 'active') : 'inactive',
      memberId,
      planName,
      payerName,
      copay,
      deductibleRemaining,
      coinsurance,
      coverageActive,
      eligibilityMessage: deriveCoverageMessage({ coverageActive, copay, deductibleRemaining, needsPriorAuth, benefitUncertainty }),
      payerReference: context.policy?.memberId ? `${payerName}-${context.policy.memberId}` : inferPayerReference({ payerName, patientId: patient?.id, appointmentId: appointment?.id }),
      checkedAt: new Date().toISOString(),
      effectiveFrom: null,
      expiresAt: null,
      providerMode: this.mode,
      providerName: this.displayName,
      needsPriorAuth,
      priorAuthRequired: needsPriorAuth,
      benefitUncertainty,
      riskLevel,
      recommendedAction,
      revenueAtRisk,
      benefitDataIncomplete: false,
      missingBenefitFields: [],
      storeRawResponse: false,
    };
  }

  async runEligibilityCheck(_input: EligibilityCheckContext): Promise<EligibilityOutcome> {
    return this.normalizeEligibilityResponse({}, _input);
  }
}

export class StediEligibilityProvider extends MockEligibilityProvider {
  providerKey = 'stedi';
  displayName = 'Stedi Eligibility';
  mode: ProviderMode = env.STEDI_TEST_MODE ? 'sandbox' : 'live';

  async runEligibilityCheck(context: EligibilityCheckContext): Promise<EligibilityOutcome> {
    if (!env.STEDI_API_KEY) {
      throw new Error('Stedi eligibility is not configured');
    }

    try {
      const payer = context.payer ?? (await db.insurancePayer.findFirst({
        where: { tenantId: context.tenantId, active: true },
        orderBy: { sortOrder: 'asc' },
      }));
      const subscriber = {
        firstName: context.patient?.firstName ?? 'Jane',
        lastName: context.patient?.lastName ?? 'Doe',
        dateOfBirth: '19850101',
        memberId: context.policy?.memberId ?? `TEST-${randomUUID().slice(0, 8).toUpperCase()}`,
      };
      const requestBody = {
        controlNumber: (context.providerExecutionKey ?? randomUUID()).replace(/-/g, '').slice(0, 12),
        tradingPartnerServiceId: payer?.tradingPartnerServiceId ?? 'TEST',
        provider: {
          organizationName: 'CareCommand Clinic',
          npi: '1999999984',
        },
        subscriber,
        encounter: {
          serviceTypeCodes: ['MH'],
        },
        externalPatientId: context.patient?.id ?? `PAT-${randomUUID().slice(0, 8)}`,
      };
      const { response, body: payload } = await fetchJsonWithTimeout(`${env.STEDI_BASE_URL}/2024-04-01/change/medicalnetwork/eligibility/v3`, {
        method: 'POST',
        headers: {
          Authorization: env.STEDI_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });
      if (!response.ok) {
        throw new Error(`Stedi eligibility request failed with status ${response.status}`);
      }

      return this.normalizeEligibilityResponse(payload, context);
    } catch (error) {
      throw error instanceof Error ? error : new Error('Stedi eligibility request failed');
    }
  }

  normalizeEligibilityResponse(response: unknown, context: EligibilityCheckContext): EligibilityOutcome {
    const payload = asRecord(response) as EligibilityPayload;
    const serviceName = context.serviceType ?? context.appointment?.service ?? '';
    const benefits = asRecord(Array.isArray(payload.benefitsInformation) ? payload.benefitsInformation[0] : payload.benefitsInformation ?? payload);
    const patientResponsibility = asRecord(benefits.patientResponsibility);
    const deductible = asRecord(benefits.deductible);
    const officeVisit = asRecord(benefits.officeVisit);
    const benefitsSummary = asRecord(benefits.benefits);
    const rawStatus =
      benefits.coverageStatus ??
      benefits.eligibilityStatus ??
      payload.coverageStatus ??
      payload.status;
    const statusText = typeof rawStatus === 'string' ? rawStatus.trim().toLowerCase() : '';
    const explicitlyInactive = /(^|\b)(inactive|terminated|invalid|not covered|denied)(\b|$)/.test(statusText);
    const coverageActive = !explicitlyInactive && /(^|\b)(active|verified|covered)(\b|$)/.test(statusText);
    const coverageStatusUncertain = !coverageActive && !explicitlyInactive;
    const planName = String(benefits.planName ?? benefits.planDescription ?? context.policy?.planName ?? 'Stedi Health Plan');
    const payerName = String(benefits.payerName ?? benefits.payer ?? context.payer?.name ?? 'Stedi Test Payer');
    const memberId = String(benefits.memberId ?? context.policy?.memberId ?? inferPayerReference({ payerName, patientId: context.patient?.id, appointmentId: context.appointment?.id }));
    // Honesty (P0): do NOT invent coverage numbers. A real 271 that omits copay /
    // deductible / coinsurance is reported as UNKNOWN — never backfilled with a
    // fabricated dollar figure (previously 25 / 850 / 0.2) presented as real coverage.
    const copayRaw =
      benefits.copay ??
      benefits.copayAmount ??
      patientResponsibility.copay ??
      asRecord(benefits.financialResponsibility).copayAmount ??
      officeVisit.copay ??
      null;
    const deductibleRaw =
      benefits.deductibleRemaining ??
      deductible.remaining ??
      deductible.remainingAmount ??
      benefitsSummary.deductibleRemaining ??
      null;
    const coinsuranceRaw =
      benefits.coinsurance ??
      benefits.coInsurance ??
      patientResponsibility.coinsurance ??
      null;
    const missingBenefitFields: string[] = [];
    if (copayRaw == null) missingBenefitFields.push('copay');
    if (deductibleRaw == null) missingBenefitFields.push('deductibleRemaining');
    if (coinsuranceRaw == null) missingBenefitFields.push('coinsurance');
    const benefitDataIncomplete = missingBenefitFields.length > 0;
    // For internal risk math an unknown field is treated as 0 (a conservative,
    // non-fabricated placeholder), but it is flagged unknown to every consumer.
    const copay = toNumber(copayRaw ?? 0);
    const deductibleRemaining = toNumber(deductibleRaw ?? 0);
    const coinsurance = toNumber(coinsuranceRaw ?? 0);
    const needsPriorAuth = String(
      benefits.authorizationRequired ??
      benefits.priorAuthorizationRequired ??
      payload.authorizationRequired ??
      '',
    ).toLowerCase().includes('true') || deductibleRemaining > 1600 || /surgery|injection|procedure|botox|laser|consultation/i.test(serviceName);
    const benefitUncertainty = !response || !Object.keys(payload).length || Boolean(payload.warnings?.length) || benefitDataIncomplete || coverageStatusUncertain;
    const parsePayerDate = (value: unknown): string | null => {
      if (typeof value !== 'string' || !value.trim()) return null;
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
    };
    const effectiveFrom = parsePayerDate(benefits.effectiveFrom ?? benefits.effectiveDate ?? payload.effectiveFrom ?? payload.effectiveDate);
    const expiresAt = parsePayerDate(benefits.expiresAt ?? benefits.terminationDate ?? benefits.endDate ?? payload.expiresAt ?? payload.terminationDate ?? payload.endDate);
    const payerReference = String(
      benefits.payerReference ??
      payload.id ??
      context.policy?.memberId ??
      inferPayerReference({ payerName, patientId: context.patient?.id, appointmentId: context.appointment?.id }),
    );
    const riskLevel = buildEligibilityRiskLevel({ coverageActive, copay, deductibleRemaining, needsPriorAuth, benefitUncertainty });
    const recommendedAction = buildRecommendedAction({ coverageActive, copay, deductibleRemaining, needsPriorAuth });
    const revenueAtRisk = coverageActive ? 0 : Math.max(185, Math.round((context.patient?.outstandingBalance ?? 0) * 0.4 + copay));
    const eligibilityMessage = coverageStatusUncertain
      ? 'Payer response did not contain a recognized coverage status; coverage is not confirmed and requires manual review.'
      : benefitDataIncomplete
      ? `Payer response did not include ${missingBenefitFields.join(', ')}; benefit estimate is incomplete and must be verified manually before quoting the patient.`
      : deriveCoverageMessage({ coverageActive, copay, deductibleRemaining, needsPriorAuth, benefitUncertainty });

    return {
      coverageStatus: coverageStatusUncertain ? 'uncertain' : coverageActive ? (benefitUncertainty ? 'uncertain' : 'active') : 'inactive',
      memberId,
      planName,
      payerName,
      copay,
      deductibleRemaining,
      coinsurance,
      coverageActive,
      eligibilityMessage,
      payerReference,
      checkedAt: new Date().toISOString(),
      effectiveFrom,
      expiresAt,
      providerMode: this.mode,
      providerName: this.displayName,
      needsPriorAuth,
      priorAuthRequired: needsPriorAuth,
      benefitUncertainty,
      riskLevel,
      recommendedAction,
      revenueAtRisk,
      benefitDataIncomplete,
      missingBenefitFields,
      rawResponse: payload as Prisma.InputJsonValue,
      storeRawResponse: true,
    };
  }
}

class UnavailableEligibilityProvider extends MockEligibilityProvider {
  constructor(public providerKey: string, public displayName: string) {
    super();
  }

  override async runEligibilityCheck(): Promise<EligibilityOutcome> {
    throw new ProviderOperationError(this.displayName, 'eligibility check');
  }
}

class MockPaymentProvider {
  providerKey = 'mock';
  displayName = 'Mock Payments';
  mode: ProviderMode = 'mock';

  async createPaymentRequest(input: PaymentRequestContext): Promise<PaymentOutcome> {
    const amount = roundMoney(input.amount);
    const providerReference = `mock_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    return {
      amount,
      currency: 'USD',
      status: 'pending',
      provider: this.displayName,
      providerMode: this.mode,
      providerReference,
      paymentUrl: `http://localhost:12000/revenue-protection?payment=${providerReference}`,
      message: 'Mock payment request created for demo and local testing.',
      rawResponse: { providerReference, paymentUrl: `http://localhost:12000/revenue-protection?payment=${providerReference}` },
      storeRawResponse: false,
    };
  }

  async createPaymentLink(input: PaymentRequestContext): Promise<PaymentOutcome> {
    const request = await this.createPaymentRequest(input);
    return {
      ...request,
      message: 'Mock payment link generated for local testing.',
    };
  }

  async getPaymentStatus(reference: string) {
    return {
      amount: 0,
      currency: 'USD',
      status: reference ? 'pending' : 'unknown',
      provider: this.displayName,
      providerMode: this.mode,
      providerReference: reference,
      message: 'Mock payment status lookup.',
      storeRawResponse: false,
    };
  }

  normalizePaymentResponse(response: unknown, input: PaymentRequestContext): PaymentOutcome {
    const payload = asRecord(response);
    return {
      amount: roundMoney(input.amount),
      currency: 'USD',
      status: 'pending',
      provider: this.displayName,
      providerMode: this.mode,
      providerReference: String(payload.providerReference ?? `mock_${randomUUID().slice(0, 8)}`),
      paymentUrl: String(payload.paymentUrl ?? ''),
      message: 'Mock payment response.',
      rawResponse: response,
      storeRawResponse: false,
    };
  }
}

export class StripePaymentProvider extends MockPaymentProvider {
  providerKey = 'stripe';
  displayName = 'Stripe Payments';
  mode: ProviderMode = env.STRIPE_SECRET_KEY?.startsWith('sk_test_') || env.NODE_ENV !== 'production' ? 'sandbox' : 'live';

  private async stripeForm(path: string, fields: Record<string, string>): Promise<StripePayload | null> {
    if (!env.STRIPE_SECRET_KEY) return null;
    const body = new URLSearchParams(fields);
    const { response, body: payload } = await fetchJsonWithTimeout(`https://api.stripe.com${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });
    if (!response.ok) throw new Error(payload && payload.error ? JSON.stringify(payload.error) : 'Stripe request failed');
    return payload;
  }

  async createPaymentRequest(input: PaymentRequestContext): Promise<PaymentOutcome> {
    if (!env.STRIPE_SECRET_KEY) throw new ProviderOperationError(this.displayName, 'checkout session creation');

    try {
      const amount = roundMoney(input.amount);
      const payload = await this.stripeForm('/v1/checkout/sessions', {
        mode: 'payment',
        success_url: env.STRIPE_SUCCESS_URL,
        cancel_url: env.STRIPE_CANCEL_URL,
        client_reference_id: input.patient?.id ?? input.appointment?.id ?? randomUUID(),
        'line_items[0][price_data][currency]': 'usd',
        'line_items[0][price_data][product_data][name]': input.reason || 'CareCommand Payment Request',
        'line_items[0][price_data][product_data][description]': input.patient ? `${input.patient.firstName} ${input.patient.lastName}` : 'Patient payment request',
        'line_items[0][price_data][unit_amount]': toMinorUnits(amount),
        'line_items[0][quantity]': '1',
        'metadata[tenantId]': input.tenantId,
        'metadata[branchId]': input.branchId ?? '',
        'metadata[reason]': input.reason,
      });
      if (!payload) throw new ProviderOperationError(this.displayName, 'checkout session creation');
      return {
        amount,
        currency: 'USD',
        status: payload.payment_status === 'paid' ? 'paid' : 'pending',
        provider: this.displayName,
        providerMode: this.mode,
        providerReference: String(payload.id),
        paymentUrl: String(payload.url ?? ''),
        message: 'Stripe checkout session created.',
        rawResponse: payload,
        storeRawResponse: true,
      };
    } catch {
      throw new ProviderOperationError(this.displayName, 'checkout session creation');
    }
  }

  async createPaymentLink(input: PaymentRequestContext): Promise<PaymentOutcome> {
    if (!env.STRIPE_SECRET_KEY) throw new ProviderOperationError(this.displayName, 'payment link creation');

    try {
      const amount = roundMoney(input.amount);
      const payload = await this.stripeForm('/v1/payment_links', {
        'line_items[0][price_data][currency]': 'usd',
        'line_items[0][price_data][product_data][name]': input.reason || 'CareCommand Deposit',
        'line_items[0][price_data][product_data][description]': input.patient ? `${input.patient.firstName} ${input.patient.lastName}` : 'Patient deposit request',
        'line_items[0][price_data][unit_amount]': toMinorUnits(amount),
        'line_items[0][quantity]': '1',
        'after_completion[type]': 'redirect',
        'after_completion[redirect][url]': env.STRIPE_SUCCESS_URL,
        'metadata[tenantId]': input.tenantId,
        'metadata[branchId]': input.branchId ?? '',
        'metadata[reason]': input.reason,
      });
      if (!payload) throw new ProviderOperationError(this.displayName, 'payment link creation');
      return {
        amount,
        currency: 'USD',
        status: payload.active ? 'pending' : 'inactive',
        provider: this.displayName,
        providerMode: this.mode,
        providerReference: String(payload.id),
        paymentUrl: String(payload.url ?? ''),
        message: 'Stripe payment link created.',
        rawResponse: payload,
        storeRawResponse: true,
      };
    } catch {
      throw new ProviderOperationError(this.displayName, 'payment link creation');
    }
  }

  async getPaymentStatus(reference: string) {
    if (!env.STRIPE_SECRET_KEY) throw new ProviderOperationError(this.displayName, 'status lookup');
    try {
      const path = reference.startsWith('plink_') ? `/v1/payment_links/${reference}` : `/v1/checkout/sessions/${reference}`;
      const { response, body: payload } = await fetchJsonWithTimeout(`https://api.stripe.com${path}`, {
        headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
      });
      if (!response.ok || !payload) throw new ProviderOperationError(this.displayName, 'status lookup');
      const status = String(payload.payment_status ?? payload.active ?? 'pending');
      return {
        amount: toNumber(payload.amount_total ?? payload.amount_subtotal ?? 0) / 100,
        currency: String(payload.currency ?? 'USD').toUpperCase(),
        status,
        provider: this.displayName,
        providerMode: this.mode,
        providerReference: reference,
        paymentUrl: String(payload.url ?? ''),
        message: 'Stripe payment status retrieved.',
        rawResponse: payload as Prisma.InputJsonValue,
        storeRawResponse: true,
      };
    } catch {
      throw new ProviderOperationError(this.displayName, 'status lookup');
    }
  }
}

class UnavailablePaymentProvider extends MockPaymentProvider {
  constructor(public providerKey: string, public displayName: string) {
    super();
  }

  override async createPaymentRequest(): Promise<PaymentOutcome> {
    throw new ProviderOperationError(this.displayName, 'payment request creation');
  }

  override async createPaymentLink(): Promise<PaymentOutcome> {
    throw new ProviderOperationError(this.displayName, 'payment link creation');
  }

  override async getPaymentStatus(): Promise<never> {
    throw new ProviderOperationError(this.displayName, 'status lookup');
  }
}

export function createInsuranceProvider() {
  switch (env.INSURANCE_PROVIDER) {
    case 'stedi':
      return env.STEDI_API_KEY ? new StediEligibilityProvider() : new UnavailableEligibilityProvider('stedi', 'Stedi Eligibility');
    case 'availity':
      return new UnavailableEligibilityProvider('availity', 'Availity Eligibility');
    case 'pverify':
      return new UnavailableEligibilityProvider('pverify', 'pVerify Eligibility');
    case 'optum':
      return new UnavailableEligibilityProvider('optum', 'Optum Eligibility');
    case 'mock':
    default:
      return new MockEligibilityProvider();
  }
}

export function createPaymentProvider() {
  switch (env.PAYMENT_PROVIDER) {
    case 'stripe':
      return env.STRIPE_SECRET_KEY ? new StripePaymentProvider() : new UnavailablePaymentProvider('stripe', 'Stripe Payments');
    case 'square':
      return new UnavailablePaymentProvider('square', 'Square Payments');
    case 'authorize_net':
      return new UnavailablePaymentProvider('authorize_net', 'Authorize.Net Payments');
    case 'clover':
      return new UnavailablePaymentProvider('clover', 'Clover Payments');
    case 'paypal':
      return new UnavailablePaymentProvider('paypal', 'PayPal Payments');
    case 'mock':
    default:
      return new MockPaymentProvider();
  }
}

async function selectDefaultPayer(context: RevenueContext) {
  return db.insurancePayer.findFirst({
    where: { tenantId: context.tenantId, active: true },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  });
}

async function createEligibilityAlert(context: RevenueContext, branchId: string, patientId: string | null, appointmentId: string | null, outcome: EligibilityOutcome, verificationId: string, client?: Prisma.TransactionClient) {
  const riskThemes = deriveEligibilityRisk(outcome);
  if (!riskThemes.length) return null;
  const [primaryTheme, ...rest] = riskThemes;
  // RLS (B-3): RevenueProtectionAlert is tenant-isolated; create under context.
  const create = (tx: Prisma.TransactionClient) => tx.revenueProtectionAlert.create({
    data: {
      tenantId: context.tenantId,
      branchId,
      patientId: patientId ?? undefined,
      appointmentId: appointmentId ?? undefined,
      sourceType: 'eligibility',
      severity: !outcome.coverageActive ? 'high' : outcome.deductibleRemaining > 1400 ? 'medium' : 'low',
      title: `Eligibility risk: ${primaryTheme}`,
      description: outcome.eligibilityMessage,
      evidence: {
        verificationId,
        coverageStatus: outcome.coverageStatus,
        payerName: outcome.payerName,
        planName: outcome.planName,
        copay: outcome.copay,
        deductibleRemaining: outcome.deductibleRemaining,
        coinsurance: outcome.coinsurance,
        alerts: rest,
      },
      estimatedValue: outcome.revenueAtRisk > 0 ? outcome.revenueAtRisk : Math.max(0, outcome.deductibleRemaining * 0.18 + outcome.copay),
      status: 'open',
      recommendedAction: outcome.needsPriorAuth
        ? 'Review prior authorisation before the appointment.'
        : 'Collect deposit or route to front desk follow-up.',
      actionLink: '/revenue-protection',
    },
  });
  return client ? create(client) : runWithTenantContext(context.tenantId, create);
}

async function buildResponsibilityEstimate(context: RevenueContext, branchId: string, patientId: string, appointmentId: string | null, verificationId: string, outcome: EligibilityOutcome, client: Prisma.TransactionClient = db) {
  const appointment = appointmentId
    ? await client.appointment.findFirst({
        where: { id: appointmentId, tenantId: context.tenantId },
        select: { value: true, noShowRisk: true, service: true },
      })
    : null;
  const patient = await client.patient.findFirst({
    where: { id: patientId, tenantId: context.tenantId },
    select: { outstandingBalance: true, churnRisk: true, lifecycleStage: true },
  });
  const appointmentValue = toNumber(appointment?.value ?? 180);
  const deductiblePortion = Math.min(outcome.deductibleRemaining * 0.25, appointmentValue * 0.5);
  const responsibility = Math.max(0, outcome.copay + deductiblePortion + toNumber(patient?.outstandingBalance ?? 0) * 0.25);
  const insurancePortion = Math.max(0, appointmentValue - responsibility);
  const recommendedCollectAmount = Math.max(
    outcome.copay,
    Math.min(responsibility, appointmentValue * 0.4),
  );

  return client.patientResponsibilityEstimate.create({
    data: {
      tenantId: context.tenantId,
      branchId,
      patientId,
      appointmentId: appointmentId ?? undefined,
      eligibilityVerificationId: verificationId,
      estimatedInsurancePortion: insurancePortion,
      estimatedPatientResponsibility: responsibility,
      recommendedCollectAmount,
      reason: outcome.coverageActive
        ? outcome.deductibleRemaining > 1200
          ? 'Active coverage with a high deductible.'
          : 'Active coverage and a recoverable copay.'
        : 'Coverage is inactive and the patient should be reviewed before the visit.',
    },
  });
}

function mapVerification(row: {
  id: string;
  branchId: string;
  patientId: string;
  appointmentId?: string | null;
  payerId?: string | null;
  policyId?: string | null;
  providerMode: string;
  coverageStatus: string;
  planName: string;
  payerName: string;
  copay: unknown;
  deductibleRemaining: unknown;
  coinsurance: unknown;
  coverageActive: boolean;
  eligibilityMessage: string;
  payerReference?: string | null;
  checkedAt: Date;
  patient: { firstName: string; lastName: string };
  branch: { name: string };
  payer?: { name: string } | null;
  policy?: { memberId: string; planName: string; groupNumber?: string | null } | null;
}) {
  return {
    id: row.id,
    branchId: row.branchId,
    branchName: row.branch.name,
    patientId: row.patientId,
    patientName: `${row.patient.firstName} ${row.patient.lastName}`,
    appointmentId: row.appointmentId ?? null,
    payerId: row.payerId ?? null,
    policyId: row.policyId ?? null,
    memberId: row.policy?.memberId ?? null,
    providerMode: row.providerMode,
    coverageStatus: row.coverageStatus,
    planName: row.planName,
    payerName: row.payerName,
    copay: toNumber(row.copay),
    deductibleRemaining: toNumber(row.deductibleRemaining),
    coinsurance: toNumber(row.coinsurance),
    coverageActive: row.coverageActive,
    eligibilityMessage: row.eligibilityMessage,
    payerReference: row.payerReference ?? null,
    checkedAt: row.checkedAt.toISOString(),
    priorAuthRequired: row.coverageStatus.toLowerCase() !== 'active',
    recommendedAction: row.coverageStatus.toLowerCase() === 'active'
      ? (toNumber(row.copay) > 0 ? `Collect $${Math.round(toNumber(row.copay))} copay before visit.` : 'Coverage is active and no immediate action is required.')
      : 'Request updated insurance before appointment.',
    riskLevel: row.coverageActive ? (toNumber(row.deductibleRemaining) > 1000 ? 'MEDIUM' : 'LOW') : 'HIGH',
    revenueAtRisk: row.coverageActive ? 0 : Math.max(185, Math.round(toNumber(row.deductibleRemaining) * 0.18 + toNumber(row.copay))),
  };
}

async function buildRevenueEligibilityResponse(tenantId: string, verificationId: string, client: Prisma.TransactionClient = db) {
  const verification = await client.eligibilityVerification.findFirst({
    where: { id: verificationId, tenantId },
    include: {
      branch: { select: { name: true } },
      patient: { select: { firstName: true, lastName: true } },
      payer: { select: { name: true } },
      policy: { select: { memberId: true } },
    },
  });
  if (!verification) throw new Error('Eligibility result is unavailable');
  const outcome = verification.normalizedResponse as unknown as EligibilityOutcome;
  const alert = await client.revenueProtectionAlert.findFirst({
    where: { tenantId, sourceType: 'eligibility', evidence: { path: ['verificationId'], equals: verificationId } },
    select: { id: true, estimatedValue: true },
  });
  return {
    verificationId: verification.id,
    id: verification.id,
    branchId: verification.branchId,
    branchName: verification.branch.name,
    patientId: verification.patientId,
    patientName: `${verification.patient.firstName} ${verification.patient.lastName}`,
    appointmentId: verification.appointmentId ?? null,
    payerId: verification.payerId ?? null,
    payerName: verification.payer?.name ?? verification.payerName,
    policyId: verification.policyId ?? null,
    memberId: verification.policy?.memberId ?? null,
    planName: verification.planName,
    coverageStatus: verification.coverageStatus.toUpperCase(),
    coverageActive: verification.coverageActive,
    copay: verification.copay === null ? null : toNumber(verification.copay),
    deductibleRemaining: verification.deductibleRemaining === null ? null : toNumber(verification.deductibleRemaining),
    coinsurance: verification.coinsurance === null ? null : toNumber(verification.coinsurance),
    benefitDataIncomplete: outcome.benefitDataIncomplete,
    missingBenefitFields: outcome.missingBenefitFields,
    eligibilityMessage: verification.eligibilityMessage,
    payerReference: verification.payerReference ?? outcome.payerReference,
    checkedAt: verification.checkedAt.toISOString(),
    providerMode: verification.providerMode,
    alertId: alert?.id ?? null,
    priorAuthRequired: outcome.priorAuthRequired,
    recommendedAction: outcome.recommendedAction,
    riskLevel: outcome.riskLevel,
    revenueAtRisk: toNumber(alert?.estimatedValue ?? outcome.revenueAtRisk),
    benefitUncertainty: outcome.benefitUncertainty,
  };
}

function mapAppointmentQueueRow(row: {
  id: string;
  branchId: string;
  service: string;
  startsAt: Date;
  status: string;
  patient: {
    id: string;
    firstName: string;
    lastName: string;
    patientInsurancePolicies: Array<{
      id: string;
      payerId?: string | null;
      memberId: string;
      groupNumber?: string | null;
      payer?: { name: string } | null;
      verificationStatus: string;
      verifiedAt?: Date | null;
      active: boolean;
    }>;
    eligibilityVerifications: Array<{
      id: string;
      coverageStatus: string;
      coverageActive: boolean;
      copay: unknown;
      deductibleRemaining: unknown;
      coinsurance: unknown;
      eligibilityMessage: string;
      payerReference?: string | null;
      checkedAt: Date;
      providerMode: string;
      payer?: { name: string } | null;
      policy?: { memberId: string; groupNumber?: string | null } | null;
    }>;
    priorAuthorizations: Array<{
      id: string;
      status: string;
      serviceName: string;
      notes?: string | null;
      dueAt?: Date | null;
    }>;
  };
  branch: { name: string };
}) {
  const latestPolicy = row.patient.patientInsurancePolicies[0] ?? null;
  const latestVerification = row.patient.eligibilityVerifications[0] ?? null;
  const latestPriorAuth = row.patient.priorAuthorizations[0] ?? null;
  return {
    id: row.id,
    branchId: row.branchId,
    branchName: row.branch.name,
    patientId: row.patient.id,
    patientName: `${row.patient.firstName} ${row.patient.lastName}`,
    appointmentTime: row.startsAt.toISOString(),
    serviceType: row.service,
    payerName: latestPolicy?.payer?.name ?? latestVerification?.payer?.name ?? '—',
    memberId: latestPolicy?.memberId ?? latestVerification?.policy?.memberId ?? '—',
    groupNumber: latestPolicy?.groupNumber ?? latestVerification?.policy?.groupNumber ?? null,
    eligibilityStatus: latestVerification
      ? (latestVerification.coverageActive ? 'Active' : 'Inactive')
      : (latestPolicy?.verificationStatus === 'verified' ? 'Active' : 'Not Verified'),
    copay: latestVerification ? toNumber(latestVerification.copay) : 0,
    deductibleRemaining: latestVerification ? toNumber(latestVerification.deductibleRemaining) : 0,
    priorAuthStatus: latestVerification?.eligibilityMessage.toLowerCase().includes('prior')
      ? 'Required'
      : (latestPriorAuth?.status ?? 'Not Required'),
    verificationId: latestVerification?.id ?? null,
    priorAuthId: latestPriorAuth?.id ?? null,
    coverageActive: latestVerification?.coverageActive ?? false,
    coverageStatus: latestVerification?.coverageStatus ?? latestPolicy?.verificationStatus ?? 'not_verified',
    checkedAt: latestVerification?.checkedAt.toISOString() ?? latestPolicy?.verifiedAt?.toISOString() ?? null,
    providerMode: latestVerification?.providerMode ?? 'mock',
    payerReference: latestVerification?.payerReference ?? latestPolicy?.memberId ?? null,
    recommendedAction: latestVerification?.eligibilityMessage ?? 'Verify insurance before the appointment.',
    riskLevel: latestVerification?.coverageActive === false ? 'HIGH' : 'LOW',
  };
}

function mapPriorAuth(row: {
  id: string;
  branchId: string;
  patientId?: string | null;
  appointmentId?: string | null;
  payerId?: string | null;
  serviceName: string;
  authNumber?: string | null;
  status: string;
  dueAt?: Date | null;
  notes?: string | null;
  lastUpdatedAt?: Date | null;
  patient?: { firstName: string; lastName: string } | null;
  branch: { name: string };
  payer?: { name: string } | null;
}) {
  return {
    id: row.id,
    branchId: row.branchId,
    branchName: row.branch.name,
    patientId: row.patientId ?? null,
    patientName: row.patient ? `${row.patient.firstName} ${row.patient.lastName}` : '—',
    appointmentId: row.appointmentId ?? null,
    payerId: row.payerId ?? null,
    payerName: row.payer?.name ?? '—',
    serviceName: row.serviceName,
    authNumber: row.authNumber ?? null,
    status: row.status,
    dueAt: row.dueAt?.toISOString() ?? null,
    notes: row.notes ?? null,
    lastUpdatedAt: row.lastUpdatedAt?.toISOString() ?? null,
  };
}

function mapPaymentRequest(row: {
  id: string;
  branchId: string;
  patientId?: string | null;
  appointmentId?: string | null;
  amount: unknown;
  currency: string;
  status: string;
  reason: string;
  mode: string;
  paymentUrl?: string | null;
  providerReference?: string | null;
  dueAt?: Date | null;
  patient?: { firstName: string; lastName: string } | null;
  branch: { name: string };
  appointment?: { service: string } | null;
}) {
  return {
    id: row.id,
    branchId: row.branchId,
    branchName: row.branch.name,
    patientId: row.patientId ?? null,
    patientName: row.patient ? `${row.patient.firstName} ${row.patient.lastName}` : '—',
    appointmentId: row.appointmentId ?? null,
    appointmentService: row.appointment?.service ?? null,
    amount: toNumber(row.amount),
    currency: row.currency,
    status: row.status,
    reason: row.reason,
    mode: row.mode,
    paymentUrl: row.paymentUrl ?? null,
    providerReference: row.providerReference ?? null,
    dueAt: row.dueAt?.toISOString() ?? null,
  };
}

function mapTransaction(row: {
  id: string;
  branchId: string;
  patientId?: string | null;
  appointmentId?: string | null;
  amount: unknown;
  currency: string;
  status: string;
  mode: string;
  providerReference?: string | null;
  receivedAt?: Date | null;
  branch: { name: string };
  patient?: { firstName: string; lastName: string } | null;
}) {
  return {
    id: row.id,
    branchId: row.branchId,
    branchName: row.branch.name,
    patientId: row.patientId ?? null,
    patientName: row.patient ? `${row.patient.firstName} ${row.patient.lastName}` : '—',
    appointmentId: row.appointmentId ?? null,
    amount: toNumber(row.amount),
    currency: row.currency,
    status: row.status,
    mode: row.mode,
    providerReference: row.providerReference ?? null,
    receivedAt: row.receivedAt?.toISOString() ?? null,
  };
}

function mapDepositRule(row: {
  id: string;
  branchId?: string | null;
  name: string;
  ruleType: string;
  description: string;
  active: boolean;
  depositRequired: boolean;
  amountType: string;
  amountValue: unknown;
  refundable: boolean;
  cancellationWindowHours: number;
  appliesToNewPatients: boolean;
  appliesToHighNoShowRisk: boolean;
  appliesToPremiumServices: boolean;
  appliesToSameDayAppointments: boolean;
  appliesToExemptPatients: boolean;
  sortOrder: number;
  branch?: { name: string } | null;
}) {
  return {
    id: row.id,
    branchId: row.branchId ?? null,
    branchName: row.branch?.name ?? null,
    name: row.name,
    ruleType: row.ruleType,
    description: row.description,
    active: row.active,
    depositRequired: row.depositRequired,
    amountType: row.amountType,
    amountValue: toNumber(row.amountValue),
    refundable: row.refundable,
    cancellationWindowHours: row.cancellationWindowHours,
    appliesToNewPatients: row.appliesToNewPatients,
    appliesToHighNoShowRisk: row.appliesToHighNoShowRisk,
    appliesToPremiumServices: row.appliesToPremiumServices,
    appliesToSameDayAppointments: row.appliesToSameDayAppointments,
    appliesToExemptPatients: row.appliesToExemptPatients,
    sortOrder: row.sortOrder,
  };
}

function mapDepositRequirement(row: {
  id: string;
  branchId: string;
  patientId?: string | null;
  appointmentId?: string | null;
  depositRuleId?: string | null;
  paymentRequestId?: string | null;
  status: string;
  requiredAmount: unknown;
  collectedAmount: unknown;
  waiverReason?: string | null;
  reason: string;
  mode: string;
  dueAt?: Date | null;
  collectedAt?: Date | null;
  branch: { name: string };
  patient?: { firstName: string; lastName: string } | null;
  appointment?: { service: string } | null;
  depositRule?: { name: string } | null;
}) {
  return {
    id: row.id,
    branchId: row.branchId,
    branchName: row.branch.name,
    patientId: row.patientId ?? null,
    patientName: row.patient ? `${row.patient.firstName} ${row.patient.lastName}` : '—',
    appointmentId: row.appointmentId ?? null,
    appointmentService: row.appointment?.service ?? null,
    depositRuleId: row.depositRuleId ?? null,
    paymentRequestId: row.paymentRequestId ?? null,
    depositRuleName: row.depositRule?.name ?? null,
    status: row.status,
    requiredAmount: toNumber(row.requiredAmount),
    collectedAmount: toNumber(row.collectedAmount),
    waiverReason: row.waiverReason ?? null,
    reason: row.reason,
    mode: row.mode,
    dueAt: row.dueAt?.toISOString() ?? null,
    collectedAt: row.collectedAt?.toISOString() ?? null,
  };
}

function mapAlert(row: {
  id: string;
  branchId: string;
  patientId?: string | null;
  appointmentId?: string | null;
  sourceType: string;
  severity: string;
  title: string;
  description: string;
  evidence?: unknown;
  estimatedValue: unknown;
  status: string;
  recommendedAction: string;
  actionLink?: string | null;
  branch: { name: string };
  patient?: { firstName: string; lastName: string } | null;
  appointment?: { service: string } | null;
}) {
  return {
    id: row.id,
    branchId: row.branchId,
    branchName: row.branch.name,
    patientId: row.patientId ?? null,
    patientName: row.patient ? `${row.patient.firstName} ${row.patient.lastName}` : '—',
    appointmentId: row.appointmentId ?? null,
    appointmentService: row.appointment?.service ?? null,
    sourceType: row.sourceType,
    severity: row.severity,
    title: row.title,
    description: row.description,
    evidence: row.evidence ?? null,
    estimatedValue: toNumber(row.estimatedValue),
    status: row.status,
    recommendedAction: row.recommendedAction,
    actionLink: row.actionLink ?? null,
  };
}

async function loadOverview(context: RevenueContext, branchId?: string) {
  const filter = context.branchId ? { branchId: context.branchId } : branchId ? { branchId } : {};
  const [insurancePayers, patientInsurancePolicies, eligibilityVerifications, patientResponsibilityEstimates, priorAuthorizations, paymentRequests, paymentTransactions, depositRules, depositRequirements, revenueProtectionAlerts, integrationRunLogs] = await Promise.all([
    db.insurancePayer.findMany({ where: { tenantId: context.tenantId, active: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], take: 50 }),
    db.patientInsurancePolicy.findMany({
      where: { tenantId: context.tenantId, ...filter },
      orderBy: { updatedAt: 'desc' },
      take: 50,
      include: { branch: { select: { name: true } }, patient: { select: { firstName: true, lastName: true } }, payer: { select: { name: true } } },
    }),
    db.eligibilityVerification.findMany({
      where: { tenantId: context.tenantId, ...filter },
      orderBy: { checkedAt: 'desc' },
      take: 50,
      include: {
        branch: { select: { name: true } },
        patient: { select: { firstName: true, lastName: true } },
        payer: { select: { name: true } },
        policy: { select: { memberId: true, planName: true } },
      },
    }),
    db.patientResponsibilityEstimate.findMany({
      where: { tenantId: context.tenantId, ...filter },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: {
        branch: { select: { name: true } },
        patient: { select: { firstName: true, lastName: true } },
        appointment: { select: { service: true } },
        eligibilityVerification: { select: { id: true } },
      },
    }),
    db.priorAuthorization.findMany({
      where: { tenantId: context.tenantId, ...filter },
      orderBy: [{ dueAt: 'asc' }, { updatedAt: 'desc' }],
      take: 50,
      include: { branch: { select: { name: true } }, patient: { select: { firstName: true, lastName: true } }, payer: { select: { name: true } } },
    }),
    db.paymentRequest.findMany({
      where: { tenantId: context.tenantId, ...filter },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { branch: { select: { name: true } }, patient: { select: { firstName: true, lastName: true } }, appointment: { select: { service: true } } },
    }),
    db.paymentTransaction.findMany({
      where: { tenantId: context.tenantId, ...filter },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { branch: { select: { name: true } }, patient: { select: { firstName: true, lastName: true } } },
    }),
    // RLS (B-3): DepositRule is tenant-isolated — read under tenant context.
    runWithTenantContext(context.tenantId, tx => tx.depositRule.findMany({
      where: { tenantId: context.tenantId, ...filter },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
      take: 50,
      include: { branch: { select: { name: true } } },
    })),
    // The depositRule include below also reads the RLS table, so wrap this read.
    runWithTenantContext(context.tenantId, tx => tx.depositRequirement.findMany({
      where: { tenantId: context.tenantId, ...filter },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: {
        branch: { select: { name: true } },
        patient: { select: { firstName: true, lastName: true } },
        appointment: { select: { service: true } },
        depositRule: { select: { name: true } },
      },
    })),
    // RLS (B-3): RevenueProtectionAlert is tenant-isolated — read under context.
    runWithTenantContext(context.tenantId, tx => tx.revenueProtectionAlert.findMany({
      where: { tenantId: context.tenantId, ...filter },
      orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }],
      take: 50,
      include: {
        branch: { select: { name: true } },
        patient: { select: { firstName: true, lastName: true } },
        appointment: { select: { service: true } },
      },
    })),
    db.integrationRunLog.findMany({
      where: { tenantId: context.tenantId, ...filter },
      orderBy: { createdAt: 'desc' },
      take: 20,
      include: { branch: { select: { name: true } } },
    }),
  ]);

  // Headline financial totals MUST be computed with DB aggregates, not by summing
  // the truncated `take: 50` collections above — otherwise the dashboard silently
  // under-reports past 50 contributing rows. All numbers are tenant-scoped (and,
  // for RLS tables, read under tenant context). The returned shape is unchanged.
  const { start: dueStart, end: dueEnd } = todayRange();
  // Statuses that are NOT genuinely-open AR. `expired`/`failed`/`cancelled` requests
  // are dead (and expiry spawns a fresh row, so the same balance would otherwise be
  // counted twice); `collected`/`refunded` are settled. Only truly-open requests are
  // owed money. This prevents the stale-AR over-count.
  const NON_OPEN_REQUEST_STATUSES = ['collected', 'failed', 'expired', 'cancelled', 'refunded'];
  const [
    paymentsDueTodayCount,
    unpaidBalancesAgg,
    depositsCollectedAgg,
    failedPaymentsCount,
    succeededTransactionsAgg,
    refundedTransactionsAgg,
    revenueAtRiskAgg,
    collectedDeposits,
    succeededTxnRequestRows,
  ] = await Promise.all([
    db.paymentRequest.count({ where: { tenantId: context.tenantId, ...filter, status: 'pending', dueAt: { gte: dueStart, lt: dueEnd } } }),
    db.paymentRequest.aggregate({ _sum: { amount: true }, where: { tenantId: context.tenantId, ...filter, status: { notIn: NON_OPEN_REQUEST_STATUSES } } }),
    runWithTenantContext(context.tenantId, tx => tx.depositRequirement.aggregate({ _sum: { collectedAmount: true }, where: { tenantId: context.tenantId, ...filter, status: 'collected' } })),
    db.paymentTransaction.count({ where: { tenantId: context.tenantId, ...filter, status: 'failed' } }),
    db.paymentTransaction.aggregate({ _sum: { amount: true }, where: { tenantId: context.tenantId, ...filter, status: { in: ['succeeded', 'paid'] } } }),
    db.paymentTransaction.aggregate({ _sum: { amount: true }, where: { tenantId: context.tenantId, ...filter, status: 'refunded' } }),
    runWithTenantContext(context.tenantId, tx => tx.revenueProtectionAlert.aggregate({ _sum: { estimatedValue: true }, where: { tenantId: context.tenantId, ...filter, status: { not: 'resolved' } } })),
    // Collected deposits (to add manually-collected ones that have no transaction).
    runWithTenantContext(context.tenantId, tx => tx.depositRequirement.findMany({ where: { tenantId: context.tenantId, ...filter, status: 'collected' }, select: { paymentRequestId: true, collectedAmount: true } })),
    // Payment requests that already have a succeeded/paid transaction — a collected
    // deposit linked to one of these is ALREADY counted in the transaction total.
    db.paymentTransaction.findMany({ where: { tenantId: context.tenantId, ...filter, status: { in: ['succeeded', 'paid'] }, paymentRequestId: { not: null } }, select: { paymentRequestId: true } }),
  ]);

  const unpaidBalancesTotal = toNumber(unpaidBalancesAgg._sum.amount);
  const depositsCollectedTotal = toNumber(depositsCollectedAgg._sum.collectedAmount);
  // revenueProtected must count each economic event ONCE. A webhook-settled deposit is
  // written as BOTH a succeeded paymentTransaction AND a collected DepositRequirement,
  // so naively adding both aggregates double-counts it. The money-movement truth is the
  // net of transactions (succeeded/paid minus refunded); to that we add only the
  // manually-collected deposits that have NO linked transaction. Refunds reduce the
  // total via the refunded transactions (and their deposit flips out of 'collected').
  const succeededTxnRequestIds = new Set(
    succeededTxnRequestRows.map(r => r.paymentRequestId).filter((x): x is string => Boolean(x)),
  );
  const manualDepositsTotal = collectedDeposits
    .filter(d => !d.paymentRequestId || !succeededTxnRequestIds.has(d.paymentRequestId))
    .reduce((sum, d) => sum + toNumber(d.collectedAmount), 0);
  const netTransactionsTotal = toNumber(succeededTransactionsAgg._sum.amount) - toNumber(refundedTransactionsAgg._sum.amount);
  const summary = {
    paymentsDueToday: paymentsDueTodayCount,
    // copaysExpected and unpaidBalances share the same definition (genuinely-open requests).
    copaysExpected: unpaidBalancesTotal,
    depositsCollected: depositsCollectedTotal,
    unpaidBalances: unpaidBalancesTotal,
    failedPayments: failedPaymentsCount,
    revenueProtected: netTransactionsTotal + manualDepositsTotal,
    revenueAtRisk: toNumber(revenueAtRiskAgg._sum.estimatedValue),
  };

  return {
    summary,
    insurancePayers: insurancePayers.map(mapPayer),
    patientInsurancePolicies: patientInsurancePolicies.map(row => ({
      id: row.id,
      branchId: row.branchId,
      branchName: row.branch.name,
      patientId: row.patientId,
      patientName: `${row.patient.firstName} ${row.patient.lastName}`,
      payerId: row.payerId ?? null,
      payerName: row.payer?.name ?? '—',
      planName: row.planName,
      memberId: row.memberId,
      groupNumber: row.groupNumber ?? null,
      relationship: row.relationship ?? null,
      subscriberName: row.subscriberName ?? null,
      payerReference: row.payerReference ?? null,
      verificationStatus: row.verificationStatus,
      active: row.active,
      verifiedAt: row.verifiedAt?.toISOString() ?? null,
    })),
    eligibilityVerifications: eligibilityVerifications.map(mapVerification),
    patientResponsibilityEstimates: patientResponsibilityEstimates.map(row => ({
      id: row.id,
      branchId: row.branchId,
      branchName: row.branch.name,
      patientId: row.patientId,
      patientName: `${row.patient.firstName} ${row.patient.lastName}`,
      appointmentId: row.appointmentId ?? null,
      appointmentService: row.appointment?.service ?? null,
      eligibilityVerificationId: row.eligibilityVerificationId ?? null,
      estimatedInsurancePortion: toNumber(row.estimatedInsurancePortion),
      estimatedPatientResponsibility: toNumber(row.estimatedPatientResponsibility),
      recommendedCollectAmount: toNumber(row.recommendedCollectAmount),
      reason: row.reason,
      createdAt: row.createdAt.toISOString(),
    })),
    priorAuthorizations: priorAuthorizations.map(mapPriorAuth),
    paymentRequests: paymentRequests.map(mapPaymentRequest),
    paymentTransactions: paymentTransactions.map(mapTransaction),
    depositRules: depositRules.map(mapDepositRule),
    depositRequirements: depositRequirements.map(mapDepositRequirement),
    revenueProtectionAlerts: revenueProtectionAlerts.map(mapAlert),
    integrationRunLogs: integrationRunLogs.map(row => ({
      id: row.id,
      branchId: row.branchId ?? null,
      branchName: row.branch?.name ?? null,
      provider: row.provider,
      providerMode: row.providerMode,
      operation: row.operation,
      status: row.status,
      requestSummary: row.requestSummary ?? null,
      responseSummary: row.responseSummary ?? null,
      errorMessage: row.errorMessage ?? null,
      createdAt: row.createdAt.toISOString(),
    })),
  };
}

export const revenueProtectionRoutes: FastifyPluginAsync = async app => {
  app.get('/overview', { preHandler: billingRead }, async request => {
    const query = listLimit.parse(request.query);
    branchFilter(request, query.branchId);
    const result = await loadOverview({ tenantId: request.auth.tenantId, branchId: request.auth.branchId ?? undefined }, query.branchId);
    await audit(request, { action: 'revenueProtection.overview.read', resource: 'revenueProtection', metadata: { branchId: request.auth.branchId ?? query.branchId ?? null } });
    return result;
  });

  app.get('/integration-status', { preHandler: billingRead }, async request => {
    const insuranceProvider = createInsuranceProvider();
    const paymentProvider = createPaymentProvider();
    const insuranceConfigured = env.INSURANCE_PROVIDER === 'mock' || (env.INSURANCE_PROVIDER === 'stedi' && Boolean(env.STEDI_API_KEY));
    const paymentConfigured = env.PAYMENT_PROVIDER === 'mock' || (env.PAYMENT_PROVIDER === 'stripe' && Boolean(env.STRIPE_SECRET_KEY));
    const [recentRuns, payerList] = await Promise.all([
      db.integrationRunLog.findMany({
        where: { tenantId: request.auth.tenantId, ...branchFilter(request, undefined) },
        orderBy: { createdAt: 'desc' },
        take: 8,
      }),
      insuranceProvider.getPayerList({ tenantId: request.auth.tenantId, branchId: request.auth.branchId ?? undefined }),
    ]);

    const result = {
      insurance: {
        provider: env.INSURANCE_PROVIDER,
        providerName: insuranceProvider.displayName,
        mode: insuranceProvider.mode,
        label: insuranceConfigured
          ? (insuranceProvider.providerKey === 'stedi'
            ? `Stedi ${insuranceProvider.mode === 'live' ? 'Live Active' : 'Sandbox Active'}`
            : `${insuranceProvider.displayName} Active`)
          : 'Mock Mode',
        configured: insuranceConfigured,
      },
      payment: {
        provider: env.PAYMENT_PROVIDER,
        providerName: paymentProvider.displayName,
        mode: paymentProvider.mode,
        label: paymentConfigured
          ? (paymentProvider.providerKey === 'stripe'
            ? `Stripe ${paymentProvider.mode === 'live' ? 'Live Active' : 'Test Mode Active'}`
            : `${paymentProvider.displayName} Active`)
          : 'Mock Mode',
        configured: paymentConfigured,
      },
      payerCount: payerList.length,
      recentRuns: recentRuns.length,
      latestRun: recentRuns[0] ?? null,
    };
    await audit(request, { action: 'revenueProtection.integrationStatus.read', resource: 'integrationStatus', metadata: { recentRunCount: recentRuns.length } });
    return result;
  });

  app.get('/eligibility', { preHandler: [insuranceFeature, billingRead] }, async request => {
    const query = listLimit.parse(request.query);
    const filter = { ...branchFilter(request, query.branchId), ...(query.patientId ? { patientId: query.patientId } : {}), ...(query.appointmentId ? { appointmentId: query.appointmentId } : {}) };
    const [insurancePayers, patientInsurancePolicies, eligibilityVerifications, patientResponsibilityEstimates] = await Promise.all([
      db.insurancePayer.findMany({ where: { tenantId: request.auth.tenantId, active: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], take: query.limit }),
      db.patientInsurancePolicy.findMany({
        where: { tenantId: request.auth.tenantId, ...filter },
        orderBy: { updatedAt: 'desc' },
        take: query.limit,
        include: { branch: { select: { name: true } }, patient: { select: { firstName: true, lastName: true } }, payer: { select: { name: true } } },
      }),
      db.eligibilityVerification.findMany({
        where: { tenantId: request.auth.tenantId, ...filter },
        orderBy: { checkedAt: 'desc' },
        take: query.limit,
        include: { branch: { select: { name: true } }, patient: { select: { firstName: true, lastName: true } }, payer: { select: { name: true } }, policy: { select: { memberId: true, planName: true } } },
      }),
      db.patientResponsibilityEstimate.findMany({
        where: { tenantId: request.auth.tenantId, ...filter },
        orderBy: { createdAt: 'desc' },
        take: query.limit,
        include: { branch: { select: { name: true } }, patient: { select: { firstName: true, lastName: true } }, appointment: { select: { service: true } }, eligibilityVerification: { select: { id: true } } },
      }),
    ]);
    const result = {
      insurancePayers: insurancePayers.map(mapPayer),
      patientInsurancePolicies: patientInsurancePolicies.map(row => ({
        id: row.id,
        branchId: row.branchId,
        branchName: row.branch.name,
        patientId: row.patientId,
        patientName: `${row.patient.firstName} ${row.patient.lastName}`,
        payerId: row.payerId ?? null,
        payerName: row.payer?.name ?? '—',
        planName: row.planName,
        memberId: row.memberId,
        groupNumber: row.groupNumber ?? null,
        relationship: row.relationship ?? null,
        subscriberName: row.subscriberName ?? null,
        payerReference: row.payerReference ?? null,
        verificationStatus: row.verificationStatus,
        active: row.active,
        verifiedAt: row.verifiedAt?.toISOString() ?? null,
      })),
      eligibilityVerifications: eligibilityVerifications.map(mapVerification),
      patientResponsibilityEstimates: patientResponsibilityEstimates.map(row => ({
        id: row.id,
        branchId: row.branchId,
        branchName: row.branch.name,
        patientId: row.patientId,
        patientName: `${row.patient.firstName} ${row.patient.lastName}`,
        appointmentId: row.appointmentId ?? null,
        appointmentService: row.appointment?.service ?? null,
        eligibilityVerificationId: row.eligibilityVerificationId ?? null,
        estimatedInsurancePortion: toNumber(row.estimatedInsurancePortion),
        estimatedPatientResponsibility: toNumber(row.estimatedPatientResponsibility),
        recommendedCollectAmount: toNumber(row.recommendedCollectAmount),
        reason: row.reason,
        createdAt: row.createdAt.toISOString(),
      })),
    };
    await audit(request, { action: 'eligibility.list', resource: 'eligibilityVerification', metadata: { count: eligibilityVerifications.length, branchId: request.auth.branchId ?? query.branchId ?? null } });
    return result;
  });

  app.get('/appointment-queue', { preHandler: [insuranceFeature, billingRead] }, async request => {
    const query = listLimit.parse(request.query);
    const filter = branchFilter(request, query.branchId);
    const rows = await db.appointment.findMany({
      where: {
        tenantId: request.auth.tenantId,
        deletedAt: null,
        ...filter,
      },
      orderBy: { startsAt: 'asc' },
      take: query.limit,
      include: {
        branch: { select: { name: true } },
        patient: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            patientInsurancePolicies: {
              where: { tenantId: request.auth.tenantId, active: true },
              orderBy: { updatedAt: 'desc' },
              take: 1,
              include: { payer: { select: { name: true } } },
            },
            eligibilityVerifications: {
              where: { tenantId: request.auth.tenantId },
              orderBy: { checkedAt: 'desc' },
              take: 1,
              include: { payer: { select: { name: true } }, policy: { select: { memberId: true, groupNumber: true } } },
            },
            priorAuthorizations: {
              where: { tenantId: request.auth.tenantId },
              orderBy: [{ dueAt: 'asc' }, { updatedAt: 'desc' }],
              take: 1,
            },
          },
        },
      },
    });

    await audit(request, { action: 'eligibility.appointmentQueue.list', resource: 'appointment', metadata: { count: rows.length, branchId: request.auth.branchId ?? query.branchId ?? null } });
    return { appointments: rows.map(mapAppointmentQueueRow) };
  });

  app.post('/eligibility/check', { preHandler: [insuranceFeature, billingWrite] }, async (request, reply) => {
    const body = z.object({
      branchId: uuid.optional(),
      patientId: uuid.optional(),
      appointmentId: uuid.optional(),
      payerId: uuid.optional(),
      policyId: uuid.optional(),
      serviceType: z.string().trim().min(2).max(120).optional(),
    }).parse(request.body);

    if (!body.patientId && !body.appointmentId) {
      throw app.httpErrors.badRequest('A patient or appointment context is required');
    }

    // Truthful provider gating: never fabricate an eligible result when the
    // eligibility provider is unconfigured (and never run mock in production).
    const providerStatus = eligibilityProviderStatus();
    if (providerStatus.setupRequired) {
      return reply.code(200).send({ status: 'setup_required', setupRequired: true, provider: providerStatus.provider, missing: providerStatus.missing, message: `Configure the ${providerStatus.provider} eligibility provider to run real checks.` });
    }
    const entities = await resolveBranchIdAndEntities(request, { tenantId: request.auth.tenantId, branchId: request.auth.branchId ?? undefined }, body);
    if (body.patientId && !entities.patient) throw app.httpErrors.notFound('Patient not found');
    if (body.appointmentId && !entities.appointment) throw app.httpErrors.notFound('Appointment not found');
    const payer = body.payerId
      ? await db.insurancePayer.findFirst({ where: { id: body.payerId, tenantId: request.auth.tenantId, active: true } })
      : await selectDefaultPayer({ tenantId: request.auth.tenantId, branchId: entities.branchId });
    const policy = await ensurePolicy({ tenantId: request.auth.tenantId, branchId: entities.branchId }, entities, payer?.id, body.policyId);
    if (!policy || !policy.payer) throw app.httpErrors.badRequest('Select an active patient policy with a configured payer before checking eligibility');
    if (payer && policy.payer.id !== payer.id) throw app.httpErrors.badRequest('Selected payer does not match the policy');
    const selectedPayer = payer ?? policy.payer;
    const provider = createInsuranceProvider();
    const patientId = entities.patient?.id ?? body.patientId!;
    const appointmentId = entities.appointment?.id ?? body.appointmentId ?? null;
    const rawIdempotencyKey = eligibilityIdempotencyKey(request);

    try {
      const execution = await runEligibilityExecution({
        context: {
          tenantId: request.auth.tenantId,
          branchId: entities.branchId,
          patientId,
          appointmentId,
          payerId: selectedPayer.id,
          policyId: policy.id,
          actorUserId: request.auth.userId,
          requestId: request.id,
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'],
        },
        rawIdempotencyKey,
        fingerprintParts: {
          contract: 'revenue_protection_v1',
          branchId: entities.branchId,
          patientId,
          appointmentId,
          payerId: selectedPayer.id,
          policyId: policy.id,
          memberId: policy.memberId,
          providerKey: provider.providerKey,
          serviceType: body.serviceType ?? entities.appointment?.service ?? null,
        },
        requestContract: 'revenue_protection_v1',
        providerKey: provider.providerKey,
        providerMode: provider.mode,
        executeProvider: providerExecutionKey => provider.runEligibilityCheck({
          tenantId: request.auth.tenantId,
          branchId: entities.branchId,
          providerExecutionKey,
          patient: entities.patient ?? undefined,
          appointment: entities.appointment ?? undefined,
          payer: { id: selectedPayer.id, name: selectedPayer.name, tradingPartnerServiceId: selectedPayer.tradingPartnerServiceId, sourceProvider: selectedPayer.sourceProvider },
          policy: {
            id: policy.id,
            planName: policy.planName,
            memberId: policy.memberId,
            groupNumber: policy.groupNumber,
            subscriberName: policy.subscriberName,
          },
          serviceType: body.serviceType ?? entities.appointment?.service,
        }),
        finalize: async (tx, outcome, executionId) => {
          const verifiedAt = new Date();
          const missing = new Set(outcome.missingBenefitFields);
          const payerReference = outcome.payerReference.includes(policy.memberId) ? null : outcome.payerReference;
          const verification = await tx.eligibilityVerification.create({
            data: {
              tenantId: request.auth.tenantId,
              branchId: entities.branchId,
              patientId,
              appointmentId: appointmentId ?? undefined,
              payerId: selectedPayer.id,
              policyId: policy.id,
              providerMode: outcome.providerMode,
              coverageStatus: outcome.coverageStatus,
              planName: outcome.planName,
              payerName: outcome.payerName,
              copay: missing.has('copay') ? null : outcome.copay,
              deductibleRemaining: missing.has('deductibleRemaining') ? null : outcome.deductibleRemaining,
              coinsurance: missing.has('coinsurance') ? null : outcome.coinsurance,
              coverageActive: outcome.coverageActive,
              eligibilityMessage: outcome.eligibilityMessage,
              payerReference,
              decisionSource: outcome.providerMode === 'live' ? 'PAYER_RESPONSE' : 'SIMULATED',
              effectiveFrom: outcome.effectiveFrom ? new Date(outcome.effectiveFrom) : null,
              expiresAt: outcome.expiresAt ? new Date(outcome.expiresAt) : null,
              normalizedResponse: {
                coverageStatus: outcome.coverageStatus,
                planName: outcome.planName,
                payerName: outcome.payerName,
                copay: missing.has('copay') ? null : outcome.copay,
                deductibleRemaining: missing.has('deductibleRemaining') ? null : outcome.deductibleRemaining,
                coinsurance: missing.has('coinsurance') ? null : outcome.coinsurance,
                coverageActive: outcome.coverageActive,
                eligibilityMessage: outcome.eligibilityMessage,
                payerReference,
                checkedAt: outcome.checkedAt,
                effectiveFrom: outcome.effectiveFrom,
                expiresAt: outcome.expiresAt,
                providerMode: outcome.providerMode,
                providerName: outcome.providerName,
                needsPriorAuth: outcome.needsPriorAuth,
                priorAuthRequired: outcome.priorAuthRequired,
                benefitUncertainty: outcome.benefitUncertainty,
                riskLevel: outcome.riskLevel,
                recommendedAction: outcome.recommendedAction,
                revenueAtRisk: outcome.revenueAtRisk,
                benefitDataIncomplete: outcome.benefitDataIncomplete,
                missingBenefitFields: outcome.missingBenefitFields,
              } as Prisma.InputJsonValue,
            },
          });
          await tx.patient.updateMany({
            where: { id: patientId, tenantId: request.auth.tenantId },
            data: { eligibilityStatus: outcome.coverageActive ? 'ACTIVE' : 'INACTIVE', eligibilityLastVerifiedAt: verifiedAt },
          });
          if (appointmentId) {
            await tx.appointment.updateMany({
              where: { id: appointmentId, tenantId: request.auth.tenantId },
              data: { eligibilityStatus: outcome.coverageActive ? 'ACTIVE' : 'INACTIVE', eligibilityLastVerifiedAt: verifiedAt },
            });
          }
          await tx.patientInsurancePolicy.update({
            where: { id: policy.id },
            data: { verificationStatus: outcome.coverageActive ? 'verified' : 'inactive', verifiedAt },
          });
          await tx.benefitSnapshot.create({
            data: {
              tenantId: request.auth.tenantId,
              branchId: entities.branchId,
              verificationId: verification.id,
              summary: outcome.eligibilityMessage,
              details: {
                coverageStatus: outcome.coverageStatus,
                payerName: outcome.payerName,
                planName: outcome.planName,
                copay: missing.has('copay') ? null : outcome.copay,
                deductibleRemaining: missing.has('deductibleRemaining') ? null : outcome.deductibleRemaining,
                coinsurance: missing.has('coinsurance') ? null : outcome.coinsurance,
                needsPriorAuth: outcome.needsPriorAuth,
                benefitUncertainty: outcome.benefitUncertainty,
              },
            },
          });
          if (entities.patient) {
            await buildResponsibilityEstimate(
              { tenantId: request.auth.tenantId, branchId: entities.branchId },
              entities.branchId,
              entities.patient.id,
              appointmentId,
              verification.id,
              outcome,
              tx,
            );
          }
          await createEligibilityAlert(
            { tenantId: request.auth.tenantId, branchId: entities.branchId },
            entities.branchId,
            patientId,
            appointmentId,
            outcome,
            verification.id,
            tx,
          );
          await tx.integrationRunLog.create({
            data: {
              tenantId: request.auth.tenantId,
              branchId: entities.branchId,
              provider: provider.providerKey,
              providerMode: outcome.providerMode,
              operation: 'eligibility.check',
              status: 'success',
              requestSummary: { executionId, patientId, appointmentId, payerId: selectedPayer.id },
              responseSummary: { coverageStatus: outcome.coverageStatus, benefitDataIncomplete: outcome.benefitDataIncomplete },
            },
          });
          const eligEvent = !outcome.coverageActive ? 'insurance.eligibility.failed' : outcome.benefitUncertainty ? 'insurance.eligibility.needs_review' : 'insurance.eligibility.completed';
          await tx.businessEvent.create({
            data: {
              tenantId: request.auth.tenantId,
              eventType: eligEvent,
              entityType: 'eligibilityVerification',
              entityId: verification.id,
              sourceModule: 'insurance',
              payload: { coverageStatus: outcome.coverageStatus, appointmentId, executionId },
            },
          });
          return {
            verificationId: verification.id,
            result: await buildRevenueEligibilityResponse(request.auth.tenantId, verification.id, tx),
            auditMetadata: { branchId: entities.branchId, providerMode: outcome.providerMode, coverageStatus: outcome.coverageStatus },
          };
        },
        replay: verificationId => buildRevenueEligibilityResponse(request.auth.tenantId, verificationId),
      });
      if (!execution.replayed && execution.result.appointmentId) {
        await runDenialPreventionForAppointment(request.auth.tenantId, execution.result.appointmentId, { actorUserId: request.auth.userId, branchId: entities.branchId }).catch(() => {});
      }
      return reply.send({ ...execution.result, executionId: execution.executionId, replayed: execution.replayed });
    } catch (error) {
      if (!(error instanceof EligibilityExecutionConflictError)) throw error;
      return reply.code(409).send({
        status: error.code,
        executionId: error.executionId,
        retryable: false,
        message: error.code === 'reconciliation_required'
          ? 'The payer outcome is ambiguous and requires staff reconciliation. The provider was not called again.'
          : 'This eligibility execution cannot be repeated with the supplied idempotency key.',
      });
    }
  });

  app.patch('/eligibility/:id/status', { preHandler: [insuranceFeature, billingWrite] }, async (request, reply) => {
    const params = z.object({ id: uuid }).parse(request.params);
    const body = z.object({ coverageStatus: z.string().min(2).max(80) }).parse(request.body);
    const existing = await db.eligibilityVerification.findFirst({
      where: { id: params.id, tenantId: request.auth.tenantId },
      include: { patient: { select: { firstName: true, lastName: true } }, branch: { select: { name: true } }, policy: true },
    });
    if (!existing) throw app.httpErrors.notFound('Eligibility verification not found');
    assertBranchAccess(request, existing.branchId);

    const row = await db.eligibilityVerification.update({
      where: { id: params.id },
      data: {
        coverageStatus: body.coverageStatus,
        coverageActive: body.coverageStatus.toLowerCase().includes('active') || body.coverageStatus.toLowerCase().includes('verified'),
        eligibilityMessage: body.coverageStatus === 'verified'
          ? 'Coverage manually verified by the front desk.'
          : existing.eligibilityMessage,
      },
    });

    if (existing.policyId) {
      await db.patientInsurancePolicy.update({
        where: { id: existing.policyId },
        data: { verificationStatus: body.coverageStatus.toLowerCase(), verifiedAt: new Date() },
      });
    }

    await audit(request, {
      action: 'eligibility.status.updated',
      resource: 'eligibilityVerification',
      resourceId: row.id,
      metadata: { coverageStatus: body.coverageStatus },
    });

    return reply.send({
      id: row.id,
      coverageStatus: row.coverageStatus,
      coverageActive: row.coverageActive,
      checkedAt: row.checkedAt.toISOString(),
    });
  });

  app.get('/prior-auth', { preHandler: [insuranceFeature, billingRead] }, async request => {
    const query = listLimit.parse(request.query);
    const filter = branchFilter(request, query.branchId);
    const rows = await db.priorAuthorization.findMany({
      where: { tenantId: request.auth.tenantId, ...filter },
      orderBy: [{ dueAt: 'asc' }, { updatedAt: 'desc' }],
      take: query.limit,
      include: { branch: { select: { name: true } }, patient: { select: { firstName: true, lastName: true } }, payer: { select: { name: true } } },
    });
    await audit(request, { action: 'priorAuth.list', resource: 'priorAuthorization', metadata: { count: rows.length, branchId: request.auth.branchId ?? query.branchId ?? null } });
    return { priorAuthorizations: rows.map(mapPriorAuth) };
  });

  app.patch('/prior-auth/:id/status', { preHandler: [insuranceFeature, billingWrite] }, async (request, reply) => {
    const params = z.object({ id: uuid }).parse(request.params);
    const body = z.object({
      status: z.string().min(2).max(80),
      notes: z.string().max(1000).optional(),
    }).parse(request.body);
    const existing = await db.priorAuthorization.findFirst({
      where: { id: params.id, tenantId: request.auth.tenantId },
    });
    if (!existing) throw app.httpErrors.notFound('Prior authorization not found');
    assertBranchAccess(request, existing.branchId);
    const row = await db.priorAuthorization.update({
      where: { id: params.id },
      data: { status: body.status, notes: body.notes ?? existing.notes, lastUpdatedAt: new Date() },
    });
    await audit(request, {
      action: 'priorAuth.status.updated',
      resource: 'priorAuthorization',
      resourceId: row.id,
      metadata: { status: body.status },
    });
    await emitBusinessEvent(request.auth.tenantId, { eventType: 'insurance.prior_auth.updated', entityType: 'priorAuthorization', entityId: row.id, sourceModule: 'insurance', payload: { status: row.status, appointmentId: row.appointmentId } }).catch(() => {});
    if (row.appointmentId) {
      await runDenialPreventionForAppointment(request.auth.tenantId, row.appointmentId, { actorUserId: request.auth.userId, branchId: row.branchId }).catch(() => {});
    }
    return reply.send({
      id: row.id,
      status: row.status,
      notes: row.notes ?? null,
      lastUpdatedAt: row.lastUpdatedAt?.toISOString() ?? null,
    });
  });

  app.get('/payments', { preHandler: [paymentsFeature, billingRead] }, async request => {
    const query = listLimit.parse(request.query);
    const filter = branchFilter(request, query.branchId);
    const [paymentRequests, paymentTransactions, depositRequirements] = await Promise.all([
      db.paymentRequest.findMany({
        where: { tenantId: request.auth.tenantId, ...filter },
        orderBy: { createdAt: 'desc' },
        take: query.limit,
        include: { branch: { select: { name: true } }, patient: { select: { firstName: true, lastName: true } }, appointment: { select: { service: true } } },
      }),
      db.paymentTransaction.findMany({
        where: { tenantId: request.auth.tenantId, ...filter },
        orderBy: { createdAt: 'desc' },
        take: query.limit,
        include: { branch: { select: { name: true } }, patient: { select: { firstName: true, lastName: true } } },
      }),
      // RLS (B-3): the depositRule include reads a tenant-isolated table, so
      // this read runs under tenant context (payment reads above are untouched).
      runWithTenantContext(request.auth.tenantId, tx => tx.depositRequirement.findMany({
        where: { tenantId: request.auth.tenantId, ...filter },
        orderBy: { createdAt: 'desc' },
        take: query.limit,
        include: { branch: { select: { name: true } }, patient: { select: { firstName: true, lastName: true } }, appointment: { select: { service: true } }, depositRule: { select: { name: true } } },
      })),
    ]);
    const result = {
      paymentRequests: paymentRequests.map(mapPaymentRequest),
      paymentTransactions: paymentTransactions.map(mapTransaction),
      depositRequirements: depositRequirements.map(mapDepositRequirement),
    };
    await audit(request, { action: 'payment.list', resource: 'paymentRequest', metadata: { requestCount: paymentRequests.length, transactionCount: paymentTransactions.length, branchId: request.auth.branchId ?? query.branchId ?? null } });
    return result;
  });

  app.post('/payment/request', { preHandler: [paymentsFeature, billingWrite] }, async (request, reply) => {
    const body = z.object({
      branchId: uuid.optional(),
      patientId: uuid.optional(),
      appointmentId: uuid.optional(),
      amount: z.coerce.number().min(0),
      reason: z.string().min(2).max(240),
      depositRuleId: uuid.optional(),
      dueAt: z.coerce.date().optional(),
      createDepositRequirement: z.boolean().default(false),
    }).parse(request.body);

    if (!body.patientId && !body.appointmentId) {
      throw app.httpErrors.badRequest('A patient or appointment context is required');
    }

    // Truthful provider gating (matches checkout.ts): a placeholder/unconfigured
    // provider (square/paypal/clover/authorize_net, or Stripe without a key) must
    // NOT issue a "real" payment request. Fail fast BEFORE claiming idempotency or
    // persisting anything so no fabricated request is created in a pilot posture.
    const paymentStatus = paymentProviderStatus();
    if (paymentStatus.setupRequired) {
      return reply.code(200).send({ status: 'setup_required', setupRequired: true, provider: paymentStatus.provider, message: `Connect ${paymentStatus.provider} to issue real payment requests.` });
    }

    // Optional client idempotency: replays with the same Idempotency-Key return
    // the original payment request instead of creating a duplicate (and a
    // duplicate provider charge).
    const idempotencyHeader = typeof request.headers['idempotency-key'] === 'string' ? request.headers['idempotency-key'].trim() : '';
    const idempotencyScope = 'payment.request';
    const idempotencyKey = idempotencyHeader ? `${request.auth.tenantId}:${idempotencyHeader}` : '';
    if (idempotencyKey) {
      const claim = await claimIdempotency(idempotencyScope, idempotencyKey, request.auth.tenantId);
      if (!claim.claimed) {
        if (claim.resultId) {
          const existing = await db.paymentRequest.findFirst({
            where: { id: claim.resultId, tenantId: request.auth.tenantId },
            include: {
              branch: { select: { name: true } },
              patient: { select: { firstName: true, lastName: true } },
              appointment: { select: { service: true } },
              depositRequirements: { select: { id: true }, take: 1 },
            },
          });
          if (existing) {
            assertBranchAccess(request, existing.branchId);
            return reply.code(200).send({ ...mapPaymentRequest(existing), depositRequirementId: existing.depositRequirements[0]?.id ?? null });
          }
        }
        throw app.httpErrors.conflict('A payment request for this idempotency key is already being processed');
      }
    }

    const entities = await resolveBranchIdAndEntities(request, { tenantId: request.auth.tenantId, branchId: request.auth.branchId ?? undefined }, body);
    if (body.patientId && !entities.patient) throw app.httpErrors.notFound('Patient not found');
    if (body.appointmentId && !entities.appointment) throw app.httpErrors.notFound('Appointment not found');
    const depositRule = await resolveDepositRuleForBranch(request, body.depositRuleId, entities.branchId);
    const provider = createPaymentProvider();
    let outcome: PaymentOutcome;
    try {
      outcome = await provider.createPaymentRequest({
          tenantId: request.auth.tenantId,
          branchId: entities.branchId,
          patient: entities.patient ?? undefined,
          appointment: entities.appointment ?? undefined,
          amount: body.amount,
          reason: body.reason,
          depositRule: depositRule
            ? { id: depositRule.id, name: depositRule.name, ruleType: depositRule.ruleType, depositRequired: depositRule.depositRequired, amountType: depositRule.amountType, amountValue: toNumber(depositRule.amountValue), refundable: depositRule.refundable, cancellationWindowHours: depositRule.cancellationWindowHours }
            : undefined,
      });
    } catch (error) {
      if (!(error instanceof ProviderOperationError)) throw error;
      await emitBusinessEvent(request.auth.tenantId, { eventType: 'payment.failed', entityType: 'appointment', entityId: body.appointmentId ?? body.patientId ?? null, sourceModule: 'revenue-protection', payload: { provider: paymentStatus.provider, reason: 'provider_unavailable' } }).catch(() => {});
      return reply.code(503).send({
        status: 'provider_unavailable', retryable: false, reconciliationRequired: true,
        provider: paymentStatus.provider,
        message: 'The payment provider did not confirm the outcome. No local payment request was created; reconcile with the provider before retrying.',
      });
    }

    const requestRow = await db.paymentRequest.create({
      data: {
        tenantId: request.auth.tenantId,
        branchId: entities.branchId,
        patientId: entities.patient?.id ?? body.patientId ?? undefined,
        appointmentId: entities.appointment?.id ?? body.appointmentId ?? undefined,
        paymentProviderConnectionId: undefined,
        amount: outcome.amount,
        currency: outcome.currency,
        status: outcome.status,
        reason: body.reason,
        mode: outcome.providerMode,
        paymentUrl: outcome.paymentUrl ?? null,
        providerReference: outcome.providerReference,
        dueAt: body.dueAt ?? new Date(),
      },
      include: { branch: { select: { name: true } }, patient: { select: { firstName: true, lastName: true } }, appointment: { select: { service: true } } },
    });

    let depositRequirement = null;
    if (body.createDepositRequirement || body.depositRuleId) {
      depositRequirement = await db.depositRequirement.create({
        data: {
          tenantId: request.auth.tenantId,
          branchId: entities.branchId,
          patientId: entities.patient?.id ?? body.patientId ?? undefined,
          appointmentId: entities.appointment?.id ?? body.appointmentId ?? undefined,
          depositRuleId: body.depositRuleId ?? undefined,
          paymentRequestId: requestRow.id,
          status: 'requested',
          requiredAmount: outcome.amount,
          collectedAmount: 0,
          reason: body.reason,
          mode: outcome.providerMode,
          dueAt: body.dueAt ?? new Date(),
        },
      });
    }

    await db.integrationRunLog.create({
      data: {
        tenantId: request.auth.tenantId,
        branchId: entities.branchId,
        provider: provider.providerKey,
        providerMode: outcome.providerMode,
        operation: 'payment.request',
        status: 'success',
        requestSummary: {
          patientId: entities.patient?.id ?? body.patientId ?? null,
          appointmentId: entities.appointment?.id ?? body.appointmentId ?? null,
          amount: body.amount,
          reason: body.reason,
        },
        responseSummary: {
          providerReference: outcome.providerReference,
          paymentUrl: outcome.paymentUrl ?? null,
        },
      },
    });

    if (idempotencyKey) {
      await recordIdempotencyResult(idempotencyScope, idempotencyKey, requestRow.id);
    }

    await audit(request, {
      action: 'payment.request.created',
      resource: 'paymentRequest',
      resourceId: requestRow.id,
      metadata: { amount: outcome.amount, providerReference: outcome.providerReference },
    });

    return reply.code(201).send({
      id: requestRow.id,
      branchId: requestRow.branchId,
      branchName: requestRow.branch.name,
      patientId: requestRow.patientId ?? null,
      patientName: requestRow.patient ? `${requestRow.patient.firstName} ${requestRow.patient.lastName}` : '—',
      appointmentId: requestRow.appointmentId ?? null,
      appointmentService: requestRow.appointment?.service ?? null,
      amount: toNumber(requestRow.amount),
      currency: requestRow.currency,
      status: requestRow.status,
      reason: requestRow.reason,
      mode: requestRow.mode,
      paymentUrl: requestRow.paymentUrl ?? null,
      providerReference: requestRow.providerReference ?? null,
      dueAt: requestRow.dueAt?.toISOString() ?? null,
      depositRequirementId: depositRequirement ? depositRequirement.id : null,
    });
  });

  app.post('/payment-link', { preHandler: [paymentsFeature, billingWrite] }, async (request, reply) => {
    const body = z.object({
      branchId: uuid.optional(),
      patientId: uuid.optional(),
      appointmentId: uuid.optional(),
      amount: z.coerce.number().min(0),
      reason: z.string().min(2).max(240),
      depositRuleId: uuid.optional(),
      dueAt: z.coerce.date().optional(),
      createDepositRequirement: z.boolean().default(true),
    }).parse(request.body);

    if (!body.patientId && !body.appointmentId) {
      throw app.httpErrors.badRequest('A patient or appointment context is required');
    }

    // Truthful provider gating (matches checkout.ts): never fabricate a payment
    // link from a placeholder/unconfigured provider.
    const linkProviderStatus = paymentProviderStatus();
    if (linkProviderStatus.setupRequired) {
      return reply.code(200).send({ status: 'setup_required', setupRequired: true, provider: linkProviderStatus.provider, message: `Connect ${linkProviderStatus.provider} to generate real payment links.` });
    }

    const entities = await resolveBranchIdAndEntities(request, { tenantId: request.auth.tenantId, branchId: request.auth.branchId ?? undefined }, body);
    if (body.patientId && !entities.patient) throw app.httpErrors.notFound('Patient not found');
    if (body.appointmentId && !entities.appointment) throw app.httpErrors.notFound('Appointment not found');
    const depositRule = await resolveDepositRuleForBranch(request, body.depositRuleId, entities.branchId);
    const provider = createPaymentProvider();
    let outcome: PaymentOutcome;
    try {
      outcome = await provider.createPaymentLink({
        tenantId: request.auth.tenantId,
        branchId: entities.branchId,
        patient: entities.patient ?? undefined,
        appointment: entities.appointment ?? undefined,
        amount: body.amount,
        reason: body.reason,
        depositRule: depositRule
          ? { id: depositRule.id, name: depositRule.name, ruleType: depositRule.ruleType, depositRequired: depositRule.depositRequired, amountType: depositRule.amountType, amountValue: toNumber(depositRule.amountValue), refundable: depositRule.refundable, cancellationWindowHours: depositRule.cancellationWindowHours }
          : undefined,
      });
    } catch (error) {
      if (!(error instanceof ProviderOperationError)) throw error;
      await emitBusinessEvent(request.auth.tenantId, { eventType: 'payment.failed', entityType: 'appointment', entityId: body.appointmentId ?? body.patientId ?? null, sourceModule: 'revenue-protection', payload: { provider: linkProviderStatus.provider, reason: 'provider_unavailable' } }).catch(() => {});
      return reply.code(503).send({
        status: 'provider_unavailable', retryable: false, reconciliationRequired: true,
        provider: linkProviderStatus.provider,
        message: 'The payment provider did not confirm the link. No local payment request was created; reconcile with the provider before retrying.',
      });
    }

    const requestRow = await db.paymentRequest.create({
      data: {
        tenantId: request.auth.tenantId,
        branchId: entities.branchId,
        patientId: entities.patient?.id ?? body.patientId ?? undefined,
        appointmentId: entities.appointment?.id ?? body.appointmentId ?? undefined,
        amount: outcome.amount,
        currency: outcome.currency,
        status: 'link_sent',
        reason: body.reason,
        mode: outcome.providerMode,
        paymentUrl: outcome.paymentUrl ?? null,
        providerReference: outcome.providerReference,
        dueAt: body.dueAt ?? new Date(),
      },
      include: { branch: { select: { name: true } }, patient: { select: { firstName: true, lastName: true } }, appointment: { select: { service: true } } },
    });

    let depositRequirement = null;
    if (body.createDepositRequirement || body.depositRuleId) {
      depositRequirement = await db.depositRequirement.create({
        data: {
          tenantId: request.auth.tenantId,
          branchId: entities.branchId,
          patientId: entities.patient?.id ?? body.patientId ?? undefined,
          appointmentId: entities.appointment?.id ?? body.appointmentId ?? undefined,
          depositRuleId: body.depositRuleId ?? undefined,
          paymentRequestId: requestRow.id,
          status: 'requested',
          requiredAmount: outcome.amount,
          collectedAmount: 0,
          reason: body.reason,
          mode: outcome.providerMode,
          dueAt: body.dueAt ?? new Date(),
        },
      });
    }

    await db.integrationRunLog.create({
      data: {
        tenantId: request.auth.tenantId,
        branchId: entities.branchId,
        provider: provider.providerKey,
        providerMode: outcome.providerMode,
        operation: 'payment.link',
        status: 'success',
        requestSummary: {
          patientId: entities.patient?.id ?? body.patientId ?? null,
          appointmentId: entities.appointment?.id ?? body.appointmentId ?? null,
          amount: body.amount,
          reason: body.reason,
        },
        responseSummary: {
          providerReference: outcome.providerReference,
          paymentUrl: outcome.paymentUrl ?? null,
        },
      },
    });

    await audit(request, {
      action: 'payment.link.created',
      resource: 'paymentRequest',
      resourceId: requestRow.id,
      metadata: { providerReference: outcome.providerReference },
    });

    return reply.code(201).send({
      id: requestRow.id,
      branchId: requestRow.branchId,
      branchName: requestRow.branch.name,
      patientId: requestRow.patientId ?? null,
      patientName: requestRow.patient ? `${requestRow.patient.firstName} ${requestRow.patient.lastName}` : '—',
      appointmentId: requestRow.appointmentId ?? null,
      appointmentService: requestRow.appointment?.service ?? null,
      amount: toNumber(requestRow.amount),
      currency: requestRow.currency,
      status: requestRow.status,
      reason: requestRow.reason,
      mode: requestRow.mode,
      paymentUrl: requestRow.paymentUrl ?? null,
      providerReference: requestRow.providerReference ?? null,
      dueAt: requestRow.dueAt?.toISOString() ?? null,
      depositRequirementId: depositRequirement ? depositRequirement.id : null,
    });
  });

  app.patch('/payment/:id/status', { preHandler: [paymentsFeature, billingWrite] }, async (request, reply) => {
    const params = z.object({ id: uuid }).parse(request.params);
    const body = z.object({
      status: z.enum(PAYMENT_REQUEST_STATUSES),
      providerReference: z.string().max(120).optional(),
    }).parse(request.body);
    // Segregation of duties: FRONT_DESK cannot manually attest a collection.
    if (body.status === 'collected' && !COLLECT_PRIVILEGED_ROLES.includes(request.auth.role as typeof COLLECT_PRIVILEGED_ROLES[number])) {
      throw app.httpErrors.forbidden('Your role cannot manually mark a payment as collected');
    }
    const existing = await db.paymentRequest.findFirst({
      where: { id: params.id, tenantId: request.auth.tenantId },
    });
    if (!existing) throw app.httpErrors.notFound('Payment request not found');
    assertBranchAccess(request, existing.branchId);

    const isNewCollection = body.status === 'collected' && existing.status !== 'collected';
    const collectedAmount = toNumber(existing.amount);

    const row = await db.paymentRequest.update({
      where: { id: params.id },
      data: { status: body.status, providerReference: body.providerReference ?? existing.providerReference },
    });

    if (isNewCollection) {
      await db.$transaction(async tx => {
        await tx.paymentTransaction.create({
          data: {
            tenantId: request.auth.tenantId,
            branchId: row.branchId,
            patientId: row.patientId ?? undefined,
            appointmentId: row.appointmentId ?? undefined,
            paymentRequestId: row.id,
            amount: row.amount,
            currency: row.currency,
            status: 'succeeded',
            mode: row.mode,
            providerReference: body.providerReference ?? row.providerReference ?? undefined,
            receivedAt: new Date(),
            rawResponse: {
              status: 'succeeded',
              source: 'manual',
              actorUserId: request.auth.userId,
            },
          },
        });
        // AR reconciliation: a real collection reduces the patient's outstanding
        // balance (clamped at 0 — the column is non-negative by constraint).
        if (row.patientId) {
          await decrementOutstandingBalance(request.auth.tenantId, row.patientId, collectedAmount, tx);
        }
      });
    }

    await audit(request, {
      action: 'payment.status.updated',
      resource: 'paymentRequest',
      resourceId: row.id,
      metadata: { status: body.status },
    });

    return reply.send({
      id: row.id,
      status: row.status,
      providerReference: row.providerReference ?? null,
    });
  });

  // Stripe webhook moved to the public, signature-verified plugin
  // `revenueProtectionWebhookRoutes` (registered outside the authenticated
  // scope, since Stripe cannot present a JWT).

  app.get('/deposit-rules', { preHandler: [paymentsFeature, billingRead] }, async request => {
    const query = listLimit.parse(request.query);
    const filter = branchFilter(request, query.branchId);
    const rows = await runWithTenantContext(request.auth.tenantId, tx => tx.depositRule.findMany({
      where: { tenantId: request.auth.tenantId, ...filter },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
      take: query.limit,
      include: { branch: { select: { name: true } } },
    }));
    await audit(request, { action: 'depositRule.list', resource: 'depositRule', metadata: { count: rows.length, branchId: request.auth.branchId ?? query.branchId ?? null } });
    return { depositRules: rows.map(mapDepositRule) };
  });

  app.post('/deposit-rules', { preHandler: [paymentsFeature, billingWrite] }, async (request, reply) => {
    const body = z.object({
      branchId: uuid.optional(),
      name: z.string().min(2).max(160),
      ruleType: z.string().min(2).max(80),
      description: z.string().min(2).max(500),
      active: z.boolean().default(true),
      depositRequired: z.boolean().default(true),
      amountType: z.string().min(2).max(40).default('fixed'),
      amountValue: z.coerce.number().min(0).default(0),
      refundable: z.boolean().default(true),
      cancellationWindowHours: z.coerce.number().int().min(0).default(24),
      appliesToNewPatients: z.boolean().default(false),
      appliesToHighNoShowRisk: z.boolean().default(false),
      appliesToPremiumServices: z.boolean().default(false),
      appliesToSameDayAppointments: z.boolean().default(false),
      appliesToExemptPatients: z.boolean().default(false),
      sortOrder: z.coerce.number().int().min(0).default(0),
    }).parse(request.body);
    const branchId = branchIdForWrite(request, body.branchId);
    if (branchId) assertBranchAccess(request, branchId);
    const row = await runWithTenantContext(request.auth.tenantId, tx => tx.depositRule.create({
      data: {
        tenantId: request.auth.tenantId,
        branchId: branchId ?? undefined,
        name: body.name,
        ruleType: body.ruleType,
        description: body.description,
        active: body.active,
        depositRequired: body.depositRequired,
        amountType: body.amountType,
        amountValue: body.amountValue,
        refundable: body.refundable,
        cancellationWindowHours: body.cancellationWindowHours,
        appliesToNewPatients: body.appliesToNewPatients,
        appliesToHighNoShowRisk: body.appliesToHighNoShowRisk,
        appliesToPremiumServices: body.appliesToPremiumServices,
        appliesToSameDayAppointments: body.appliesToSameDayAppointments,
        appliesToExemptPatients: body.appliesToExemptPatients,
        sortOrder: body.sortOrder,
      },
      include: { branch: { select: { name: true } } },
    }));
    await audit(request, { action: 'depositRule.created', resource: 'depositRule', resourceId: row.id });
    return reply.code(201).send(mapDepositRule(row));
  });

  app.patch('/deposit-rules/:id', { preHandler: [paymentsFeature, billingWrite] }, async (request, reply) => {
    const params = z.object({ id: uuid }).parse(request.params);
    const body = z.object({
      branchId: uuid.optional(),
      name: z.string().min(2).max(160).optional(),
      ruleType: z.string().min(2).max(80).optional(),
      description: z.string().min(2).max(500).optional(),
      active: z.boolean().optional(),
      depositRequired: z.boolean().optional(),
      amountType: z.string().min(2).max(40).optional(),
      amountValue: z.coerce.number().min(0).optional(),
      refundable: z.boolean().optional(),
      cancellationWindowHours: z.coerce.number().int().min(0).optional(),
      appliesToNewPatients: z.boolean().optional(),
      appliesToHighNoShowRisk: z.boolean().optional(),
      appliesToPremiumServices: z.boolean().optional(),
      appliesToSameDayAppointments: z.boolean().optional(),
      appliesToExemptPatients: z.boolean().optional(),
      sortOrder: z.coerce.number().int().min(0).optional(),
    }).parse(request.body);
    const row = await runWithTenantContext(request.auth.tenantId, async tx => {
      const existing = await tx.depositRule.findFirst({ where: { id: params.id, tenantId: request.auth.tenantId } });
      if (!existing) throw app.httpErrors.notFound('Deposit rule not found');
      assertBranchAccess(request, existing.branchId ?? request.auth.branchId ?? existing.branchId ?? '');
      if (request.auth.branchId && !existing.branchId) {
        throw app.httpErrors.forbidden('Branch-restricted accounts cannot modify tenant-wide deposit rules');
      }
      const targetBranchId = body.branchId === undefined ? existing.branchId : branchIdForWrite(request, body.branchId);
      if (targetBranchId) assertBranchAccess(request, targetBranchId);
      return tx.depositRule.update({
        where: { id: params.id },
        data: {
          ...body,
          branchId: targetBranchId ?? existing.branchId ?? undefined,
        },
        include: { branch: { select: { name: true } } },
      });
    });
    await audit(request, { action: 'depositRule.updated', resource: 'depositRule', resourceId: row.id, metadata: body });
    return reply.send(mapDepositRule(row));
  });

  app.patch('/deposit-requirements/:id/status', { preHandler: [paymentsFeature, billingWrite] }, async (request, reply) => {
    const params = z.object({ id: uuid }).parse(request.params);
    const body = z.object({
      status: z.enum(DEPOSIT_REQUIREMENT_STATUSES),
      reason: z.string().max(240).optional(),
      collectedAmount: z.coerce.number().min(0).optional(),
      waiverReason: z.string().max(240).optional(),
    }).parse(request.body);
    // Segregation of duties: FRONT_DESK cannot manually attest a collection.
    if (body.status === 'collected' && !COLLECT_PRIVILEGED_ROLES.includes(request.auth.role as typeof COLLECT_PRIVILEGED_ROLES[number])) {
      throw app.httpErrors.forbidden('Your role cannot manually mark a deposit as collected');
    }
    const existing = await db.depositRequirement.findFirst({
      where: { id: params.id, tenantId: request.auth.tenantId },
    });
    if (!existing) throw app.httpErrors.notFound('Deposit requirement not found');
    assertBranchAccess(request, existing.branchId);

    // Integrity: a manual collectedAmount can never exceed the required amount —
    // otherwise revenue is fabricated beyond what was ever owed.
    const requiredAmount = toNumber(existing.requiredAmount);
    if (body.collectedAmount != null && body.collectedAmount > requiredAmount) {
      throw app.httpErrors.badRequest('collectedAmount cannot exceed the required amount');
    }
    const isNewCollection = body.status === 'collected' && existing.status !== 'collected';
    const collectedAmount = body.collectedAmount ?? (isNewCollection ? requiredAmount : toNumber(existing.collectedAmount));

    const row = await db.depositRequirement.update({
      where: { id: params.id },
      data: {
        status: body.status,
        collectedAmount,
        waiverReason: body.waiverReason ?? existing.waiverReason,
        collectedAt: body.status === 'collected' ? new Date() : existing.collectedAt,
        reason: body.reason ?? existing.reason,
      },
    });

    // AR reconciliation: a fresh manual deposit collection reduces the patient's
    // outstanding balance (tenant-scoped, clamped at 0).
    if (isNewCollection && existing.patientId) {
      await decrementOutstandingBalance(request.auth.tenantId, existing.patientId, collectedAmount);
    }

    await audit(request, {
      action: 'depositRequirement.status.updated',
      resource: 'depositRequirement',
      resourceId: row.id,
      metadata: { status: body.status },
    });

    return reply.send({
      id: row.id,
      status: row.status,
      requiredAmount: toNumber(row.requiredAmount),
      collectedAmount: toNumber(row.collectedAmount),
      waiverReason: row.waiverReason ?? null,
      collectedAt: row.collectedAt?.toISOString() ?? null,
    });
  });

  app.get('/leaks', { preHandler: billingRead }, async request => {
    const query = listLimit.parse(request.query);
    const filter = branchFilter(request, query.branchId);
    const rows = await runWithTenantContext(request.auth.tenantId, tx => tx.revenueProtectionAlert.findMany({
      where: { tenantId: request.auth.tenantId, ...filter },
      orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }],
      take: query.limit,
      include: {
        branch: { select: { name: true } },
        patient: { select: { firstName: true, lastName: true } },
        appointment: { select: { service: true } },
      },
    }));
    await audit(request, { action: 'revenueProtectionAlert.list', resource: 'revenueProtectionAlert', metadata: { count: rows.length, branchId: request.auth.branchId ?? query.branchId ?? null } });
    return { revenueProtectionAlerts: rows.map(mapAlert) };
  });

  app.patch('/leaks/:id/status', { preHandler: billingWrite }, async (request, reply) => {
    const params = z.object({ id: uuid }).parse(request.params);
    const body = z.object({
      status: z.string().min(2).max(80),
      createRecoveryTask: z.boolean().default(false),
      taskTitle: z.string().max(240).optional(),
      taskPriority: z.string().max(40).optional(),
    }).parse(request.body);
    const { existing, row } = await runWithTenantContext(request.auth.tenantId, async tx => {
      const existing = await tx.revenueProtectionAlert.findFirst({
        where: { id: params.id, tenantId: request.auth.tenantId },
        include: {
          patient: { select: { firstName: true, lastName: true } },
          appointment: { select: { service: true } },
          branch: { select: { name: true } },
        },
      });
      if (!existing) throw app.httpErrors.notFound('Revenue protection alert not found');
      assertBranchAccess(request, existing.branchId);
      const row = await tx.revenueProtectionAlert.update({
        where: { id: params.id },
        data: { status: body.status },
      });
      return { existing, row };
    });

    let task = null;
    if (body.createRecoveryTask || body.status === 'task_created') {
      task = await db.staffTask.create({
        data: {
          tenantId: request.auth.tenantId,
          branchId: existing.branchId,
          title: body.taskTitle ?? `${existing.title} recovery task`,
          priority: body.taskPriority ?? (existing.severity === 'high' ? 'high' : 'medium'),
        },
      });
    }

    await audit(request, {
      action: 'revenueProtectionAlert.status.updated',
      resource: 'revenueProtectionAlert',
      resourceId: row.id,
      metadata: { status: body.status, taskId: task?.id ?? null },
    });

    return reply.send({
      id: row.id,
      status: row.status,
      taskId: task?.id ?? null,
    });
  });
};

// ===========================================================================
// Public Stripe webhook (no JWT — Stripe cannot present one).
// Verifies the Stripe signature over the raw body, is idempotent on the Stripe
// event id, and never double-records a payment transaction on redelivery.
// ===========================================================================
export const revenueProtectionWebhookRoutes: FastifyPluginAsync = async app => {
  app.post('/webhooks/stripe', async (request, reply) => {
    const secret = env.STRIPE_WEBHOOK_SECRET;
    const signatureRaw = request.headers['stripe-signature'];
    const signatureHeader = Array.isArray(signatureRaw) ? signatureRaw[0] : signatureRaw;

    if (secret) {
      if (!verifyStripeSignature(request.rawBody, signatureHeader, secret)) {
        request.log.warn({ ip: request.ip }, 'Stripe webhook signature verification failed');
        return reply.code(400).send({ error: 'INVALID_SIGNATURE' });
      }
    } else {
      // A webhook without a configured verifier cannot establish tenant
      // authority in any environment.
      request.log.error('Stripe webhook rejected: STRIPE_WEBHOOK_SECRET not configured');
      return reply.code(503).send({ error: 'WEBHOOK_NOT_CONFIGURED' });
    }

    const event = z.object({
      id: z.string(),
      type: z.string(),
      data: z.object({ object: z.record(z.string(), z.unknown()).optional() }).partial().optional(),
    }).partial().parse(request.body ?? {});
    if (!event.id || !event.type) return reply.code(400).send({ error: 'INVALID_EVENT' });
    const eventId = event.id;

    const object = (event.data?.object ?? {}) as Record<string, unknown>;
    const candidates = [...new Set([object.id, object.payment_intent, object.client_reference_id].filter(
      (value): value is string => typeof value === 'string',
    ))];
    if (candidates.length === 0) {
      return reply.code(200).send({ received: true });
    }

    // The Stripe signature is verified above. Only then may the opaque provider
    // reference cross the narrow bootstrap resolver. Multiple distinct matches
    // fail closed instead of selecting an arbitrary tenant.
    const resolvedMatches = (await Promise.all(candidates.map(candidate =>
      resolveIngressTenant('stripe_provider_reference', candidate),
    ))).filter((row): row is NonNullable<typeof row> => row !== null);
    const distinctMatches = [...new Map(resolvedMatches.map(row => [`${row.tenantId}:${row.resourceId}`, row])).values()];
    if (distinctMatches.length !== 1) {
      request.log.info({ eventId: event.id, type: event.type }, 'Stripe webhook: no matching payment request');
      return reply.code(200).send({ received: true });
    }
    const resolved = distinctMatches[0];
    enterTenantContext({ tenantId: resolved.tenantId, actorId: `webhook:stripe:${resolved.resourceId}`, actorRole: 'WEBHOOK', source: 'webhook', requestId: request.id });

    // Idempotent on the Stripe event id, but crash-safe: a claimed key is only a
    // true DUPLICATE once processing has COMPLETED (recorded a resultId). A
    // claimed-but-not-completed key means a prior attempt threw before finishing.
    const claim = await claimIdempotency('stripe.webhook', event.id, resolved.tenantId);
    if (!claim.claimed && claim.resultId) {
      return reply.code(200).send({ received: true, duplicate: true });
    }

    const paymentRequest = await db.paymentRequest.findFirst({ where: { id: resolved.resourceId, providerReference: { in: candidates } } });
    if (!paymentRequest) return reply.code(200).send({ received: true, matched: false });

    // Audit receipt of the verified webhook (no PHI — ids + event type only).
    await db.auditEvent.create({ data: { tenantId: paymentRequest.tenantId, action: 'payment.webhook.received', resource: 'paymentRequest', resourceId: paymentRequest.id, ipAddress: request.ip, metadata: { eventId: event.id, type: event.type } } });

    const succeeded = ['checkout.session.completed', 'payment_intent.succeeded', 'charge.succeeded'].includes(event.type)
      || object.payment_status === 'paid';
    const refunded = event.type === 'charge.refunded';
    const disputed = event.type === 'charge.dispute.created';
    const failed = ['payment_intent.payment_failed', 'charge.failed'].includes(event.type);
    const expired = ['checkout.session.expired', 'payment_link.expired'].includes(event.type);

    // Reconcile against the ACTUAL settled amount reported by Stripe (minor units),
    // not the requested amount — a partial/adjusted settlement must be recorded truthfully.
    const eventMinorUnits = toNumber(object.amount_total ?? object.amount_received ?? object.amount);
    const settledAmount = eventMinorUnits > 0 ? eventMinorUnits / 100 : toNumber(paymentRequest.amount);
    const refundMinorUnits = toNumber(object.amount_refunded ?? object.amount);
    const refundAmount = refundMinorUnits > 0 ? refundMinorUnits / 100 : toNumber(paymentRequest.amount);

    if (succeeded) {
      const successResult = await db.$transaction(async tx => {
        const locked = await lockStripeReconciliation(tx, eventId, paymentRequest.id);
        if (locked.eventComplete) return 'duplicate' as const;
        // A provider may deliver a failure/expiry before the eventual success
        // for the same payment intent/session. Those states describe the last
        // observed attempt, not proof that money can never settle later.
        if (!['pending', 'link_sent', 'provider_pending', 'reconciliation_required', 'reconciliation_required_paid', 'failed', 'expired'].includes(locked.paymentStatus ?? '')) {
          await tx.idempotencyKey.updateMany({ where: { scope: 'stripe.webhook', key: event.id }, data: { resultId: paymentRequest.id } });
          return 'terminal_state' as const;
        }
        await tx.paymentTransaction.create({
          data: {
            tenantId: paymentRequest.tenantId,
            branchId: paymentRequest.branchId,
            patientId: paymentRequest.patientId ?? undefined,
            appointmentId: paymentRequest.appointmentId ?? undefined,
            paymentRequestId: paymentRequest.id,
            amount: settledAmount,
            currency: paymentRequest.currency,
            status: 'succeeded',
            mode: paymentRequest.mode,
            providerReference: typeof object.id === 'string' ? object.id : paymentRequest.providerReference ?? undefined,
            receivedAt: new Date(),
            rawResponse: { eventId: event.id, type: event.type, source: 'stripe-webhook', settledAmount },
          },
        });
        await tx.paymentRequest.update({ where: { id: paymentRequest.id }, data: { status: 'collected' } });
        // Appointment Checkout: settle the linked deposit requirement(s) at the
        // actually-settled amount.
        await tx.depositRequirement.updateMany({
          where: { tenantId: paymentRequest.tenantId, paymentRequestId: paymentRequest.id, status: { notIn: ['collected', 'waived'] } },
          data: { status: 'collected', collectedAmount: settledAmount, collectedAt: new Date() },
        });
        // AR reconciliation (#7): a real settlement reduces the patient's outstanding
        // balance (clamped at 0 — the column is non-negative by constraint).
        if (paymentRequest.patientId) {
          await tx.$executeRaw`UPDATE "Patient" SET "outstandingBalance" = GREATEST(0, "outstandingBalance" - ${settledAmount}::numeric) WHERE "id" = ${paymentRequest.patientId}::uuid AND "tenantId" = ${paymentRequest.tenantId}::uuid`;
        }
        await tx.integrationRunLog.create({
          data: {
            tenantId: paymentRequest.tenantId,
            branchId: paymentRequest.branchId,
            provider: 'stripe',
            providerMode: paymentRequest.mode,
            operation: 'webhook.payment',
            status: 'success',
            requestSummary: { eventId: event.id, type: event.type },
            responseSummary: { paymentRequestId: paymentRequest.id, settledAmount },
          },
        });
        await tx.auditEvent.create({
          data: {
            tenantId: paymentRequest.tenantId,
            action: 'payment.succeeded',
            resource: 'paymentRequest',
            resourceId: paymentRequest.id,
            metadata: { eventId: event.id, appointmentId: paymentRequest.appointmentId, settledAmount },
          },
        });
        // Mark the webhook idempotency key COMPLETED atomically with the money
        // movement: only now is a redelivery a true duplicate. If any step above
        // fails, this update rolls back too, leaving the key reprocessable.
        await tx.idempotencyKey.updateMany({ where: { scope: 'stripe.webhook', key: event.id }, data: { resultId: paymentRequest.id } });
        return 'processed' as const;
      });
      if (successResult === 'duplicate') return reply.code(200).send({ received: true, duplicate: true });
      if (successResult === 'terminal_state') return reply.code(200).send({ received: true, ignored: 'terminal_payment_state' });
      // The money movement, mandatory audit, and idempotency completion above
      // are already committed. Workflow propagation is optional downstream
      // fan-out: its failure must never turn a durably processed Stripe event
      // into a 500 that invites needless provider redelivery.
      try {
        await recordWorkflowEvent(paymentRequest.tenantId, { eventType: 'payment.succeeded', entityType: 'paymentRequest', entityId: paymentRequest.id, sourceModule: 'payments', payload: { appointmentId: paymentRequest.appointmentId } });
      } catch (error) {
        request.log.warn({ err: error, eventId: event.id, operation: 'payment_success_workflow_event' }, 'Optional payment success workflow event fan-out failed');
      }
    } else if (refunded) {
      // Stripe's amount_refunded is cumulative. Persist only the delta beyond
      // refunds already recorded for this request, keep a partial refund in the
      // collected state, and restore AR by exactly that delta.
      const refundResult = await db.$transaction(async tx => {
        const locked = await lockStripeReconciliation(tx, eventId, paymentRequest.id);
        if (locked.eventComplete) return 'duplicate' as const;
        const [settled, refundedSoFar] = await Promise.all([
          tx.paymentTransaction.aggregate({
            _sum: { amount: true },
            where: { tenantId: paymentRequest.tenantId, paymentRequestId: paymentRequest.id, status: { in: ['succeeded', 'paid'] } },
          }),
          tx.paymentTransaction.aggregate({
            _sum: { amount: true },
            where: { tenantId: paymentRequest.tenantId, paymentRequestId: paymentRequest.id, status: 'refunded' },
          }),
        ]);
        const settledTotal = roundMoney(toNumber(settled._sum.amount));
        const priorRefundTotal = roundMoney(toNumber(refundedSoFar._sum.amount));

        // Do not consume an out-of-order refund. Leaving resultId null makes the
        // durable webhook claim reprocessable after the success event arrives.
        if (settledTotal <= 0 || (locked.paymentStatus !== 'collected' && locked.paymentStatus !== 'refunded')) {
          return 'awaiting_success' as const;
        }
        const cumulativeRefundTotal = roundMoney(refundAmount);
        if (cumulativeRefundTotal > settledTotal) return 'invalid_refund_total' as const;
        const refundDelta = roundMoney(Math.max(0, cumulativeRefundTotal - priorRefundTotal));
        if (refundDelta === 0) {
          await tx.idempotencyKey.updateMany({ where: { scope: 'stripe.webhook', key: event.id }, data: { resultId: paymentRequest.id } });
          return 'no_change' as const;
        }
        const fullyRefunded = cumulativeRefundTotal >= settledTotal;
        const remainingCollected = roundMoney(settledTotal - cumulativeRefundTotal);
        await tx.paymentTransaction.create({
          data: {
            tenantId: paymentRequest.tenantId,
            branchId: paymentRequest.branchId,
            patientId: paymentRequest.patientId ?? undefined,
            appointmentId: paymentRequest.appointmentId ?? undefined,
            paymentRequestId: paymentRequest.id,
            amount: refundDelta,
            currency: paymentRequest.currency,
            status: 'refunded',
            mode: paymentRequest.mode,
            providerReference: typeof object.id === 'string' ? object.id : paymentRequest.providerReference ?? undefined,
            receivedAt: new Date(),
            rawResponse: { eventId: event.id, type: event.type, source: 'stripe-webhook', refundAmount: refundDelta, cumulativeRefundTotal },
          },
        });
        await tx.paymentRequest.update({ where: { id: paymentRequest.id }, data: { status: fullyRefunded ? 'refunded' : 'collected' } });
        await tx.depositRequirement.updateMany({
          where: { tenantId: paymentRequest.tenantId, paymentRequestId: paymentRequest.id, status: { in: ['collected', 'refunded'] } },
          data: { status: fullyRefunded ? 'refunded' : 'collected', collectedAmount: remainingCollected },
        });
        // AR reconciliation: a refund restores the previously-reduced outstanding balance.
        if (paymentRequest.patientId) {
          await tx.patient.updateMany({ where: { id: paymentRequest.patientId, tenantId: paymentRequest.tenantId }, data: { outstandingBalance: { increment: refundDelta } } });
        }
        await tx.integrationRunLog.create({
          data: {
            tenantId: paymentRequest.tenantId,
            branchId: paymentRequest.branchId,
            provider: 'stripe',
            providerMode: paymentRequest.mode,
            operation: 'webhook.refund',
            status: 'success',
            requestSummary: { eventId: event.id, type: event.type },
            responseSummary: { paymentRequestId: paymentRequest.id, refundAmount: refundDelta, cumulativeRefundTotal },
          },
        });
        await tx.auditEvent.create({
          data: {
            tenantId: paymentRequest.tenantId,
            action: 'payment.refunded',
            resource: 'paymentRequest',
            resourceId: paymentRequest.id,
            metadata: { eventId: event.id, appointmentId: paymentRequest.appointmentId, refundAmount: refundDelta, cumulativeRefundTotal, fullyRefunded },
          },
        });
        // A refund is complete only when its money state and mandatory audit
        // evidence are durable together. An audit failure rolls this whole
        // transaction back and leaves the original claim reprocessable.
        await tx.idempotencyKey.updateMany({ where: { scope: 'stripe.webhook', key: event.id }, data: { resultId: paymentRequest.id } });
        return 'processed' as const;
      });
      if (refundResult === 'duplicate') return reply.code(200).send({ received: true, duplicate: true });
      if (refundResult === 'awaiting_success') return reply.code(409).send({ received: false, retryable: true, deferred: 'awaiting_success' });
      if (refundResult === 'invalid_refund_total') return reply.code(409).send({ received: false, retryable: false, error: 'refund_exceeds_settled_amount' });
      if (refundResult === 'no_change') return reply.code(200).send({ received: true, duplicateEconomicEffect: true });
    } else if (disputed) {
      // The durable dispute fact, its mandatory audit evidence, and webhook
      // completion are one unit. The operational alert is downstream fan-out:
      // useful, but it must never decide whether Stripe receives an ACK.
      const disputeResult = await db.$transaction(async tx => {
        const locked = await lockStripeReconciliation(tx, eventId, paymentRequest.id);
        if (locked.eventComplete) return 'duplicate' as const;
        await tx.integrationRunLog.create({
          data: {
            tenantId: paymentRequest.tenantId, branchId: paymentRequest.branchId,
            provider: 'stripe', providerMode: paymentRequest.mode, operation: 'webhook.dispute',
            status: 'success', requestSummary: { eventId: event.id, type: event.type }, responseSummary: { paymentRequestId: paymentRequest.id },
          },
        });
        await tx.auditEvent.create({
          data: {
            tenantId: paymentRequest.tenantId,
            action: 'payment.dispute.created',
            resource: 'paymentRequest',
            resourceId: paymentRequest.id,
            metadata: { eventId: event.id, appointmentId: paymentRequest.appointmentId },
          },
        });
        await tx.idempotencyKey.updateMany({ where: { scope: 'stripe.webhook', key: event.id }, data: { resultId: paymentRequest.id } });
        return 'processed' as const;
      });
      if (disputeResult === 'duplicate') return reply.code(200).send({ received: true, duplicate: true });
      try {
        await runWithTenantContext(paymentRequest.tenantId, tx => tx.revenueProtectionAlert.create({
          data: {
            tenantId: paymentRequest.tenantId, branchId: paymentRequest.branchId,
            patientId: paymentRequest.patientId ?? undefined, appointmentId: paymentRequest.appointmentId ?? undefined,
            sourceType: 'payment_dispute', severity: 'high',
            title: 'Payment dispute opened',
            description: 'A patient (or their bank) opened a dispute/chargeback on a collected payment. Respond before the evidence deadline.',
            estimatedValue: refundAmount, status: 'open',
            recommendedAction: 'Review the dispute in Stripe and submit evidence before the deadline.',
            actionLink: paymentRequest.appointmentId ? `appointment/${paymentRequest.appointmentId}` : null,
          },
        }));
      } catch (error) {
        request.log.warn({ err: error, eventId: event.id, operation: 'payment_dispute_alert' }, 'Optional payment dispute alert fan-out failed');
      }
    } else if (failed || expired) {
      const newStatus = failed ? 'failed' : 'expired';
      // Commit the guarded terminal transition, mandatory evidence, and webhook
      // completion together. The conditional update prevents an out-of-order
      // failure/expiry event from regressing a concurrently collected request.
      const terminal = await db.$transaction(async tx => {
        const locked = await lockStripeReconciliation(tx, eventId, paymentRequest.id);
        if (locked.eventComplete) return { duplicate: true, ignored: false };
        if (locked.paymentStatus !== 'pending' && locked.paymentStatus !== 'link_sent') {
          await tx.idempotencyKey.updateMany({ where: { scope: 'stripe.webhook', key: event.id }, data: { resultId: paymentRequest.id } });
          return { duplicate: false, ignored: true };
        }
        const updated = await tx.paymentRequest.updateMany({
          where: { id: paymentRequest.id, status: { in: ['pending', 'link_sent'] } },
          data: { status: newStatus },
        });
        if (updated.count === 0) {
          await tx.idempotencyKey.updateMany({ where: { scope: 'stripe.webhook', key: event.id }, data: { resultId: paymentRequest.id } });
          return { duplicate: false, ignored: true };
        }
        await tx.auditEvent.create({
          data: {
            tenantId: paymentRequest.tenantId,
            action: failed ? 'payment.failed' : 'payment.expired',
            resource: 'paymentRequest',
            resourceId: paymentRequest.id,
            metadata: { eventId: event.id, type: event.type },
          },
        });
        await tx.idempotencyKey.updateMany({ where: { scope: 'stripe.webhook', key: event.id }, data: { resultId: paymentRequest.id } });
        return { duplicate: false, ignored: false };
      });
      if (terminal.duplicate) return reply.code(200).send({ received: true, duplicate: true });
      if (terminal.ignored) {
        return reply.code(200).send({ received: true, ignored: 'terminal_payment_state' });
      }

      // Dedupe the follow-up task/alert per (request,outcome) so distinct
      // provider failure events don't spam revenue protection.
      const failureClaim = await claimIdempotency('payment.failure', `${paymentRequest.tenantId}:${paymentRequest.id}:${newStatus}`, paymentRequest.tenantId);
      if (failureClaim.claimed) {
        try {
          await db.staffTask.create({
            data: {
              tenantId: paymentRequest.tenantId, branchId: paymentRequest.branchId,
              title: failed ? 'Review failed deposit payment' : 'Resend expired deposit link',
              priority: failed ? 'high' : 'normal', status: 'OPEN',
              metadata: { source: 'payment_webhook', paymentRequestId: paymentRequest.id, appointmentId: paymentRequest.appointmentId, event: event.type },
            },
          });
        } catch (error) {
          request.log.warn({ err: error, eventId: event.id, operation: 'payment_failure_task' }, 'Optional payment failure task fan-out failed');
        }
        if (paymentRequest.appointmentId || paymentRequest.patientId) {
          try {
            await runWithTenantContext(paymentRequest.tenantId, tx => tx.revenueProtectionAlert.create({
              data: {
                tenantId: paymentRequest.tenantId, branchId: paymentRequest.branchId,
                patientId: paymentRequest.patientId ?? undefined, appointmentId: paymentRequest.appointmentId ?? undefined,
                sourceType: 'deposit_payment', severity: failed ? 'high' : 'medium',
                title: failed ? 'Deposit payment failed' : 'Deposit link expired unpaid',
                description: failed ? 'A patient deposit payment failed and needs follow-up.' : 'A deposit payment link expired before payment.',
                estimatedValue: paymentRequest.amount, status: 'open',
                recommendedAction: failed ? 'Contact the patient and resend a payment link.' : 'Resend a fresh deposit payment link.',
                actionLink: paymentRequest.appointmentId ? `appointment/${paymentRequest.appointmentId}` : null,
              },
            }));
          } catch (error) {
            request.log.warn({ err: error, eventId: event.id, operation: 'payment_failure_alert' }, 'Optional payment failure alert fan-out failed');
          }
        }
        try {
          await recordWorkflowEvent(paymentRequest.tenantId, { eventType: failed ? 'payment.failed' : 'payment.expired', entityType: 'paymentRequest', entityId: paymentRequest.id, sourceModule: 'payments', payload: { appointmentId: paymentRequest.appointmentId } });
        } catch (error) {
          request.log.warn({ err: error, eventId: event.id, operation: 'payment_failure_workflow_event' }, 'Optional payment workflow event fan-out failed');
        }
      }
    }

    // Terminal completion for every reconciled path (success already recorded the
    // result atomically above; this also covers failed/expired and unhandled event
    // types). Recording a resultId marks the event fully processed so a later
    // redelivery is acknowledged as a duplicate rather than reprocessed.
    await recordIdempotencyResult('stripe.webhook', event.id, paymentRequest.id);
    return reply.code(200).send({ received: true });
  });
};
