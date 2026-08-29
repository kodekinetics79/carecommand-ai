import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client';
import { db } from '../../lib/db';
import { requirePortalAccess, requirePortalFeature, portalAudit } from '../../lib/portalAuth';
import { publicView, submitSectionMutation, emitSectionSubmissionEffects, submitPacketMutation, emitPacketSubmissionEffects, readinessScore } from '../../lib/intake';
import { computeProviderSlots, findSlotConflict, getSchedulingPolicy, isDoubleBookConflictError, resolveSchedulingService, unmetPreVisitRequirements } from '../../lib/scheduling';
import { evaluateDepositForAppointment } from '../../lib/deposits';
import { canonicalDncDestination, lockSuppressionFences } from '../../lib/receptionist/dncFence';

// Appointment states a patient can still act on from the portal. COMPLETED /
// ARRIVED / NO_SHOW are terminal-for-the-patient (staff-only from here on).
const PATIENT_MUTABLE_STATUSES = ['CONFIRMED', 'RISKY', 'WAITLIST'] as const;

const n = (v: unknown): number => typeof v === 'object' && v !== null && 'toString' in v ? Number(v) : Number(v) || 0;

// Patient-safe wording for insurance state (never the internal setup_required).
function safeInsuranceStatus(policy: { verificationStatus: string; verifiedAt: Date | null } | null): string {
  if (!policy) return 'needs_update';
  const s = policy.verificationStatus.toLowerCase();
  if (s.includes('verif') || s === 'active') {
    if (policy.verifiedAt && policy.verifiedAt > new Date(Date.now() - 30 * 86400000)) return 'verified_recently';
    return 'on_file';
  }
  if (s.includes('pending') || s.includes('review') || s === 'setup_required') return 'pending_review';
  if (s.includes('expire')) return 'expired';
  if (s.includes('fail') || s.includes('unable')) return 'unable_to_verify';
  return 'pending_review';
}

export function insuranceCardState(status: string): 'completed' | 'pending_review' | 'needs_update' | 'action_required' {
  if (status === 'verified_recently') return 'completed';
  if (status === 'needs_update') return 'needs_update';
  if (status === 'expired' || status === 'unable_to_verify') return 'action_required';
  return 'pending_review';
}
function intakeLabel(status: string): string {
  const s = status.toLowerCase();
  if (s === 'submitted' || s === 'reviewed') return 'completed';
  if (s === 'in_progress') return 'action_required';
  if (s === 'draft') return 'action_required';
  return 'pending_review';
}

