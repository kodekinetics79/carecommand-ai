import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../../lib/db';
import { audit } from '../../lib/audit';
import { env } from '../../config/env';
import { requireFeature } from '../../lib/entitlements';
import { requireRoles } from '../../plugins/roles';
import { createPaymentProvider, type PaymentRequestContext } from '../revenue-protection';
import {
  evaluateDepositForAppointment, deriveAppointmentPaymentStatus, allowedPaymentActions,
  paymentProviderStatus, newPublicToken, toAmount,
} from '../../lib/deposits';
import { enterTenantContext } from '../../lib/tenantContext';
import { resolveIngressTenant } from '../../lib/tenantIngressResolvers';
import { requirePermission } from '../../lib/permissions';
import { assertBranchAccess, branchScope } from '../../lib/scope';
import type { Prisma } from '../../generated/prisma/client';

// ===========================================================================
// Appointment Checkout — appointment-linked deposit/payment status, payment
// link generation (real Stripe or setup_required, never faked), deposit waiver,
// and the payment-request queue. Reuses the existing payment provider, models,
// idempotency, and Stripe webhook from revenue-protection.
// ===========================================================================

const uuid = z.string().uuid();
const idParam = z.object({ id: uuid });
// OWNER/ADMIN/BILLING configure deposit/payment settings (+ MANAGER as admin).
const configRoles = requireRoles('OWNER', 'ADMIN', 'MANAGER', 'BILLING');
// FRONT_DESK may additionally generate/send payment links.
const actionRoles = requireRoles('OWNER', 'ADMIN', 'MANAGER', 'BILLING', 'FRONT_DESK');

const LINK_TTL_HOURS = 72;
const PROVIDER_PENDING_RECONCILIATION_MS = 2 * 60 * 1000;

type PaymentLinkOutcome = {
  currency: string;
  status: string;
  providerMode: string;
  providerReference?: string;
  paymentUrl?: string;
};

type PaymentLinkClaim =
  | { kind: 'existing' | 'resume'; requirementId: string; paymentRequestId: string }
  | { kind: 'pending' | 'unknown'; requirementId: string; paymentRequestId: string }
  | { kind: 'claimed'; requirementId: string; paymentRequestId: string; publicToken: string };

function paymentLinkLockKey(tenantId: string, appointmentId: string) {
  return `payment-link:${tenantId}:${appointmentId}`;
}

