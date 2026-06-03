import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { env } from '../config/env';
import { db } from '../lib/db';
import { audit } from '../lib/audit';
import { assertBranchAccess } from '../lib/scope';
import { requireRoles } from '../plugins/roles';
import type { Prisma } from '../generated/prisma/client';

type ProviderMode = 'mock' | 'sandbox' | 'live';
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

const editRoles = requireRoles('OWNER', 'ADMIN', 'MANAGER', 'FRONT_DESK');
const adminRoles = requireRoles('OWNER', 'ADMIN', 'MANAGER');

type RevenueContext = {
  tenantId: string;
  branchId?: string;
};

type EligibilityCheckContext = RevenueContext & {
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

type PaymentRequestContext = RevenueContext & {
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
  providerMode: ProviderMode;
  providerName: string;
  needsPriorAuth: boolean;
  priorAuthRequired: boolean;
  benefitUncertainty: boolean;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  recommendedAction: string;
  revenueAtRisk: number;
  rawResponse?: unknown;
  storeRawResponse: boolean;
};

type PaymentOutcome = {
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
        service: true,
        startsAt: true,
        value: true,
        noShowRisk: true,
        providerRef: true,
      },
    });
    if (row) {
      appointment = {
        ...row,
        value: toNumber(row.value),
      };
    }
  }

  const resolvedBranchId = branchId ?? appointment?.branchId ?? patient?.branchId;
  if (!resolvedBranchId) {
    return { branchId: context.branchId ?? request.auth.branchId ?? input.branchId ?? '', patient, appointment };
  }
  return { branchId: resolvedBranchId, patient, appointment };
}

async function ensurePolicy(context: RevenueContext, entities: Awaited<ReturnType<typeof resolveBranchIdAndEntities>>, payerId?: string) {
  if (!entities.patient) return null;

  const existing = await db.patientInsurancePolicy.findFirst({
    where: { tenantId: context.tenantId, patientId: entities.patient.id, active: true },
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

  const payer = payerId
    ? await db.insurancePayer.findFirst({ where: { id: payerId, tenantId: context.tenantId, active: true } })
    : await db.insurancePayer.findFirst({ where: { tenantId: context.tenantId, active: true }, orderBy: { sortOrder: 'asc' } });

  const created = await db.patientInsurancePolicy.create({
    data: {
      tenantId: context.tenantId,
      branchId: entities.branchId,
      patientId: entities.patient.id,
      payerId: payer?.id,
      planName: payer?.name ? `${payer.name} Standard` : 'Demo Health Plan',
      memberId: `TEST-${entities.patient.id.slice(0, 8).toUpperCase()}`,
      groupNumber: 'GRP-TEST-001',
      relationship: 'self',
      subscriberName: `${entities.patient.firstName} ${entities.patient.lastName}`,
      payerReference: payer?.tradingPartnerServiceId ?? `TEST-${randomUUID().slice(0, 8).toUpperCase()}`,
      verificationStatus: 'pending',
      active: true,
    },
    include: { payer: { select: { id: true, name: true, tradingPartnerServiceId: true, sourceProvider: true } } },
  });

  return {
    id: created.id,
    planName: created.planName,
    memberId: created.memberId,
    groupNumber: created.groupNumber,
    subscriberName: created.subscriberName,
    payer: created.payer,
  };
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
      providerMode: this.mode,
      providerName: this.displayName,
      needsPriorAuth,
      priorAuthRequired: needsPriorAuth,
      benefitUncertainty,
      riskLevel,
      recommendedAction,
      revenueAtRisk,
      storeRawResponse: false,
    };
  }

  async runEligibilityCheck(_input: EligibilityCheckContext): Promise<EligibilityOutcome> {
    return this.normalizeEligibilityResponse({}, _input);
  }
}

class StediEligibilityProvider extends MockEligibilityProvider {
  providerKey = 'stedi';
  displayName = 'Stedi Eligibility';
  mode: ProviderMode = env.STEDI_TEST_MODE ? 'sandbox' : 'live';