export const portalRoutes: FastifyPluginAsync = async app => {
  app.addHook('preHandler', requirePortalAccess());
  app.addHook('preHandler', requirePortalFeature());
  // A soft-deleted patient must not retain access through an otherwise-valid,
  // unexpired portal JWT.
  app.addHook('preHandler', async (request, reply) => {
    const portal = request.portal;
    if (!portal) return;
    const patient = await db.patient.findFirst({ where: { id: portal.patientId, tenantId: portal.tenantId, deletedAt: null }, select: { id: true } });
    if (!patient) return reply.code(401).send({ error: 'portal_unauthorized', message: 'This account is no longer active.' });
  });

  // ===== Dashboard (patient-safe summary) =================================
  app.get('/dashboard', async request => {
    const { tenantId, patientId } = request.portal!;
    const now = new Date();
    const [patient, tenant, upcoming, requests, packet, payments, policy, estimate] = await Promise.all([
      db.patient.findUnique({ where: { id: patientId }, select: { firstName: true, lastName: true, branchId: true } }),
      db.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
      db.appointment.findMany({ where: { tenantId, patientId, startsAt: { gte: now }, status: { notIn: ['CANCELED', 'NO_SHOW'] } }, orderBy: { startsAt: 'asc' }, take: 3, select: { id: true, service: true, startsAt: true, status: true } }),
      db.appointmentRequest.count({ where: { tenantId, patientId, status: 'PENDING_REVIEW' } }),
      db.patientIntakePacket.findFirst({ where: { tenantId, patientId }, orderBy: { createdAt: 'desc' }, select: { id: true, status: true, readinessScore: true } }),
      db.paymentRequest.findMany({ where: { tenantId, patientId, status: { in: ['pending', 'requires_action', 'unpaid', 'requested'] } }, select: { amount: true, currency: true } }),
      db.patientInsurancePolicy.findFirst({ where: { tenantId, patientId, active: true }, orderBy: { createdAt: 'desc' }, select: { verificationStatus: true, verifiedAt: true } }),
      db.patientResponsibilityEstimate.findFirst({ where: { tenantId, patientId }, orderBy: { createdAt: 'desc' }, select: { id: true, acknowledgedAt: true } }),
    ]);

    const branchName = patient?.branchId ? (await db.branch.findUnique({ where: { id: patient.branchId }, select: { name: true } }))?.name ?? null : null;
    const unpaidTotal = payments.reduce((s, p) => s + n(p.amount), 0);
    const insuranceStatus = safeInsuranceStatus(policy);
    const cards = {
      nextAppointment: upcoming[0] ? { service: upcoming[0].service, startsAt: upcoming[0].startsAt.toISOString(), state: 'scheduled' } : { state: 'unavailable' },
      intake: packet ? { state: intakeLabel(packet.status) } : { state: 'unavailable' },
      insurance: { state: insuranceCardState(insuranceStatus), detail: insuranceStatus },
      payment: unpaidTotal > 0 ? { state: 'payment_required', amount: unpaidTotal, currency: payments[0]?.currency ?? 'USD' } : { state: 'completed' },
      estimate: estimate ? { state: estimate.acknowledgedAt ? 'completed' : 'action_required' } : { state: 'unavailable' },
      appointmentRequests: requests > 0 ? { state: 'pending_review', count: requests } : { state: 'completed' },
    };
    return {
      displayName: `${patient?.firstName ?? ''} ${patient?.lastName ?? ''}`.trim() || 'Patient',
      clinicName: tenant?.name ?? 'Your clinic',
      branchName,
      cards,
      // No versioned clinic payment-policy artifact exists yet. Never represent
      // a legacy timestamp as acknowledgment of unknown text/version.
      paymentPolicyAvailable: false,
      paymentPolicyAcknowledged: false,
      allowedActions: ['view_appointments', 'request_appointment', 'continue_intake', 'update_insurance', 'view_payments', 'acknowledge_estimate', 'update_preferences'],
      deepLinkTargets: { appointments: '/client/appointments', requests: '/client/requests', intake: '/client/intake', insurance: '/client/insurance', payments: '/client/payments', profile: '/client/profile', preferences: '/client/preferences' },
    };
  });

  // ===== Appointments =====================================================
  app.get('/appointments', async request => {
    const { tenantId, patientId } = request.portal!;
    const now = new Date();
    const rows = await db.appointment.findMany({ where: { tenantId, patientId }, orderBy: { startsAt: 'desc' }, take: 50, select: { id: true, service: true, startsAt: true, endsAt: true, status: true, providerRef: true } });
    return {
      upcoming: rows.filter(r => r.startsAt >= now && !['CANCELED', 'NO_SHOW'].includes(r.status)).map(safeAppt),
      past: rows.filter(r => r.startsAt < now || ['CANCELED', 'NO_SHOW'].includes(r.status)).slice(0, 20).map(safeAppt),
    };
  });
  app.get('/appointments/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { tenantId, patientId } = request.portal!;
    const a = await db.appointment.findFirst({ where: { id, tenantId, patientId }, select: { id: true, service: true, startsAt: true, endsAt: true, status: true, providerRef: true } });
    if (!a) return reply.code(404).send({ error: 'not_found' });
    return safeAppt(a);
  });

  // ===== Appointment requests (submit for staff review; idempotent) ======
  app.get('/appointment-requests', async request => {
    const { tenantId, patientId } = request.portal!;
    const rows = await db.appointmentRequest.findMany({ where: { tenantId, patientId }, orderBy: { createdAt: 'desc' }, take: 30, select: { id: true, requestedService: true, requestedDateTime: true, status: true, createdAt: true } });
    return rows.map(r => ({ id: r.id, service: r.requestedService, requestedDateTime: r.requestedDateTime?.toISOString() ?? null, status: r.status, createdAt: r.createdAt.toISOString() }));
  });
  app.post('/appointment-requests', async (request, reply) => {
    const { tenantId, patientId } = request.portal!;
    const body = z.object({ service: z.string().trim().min(2).max(120), requestedDateTime: z.coerce.date().optional(), notes: z.string().trim().max(500).optional() }).parse(request.body);
    const patient = await db.patient.findUnique({ where: { id: patientId }, select: { branchId: true, firstName: true, lastName: true, email: true, phone: true } });
    // Idempotent: an identical pending request from this patient is returned as-is.
    const existing = await db.appointmentRequest.findFirst({ where: { tenantId, patientId, status: 'PENDING_REVIEW', requestedService: body.service, requestedDateTime: body.requestedDateTime ?? null } });
    if (existing) return reply.code(200).send({ id: existing.id, status: existing.status, deduped: true });
    const row = await db.$transaction(async tx => {
      const created = await tx.appointmentRequest.create({ data: { tenantId, branchId: patient?.branchId ?? null, patientId, requestedService: body.service, requestedDateTime: body.requestedDateTime, collectedName: `${patient?.firstName ?? ''} ${patient?.lastName ?? ''}`.trim(), collectedEmail: patient?.email ?? null, collectedPhone: patient?.phone ?? null, source: 'patient_portal', status: 'PENDING_REVIEW', rawCollectedFields: body.notes ? { notes: body.notes } : undefined } });
      await portalAudit(tenantId, 'portal.appointmentRequest.created', created.id, request, { service: body.service }, { critical: true, tx });
      return created;
    });
    return reply.code(201).send({ id: row.id, status: row.status, deduped: false });
  });

  // ===== Self-scheduling (direct booking on real availability) ===========
  // Patient books a real open slot for THEMSELVES (patientId from the portal
  // session, never the body), against providers in their own clinic. Slot math
  // + conflict checks are backend-owned (lib/scheduling.ts); booking is
  // conflict-safe in a transaction, and gated by the tenant's SchedulingPolicy
  // (self-book toggle, horizon/notice, pre-visit requirements). Distinct from
  // request-mode above.

  app.get('/booking/providers', async request => {
    const { tenantId, patientId } = request.portal!;
    const patient = await db.patient.findUnique({ where: { id: patientId }, select: { branchId: true } });
    if (!patient) return [];
    const providers = await db.providerProfile.findMany({
      // Deactivated clinicians are off the schedule; never offer one to a patient.
      where: { tenantId, branchId: patient.branchId, active: true },
      select: { id: true, specialty: true, rating: true, reviewCount: true, user: { select: { displayName: true } } },
      orderBy: { rating: 'desc' },
    });
    // Patient-safe fields only — no utilization/revenue/internal metrics.
    return providers.map(p => ({ id: p.id, name: p.user.displayName, specialty: p.specialty, rating: n(p.rating), reviewCount: p.reviewCount }));
  });

  async function loadBookableProvider(tenantId: string, patientId: string, providerId: string) {
    const patient = await db.patient.findUnique({ where: { id: patientId }, select: { branchId: true } });
    if (!patient) return null;
    return db.providerProfile.findFirst({ where: { id: providerId, tenantId, branchId: patient.branchId, active: true }, select: { id: true, branchId: true } });
  }

  app.get('/booking/providers/:providerId/slots', async (request, reply) => {
    const { tenantId, patientId } = request.portal!;
    const { providerId } = z.object({ providerId: z.string().uuid() }).parse(request.params);
    const { date, durationMin, serviceCatalogItemId, service: serviceName } = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), durationMin: z.coerce.number().int().min(5).max(240).optional(), serviceCatalogItemId: z.string().uuid().optional(), service: z.string().trim().max(160).optional() }).parse(request.query);
    const provider = await loadBookableProvider(tenantId, patientId, providerId);
    if (!provider) return reply.code(404).send({ error: 'not_found' });
    const service = await resolveSchedulingService({ tenantId, serviceCatalogItemId, service: serviceName, fallbackDurationMin: durationMin });
    if (!service) return reply.code(400).send({ error: 'invalid_service' });
    const slots = await computeProviderSlots({ tenantId, providerProfileId: providerId, dateISO: date, durationMin: service.durationMin });
    return { providerId, date, slots: slots.map(s => ({ startsAt: s.startsAt.toISOString(), endsAt: s.endsAt.toISOString() })) };
  });

  app.post('/booking/providers/:providerId/book', async (request, reply) => {
    const { tenantId, patientId } = request.portal!;
    const { providerId } = z.object({ providerId: z.string().uuid() }).parse(request.params);
    const body = z.object({
      startsAt: z.coerce.date(),
      durationMin: z.number().int().min(5).max(240).optional(),
      serviceCatalogItemId: z.string().uuid().optional(),
      reason: z.string().trim().min(2).max(160),
      channel: z.enum(['WHATSAPP', 'SMS', 'EMAIL', 'PUSH', 'CALL', 'VIDEO']).default('EMAIL'),
    }).parse(request.body);
    const provider = await loadBookableProvider(tenantId, patientId, providerId);
    if (!provider) return reply.code(404).send({ error: 'not_found' });
    const service = await resolveSchedulingService({ tenantId, serviceCatalogItemId: body.serviceCatalogItemId, service: body.reason, fallbackDurationMin: body.durationMin });
    if (!service) return reply.code(400).send({ error: 'invalid_service', message: 'Select an active service before booking.' });

    // Per-tenant self-scheduling policy: toggle, booking horizon/notice, and
    // pre-visit requirement gates — all backend-enforced.
    const policy = await getSchedulingPolicy(tenantId);
    if (!policy.selfBookEnabled) return reply.code(403).send({ error: 'self_book_disabled', message: 'Online self-booking is not available at this clinic.' });

    const now = Date.now();
    if (body.startsAt.getTime() < now + policy.minNoticeHours * 3600_000) {
      return reply.code(400).send({ error: 'too_soon', message: `Bookings require at least ${policy.minNoticeHours} hours notice.` });
    }
    if (body.startsAt > new Date(now + policy.maxHorizonDays * 86400000)) {
      return reply.code(400).send({ error: 'too_far_out', message: `Bookings are limited to the next ${policy.maxHorizonDays} days.` });
    }

    // Block confirmation until pre-visit requirements (intake/eligibility) are met.
    const unmet = await unmetPreVisitRequirements(tenantId, patientId, policy);
    if (unmet.length > 0) {
      await portalAudit(tenantId, 'portal.appointment.book_blocked', null, request, { providerId, unmet });
      return reply.code(422).send({ error: 'pre_visit_requirements_unmet', unmet, message: 'Please complete the required pre-visit steps before booking.' });
    }

    const endsAt = new Date(body.startsAt.getTime() + service.durationMin * 60_000);

    // DB exclusion constraint is the final guard if a concurrent booking races
    // past the in-transaction conflict check.
    let result: { conflict: Awaited<ReturnType<typeof findSlotConflict>> } | { appointment: Awaited<ReturnType<typeof db.appointment.create>> };
    try {
      result = await db.$transaction(async tx => {
        const conflict = await findSlotConflict({ tenantId, providerProfileId: providerId, startsAt: body.startsAt, durationMin: service.durationMin }, tx);
        if (conflict) return { conflict } as const;
        const appointment = await tx.appointment.create({
          data: { tenantId, branchId: provider.branchId, patientId, providerProfileId: providerId, providerRef: providerId, service: service.name, serviceCatalogItemId: service.id, startsAt: body.startsAt, endsAt, status: 'CONFIRMED', channel: body.channel },
        });
        await portalAudit(tenantId, 'portal.appointment.booked', appointment.id, request, { providerId }, { critical: true, tx });
        return { appointment } as const;
      });
    } catch (error) {
      if (isDoubleBookConflictError(error)) return reply.code(409).send({ error: 'slot_unavailable', reason: 'already_booked' });
      throw error;
    }
    if ('conflict' in result) return reply.code(409).send({ error: 'slot_unavailable', reason: result.conflict });

    return reply.code(201).send(safeAppt(result.appointment));
  });

  // ===== Self cancel / reschedule =========================================
  // The patient acts on THEIR OWN appointment only. Ownership is enforced by a
  // findFirst scoped to BOTH the session tenantId AND patientId — a 404 (never a
  // 403) is returned otherwise, so one patient can never confirm the existence
  // of, or touch, another patient's appointment. The clinic SchedulingPolicy's
  // min-notice window bounds how late a self-service change is allowed; deposits
  // reuse the same staff-path helpers (void unpaid, flag paid for MANUAL refund —
  // never a faked refund).

  app.post('/appointments/:id/cancel', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { tenantId, patientId } = request.portal!;
    const body = z.object({ reason: z.string().trim().max(240).optional() }).parse(request.body ?? {});
    // STRICT ownership: must belong to this patient AND tenant, or 404.
    const appt = await db.appointment.findFirst({ where: { id, tenantId, patientId, deletedAt: null } });
    if (!appt) return reply.code(404).send({ error: 'not_found' });
    if (appt.status === 'CANCELED') return { id, status: 'CANCELED', deduped: true }; // idempotent
    if (!PATIENT_MUTABLE_STATUSES.includes(appt.status as (typeof PATIENT_MUTABLE_STATUSES)[number])) {
      return reply.code(409).send({ error: 'not_cancellable', message: 'This appointment can no longer be changed online. Please contact the clinic.' });
    }

    // Min-notice window: a patient may not self-cancel inside the clinic's notice window.
    const policy = await getSchedulingPolicy(tenantId);
    if (policy.minNoticeHours > 0 && Date.now() > appt.startsAt.getTime() - policy.minNoticeHours * 3600_000) {
      return reply.code(422).send({ error: 'too_late_to_cancel', message: `Cancellations require at least ${policy.minNoticeHours} hours notice. Please contact the clinic to cancel.` });
    }

    const deposit = await db.$transaction(async tx => {
      const changed = await tx.appointment.updateMany({
        where: { id, tenantId, patientId, status: { in: [...PATIENT_MUTABLE_STATUSES] }, deletedAt: null },
        data: { status: 'CANCELED' },
      });
      if (changed.count !== 1) return null;
      const requirements = await tx.depositRequirement.findMany({ where: { tenantId, appointmentId: id, status: { notIn: ['cancelled', 'waived'] } }, select: { id: true, status: true } });
      const needsManualRefund = requirements.some(requirement => requirement.status === 'collected');
      for (const requirement of requirements.filter(row => row.status !== 'collected')) {
        await tx.depositRequirement.update({ where: { id: requirement.id }, data: { status: 'cancelled' } });
        await tx.auditEvent.create({ data: { tenantId, actorUserId: null, action: 'deposit.cancelled', resource: 'depositRequirement', resourceId: requirement.id, requestId: request.id, metadata: { appointmentId: id, source: 'patient_portal' } } });
      }
      await portalAudit(tenantId, 'portal.appointment.cancelled', id, request, { reason: body.reason ?? null, needsManualRefund }, { critical: true, tx });
      return { needsManualRefund };
    });
    if (!deposit) return reply.code(409).send({ error: 'not_cancellable', message: 'This appointment changed while you were viewing it. Refresh and contact the clinic if needed.' });
    return { id, status: 'CANCELED', deposit: { needsManualRefund: deposit.needsManualRefund } };
  });

  app.post('/appointments/:id/reschedule', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { tenantId, patientId } = request.portal!;
    const body = z.object({ startsAt: z.coerce.date(), durationMin: z.number().int().min(5).max(240).optional() }).parse(request.body);
    // STRICT ownership: must belong to this patient AND tenant, or 404.
    const appt = await db.appointment.findFirst({ where: { id, tenantId, patientId, deletedAt: null } });
    if (!appt) return reply.code(404).send({ error: 'not_found' });
    if (appt.status === 'CANCELED') return reply.code(409).send({ error: 'not_reschedulable', message: 'A cancelled appointment cannot be rescheduled. Please book a new time.' });
    if (!PATIENT_MUTABLE_STATUSES.includes(appt.status as (typeof PATIENT_MUTABLE_STATUSES)[number])) {
      return reply.code(409).send({ error: 'not_reschedulable', message: 'This appointment can no longer be changed online. Please contact the clinic.' });
    }

    const policy = await getSchedulingPolicy(tenantId);
    if (!policy.selfBookEnabled) return reply.code(403).send({ error: 'self_book_disabled', message: 'Online self-scheduling is not available at this clinic.' });

    const now = Date.now();
    // Moving an imminent appointment inside the notice window is a staff action.
    if (policy.minNoticeHours > 0 && now > appt.startsAt.getTime() - policy.minNoticeHours * 3600_000) {
      return reply.code(422).send({ error: 'too_late_to_reschedule', message: `Changes require at least ${policy.minNoticeHours} hours notice. Please contact the clinic.` });
    }
    // The NEW time respects the same notice/horizon gates as a fresh booking.
    if (body.startsAt.getTime() < now + policy.minNoticeHours * 3600_000) {
      return reply.code(400).send({ error: 'too_soon', message: `Bookings require at least ${policy.minNoticeHours} hours notice.` });
    }
    if (body.startsAt > new Date(now + policy.maxHorizonDays * 86400000)) {
      return reply.code(400).send({ error: 'too_far_out', message: `Bookings are limited to the next ${policy.maxHorizonDays} days.` });
    }

    const service = await resolveSchedulingService({ tenantId, serviceCatalogItemId: appt.serviceCatalogItemId, service: appt.service, fallbackDurationMin: body.durationMin ?? Math.max(5, Math.round((appt.endsAt.getTime() - appt.startsAt.getTime()) / 60_000)) });
    if (!service) return reply.code(409).send({ error: 'invalid_service', message: 'This service must be reviewed by staff before rescheduling.' });
    const durationMin = service.durationMin;
    const endsAt = new Date(body.startsAt.getTime() + durationMin * 60_000);

    // Conflict-safe move: in-transaction check excludes self; the DB exclusion
    // constraint is the final guard against a concurrent booking racing in.
    let result: { conflict: Awaited<ReturnType<typeof findSlotConflict>> } | { appointment: Awaited<ReturnType<typeof db.appointment.update>> };
    try {
      result = await db.$transaction(async tx => {
        if (appt.providerProfileId) {
          const conflict = await findSlotConflict({ tenantId, providerProfileId: appt.providerProfileId, startsAt: body.startsAt, durationMin, excludeAppointmentId: appt.id }, tx);
          if (conflict) return { conflict } as const;
        }
        const changed = await tx.appointment.updateMany({
          where: { id, tenantId, patientId, status: appt.status, deletedAt: null },
          data: { startsAt: body.startsAt, endsAt, service: service.name, serviceCatalogItemId: service.id },
        });
        if (changed.count !== 1) return { conflict: 'already_booked' as const };
        const appointment = await tx.appointment.findUniqueOrThrow({ where: { id } });
        await portalAudit(tenantId, 'portal.appointment.rescheduled', id, request, { startsAt: body.startsAt.toISOString() }, { critical: true, tx });
        return { appointment } as const;
      });
    } catch (error) {
      if (isDoubleBookConflictError(error)) return reply.code(409).send({ error: 'slot_unavailable', reason: 'already_booked', message: 'That time is no longer available. Please pick another.' });
      throw error;
    }
    if ('conflict' in result) {
      const message = result.conflict === 'outside_availability' ? 'That time is outside the provider\'s available hours. Please pick another.'
        : result.conflict === 'in_past' ? 'That time is in the past. Please pick a future time.'
        : 'That time is no longer available. Please pick another.';
      return reply.code(409).send({ error: 'slot_unavailable', reason: result.conflict, message });
    }

    // Idempotently re-evaluate the deposit (never duplicated) — best-effort.
    try { await evaluateDepositForAppointment(tenantId, id, { actorUserId: null }); }
    catch (err) { request.log.error({ err }, 'portal reschedule deposit re-eval failed'); }
    return safeAppt(result.appointment);
  });

  // ===== Intake (reuse the Patient Intake engine) ========================
  app.get('/intake', async request => {
    const { tenantId, patientId } = request.portal!;
    const packets = await db.patientIntakePacket.findMany({ where: { tenantId, patientId }, orderBy: { createdAt: 'desc' }, include: { sections: { select: { sectionType: true, status: true } } } });
    return packets.map(p => ({ id: p.id, status: p.status, label: intakeLabel(p.status), readinessScore: readinessScore(p.sections), createdAt: p.createdAt.toISOString() }));
  });
  app.get('/intake/:packetId', async (request, reply) => {
    const { packetId } = z.object({ packetId: z.string().uuid() }).parse(request.params);
    const { tenantId, patientId } = request.portal!;
    const packet = await db.patientIntakePacket.findFirst({ where: { id: packetId, tenantId, patientId }, include: { sections: { orderBy: { sectionType: 'asc' } } } });
    if (!packet) return reply.code(404).send({ error: 'not_found' });
    return publicView(tenantId, packet, packet.sections);
  });
  app.post('/intake/:packetId/sections', async (request, reply) => {
    const { packetId } = z.object({ packetId: z.string().uuid() }).parse(request.params);
    const { tenantId, patientId } = request.portal!;
    const body = z.object({ sectionType: z.string().min(2).max(60), data: z.record(z.string(), z.unknown()) }).parse(request.body);
    const packet = await db.patientIntakePacket.findFirst({ where: { id: packetId, tenantId, patientId }, select: { id: true } });
    if (!packet) return reply.code(404).send({ error: 'not_found' });
    let outcome;
    try {
      outcome = await db.$transaction(async tx => {
        const mutation = await submitSectionMutation(tx, tenantId, packetId, body.sectionType, body.data as Record<string, unknown>, { source: 'patient_portal' });
        await portalAudit(tenantId, 'portal.intake.updated', packetId, request, { sectionType: body.sectionType }, { critical: true, tx });
        return mutation;
      });
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (code === 'explicit_acceptance_required') throw app.httpErrors.badRequest('Explicit acceptance is required for this acknowledgement');
      if (code === 'acknowledgement_not_approved') throw app.httpErrors.badRequest('The acknowledgement identifier is missing, outdated, or not approved');
      if (code === 'payment_policy_unavailable') throw app.httpErrors.conflict('Payment-policy acknowledgment is unavailable until the clinic publishes versioned policy text');
      throw error;
    }
    await emitSectionSubmissionEffects(outcome);
    return outcome.sectionId;
  });
  app.post('/intake/:packetId/submit', async (request, reply) => {
    const { packetId } = z.object({ packetId: z.string().uuid() }).parse(request.params);
    const { tenantId, patientId } = request.portal!;
    const packet = await db.patientIntakePacket.findFirst({ where: { id: packetId, tenantId, patientId }, select: { id: true } });
    if (!packet) return reply.code(404).send({ error: 'not_found' });
    const outcome = await db.$transaction(async tx => {
      const mutation = await submitPacketMutation(tx, tenantId, packetId);
      await portalAudit(tenantId, 'portal.intake.submitted', packetId, request, undefined, { critical: true, tx });
      return mutation;
    });
    await emitPacketSubmissionEffects(tenantId, outcome);
    return outcome;
  });

  // ===== Insurance (patient-safe) =========================================
  app.get('/insurance', async request => {
    const { tenantId, patientId } = request.portal!;
    const policies = await db.patientInsurancePolicy.findMany({ where: { tenantId, patientId, active: true }, orderBy: { createdAt: 'desc' }, select: { id: true, planName: true, memberId: true, groupNumber: true, subscriberName: true, verificationStatus: true, verifiedAt: true } });
    return policies.map(p => ({ id: p.id, planName: p.planName, memberId: maskMember(p.memberId), groupNumber: p.groupNumber, subscriberName: p.subscriberName, status: safeInsuranceStatus(p) }));
  });
  app.post('/insurance', async (request, reply) => {
    const { tenantId, patientId } = request.portal!;
    const body = insuranceSchema.parse(request.body);
    const patient = await db.patient.findUnique({ where: { id: patientId }, select: { branchId: true } });
    // Idempotent: same memberId updates the existing policy (no duplicate).
    const existing = await db.patientInsurancePolicy.findFirst({ where: { tenantId, patientId, memberId: body.memberId } });
    if (existing) {
      await db.$transaction(async tx => {
        await tx.patientInsurancePolicy.update({ where: { id: existing.id }, data: { planName: body.planName, groupNumber: body.groupNumber, subscriberName: body.subscriberName, verificationStatus: 'pending', verifiedAt: null, active: true } });
        await portalAudit(tenantId, 'portal.insurance.updated', existing.id, request, { deduped: true }, { critical: true, tx });
      });
      return { id: existing.id, status: 'pending_review', deduped: true };
    }
    const branchId = patient?.branchId ?? (await firstBranch(tenantId));
    let row: { id: string };
    try {
      row = await db.$transaction(async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tenantId}), hashtext(${patientId}))`;
        const activePolicies = await tx.patientInsurancePolicy.findMany({
          where: { tenantId, patientId, active: true },
          select: { coverageOrder: true, effectiveFrom: true, effectiveTo: true },
          orderBy: { coverageOrder: 'asc' },
        });
        const effectiveFrom = new Date();
        const occupiedOrders = new Set(
          activePolicies
            .filter(policy => policyRangesOverlap(effectiveFrom, null, policy.effectiveFrom, policy.effectiveTo))
            .map(policy => policy.coverageOrder),
        );
        let coverageOrder = 1;
        while (occupiedOrders.has(coverageOrder)) {
          coverageOrder += 1;
          if (coverageOrder > 9) throw new Error('INSURANCE_POLICY_MAX_DEPTH');
        }

        const created = await tx.patientInsurancePolicy.create({
          data: {
            tenantId,
            branchId,
            patientId,
            planName: body.planName,
            memberId: body.memberId,
            groupNumber: body.groupNumber,
            subscriberName: body.subscriberName,
            verificationStatus: 'pending',
            active: true,
            coverageOrder,
            effectiveFrom,
            payerReference: body.memberId,
          },
        });
        await portalAudit(tenantId, 'portal.insurance.updated', created.id, request, undefined, { critical: true, tx });
        return created;
      }, { isolationLevel: 'Serializable' });
    } catch (error) {
      if ((error instanceof Error && error.message === 'INSURANCE_POLICY_MAX_DEPTH') || isPolicyRangeConflict(error)) {
        return reply.code(409).send({
          error: 'insurance_policy_conflict',
          message: 'Coverage at this order overlaps an existing active policy. Please review your existing policy first, then retry.',
        });
      }
      throw error;
    }
    return reply.code(201).send({ id: row.id, status: 'pending_review', deduped: false });
  });
  app.patch('/insurance/:policyId', async (request, reply) => {
    const { policyId } = z.object({ policyId: z.string().uuid() }).parse(request.params);
    const { tenantId, patientId } = request.portal!;
    const body = insuranceSchema.partial().refine(v => Object.keys(v).length > 0, { message: 'Provide at least one policy field.' }).parse(request.body);
    const existing = await db.patientInsurancePolicy.findFirst({ where: { id: policyId, tenantId, patientId } });
    if (!existing) return reply.code(404).send({ error: 'not_found' });
    await db.$transaction(async tx => {
      await tx.patientInsurancePolicy.update({ where: { id: policyId }, data: { planName: body.planName, memberId: body.memberId, payerReference: body.memberId, groupNumber: body.groupNumber, subscriberName: body.subscriberName, verificationStatus: 'pending', verifiedAt: null } });
      await portalAudit(tenantId, 'portal.insurance.updated', policyId, request, undefined, { critical: true, tx });
    });
    return { id: policyId, status: 'pending_review' };
  });

  // ===== Payments & estimates (never settle from portal) =================
  app.get('/payments', async request => {
    const { tenantId, patientId } = request.portal!;
    const rows = await db.paymentRequest.findMany({ where: { tenantId, patientId }, orderBy: { createdAt: 'desc' }, take: 30, select: { id: true, amount: true, currency: true, status: true, reason: true, paymentUrl: true, publicToken: true, linkExpiresAt: true, dueAt: true } });
    const now = new Date();
    return rows.map(p => {
      const live = !p.linkExpiresAt || p.linkExpiresAt > now;
      const settled = p.status === 'collected' || p.status === 'paid';
      // The REAL, provider-hosted checkout page (absolute Stripe/mock URL the
      // provider returned). We never fabricate a link: when none exists (mock/
      // unconfigured or expired), payLink is null and the UI shows an honest
      // "not available — contact clinic" state instead of a dead 404.
      const payLink = !settled && live ? safePaymentUrl(p.paymentUrl) : null;
      return {
        id: p.id, amount: n(p.amount), currency: p.currency, status: p.status, reason: p.reason,
        payLink,
        // True when a balance is owed but no usable link exists yet (honest CTA).
        payLinkUnavailable: !settled && !payLink,
        dueAt: p.dueAt?.toISOString() ?? null,
      };
    });
  });
  app.get('/estimates', async request => {
    const { tenantId, patientId } = request.portal!;
    const rows = await db.patientResponsibilityEstimate.findMany({ where: { tenantId, patientId }, orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, estimatedPatientResponsibility: true, recommendedCollectAmount: true, acknowledgedAt: true, createdAt: true } });
    return rows.map(e => ({ id: e.id, estimatedPatientResponsibility: n(e.estimatedPatientResponsibility), recommendedCollectAmount: n(e.recommendedCollectAmount), acknowledged: !!e.acknowledgedAt, createdAt: e.createdAt.toISOString(), disclaimer: 'This is an estimate, not a guarantee of final cost.' }));
  });
  app.post('/estimates/:id/acknowledge', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { tenantId, patientId } = request.portal!;
    const e = await db.patientResponsibilityEstimate.findFirst({ where: { id, tenantId, patientId } });
    if (!e) return reply.code(404).send({ error: 'not_found' });
    if (e.acknowledgedAt) return { id, acknowledged: true, deduped: true }; // idempotent
    await db.$transaction(async tx => {
      await tx.patientResponsibilityEstimate.update({ where: { id }, data: { acknowledgedAt: new Date() } });
      await portalAudit(tenantId, 'portal.estimate.acknowledged', id, request, undefined, { critical: true, tx });
    });
    return { id, acknowledged: true, deduped: false };
  });
  app.post('/payment-policy/acknowledge', async (_request, reply) => {
    return reply.code(409).send({
      error: 'payment_policy_unavailable',
      message: 'Payment-policy acknowledgment is unavailable until the clinic publishes versioned policy text.',
    });
  });

  // ===== Profile & communication preferences =============================
  app.get('/profile', async request => {
    const { patientId } = request.portal!;
    const p = await db.patient.findUnique({ where: { id: patientId }, select: { firstName: true, lastName: true, email: true, phone: true } });
    return { firstName: p?.firstName ?? '', lastName: p?.lastName ?? '', email: p?.email ?? '', phone: p?.phone ?? '' };
  });
  app.patch('/profile', async request => {
    const { tenantId, patientId } = request.portal!;
    const body = z.object({ email: z.string().email().trim().optional(), phone: z.string().trim().max(40).optional() }).refine(value => value.email !== undefined || value.phone !== undefined, { message: 'Provide an email or phone update.' }).parse(request.body);
    await db.$transaction(async tx => {
      await tx.patient.update({ where: { id: patientId }, data: { email: body.email, phone: body.phone } });
      await tx.patientPortalAccount.updateMany({ where: { tenantId, patientId }, data: { email: body.email, phone: body.phone } });
      await portalAudit(tenantId, 'portal.profile.updated', patientId, request, undefined, { critical: true, tx });
    });
    return { ok: true };
  });

  app.get('/preferences', async request => {
    const { tenantId, patientId } = request.portal!;
    const [events, voiceConsents, patient, voiceOptOuts] = await Promise.all([
      db.consentEvent.findMany({ where: { tenantId, patientId }, orderBy: { occurredAt: 'desc' } }),
      db.communicationConsent.findMany({ where: { tenantId, patientId, channel: 'voice' }, orderBy: { capturedAt: 'desc' }, select: { status: true } }),
      db.patient.findFirst({ where: { tenantId, id: patientId }, select: { phone: true } }),
      db.receptionistOptOut.findMany({ where: { tenantId, revokedAt: null, channel: { in: ['ALL', 'VOICE'] }, contactPhone: { not: null } }, select: { contactPhone: true } }),
    ]);
    const latestEvent = (purpose: string) => events.find(e => e.purpose === purpose);
    const status = (purpose: string) => {
      const event = latestEvent(purpose);
      return event ? event.granted ? 'opted_in' : 'opted_out' : 'not_recorded';
    };
    const phone = canonicalDncDestination(patient?.phone ?? '');
    const globallyOptedOut = Boolean(phone) && voiceOptOuts.some(row => canonicalDncDestination(row.contactPhone ?? '') === phone);
    const voice = !globallyOptedOut && voiceConsents[0]?.status === 'opted_in';
    return {
      sms: status('SMS') === 'opted_in', email: status('EMAIL') === 'opted_in', whatsapp: status('WHATSAPP') === 'opted_in',
      smsAuthorizationStatus: status('SMS'), emailAuthorizationStatus: status('EMAIL'),
      whatsappAuthorizationStatus: status('WHATSAPP'), marketingAuthorizationStatus: status('MARKETING'),
      voice, voiceOptedOut: globallyOptedOut,
      voiceAuthorizationStatus: globallyOptedOut ? 'opted_out' : voiceConsents[0]?.status ?? 'not_recorded',
      marketing: status('MARKETING') === 'opted_in',
    };
  });
  app.patch('/preferences', async request => {
    const { tenantId, patientId } = request.portal!;
    const body = z.object({ sms: z.boolean().optional(), email: z.boolean().optional(), whatsapp: z.boolean().optional(), voice: z.boolean().optional(), marketing: z.boolean().optional() })
      .refine(value => Object.values(value).some(v => v !== undefined), { message: 'Provide at least one preference.' }).parse(request.body);
    if (body.voice === true) {
      throw app.httpErrors.conflict('Voice opt-in requires a purpose-specific disclosure and consent workflow; the generic preference toggle cannot grant outbound authority.');
    }
    if (body.sms === true || body.email === true || body.whatsapp === true || body.marketing === true) {
      throw app.httpErrors.conflict('Permission to send messages requires the approved notice for a specific purpose. This preferences page can record opt-outs only.');
    }
    const updates: Array<[string, boolean]> = [];
    if (body.sms !== undefined) updates.push(['SMS', body.sms]);
    if (body.email !== undefined) updates.push(['EMAIL', body.email]);
    if (body.whatsapp !== undefined) updates.push(['WHATSAPP', body.whatsapp]);
    if (body.voice !== undefined) updates.push(['VOICE', body.voice]);
    if (body.marketing !== undefined) updates.push(['MARKETING', body.marketing]);
    await db.$transaction(async tx => {
      // Suppression fences FIRST, in the SAME transaction as every write below —
      // exactly what campaigns POST /consent and POST /suppressions do, and the
      // mirror of what claimCampaignProviderIntent() /
      // claimCampaignProviderSubmission() take before they re-read suppression.
      //
      // Two different keys are needed because this handler writes two
      // differently-keyed opt-out records:
      //   * ConsentEvent (SMS/EMAIL/WHATSAPP/MARKETING) is IDENTITY-keyed —
      //     isSuppressedTx reads it by (tenantId, patientId, purpose), so the
      //     patient identity fence is the one a dispatcher for this patient
      //     also holds.
      //   * ReceptionistOptOut (voice) is DESTINATION-keyed — isSuppressedTx
      //     reaches it through isDestinationOptedOutTx(tenantId, destination),
      //     and it suppresses that phone number for EVERY identity, including a
      //     Lead this portal session knows nothing about. A dispatcher aimed at
      //     such a lead holds only the destination fence, so the patient fence
      //     alone would not serialize with it.
      // The destination is resolved before the fence is taken so the lock is
      // held across the read-modify-write, not just the write.
      const voiceDestination = body.voice === undefined ? null : await portalVoiceOptOutDestination(tx, tenantId, patientId);
      await lockSuppressionFences(tx, {
        tenantId,
        patientId,
        destinations: voiceDestination ? [voiceDestination] : [],
      });
      for (const [purpose, granted] of updates) {
        // Append-only consent history. SMS/EMAIL/WHATSAPP/MARKETING continue to
        // use ConsentEvent; voice uses CommunicationConsent so the portal can read
        // and persist it without expanding the legacy enum. No history is erased.
        if (purpose === 'VOICE') {
          await recordPortalVoiceOptOut(tx, tenantId, voiceDestination!);
          continue;
        }
        await tx.consentEvent.create({ data: { tenantId, patientId, purpose: purpose as 'SMS' | 'EMAIL' | 'WHATSAPP' | 'MARKETING', granted, source: 'patient_portal' } });
      }
      if (body.voice !== undefined) {
        await tx.businessEvent.create({ data: {
          tenantId,
          eventType: 'receptionist.voice_global_opt_out.recorded',
          entityType: 'patient', entityId: patientId, sourceModule: 'patient_portal',
          payload: { channel: 'voice', granted: false },
        } });
      }
      await portalAudit(tenantId, 'portal.preference.updated', patientId, request, { changed: updates.map(u => u[0]) }, { critical: true, tx });
    });
    return { ok: true };
  });

  app.get('/consents', async request => {
    const { tenantId, patientId } = request.portal!;
    const [events, voiceEvents] = await Promise.all([
      db.consentEvent.findMany({ where: { tenantId, patientId }, orderBy: { occurredAt: 'desc' }, take: 50, select: { purpose: true, granted: true, occurredAt: true } }),
      db.businessEvent.findMany({
        where: { tenantId, entityType: 'patient', entityId: patientId, eventType: 'receptionist.voice_global_opt_out.recorded' },
        orderBy: { occurredAt: 'desc' }, take: 50, select: { occurredAt: true },
      }),
    ]);
    return [
      ...events.map(event => ({ purpose: event.purpose, granted: event.granted, at: event.occurredAt.toISOString() })),
      ...voiceEvents.map(event => ({ purpose: 'VOICE', granted: false, at: event.occurredAt.toISOString() })),
    ].sort((left, right) => right.at.localeCompare(left.at)).slice(0, 50);
  });
};

// ---- helpers ---------------------------------------------------------------
function safeAppt(a: { id: string; service: string; startsAt: Date; endsAt: Date; status: string; providerRef: string | null }) {
  return { id: a.id, service: a.service, startsAt: a.startsAt.toISOString(), endsAt: a.endsAt.toISOString(), status: a.status, provider: a.providerRef };
}
function isPolicyRangeConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const anyErr = error as { code?: string; meta?: { code?: string; constraint?: unknown }; message?: string };
  const dbCode = anyErr.code ?? anyErr.meta?.code;
  if (dbCode === 'P2004' || dbCode === 'P2034' || dbCode === '23P01') return true;
  if (typeof anyErr.message === 'string' && anyErr.message.includes('PatientInsurancePolicy_active_order_range_excl')) return true;
  return false;
}
function policyRangesOverlap(aStart: Date, aEnd: Date | null, bStart: Date, bEnd: Date | null): boolean {
  const left = aStart.getTime();
  const right = aEnd ? aEnd.getTime() : Number.POSITIVE_INFINITY;
  const otherLeft = bStart.getTime();
  const otherRight = bEnd ? bEnd.getTime() : Number.POSITIVE_INFINITY;
  return left < otherRight && otherLeft < right;
}
function safePaymentUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}
function maskMember(m: string): string { return m.length <= 4 ? '••••' : `••••${m.slice(-4)}`; }
const insuranceSchema = z.object({ planName: z.string().trim().min(1).max(120), memberId: z.string().trim().min(2).max(80), groupNumber: z.string().trim().max(80).optional(), subscriberName: z.string().trim().max(120).optional() });
/**
 * The canonical destination a portal voice opt-out will be written against.
 * Split out of recordPortalVoiceOptOut so the caller can take the destination
 * suppression fence BEFORE the read-modify-write below, in the same
 * transaction. Throws the same error, at the same point in the same
 * transaction, as before — so a patient with no phone still fails the whole
 * preference update and writes nothing.
 */
async function portalVoiceOptOutDestination(tx: Prisma.TransactionClient, tenantId: string, patientId: string): Promise<string> {
  const patient = await tx.patient.findFirst({ where: { tenantId, id: patientId, deletedAt: null }, select: { phone: true } });
  const phone = canonicalDncDestination(patient?.phone ?? '');
  if (!phone) throw new Error('portal_voice_opt_out_destination_unavailable');
  return phone;
}
async function recordPortalVoiceOptOut(tx: Prisma.TransactionClient, tenantId: string, phone: string) {
  const active = await tx.receptionistOptOut.findMany({
    where: { tenantId, revokedAt: null, channel: { in: ['ALL', 'VOICE'] }, contactPhone: { not: null } },
    select: { contactPhone: true },
  });
  if (active.some(row => canonicalDncDestination(row.contactPhone ?? '') === phone)) return;
  await tx.receptionistOptOut.create({ data: {
    tenantId, contactPhone: phone, channel: 'VOICE', reason: 'Patient portal global voice opt-out',
  } });
}
async function firstBranch(tenantId: string): Promise<string> {
  const b = await db.branch.findFirst({ where: { tenantId }, select: { id: true } });
  return b!.id;
}