export async function claimPaymentLink(
  tenantId: string,
  appointmentId: string,
  input: { branchId: string; patientId: string | null; mode: string },
): Promise<PaymentLinkClaim | null> {
  return db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${paymentLinkLockKey(tenantId, appointmentId)})::bigint)`;
    const requirement = await tx.depositRequirement.findFirst({
      where: { tenantId, appointmentId, status: { notIn: ['cancelled', 'waived'] } },
      orderBy: { createdAt: 'desc' },
    });
    if (!requirement) return null;

    const current = await tx.paymentRequest.findFirst({
      where: {
        tenantId,
        appointmentId,
        status: { notIn: ['failed', 'expired', 'cancelled'] },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (current) {
      if (current.status === 'provider_pending') {
        if (Date.now() - current.createdAt.getTime() >= PROVIDER_PENDING_RECONCILIATION_MS) {
          await tx.paymentRequest.update({ where: { id: current.id }, data: { status: 'provider_outcome_unknown' } });
          return { kind: 'unknown', requirementId: requirement.id, paymentRequestId: current.id };
        }
        return { kind: 'pending', requirementId: requirement.id, paymentRequestId: current.id };
      }
      if (current.status === 'provider_outcome_unknown') return { kind: 'unknown', requirementId: requirement.id, paymentRequestId: current.id };
      if ((current.status === 'reconciliation_required' || current.status === 'reconciliation_required_paid') && current.paymentUrl) {
        return { kind: 'resume', requirementId: requirement.id, paymentRequestId: current.id };
      }
      if (current.status === 'reconciliation_required' || current.status === 'reconciliation_required_paid') {
        return { kind: 'unknown', requirementId: requirement.id, paymentRequestId: current.id };
      }
      if (current.status === 'collected') return { kind: 'existing', requirementId: requirement.id, paymentRequestId: current.id };
      const unexpired = !current.linkExpiresAt || current.linkExpiresAt.getTime() > Date.now();
      if (current.paymentUrl && unexpired) return { kind: 'existing', requirementId: requirement.id, paymentRequestId: current.id };
      if (current.status === 'link_sent' && !unexpired) {
        await tx.paymentRequest.update({ where: { id: current.id }, data: { status: 'expired' } });
      } else if (!current.paymentUrl) {
        return { kind: 'pending', requirementId: requirement.id, paymentRequestId: current.id };
      }
    }

    const publicToken = newPublicToken();
    const reserved = await tx.paymentRequest.create({
      data: {
        tenantId,
        branchId: input.branchId,
        patientId: input.patientId,
        appointmentId,
        amount: requirement.requiredAmount,
        currency: 'USD',
        status: 'provider_pending',
        reason: requirement.reason || 'Appointment deposit',
        mode: input.mode,
        dueAt: requirement.dueAt ?? undefined,
        publicToken,
      },
    });
    // Bind the reservation immediately, before the provider call. The
    // requirement remains requested until the real provider/webhook outcome,
    // but a webhook that wins the persist/finalize race can now reconcile the
    // exact requirement atomically.
    await tx.depositRequirement.update({
      where: { id: requirement.id },
      data: { paymentRequestId: reserved.id },
    });
    return { kind: 'claimed', requirementId: requirement.id, paymentRequestId: reserved.id, publicToken };
  });
}

export async function persistProviderOutcome(
  tenantId: string,
  appointmentId: string,
  paymentRequestId: string,
  outcome: PaymentLinkOutcome,
  linkExpiresAt: Date,
) {
  return db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${paymentLinkLockKey(tenantId, appointmentId)})::bigint)`;
    return tx.paymentRequest.updateMany({
      where: { id: paymentRequestId, tenantId, appointmentId, status: 'provider_pending' },
      data: {
        status: outcome.status === 'paid' ? 'reconciliation_required_paid' : 'reconciliation_required',
        currency: outcome.currency,
        mode: outcome.providerMode,
        paymentUrl: outcome.paymentUrl,
        providerReference: outcome.providerReference,
        linkExpiresAt,
      },
    });
  });
}

export async function finalizePaymentLink(
  request: Parameters<typeof audit>[0],
  input: { appointmentId: string; requirementId: string; paymentRequestId: string; amount: number; providerKey: string; outcome: PaymentLinkOutcome },
) {
  const tenantId = request.auth.tenantId;
  return db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${paymentLinkLockKey(tenantId, input.appointmentId)})::bigint)`;
    // Serialize with the Stripe webhook's request-scoped reconciliation lock.
    // If Stripe wins the race and marks the request collected, finalization
    // observes that terminal state and must never regress it to link_sent.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'payment.request:' + input.paymentRequestId}, 0))`;
    const paymentRequest = await tx.paymentRequest.findFirst({
      where: { id: input.paymentRequestId, tenantId, appointmentId: input.appointmentId },
    });
    if (!paymentRequest) throw new Error('payment_link_reservation_missing');
    if (paymentRequest.status === 'link_sent') return paymentRequest;
    if (paymentRequest.status === 'collected') {
      await tx.depositRequirement.updateMany({
        where: { id: input.requirementId, tenantId, appointmentId: input.appointmentId },
        data: { status: 'collected', paymentRequestId: paymentRequest.id },
      });
      return paymentRequest;
    }
    if ((paymentRequest.status !== 'reconciliation_required' && paymentRequest.status !== 'reconciliation_required_paid') || !paymentRequest.paymentUrl) {
      throw new Error('payment_link_provider_outcome_not_ready');
    }

    const finalized = await tx.paymentRequest.update({
      where: { id: paymentRequest.id },
      data: { status: paymentRequest.status === 'reconciliation_required_paid' ? 'collected' : 'link_sent' },
    });
    await tx.depositRequirement.update({
      where: { id: input.requirementId },
      data: { status: paymentRequest.status === 'reconciliation_required_paid' ? 'collected' : 'link_sent', paymentRequestId: finalized.id },
    });
    const auditBase: Omit<Prisma.AuditEventUncheckedCreateInput, 'action' | 'resource' | 'resourceId'> = {
      tenantId,
      actorUserId: request.auth.userId,
      requestId: request.id,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
    };
    await tx.auditEvent.create({
      data: { ...auditBase, action: 'payment.request.created', resource: 'paymentRequest', resourceId: finalized.id, metadata: { appointmentId: input.appointmentId, amount: input.amount, mode: input.outcome.providerMode } },
    });
    await tx.auditEvent.create({
      data: { ...auditBase, action: 'payment.link.created', resource: 'paymentRequest', resourceId: finalized.id, metadata: { appointmentId: input.appointmentId, provider: input.providerKey } },
    });
    await tx.businessEvent.createMany({ data: [
      { tenantId, eventType: 'payment.request.created', entityType: 'paymentRequest', entityId: finalized.id, sourceModule: 'payments', payload: { appointmentId: input.appointmentId, amount: input.amount } },
      { tenantId, eventType: 'payment.link.created', entityType: 'paymentRequest', entityId: finalized.id, sourceModule: 'payments', payload: { appointmentId: input.appointmentId } },
    ] });
    return finalized;
  });
}

