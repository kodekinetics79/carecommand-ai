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
import { recordWorkflowEvent } from '../../lib/intelligence';

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
  app.get('/appointments/:id/payment', { preHandler: requireFeature('appointments') }, async request => {
    const { id } = idParam.parse(request.params);
    const appointment = await db.appointment.findFirst({ where: { id, tenantId: request.auth.tenantId, deletedAt: null }, select: { id: true, patientId: true } });
    if (!appointment) throw app.httpErrors.notFound('Appointment not found');
    const state = await loadAppointmentPaymentState(request.auth.tenantId, id);
    return buildPaymentView(id, appointment.patientId, state, paymentProviderStatus().setupRequired);
  });

  // ----- Evaluate / link a deposit requirement for an appointment ----------
  app.post('/appointments/:id/deposit', { preHandler: [requireFeature('payments_deposits'), configRoles] }, async request => {
    const { id } = idParam.parse(request.params);
    const appointment = await db.appointment.findFirst({ where: { id, tenantId: request.auth.tenantId, deletedAt: null }, select: { id: true, patientId: true } });
    if (!appointment) throw app.httpErrors.notFound('Appointment not found');
    const result = await evaluateDepositForAppointment(request.auth.tenantId, id, { actorUserId: request.auth.userId });
    const state = await loadAppointmentPaymentState(request.auth.tenantId, id);
    return { evaluation: result, payment: buildPaymentView(id, appointment.patientId, state, paymentProviderStatus().setupRequired) };
  });

  // ----- Generate a payment link for the appointment deposit ---------------
  app.post('/appointments/:id/payment-link', { preHandler: [requireFeature('payments_deposits'), actionRoles] }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const appointment = await db.appointment.findFirst({
      where: { id, tenantId: request.auth.tenantId, deletedAt: null },
      include: { patient: { select: { id: true, firstName: true, lastName: true, lifecycleStage: true, churnRisk: true } } },
    });
    if (!appointment) throw app.httpErrors.notFound('Appointment not found');

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

    // Idempotent: reuse an existing live, unexpired link instead of duplicating.
    const existing = await db.paymentRequest.findFirst({ where: { tenantId: request.auth.tenantId, appointmentId: id, status: { notIn: ['failed', 'expired', 'cancelled'] }, paymentUrl: { not: null } }, orderBy: { createdAt: 'desc' } });
    if (existing && (!existing.linkExpiresAt || existing.linkExpiresAt.getTime() > Date.now())) {
      const state = await loadAppointmentPaymentState(request.auth.tenantId, id);
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

    let outcome;
    try {
      outcome = await provider.createPaymentLink(ctx);
    } catch (error) {
      request.log.error({ err: error }, 'Payment link creation failed');
      return reply.code(502).send({ status: 'failed', error: 'payment_link_failed' });
    }
    if (!outcome.paymentUrl) {
      return reply.code(502).send({ status: 'failed', error: 'no_payment_url' });
    }

    const publicToken = newPublicToken();
    const linkExpiresAt = new Date(Date.now() + LINK_TTL_HOURS * 3600 * 1000);
    const paymentRequest = await db.paymentRequest.create({
      data: {
        tenantId: request.auth.tenantId, branchId: appointment.branchId, patientId: appointment.patientId, appointmentId: id,
        amount, currency: outcome.currency, status: outcome.status === 'paid' ? 'collected' : 'link_sent', reason: requirement.reason || 'Appointment deposit',
        mode: outcome.providerMode, paymentUrl: outcome.paymentUrl, providerReference: outcome.providerReference,
        dueAt: requirement.dueAt ?? undefined, publicToken, linkExpiresAt,
      },
    });
    await db.depositRequirement.update({ where: { id: requirement.id }, data: { status: 'link_sent', paymentRequestId: paymentRequest.id } });

    await audit(request, { action: 'payment.request.created', resource: 'paymentRequest', resourceId: paymentRequest.id, metadata: { appointmentId: id, amount, mode: outcome.providerMode } });
    await audit(request, { action: 'payment.link.created', resource: 'paymentRequest', resourceId: paymentRequest.id, metadata: { appointmentId: id, provider: provider.providerKey } });
    await recordWorkflowEvent(request.auth.tenantId, { eventType: 'payment.request.created', entityType: 'paymentRequest', entityId: paymentRequest.id, sourceModule: 'payments', payload: { appointmentId: id, amount } });
    await recordWorkflowEvent(request.auth.tenantId, { eventType: 'payment.link.created', entityType: 'paymentRequest', entityId: paymentRequest.id, sourceModule: 'payments', payload: { appointmentId: id } });

    const state = await loadAppointmentPaymentState(request.auth.tenantId, id);
    return reply.code(201).send({ status: 'link_created', mode: outcome.providerMode, checkoutUrl: outcome.paymentUrl, publicToken, payment: buildPaymentView(id, appointment.patientId, state, false) });
  });

  // ----- Waive a deposit requirement (audited; no money movement) ----------
  app.post('/deposit-requirements/:id/waive', { preHandler: [requireFeature('payments_deposits'), configRoles] }, async request => {
    const { id } = idParam.parse(request.params);
    const body = z.object({ reason: z.string().trim().min(2).max(240) }).parse(request.body ?? {});
    const requirement = await db.depositRequirement.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!requirement) throw app.httpErrors.notFound('Deposit requirement not found');
    if (requirement.status === 'collected') throw app.httpErrors.conflict('A collected deposit cannot be waived');
    const row = await db.depositRequirement.update({ where: { id }, data: { status: 'waived', waiverReason: body.reason } });
    await audit(request, { action: 'deposit.waived', resource: 'depositRequirement', resourceId: id, metadata: { reason: body.reason, appointmentId: requirement.appointmentId } });
    return { id: row.id, status: row.status, waiverReason: row.waiverReason };
  });

  // ----- Payment-request queue (mobile-ready) ------------------------------
  app.get('/payment-requests', { preHandler: requireFeature('payments_deposits') }, async request => {
    const query = z.object({ status: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).default(100) }).parse(request.query);
    const rows = await db.paymentRequest.findMany({
      where: { tenantId: request.auth.tenantId, ...(query.status ? { status: query.status } : {}) },
      orderBy: { createdAt: 'desc' },
      take: query.limit,
      include: { appointment: { select: { service: true, startsAt: true } }, patient: { select: { firstName: true, lastName: true } } },
    });
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
    const pr = await db.paymentRequest.findFirst({
      where: { publicToken: token },
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