  async runEligibilityCheck(context: EligibilityCheckContext): Promise<EligibilityOutcome> {
    if (!env.STEDI_API_KEY) {
      return super.runEligibilityCheck(context);
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
        controlNumber: randomUUID().replace(/-/g, '').slice(0, 12),
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
        return super.runEligibilityCheck(context);
      }

      return this.normalizeEligibilityResponse(payload, context);
    } catch {
      return super.runEligibilityCheck(context);
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
    const statusText = String(
      benefits.coverageStatus ??
      benefits.eligibilityStatus ??
      payload.coverageStatus ??
      payload.status ??
      'active',
    ).toLowerCase();
    const coverageActive = statusText.includes('active') || statusText.includes('verified') || statusText.includes('covered');
    const planName = String(benefits.planName ?? benefits.planDescription ?? context.policy?.planName ?? 'Stedi Health Plan');
    const payerName = String(benefits.payerName ?? benefits.payer ?? context.payer?.name ?? 'Stedi Test Payer');
    const memberId = String(benefits.memberId ?? context.policy?.memberId ?? inferPayerReference({ payerName, patientId: context.patient?.id, appointmentId: context.appointment?.id }));
    const copay = toNumber(
      benefits.copay ??
      benefits.copayAmount ??
      patientResponsibility.copay ??
      asRecord(benefits.financialResponsibility).copayAmount ??
      officeVisit.copay ??
      25,
    );
    const deductibleRemaining = toNumber(
      benefits.deductibleRemaining ??
      deductible.remaining ??
      deductible.remainingAmount ??
      benefitsSummary.deductibleRemaining ??
      850,
    );
    const coinsurance = toNumber(
      benefits.coinsurance ??
      benefits.coInsurance ??
      patientResponsibility.coinsurance ??
      0.2,
    );
    const needsPriorAuth = String(
      benefits.authorizationRequired ??
      benefits.priorAuthorizationRequired ??
      payload.authorizationRequired ??
      '',
    ).toLowerCase().includes('true') || deductibleRemaining > 1600 || /surgery|injection|procedure|botox|laser|consultation/i.test(serviceName);
    const benefitUncertainty = !response || !Object.keys(payload).length || Boolean(payload.warnings?.length);
    const payerReference = String(
      benefits.payerReference ??
      payload.id ??
      context.policy?.memberId ??
      inferPayerReference({ payerName, patientId: context.patient?.id, appointmentId: context.appointment?.id }),
    );
    const riskLevel = buildEligibilityRiskLevel({ coverageActive, copay, deductibleRemaining, needsPriorAuth, benefitUncertainty });
    const recommendedAction = buildRecommendedAction({ coverageActive, copay, deductibleRemaining, needsPriorAuth });
    const revenueAtRisk = coverageActive ? 0 : Math.max(185, Math.round((context.patient?.outstandingBalance ?? 0) * 0.4 + copay));
    const eligibilityMessage = deriveCoverageMessage({ coverageActive, copay, deductibleRemaining, needsPriorAuth, benefitUncertainty });

    return {
      coverageStatus: coverageActive ? (benefitUncertainty ? 'uncertain' : 'active') : 'inactive',
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
      providerMode: this.mode,
      providerName: this.displayName,
      needsPriorAuth,
      priorAuthRequired: needsPriorAuth,
      benefitUncertainty,
      riskLevel,
      recommendedAction,
      revenueAtRisk,
      rawResponse: payload as Prisma.InputJsonValue,
      storeRawResponse: true,
    };
  }
}

class PlaceholderEligibilityProvider extends MockEligibilityProvider {
  constructor(public providerKey: string, public displayName: string) {
    super();
  }
}

class MockPaymentProvider {
  providerKey = 'mock';
  displayName = 'Mock Payments';
  mode: ProviderMode = 'mock';