async function loadAppointmentPaymentState(tenantId: string, appointmentId: string) {
  const [requirement, paymentRequest, succeededTxn, refundedTxn] = await Promise.all([
    db.depositRequirement.findFirst({ where: { tenantId, appointmentId, status: { notIn: ['cancelled'] } }, orderBy: { createdAt: 'desc' } }),
    db.paymentRequest.findFirst({ where: { tenantId, appointmentId }, orderBy: { createdAt: 'desc' } }),
    db.paymentTransaction.findFirst({ where: { tenantId, appointmentId, status: 'succeeded' }, select: { id: true } }),
    db.paymentTransaction.findFirst({ where: { tenantId, appointmentId, status: 'refunded' }, select: { id: true } }),
  ]);
  const status = deriveAppointmentPaymentStatus({
    requirement: requirement ? { status: requirement.status } : null,
    paymentRequest: paymentRequest ? { status: paymentRequest.status, paymentUrl: paymentRequest.paymentUrl, linkExpiresAt: paymentRequest.linkExpiresAt } : null,
    hasSucceededTxn: Boolean(succeededTxn),
    hasRefundedTxn: Boolean(refundedTxn),
  });
  return { requirement, paymentRequest, status };
}

// Mobile-ready payment view for an appointment.
function buildPaymentView(appointmentId: string, patientId: string | null, state: Awaited<ReturnType<typeof loadAppointmentPaymentState>>, providerSetupRequired: boolean) {
  const { requirement, paymentRequest, status } = state;
  const amount = requirement ? toAmount(requirement.requiredAmount) : paymentRequest ? toAmount(paymentRequest.amount) : 0;
  return {
    appointmentId,
    patientId,
    paymentRequestId: paymentRequest?.id ?? null,
    depositRequirementId: requirement?.id ?? null,
    required: Boolean(requirement) && status !== 'not_required',
    status,
    amount,
    currency: paymentRequest?.currency ?? 'USD',
    paymentUrl: paymentRequest?.paymentUrl ?? null,
    dueAt: requirement?.dueAt?.toISOString() ?? null,
    expiresAt: paymentRequest?.linkExpiresAt?.toISOString() ?? null,
    allowedActions: allowedPaymentActions(status),
    followUpNeeded: status === 'failed' || status === 'expired',
    deepLinkTarget: `appointment/${appointmentId}`,
    setupRequired: providerSetupRequired,
  };
}

export const paymentsCheckoutRoutes: FastifyPluginAsync = async app => {
  // ----- Provider setup status (no secrets) -------------------------------
  app.get('/provider-status', { preHandler: requireFeature('payments_deposits') }, async () => {
    const s = paymentProviderStatus();
    return { provider: s.provider, mode: s.mode, configured: s.configured, mock: s.mock, setupRequired: s.setupRequired };
  });

  // ----- Appointment payment/deposit status (view only; PROVIDER-safe) -----
  app.get('/appointments/:id/payment', { preHandler: [requireFeature('appointments'), requirePermission('billing:read')] }, async request => {
    const { id } = idParam.parse(request.params);
    const appointment = await db.appointment.findFirst({ where: { id, tenantId: request.auth.tenantId, deletedAt: null, ...branchScope(request) }, select: { id: true, patientId: true, branchId: true } });
    if (!appointment) throw app.httpErrors.notFound('Appointment not found');
    assertBranchAccess(request, appointment.branchId);
    const state = await loadAppointmentPaymentState(request.auth.tenantId, id);
    await audit(request, { action: 'payment.appointment.read', resource: 'appointment', resourceId: id, metadata: { branchId: appointment.branchId } });
    return buildPaymentView(id, appointment.patientId, state, paymentProviderStatus().setupRequired);
  });

  // ----- Evaluate / link a deposit requirement for an appointment ----------
  app.post('/appointments/:id/deposit', { preHandler: [requireFeature('payments_deposits'), configRoles] }, async request => {
    const { id } = idParam.parse(request.params);
    const appointment = await db.appointment.findFirst({ where: { id, tenantId: request.auth.tenantId, deletedAt: null, ...branchScope(request) }, select: { id: true, patientId: true, branchId: true } });
    if (!appointment) throw app.httpErrors.notFound('Appointment not found');
    assertBranchAccess(request, appointment.branchId);
    const result = await evaluateDepositForAppointment(request.auth.tenantId, id, { actorUserId: request.auth.userId });
    const state = await loadAppointmentPaymentState(request.auth.tenantId, id);
    return { evaluation: result, payment: buildPaymentView(id, appointment.patientId, state, paymentProviderStatus().setupRequired) };
  });

  // ----- Generate a payment link for the appointment deposit ---------------
  app.post('/appointments/:id/payment-link', { preHandler: [requireFeature('payments_deposits'), actionRoles] }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const appointment = await db.appointment.findFirst({
      where: { id, tenantId: request.auth.tenantId, deletedAt: null, ...branchScope(request) },
      include: { patient: { select: { id: true, firstName: true, lastName: true, lifecycleStage: true, churnRisk: true } } },
    });
    if (!appointment) throw app.httpErrors.notFound('Appointment not found');
    assertBranchAccess(request, appointment.branchId);

    // Ensure a deposit requirement exists (evaluate if a rule applies).
    await evaluateDepositForAppointment(request.auth.tenantId, id, { actorUserId: request.auth.userId });
    const requirement = await db.depositRequirement.findFirst({ where: { tenantId: request.auth.tenantId, appointmentId: id, status: { notIn: ['cancelled', 'waived'] } }, orderBy: { createdAt: 'desc' } });
    if (!requirement) {
      return reply.code(200).send({ status: 'not_required', message: 'No deposit is required for this appointment.' });
    }

    // Truthful provider gating: never fabricate a link when Stripe is unconfigured.
    const providerStatus = paymentProviderStatus();
    if (providerStatus.setupRequired) {
      return reply.code(200).send({ status: 'setup_required', setupRequired: true, provider: providerStatus.provider, message: `Connect ${providerStatus.provider} (set STRIPE_SECRET_KEY) to generate payment links.` });
    }

    const claim = await claimPaymentLink(request.auth.tenantId, id, {
      branchId: appointment.branchId,
      patientId: appointment.patientId,
      mode: providerStatus.mode,
    });
    if (!claim) {
      return reply.code(200).send({ status: 'not_required', message: 'No deposit is required for this appointment.' });
    }
    if (claim.kind === 'pending') {
      return reply.code(202).send({ status: 'link_creation_in_progress', retryable: true, paymentRequestId: claim.paymentRequestId });
    }
    if (claim.kind === 'unknown') {
      return reply.code(409).send({ status: 'reconciliation_required', retryable: false, paymentRequestId: claim.paymentRequestId, message: 'The payment provider outcome is unknown. Reconcile with the provider before retrying to avoid a duplicate link.' });
    }
    if (claim.kind === 'existing') {
      const existing = await db.paymentRequest.findUniqueOrThrow({ where: { id: claim.paymentRequestId } });
      const state = await loadAppointmentPaymentState(request.auth.tenantId, id);
      await audit(request, { action: 'payment.link.read', resource: 'paymentRequest', resourceId: existing.id, metadata: { appointmentId: id, reused: true } });
      return reply.code(200).send({ status: 'link_created', reused: true, payment: buildPaymentView(id, appointment.patientId, state, false), checkoutUrl: existing.paymentUrl, publicToken: existing.publicToken });
    }

    const amount = toAmount(requirement.requiredAmount);
    const provider = createPaymentProvider();
    const ctx = {
      tenantId: request.auth.tenantId,
      branchId: appointment.branchId,
      amount,
      reason: requirement.reason || 'Appointment deposit',
      patient: appointment.patient ? { id: appointment.patient.id, firstName: appointment.patient.firstName, lastName: appointment.patient.lastName, branchId: appointment.branchId, outstandingBalance: 0, lifecycleStage: appointment.patient.lifecycleStage, churnRisk: appointment.patient.churnRisk } : undefined,
      appointment: { id: appointment.id, branchId: appointment.branchId, service: appointment.service, startsAt: appointment.startsAt, value: toAmount(appointment.value), noShowRisk: appointment.noShowRisk },
    } as PaymentRequestContext;

    let outcome: PaymentLinkOutcome;
    if (claim.kind === 'resume') {
      const stored = await db.paymentRequest.findUniqueOrThrow({ where: { id: claim.paymentRequestId } });
      outcome = {
        currency: stored.currency,
        status: stored.status === 'reconciliation_required_paid' ? 'paid' : 'pending',
        providerMode: stored.mode,
        providerReference: stored.providerReference ?? undefined,
        paymentUrl: stored.paymentUrl ?? undefined,
      };
    } else {
      try {
        outcome = await provider.createPaymentLink(ctx);
      } catch (error) {
        request.log.error({ err: error }, 'Payment link provider outcome is unknown');
        await db.paymentRequest.updateMany({
          where: { id: claim.paymentRequestId, status: 'provider_pending' },
          data: { status: 'provider_outcome_unknown' },
        });
        return reply.code(502).send({ status: 'reconciliation_required', error: 'payment_provider_outcome_unknown', retryable: false, paymentRequestId: claim.paymentRequestId });
      }
      if (!outcome.paymentUrl) {
        await db.paymentRequest.updateMany({
          where: { id: claim.paymentRequestId, status: 'provider_pending' },
          data: { status: 'provider_outcome_unknown', providerReference: outcome.providerReference },
        });
        return reply.code(502).send({ status: 'reconciliation_required', error: 'no_payment_url', retryable: false, paymentRequestId: claim.paymentRequestId });
      }
      let persisted;
      try {
        persisted = await persistProviderOutcome(
          request.auth.tenantId,
          id,
          claim.paymentRequestId,
          outcome,
          new Date(Date.now() + LINK_TTL_HOURS * 3600 * 1000),
        );
      } catch (error) {
        request.log.error({ err: error, paymentRequestId: claim.paymentRequestId }, 'Provider created a payment link but its local outcome could not be persisted');
        return reply.code(503).send({ status: 'reconciliation_required', error: 'payment_provider_outcome_persistence_failed', retryable: false, paymentRequestId: claim.paymentRequestId });
      }
      if (persisted.count !== 1) {
        return reply.code(409).send({ status: 'reconciliation_required', error: 'payment_link_reservation_changed', retryable: false, paymentRequestId: claim.paymentRequestId });
      }
    }

    let paymentRequest;
    try {
      paymentRequest = await finalizePaymentLink(request, {
        appointmentId: id,
        requirementId: claim.requirementId,
        paymentRequestId: claim.paymentRequestId,
        amount,
        providerKey: provider.providerKey,
        outcome,
      });
    } catch (error) {
      request.log.error({ err: error, paymentRequestId: claim.paymentRequestId }, 'Payment link local finalization failed; durable reconciliation retained');
      return reply.code(503).send({ status: 'reconciliation_required', error: 'payment_link_local_finalize_failed', retryable: true, paymentRequestId: claim.paymentRequestId });
    }

    const state = await loadAppointmentPaymentState(request.auth.tenantId, id);
    return reply.code(claim.kind === 'resume' ? 200 : 201).send({ status: 'link_created', reused: claim.kind === 'resume', mode: outcome.providerMode, checkoutUrl: paymentRequest.paymentUrl, publicToken: paymentRequest.publicToken, payment: buildPaymentView(id, appointment.patientId, state, false) });
  });

  // ----- Waive a deposit requirement (audited; no money movement) ----------
  app.post('/deposit-requirements/:id/waive', { preHandler: [requireFeature('payments_deposits'), configRoles] }, async request => {
    const { id } = idParam.parse(request.params);
    const body = z.object({ reason: z.string().trim().min(2).max(240) }).parse(request.body ?? {});
    const requirement = await db.depositRequirement.findFirst({ where: { id, tenantId: request.auth.tenantId, ...branchScope(request) } });
    if (!requirement) throw app.httpErrors.notFound('Deposit requirement not found');
    assertBranchAccess(request, requirement.branchId);
    if (requirement.status === 'collected') throw app.httpErrors.conflict('A collected deposit cannot be waived');
    const row = await db.depositRequirement.update({ where: { id }, data: { status: 'waived', waiverReason: body.reason } });
    await audit(request, { action: 'deposit.waived', resource: 'depositRequirement', resourceId: id, metadata: { reason: body.reason, appointmentId: requirement.appointmentId } });
    return { id: row.id, status: row.status, waiverReason: row.waiverReason };
  });

  // ----- Payment-request queue (mobile-ready) ------------------------------
  app.get('/payment-requests', { preHandler: [requireFeature('payments_deposits'), requirePermission('billing:read')] }, async request => {
    const query = z.object({ status: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).default(100) }).parse(request.query);
    const rows = await db.paymentRequest.findMany({
      where: { tenantId: request.auth.tenantId, ...branchScope(request), ...(query.status ? { status: query.status } : {}) },
      orderBy: { createdAt: 'desc' },
      take: query.limit,
      include: { appointment: { select: { service: true, startsAt: true } }, patient: { select: { firstName: true, lastName: true } } },
    });
    await audit(request, { action: 'payment.queue.read', resource: 'paymentRequest', metadata: { resultCount: rows.length, status: query.status ?? null, branchScoped: Boolean(request.auth.branchId) } });
    return rows.map(r => ({
      paymentRequestId: r.id,
      appointmentId: r.appointmentId,
      patientId: r.patientId,
      patientName: r.patient ? `${r.patient.firstName} ${r.patient.lastName}` : null,
      service: r.appointment?.service ?? null,
      amount: toAmount(r.amount),
      currency: r.currency,
      status: r.status,
      mode: r.mode,
      paymentUrl: r.paymentUrl,
      dueAt: r.dueAt?.toISOString() ?? null,
      expiresAt: r.linkExpiresAt?.toISOString() ?? null,
      followUpNeeded: r.status === 'failed' || r.status === 'expired',
      deepLinkTarget: `payment-request/${r.id}`,
    }));
  });
};