  async createPaymentRequest(input: PaymentRequestContext): Promise<PaymentOutcome> {
    const amount = Math.max(0, Math.round(input.amount));
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
      amount: Math.max(0, Math.round(input.amount)),
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

class StripePaymentProvider extends MockPaymentProvider {
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
    if (!env.STRIPE_SECRET_KEY) return super.createPaymentRequest(input);

    try {
      const amount = Math.max(0, Math.round(input.amount));
      const payload = await this.stripeForm('/v1/checkout/sessions', {
        mode: 'payment',
        success_url: env.STRIPE_SUCCESS_URL,
        cancel_url: env.STRIPE_CANCEL_URL,
        client_reference_id: input.patient?.id ?? input.appointment?.id ?? randomUUID(),
        'line_items[0][price_data][currency]': 'usd',
        'line_items[0][price_data][product_data][name]': input.reason || 'CareCommand Payment Request',
        'line_items[0][price_data][product_data][description]': input.patient ? `${input.patient.firstName} ${input.patient.lastName}` : 'Patient payment request',
        'line_items[0][price_data][unit_amount]': String(amount * 100),
        'line_items[0][quantity]': '1',
        'metadata[tenantId]': input.tenantId,
        'metadata[branchId]': input.branchId ?? '',
        'metadata[reason]': input.reason,
      });
      if (!payload) return super.createPaymentRequest(input);
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
      return super.createPaymentRequest(input);
    }
  }

  async createPaymentLink(input: PaymentRequestContext): Promise<PaymentOutcome> {
    if (!env.STRIPE_SECRET_KEY) return super.createPaymentLink(input);

    try {
      const amount = Math.max(0, Math.round(input.amount));
      const payload = await this.stripeForm('/v1/payment_links', {
        'line_items[0][price_data][currency]': 'usd',
        'line_items[0][price_data][product_data][name]': input.reason || 'CareCommand Deposit',
        'line_items[0][price_data][product_data][description]': input.patient ? `${input.patient.firstName} ${input.patient.lastName}` : 'Patient deposit request',
        'line_items[0][price_data][unit_amount]': String(amount * 100),
        'line_items[0][quantity]': '1',
        'after_completion[type]': 'redirect',
        'after_completion[redirect][url]': env.STRIPE_SUCCESS_URL,
        'metadata[tenantId]': input.tenantId,
        'metadata[branchId]': input.branchId ?? '',
        'metadata[reason]': input.reason,
      });
      if (!payload) return super.createPaymentLink(input);
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
      return super.createPaymentLink(input);
    }
  }

  async getPaymentStatus(reference: string) {
    if (!env.STRIPE_SECRET_KEY) return super.getPaymentStatus(reference);
    try {
      const path = reference.startsWith('plink_') ? `/v1/payment_links/${reference}` : `/v1/checkout/sessions/${reference}`;
      const { response, body: payload } = await fetchJsonWithTimeout(`https://api.stripe.com${path}`, {
        headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
      });
      if (!response.ok || !payload) return super.getPaymentStatus(reference);
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
      return super.getPaymentStatus(reference);
    }
  }
}

class PlaceholderPaymentProvider extends MockPaymentProvider {
  constructor(public providerKey: string, public displayName: string) {
    super();
  }
}

function createInsuranceProvider() {
  switch (env.INSURANCE_PROVIDER) {
    case 'stedi':
      return env.STEDI_API_KEY ? new StediEligibilityProvider() : new MockEligibilityProvider();
    case 'availity':
      return new PlaceholderEligibilityProvider('availity', 'Availity Eligibility');
    case 'pverify':
      return new PlaceholderEligibilityProvider('pverify', 'pVerify Eligibility');
    case 'optum':
      return new PlaceholderEligibilityProvider('optum', 'Optum Eligibility');
    case 'mock':
    default:
      return new MockEligibilityProvider();
  }
}

function createPaymentProvider() {
  switch (env.PAYMENT_PROVIDER) {
    case 'stripe':
      return env.STRIPE_SECRET_KEY ? new StripePaymentProvider() : new MockPaymentProvider();
    case 'square':
      return new PlaceholderPaymentProvider('square', 'Square Payments');
    case 'authorize_net':
      return new PlaceholderPaymentProvider('authorize_net', 'Authorize.Net Payments');
    case 'clover':
      return new PlaceholderPaymentProvider('clover', 'Clover Payments');
    case 'paypal':
      return new PlaceholderPaymentProvider('paypal', 'PayPal Payments');
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

async function createEligibilityAlert(context: RevenueContext, branchId: string, patientId: string | null, appointmentId: string | null, outcome: EligibilityOutcome, verificationId: string) {
  const riskThemes = deriveEligibilityRisk(outcome);
  if (!riskThemes.length) return null;
  const [primaryTheme, ...rest] = riskThemes;
  return db.revenueProtectionAlert.create({
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
}

async function buildResponsibilityEstimate(context: RevenueContext, branchId: string, patientId: string, appointmentId: string | null, verificationId: string, outcome: EligibilityOutcome) {
  const appointment = appointmentId
    ? await db.appointment.findFirst({
        where: { id: appointmentId, tenantId: context.tenantId },
        select: { value: true, noShowRisk: true, service: true },
      })
    : null;
  const patient = await db.patient.findFirst({
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

  return db.patientResponsibilityEstimate.create({
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
    db.depositRule.findMany({
      where: { tenantId: context.tenantId, ...filter },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
      take: 50,
      include: { branch: { select: { name: true } } },
    }),
    db.depositRequirement.findMany({
      where: { tenantId: context.tenantId, ...filter },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: {
        branch: { select: { name: true } },
        patient: { select: { firstName: true, lastName: true } },
        appointment: { select: { service: true } },
        depositRule: { select: { name: true } },
      },
    }),
    db.revenueProtectionAlert.findMany({
      where: { tenantId: context.tenantId, ...filter },
      orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }],
      take: 50,
      include: {
        branch: { select: { name: true } },
        patient: { select: { firstName: true, lastName: true } },
        appointment: { select: { service: true } },
      },
    }),
    db.integrationRunLog.findMany({
      where: { tenantId: context.tenantId, ...filter },
      orderBy: { createdAt: 'desc' },
      take: 20,
      include: { branch: { select: { name: true } } },
    }),
  ]);

  const summary = {
    paymentsDueToday: paymentRequests.filter(request => request.status === 'pending' && request.dueAt && request.dueAt >= todayRange().start && request.dueAt < todayRange().end).length,
    copaysExpected: paymentRequests.filter(request => request.status !== 'collected').reduce((sum, request) => sum + toNumber(request.amount), 0),
    depositsCollected: depositRequirements.filter(requirement => requirement.status === 'collected').reduce((sum, requirement) => sum + toNumber(requirement.collectedAmount), 0),
    unpaidBalances: paymentRequests.filter(request => request.status !== 'collected').reduce((sum, request) => sum + toNumber(request.amount), 0),
    failedPayments: paymentTransactions.filter(transaction => transaction.status === 'failed').length,
    revenueProtected: depositRequirements.filter(requirement => requirement.status === 'collected').reduce((sum, requirement) => sum + toNumber(requirement.collectedAmount), 0)
      + paymentTransactions.filter(transaction => transaction.status === 'succeeded' || transaction.status === 'paid').reduce((sum, transaction) => sum + toNumber(transaction.amount), 0),
    revenueAtRisk: revenueProtectionAlerts.filter(alert => alert.status !== 'resolved').reduce((sum, alert) => sum + toNumber(alert.estimatedValue), 0),
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
  app.get('/overview', async request => {
    const query = listLimit.parse(request.query);
    return loadOverview({ tenantId: request.auth.tenantId, branchId: request.auth.branchId ?? undefined }, query.branchId);
  });

  app.get('/integration-status', async request => {
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

    return {
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
  });

  app.get('/eligibility', async request => {
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
    return {
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
  });

  app.get('/appointment-queue', async request => {
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

    return { appointments: rows.map(mapAppointmentQueueRow) };
  });

  app.post('/eligibility/check', { preHandler: editRoles }, async (request, reply) => {
    const body = z.object({
      branchId: uuid.optional(),
      patientId: uuid.optional(),
      appointmentId: uuid.optional(),
      payerId: uuid.optional(),
      serviceType: z.string().trim().min(2).max(120).optional(),
    }).parse(request.body);

    if (!body.patientId && !body.appointmentId) {
      throw app.httpErrors.badRequest('A patient or appointment context is required');
    }

    const entities = await resolveBranchIdAndEntities(request, { tenantId: request.auth.tenantId, branchId: request.auth.branchId ?? undefined }, body);
    if (body.patientId && !entities.patient) throw app.httpErrors.notFound('Patient not found');
    if (body.appointmentId && !entities.appointment) throw app.httpErrors.notFound('Appointment not found');
    const payer = body.payerId
      ? await db.insurancePayer.findFirst({ where: { id: body.payerId, tenantId: request.auth.tenantId, active: true } })
      : await selectDefaultPayer({ tenantId: request.auth.tenantId, branchId: entities.branchId });
    const policy = await ensurePolicy({ tenantId: request.auth.tenantId, branchId: entities.branchId }, entities, payer?.id);
    const provider = createInsuranceProvider();

    const outcome = await provider.runEligibilityCheck({
      tenantId: request.auth.tenantId,
      branchId: entities.branchId,
      patient: entities.patient ?? undefined,
      appointment: entities.appointment ?? undefined,
      payer: payer ? { id: payer.id, name: payer.name, tradingPartnerServiceId: payer.tradingPartnerServiceId, sourceProvider: payer.sourceProvider } : undefined,
      policy: policy ? {
        id: policy.id,
        planName: policy.planName,
        memberId: policy.memberId,
        groupNumber: policy.groupNumber,
        subscriberName: policy.subscriberName,
      } : undefined,
      serviceType: body.serviceType ?? entities.appointment?.service,
    });

    const verification = await db.eligibilityVerification.create({
      data: {
        tenantId: request.auth.tenantId,
        branchId: entities.branchId,
        patientId: entities.patient?.id ?? body.patientId!,
        appointmentId: entities.appointment?.id ?? body.appointmentId ?? undefined,
        payerId: payer?.id ?? undefined,
        policyId: policy?.id ?? undefined,
        providerMode: outcome.providerMode,
        coverageStatus: outcome.coverageStatus,
        planName: outcome.planName,
        payerName: outcome.payerName,
        copay: outcome.copay,
        deductibleRemaining: outcome.deductibleRemaining,
        coinsurance: outcome.coinsurance,
        coverageActive: outcome.coverageActive,
        eligibilityMessage: outcome.eligibilityMessage,
        payerReference: outcome.payerReference,
        normalizedResponse: {
          ...outcome,
          providerMode: outcome.providerMode,
          providerName: outcome.providerName,
        } as Prisma.InputJsonValue,
        ...(outcome.storeRawResponse && outcome.rawResponse ? { rawResponse: outcome.rawResponse as Prisma.InputJsonValue } : {}),
      },
    });

    await Promise.all([
      db.patient.updateMany({
        where: { id: entities.patient?.id ?? body.patientId!, tenantId: request.auth.tenantId },
        data: {
          eligibilityStatus: outcome.coverageActive ? 'ACTIVE' : 'INACTIVE',
          eligibilityLastVerifiedAt: new Date(),
        },
      }),
      entities.appointment
        ? db.appointment.updateMany({
            where: { id: entities.appointment.id, tenantId: request.auth.tenantId },
            data: {
              eligibilityStatus: outcome.coverageActive ? 'ACTIVE' : 'INACTIVE',
              eligibilityLastVerifiedAt: new Date(),
            },
          })
        : Promise.resolve(),
      policy
        ? db.patientInsurancePolicy.update({
            where: { id: policy.id },
            data: {
              verificationStatus: outcome.coverageActive ? 'verified' : 'inactive',
              verifiedAt: new Date(),
            },
          })
        : Promise.resolve(),
    ]);

    const verificationDetails = await db.eligibilityVerification.findUnique({
      where: { id: verification.id },
      include: {
        branch: { select: { name: true } },
        patient: { select: { firstName: true, lastName: true } },
        payer: { select: { name: true } },
        policy: { select: { memberId: true, planName: true, groupNumber: true } },
      },
    });
    if (!verificationDetails) {
      throw app.httpErrors.internalServerError('Unable to load verification details');
    }

    await db.benefitSnapshot.create({
      data: {
        tenantId: request.auth.tenantId,
        branchId: entities.branchId,
        verificationId: verification.id,
        summary: outcome.eligibilityMessage,
        details: {
          coverageStatus: outcome.coverageStatus,
          payerName: outcome.payerName,
          planName: outcome.planName,
          copay: outcome.copay,
          deductibleRemaining: outcome.deductibleRemaining,
          coinsurance: outcome.coinsurance,
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
        entities.appointment?.id ?? body.appointmentId ?? null,
        verification.id,
        outcome,
      );
    }

    const alert = await createEligibilityAlert(
      { tenantId: request.auth.tenantId, branchId: entities.branchId },
      entities.branchId,
      entities.patient?.id ?? body.patientId ?? null,
      entities.appointment?.id ?? body.appointmentId ?? null,
      outcome,
      verification.id,
    );

    await db.integrationRunLog.create({
      data: {
        tenantId: request.auth.tenantId,
        branchId: entities.branchId,
        provider: provider.providerKey,
        providerMode: outcome.providerMode,
        operation: 'eligibility.check',
        status: 'success',
        requestSummary: {
          patientId: body.patientId ?? entities.patient?.id ?? null,
          appointmentId: body.appointmentId ?? entities.appointment?.id ?? null,
          payerId: payer?.id ?? null,
        },
        responseSummary: {
          coverageStatus: outcome.coverageStatus,
          payerName: outcome.payerName,
          planName: outcome.planName,
          copay: outcome.copay,
          deductibleRemaining: outcome.deductibleRemaining,
          coinsurance: outcome.coinsurance,
        },
      },
    });

    return reply.send({
      verificationId: verification.id,
      id: verification.id,
      branchId: verificationDetails.branchId,
      branchName: verificationDetails.branch.name,
      patientId: verificationDetails.patientId,
      patientName: `${verificationDetails.patient.firstName} ${verificationDetails.patient.lastName}`,
      appointmentId: verificationDetails.appointmentId ?? null,
      payerId: verificationDetails.payerId ?? null,
      payerName: verificationDetails.payer?.name ?? outcome.payerName,
      policyId: verificationDetails.policyId ?? null,
      memberId: verificationDetails.policy?.memberId ?? outcome.memberId,
      planName: verificationDetails.planName,
      coverageStatus: verificationDetails.coverageStatus.toUpperCase(),
      coverageActive: verificationDetails.coverageActive,
      copay: toNumber(verificationDetails.copay),
      deductibleRemaining: toNumber(verificationDetails.deductibleRemaining),
      coinsurance: toNumber(verificationDetails.coinsurance),
      eligibilityMessage: verificationDetails.eligibilityMessage,
      payerReference: verificationDetails.payerReference ?? outcome.payerReference,
      checkedAt: verificationDetails.checkedAt.toISOString(),
      providerMode: verificationDetails.providerMode === 'mock' ? 'mock' : 'stedi-sandbox',
      alertId: alert?.id ?? null,
      priorAuthRequired: outcome.priorAuthRequired,
      recommendedAction: outcome.recommendedAction,
      riskLevel: outcome.riskLevel,
      revenueAtRisk: toNumber(alert?.estimatedValue ?? outcome.revenueAtRisk),
      benefitUncertainty: outcome.benefitUncertainty,
    });
  });

  app.patch('/eligibility/:id/status', { preHandler: editRoles }, async (request, reply) => {
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

  app.get('/prior-auth', async request => {
    const query = listLimit.parse(request.query);
    const filter = branchFilter(request, query.branchId);
    const rows = await db.priorAuthorization.findMany({
      where: { tenantId: request.auth.tenantId, ...filter },
      orderBy: [{ dueAt: 'asc' }, { updatedAt: 'desc' }],
      take: query.limit,
      include: { branch: { select: { name: true } }, patient: { select: { firstName: true, lastName: true } }, payer: { select: { name: true } } },
    });
    return { priorAuthorizations: rows.map(mapPriorAuth) };
  });

  app.patch('/prior-auth/:id/status', { preHandler: editRoles }, async (request, reply) => {
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
    return reply.send({
      id: row.id,
      status: row.status,
      notes: row.notes ?? null,
      lastUpdatedAt: row.lastUpdatedAt?.toISOString() ?? null,
    });
  });

  app.get('/payments', async request => {
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
      db.depositRequirement.findMany({
        where: { tenantId: request.auth.tenantId, ...filter },
        orderBy: { createdAt: 'desc' },
        take: query.limit,
        include: { branch: { select: { name: true } }, patient: { select: { firstName: true, lastName: true } }, appointment: { select: { service: true } }, depositRule: { select: { name: true } } },
      }),
    ]);
    return {
      paymentRequests: paymentRequests.map(mapPaymentRequest),
      paymentTransactions: paymentTransactions.map(mapTransaction),
      depositRequirements: depositRequirements.map(mapDepositRequirement),
    };
  });

  app.post('/payment/request', { preHandler: editRoles }, async (request, reply) => {
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

    const entities = await resolveBranchIdAndEntities(request, { tenantId: request.auth.tenantId, branchId: request.auth.branchId ?? undefined }, body);
    if (body.patientId && !entities.patient) throw app.httpErrors.notFound('Patient not found');
    if (body.appointmentId && !entities.appointment) throw app.httpErrors.notFound('Appointment not found');
    const provider = createPaymentProvider();
    const outcome = provider.mode === 'mock'
      ? await provider.createPaymentRequest({
          tenantId: request.auth.tenantId,
          branchId: entities.branchId,
          patient: entities.patient ?? undefined,
          appointment: entities.appointment ?? undefined,
          amount: body.amount,
          reason: body.reason,
          depositRule: body.depositRuleId
            ? { id: body.depositRuleId, name: body.reason, ruleType: 'manual', depositRequired: true, amountType: 'fixed', amountValue: body.amount, refundable: true, cancellationWindowHours: 24 }
            : undefined,
        })
      : await provider.createPaymentRequest({
          tenantId: request.auth.tenantId,
          branchId: entities.branchId,
          patient: entities.patient ?? undefined,
          appointment: entities.appointment ?? undefined,
          amount: body.amount,
          reason: body.reason,
          depositRule: body.depositRuleId
            ? { id: body.depositRuleId, name: body.reason, ruleType: 'manual', depositRequired: true, amountType: 'fixed', amountValue: body.amount, refundable: true, cancellationWindowHours: 24 }
            : undefined,
        });

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

  app.post('/payment-link', { preHandler: editRoles }, async (request, reply) => {
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

    const entities = await resolveBranchIdAndEntities(request, { tenantId: request.auth.tenantId, branchId: request.auth.branchId ?? undefined }, body);
    if (body.patientId && !entities.patient) throw app.httpErrors.notFound('Patient not found');
    if (body.appointmentId && !entities.appointment) throw app.httpErrors.notFound('Appointment not found');
    const provider = createPaymentProvider();
    const outcome = await provider.createPaymentLink({
      tenantId: request.auth.tenantId,
      branchId: entities.branchId,
      patient: entities.patient ?? undefined,
      appointment: entities.appointment ?? undefined,
      amount: body.amount,
      reason: body.reason,
      depositRule: body.depositRuleId
        ? { id: body.depositRuleId, name: body.reason, ruleType: 'manual', depositRequired: true, amountType: 'fixed', amountValue: body.amount, refundable: true, cancellationWindowHours: 24 }
        : undefined,
    });

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

  app.patch('/payment/:id/status', { preHandler: editRoles }, async (request, reply) => {
    const params = z.object({ id: uuid }).parse(request.params);
    const body = z.object({
      status: z.string().min(2).max(80),
      providerReference: z.string().max(120).optional(),
    }).parse(request.body);
    const existing = await db.paymentRequest.findFirst({
      where: { id: params.id, tenantId: request.auth.tenantId },
    });
    if (!existing) throw app.httpErrors.notFound('Payment request not found');
    assertBranchAccess(request, existing.branchId);

    const row = await db.paymentRequest.update({
      where: { id: params.id },
      data: { status: body.status, providerReference: body.providerReference ?? existing.providerReference },
    });

    if (body.status === 'collected') {
      await db.paymentTransaction.create({
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
          },
        },
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

  app.post('/webhooks/stripe', { preHandler: adminRoles }, async request => {
    await db.integrationRunLog.create({
      data: {
        tenantId: request.auth.tenantId,
        branchId: request.auth.branchId ?? undefined,
        provider: 'stripe',
        providerMode: env.STRIPE_SECRET_KEY ? (env.STRIPE_SECRET_KEY.startsWith('sk_test_') ? 'sandbox' : 'live') : 'mock',
        operation: 'webhook.placeholder',
        status: 'received',
        requestSummary: {
          note: 'Stripe webhook placeholder endpoint; real signature verification can be added later.',
        },
      },
    });
    return { ok: true };
  });

  app.get('/deposit-rules', async request => {
    const query = listLimit.parse(request.query);
    const filter = branchFilter(request, query.branchId);
    const rows = await db.depositRule.findMany({
      where: { tenantId: request.auth.tenantId, ...filter },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
      take: query.limit,
      include: { branch: { select: { name: true } } },
    });
    return { depositRules: rows.map(mapDepositRule) };
  });

  app.post('/deposit-rules', { preHandler: adminRoles }, async (request, reply) => {
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
    const row = await db.depositRule.create({
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
    });
    await audit(request, { action: 'depositRule.created', resource: 'depositRule', resourceId: row.id });
    return reply.code(201).send(mapDepositRule(row));
  });

  app.patch('/deposit-rules/:id', { preHandler: adminRoles }, async (request, reply) => {
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
    const existing = await db.depositRule.findFirst({ where: { id: params.id, tenantId: request.auth.tenantId } });
    if (!existing) throw app.httpErrors.notFound('Deposit rule not found');
    assertBranchAccess(request, existing.branchId ?? request.auth.branchId ?? existing.branchId ?? '');
    const row = await db.depositRule.update({
      where: { id: params.id },
      data: {
        ...body,
        branchId: body.branchId ?? existing.branchId ?? undefined,
      },
      include: { branch: { select: { name: true } } },
    });
    await audit(request, { action: 'depositRule.updated', resource: 'depositRule', resourceId: row.id, metadata: body });
    return reply.send(mapDepositRule(row));
  });

  app.patch('/deposit-requirements/:id/status', { preHandler: editRoles }, async (request, reply) => {
    const params = z.object({ id: uuid }).parse(request.params);
    const body = z.object({
      status: z.string().min(2).max(80),
      reason: z.string().max(240).optional(),
      collectedAmount: z.coerce.number().min(0).optional(),
      waiverReason: z.string().max(240).optional(),
    }).parse(request.body);
    const existing = await db.depositRequirement.findFirst({
      where: { id: params.id, tenantId: request.auth.tenantId },
    });
    if (!existing) throw app.httpErrors.notFound('Deposit requirement not found');
    assertBranchAccess(request, existing.branchId);

    const row = await db.depositRequirement.update({
      where: { id: params.id },
      data: {
        status: body.status,
        collectedAmount: body.collectedAmount ?? existing.collectedAmount,
        waiverReason: body.waiverReason ?? existing.waiverReason,
        collectedAt: body.status === 'collected' ? new Date() : existing.collectedAt,
        reason: body.reason ?? existing.reason,
      },
    });

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

  app.get('/leaks', async request => {
    const query = listLimit.parse(request.query);
    const filter = branchFilter(request, query.branchId);
    const rows = await db.revenueProtectionAlert.findMany({
      where: { tenantId: request.auth.tenantId, ...filter },
      orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }],
      take: query.limit,
      include: {
        branch: { select: { name: true } },
        patient: { select: { firstName: true, lastName: true } },
        appointment: { select: { service: true } },
      },
    });
    return { revenueProtectionAlerts: rows.map(mapAlert) };
  });

  app.patch('/leaks/:id/status', { preHandler: editRoles }, async (request, reply) => {
    const params = z.object({ id: uuid }).parse(request.params);
    const body = z.object({
      status: z.string().min(2).max(80),
      createRecoveryTask: z.boolean().default(false),
      taskTitle: z.string().max(240).optional(),
      taskPriority: z.string().max(40).optional(),
    }).parse(request.body);
    const existing = await db.revenueProtectionAlert.findFirst({
      where: { id: params.id, tenantId: request.auth.tenantId },
      include: {
        patient: { select: { firstName: true, lastName: true } },
        appointment: { select: { service: true } },
        branch: { select: { name: true } },
      },
    });
    if (!existing) throw app.httpErrors.notFound('Revenue protection alert not found');
    assertBranchAccess(request, existing.branchId);

    const row = await db.revenueProtectionAlert.update({
      where: { id: params.id },
      data: { status: body.status },
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