// ===== Public, tokenized, patient-safe checkout status (no auth) ===========
// Minimal summary only — no staff notes, no risk scores, no internal labels,
// no guessable ids. Looked up by opaque publicToken.
export const paymentsPublicRoutes: FastifyPluginAsync = async app => {
  app.get('/public/checkout/:token', async (request, reply) => {
    const { token } = z.object({ token: uuid }).parse(request.params);
    const resolved = await resolveIngressTenant('payment_public_token', token);
    if (!resolved) return reply.code(404).send({ error: 'not_found' });
    enterTenantContext({ tenantId: resolved.tenantId, actorId: resolved.resourceId, actorRole: 'PUBLIC_PAYMENT', source: 'portal', requestId: request.id });
    const pr = await db.paymentRequest.findFirst({
      where: { id: resolved.resourceId, publicToken: token },
      include: { tenant: { select: { name: true } }, appointment: { select: { service: true, startsAt: true } } },
    });
    if (!pr) return reply.code(404).send({ error: 'not_found' });
    const expired = pr.linkExpiresAt ? pr.linkExpiresAt.getTime() < Date.now() : false;
    const status = pr.status === 'collected' ? 'paid' : expired ? 'expired' : pr.status === 'failed' ? 'failed' : 'pending';
    return {
      clinicName: pr.tenant.name,
      service: pr.appointment?.service ?? 'Appointment deposit',
      appointmentAt: pr.appointment?.startsAt?.toISOString() ?? null,
      amount: toAmount(pr.amount),
      currency: pr.currency,
      status,
      checkoutUrl: status === 'pending' ? pr.paymentUrl : null,
      note: env.PAYMENT_PROVIDER === 'mock' ? 'Demo/mock payment environment.' : undefined,
    };
  });
};
