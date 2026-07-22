import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../../lib/db';
import { requirePortalAccess, requirePortalFeature, portalAudit } from '../../lib/portalAuth';
import { publicView, submitSection, submitPacket, readinessScore } from '../../lib/intake';
import { computeProviderSlots, findSlotConflict, getSchedulingPolicy, isDoubleBookConflictError, unmetPreVisitRequirements } from '../../lib/scheduling';

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
  return 'on_file';
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

  // ===== Dashboard (patient-safe summary) =================================
  app.get('/dashboard', async request => {
    const { tenantId, patientId } = request.portal!;
    const now = new Date();
    const [patient, tenant, upcoming, requests, packet, payments, policy, estimate, account] = await Promise.all([
      db.patient.findUnique({ where: { id: patientId }, select: { firstName: true, lastName: true, branchId: true } }),
      db.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
      db.appointment.findMany({ where: { tenantId, patientId, startsAt: { gte: now }, status: { notIn: ['CANCELED', 'NO_SHOW'] } }, orderBy: { startsAt: 'asc' }, take: 3, select: { id: true, service: true, startsAt: true, status: true } }),
      db.appointmentRequest.count({ where: { tenantId, patientId, status: 'PENDING_REVIEW' } }),
      db.patientIntakePacket.findFirst({ where: { tenantId, patientId }, orderBy: { createdAt: 'desc' }, select: { id: true, status: true, readinessScore: true } }),
      db.paymentRequest.findMany({ where: { tenantId, patientId, status: { in: ['pending', 'requires_action', 'unpaid', 'requested'] } }, select: { amount: true, currency: true } }),
      db.patientInsurancePolicy.findFirst({ where: { tenantId, patientId, active: true }, orderBy: { createdAt: 'desc' }, select: { verificationStatus: true, verifiedAt: true } }),
      db.patientResponsibilityEstimate.findFirst({ where: { tenantId, patientId }, orderBy: { createdAt: 'desc' }, select: { id: true, acknowledgedAt: true } }),
      db.patientPortalAccount.findFirst({ where: { tenantId, patientId }, select: { paymentPolicyAckAt: true } }),
    ]);

    const branchName = patient?.branchId ? (await db.branch.findUnique({ where: { id: patient.branchId }, select: { name: true } }))?.name ?? null : null;
    const unpaidTotal = payments.reduce((s, p) => s + n(p.amount), 0);
    const cards = {
      nextAppointment: upcoming[0] ? { service: upcoming[0].service, startsAt: upcoming[0].startsAt.toISOString(), state: 'scheduled' } : { state: 'unavailable' },
      intake: packet ? { state: intakeLabel(packet.status) } : { state: 'unavailable' },
      insurance: { state: safeInsuranceStatus(policy) === 'needs_update' ? 'needs_update' : 'completed', detail: safeInsuranceStatus(policy) },
      payment: unpaidTotal > 0 ? { state: 'payment_required', amount: unpaidTotal, currency: payments[0]?.currency ?? 'USD' } : { state: 'completed' },
      estimate: estimate ? { state: estimate.acknowledgedAt ? 'completed' : 'action_required' } : { state: 'unavailable' },
      appointmentRequests: requests > 0 ? { state: 'pending_review', count: requests } : { state: 'completed' },
    };
    return {
      displayName: `${patient?.firstName ?? ''} ${patient?.lastName ?? ''}`.trim() || 'Patient',
      clinicName: tenant?.name ?? 'Your clinic',
      branchName,
      cards,
      paymentPolicyAcknowledged: !!account?.paymentPolicyAckAt,
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
    const row = await db.appointmentRequest.create({ data: { tenantId, branchId: patient?.branchId ?? null, patientId, requestedService: body.service, requestedDateTime: body.requestedDateTime, collectedName: `${patient?.firstName ?? ''} ${patient?.lastName ?? ''}`.trim(), collectedEmail: patient?.email ?? null, collectedPhone: patient?.phone ?? null, source: 'patient_portal', status: 'PENDING_REVIEW', rawCollectedFields: body.notes ? { notes: body.notes } : undefined } });
    await portalAudit(tenantId, 'portal.appointmentRequest.created', row.id, request, { service: body.service }, { critical: true });
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
      where: { tenantId, branchId: patient.branchId },
      select: { id: true, specialty: true, rating: true, reviewCount: true, user: { select: { displayName: true } } },
      orderBy: { rating: 'desc' },
    });
    // Patient-safe fields only — no utilization/revenue/internal metrics.
    return providers.map(p => ({ id: p.id, name: p.user.displayName, specialty: p.specialty, rating: n(p.rating), reviewCount: p.reviewCount }));
  });

  async function loadBookableProvider(tenantId: string, patientId: string, providerId: string) {
    const patient = await db.patient.findUnique({ where: { id: patientId }, select: { branchId: true } });
    if (!patient) return null;
    return db.providerProfile.findFirst({ where: { id: providerId, tenantId, branchId: patient.branchId }, select: { id: true, branchId: true } });
  }

  app.get('/booking/providers/:providerId/slots', async (request, reply) => {
    const { tenantId, patientId } = request.portal!;
    const { providerId } = z.object({ providerId: z.string().uuid() }).parse(request.params);
    const { date, durationMin } = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), durationMin: z.coerce.number().int().min(5).max(240).optional() }).parse(request.query);
    const provider = await loadBookableProvider(tenantId, patientId, providerId);
    if (!provider) return reply.code(404).send({ error: 'not_found' });
    const slots = await computeProviderSlots({ tenantId, providerProfileId: providerId, dateISO: date, durationMin });
    return { providerId, date, slots: slots.map(s => ({ startsAt: s.startsAt.toISOString(), endsAt: s.endsAt.toISOString() })) };
  });

  app.post('/booking/providers/:providerId/book', async (request, reply) => {
    const { tenantId, patientId } = request.portal!;
    const { providerId } = z.object({ providerId: z.string().uuid() }).parse(request.params);
    const body = z.object({
      startsAt: z.coerce.date(),
      durationMin: z.number().int().min(5).max(240).default(30),
      reason: z.string().trim().min(2).max(160),
      channel: z.enum(['WHATSAPP', 'SMS', 'EMAIL', 'PUSH', 'CALL', 'VIDEO']).default('EMAIL'),
    }).parse(request.body);
    const provider = await loadBookableProvider(tenantId, patientId, providerId);
    if (!provider) return reply.code(404).send({ error: 'not_found' });

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

    const endsAt = new Date(body.startsAt.getTime() + body.durationMin * 60_000);

    // DB exclusion constraint is the final guard if a concurrent booking races
    // past the in-transaction conflict check.
    let result: { conflict: Awaited<ReturnType<typeof findSlotConflict>> } | { appointment: Awaited<ReturnType<typeof db.appointment.create>> };
    try {
      result = await db.$transaction(async tx => {
        const conflict = await findSlotConflict({ tenantId, providerProfileId: providerId, startsAt: body.startsAt, durationMin: body.durationMin }, tx);
        if (conflict) return { conflict } as const;
        const appointment = await tx.appointment.create({
          data: { tenantId, branchId: provider.branchId, patientId, providerProfileId: providerId, providerRef: providerId, service: body.reason, startsAt: body.startsAt, endsAt, status: 'CONFIRMED', channel: body.channel },
        });
        return { appointment } as const;
      });
    } catch (error) {
      if (isDoubleBookConflictError(error)) return reply.code(409).send({ error: 'slot_unavailable', reason: 'already_booked' });
      throw error;
    }
    if ('conflict' in result) return reply.code(409).send({ error: 'slot_unavailable', reason: result.conflict });

    await portalAudit(tenantId, 'portal.appointment.booked', result.appointment.id, request, { providerId }, { critical: true });
    return reply.code(201).send(safeAppt(result.appointment));
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
    const result = await submitSection(tenantId, packetId, body.sectionType, body.data as Record<string, unknown>, { source: 'patient_portal' });
    await portalAudit(tenantId, 'portal.intake.updated', packetId, request, { sectionType: body.sectionType }, { critical: true });
    return result;
  });
  app.post('/intake/:packetId/submit', async (request, reply) => {
    const { packetId } = z.object({ packetId: z.string().uuid() }).parse(request.params);
    const { tenantId, patientId } = request.portal!;
    const packet = await db.patientIntakePacket.findFirst({ where: { id: packetId, tenantId, patientId }, select: { id: true } });
    if (!packet) return reply.code(404).send({ error: 'not_found' });
    const result = await submitPacket(tenantId, packetId);
    await portalAudit(tenantId, 'portal.intake.submitted', packetId, request, undefined, { critical: true });
    return result;
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
      await db.patientInsurancePolicy.update({ where: { id: existing.id }, data: { planName: body.planName, groupNumber: body.groupNumber, subscriberName: body.subscriberName, verificationStatus: 'pending', active: true } });
      await portalAudit(tenantId, 'portal.insurance.updated', existing.id, request, { deduped: true }, { critical: true });
      return { id: existing.id, status: 'pending_review', deduped: true };
    }
    const row = await db.patientInsurancePolicy.create({ data: { tenantId, branchId: patient?.branchId ?? (await firstBranch(tenantId)), patientId, planName: body.planName, memberId: body.memberId, groupNumber: body.groupNumber, subscriberName: body.subscriberName, verificationStatus: 'pending', active: true } });
    await portalAudit(tenantId, 'portal.insurance.updated', row.id, request, undefined, { critical: true });
    return reply.code(201).send({ id: row.id, status: 'pending_review', deduped: false });
  });
  app.patch('/insurance/:policyId', async (request, reply) => {
    const { policyId } = z.object({ policyId: z.string().uuid() }).parse(request.params);
    const { tenantId, patientId } = request.portal!;
    const body = insuranceSchema.partial().parse(request.body);
    const existing = await db.patientInsurancePolicy.findFirst({ where: { id: policyId, tenantId, patientId } });
    if (!existing) return reply.code(404).send({ error: 'not_found' });
    await db.patientInsurancePolicy.update({ where: { id: policyId }, data: { planName: body.planName, groupNumber: body.groupNumber, subscriberName: body.subscriberName, verificationStatus: 'pending' } });
    await portalAudit(tenantId, 'portal.insurance.updated', policyId, request, undefined, { critical: true });
    return { id: policyId, status: 'pending_review' };
  });

  // ===== Payments & estimates (never settle from portal) =================
  app.get('/payments', async request => {
    const { tenantId, patientId } = request.portal!;
    const rows = await db.paymentRequest.findMany({ where: { tenantId, patientId }, orderBy: { createdAt: 'desc' }, take: 30, select: { id: true, amount: true, currency: true, status: true, reason: true, publicToken: true, linkExpiresAt: true, dueAt: true } });
    return rows.map(p => ({
      id: p.id, amount: n(p.amount), currency: p.currency, status: p.status, reason: p.reason,
      // Existing tokenized public link only (never a new/faked link).
      payLink: p.publicToken && (!p.linkExpiresAt || p.linkExpiresAt > new Date()) ? `/public/checkout/${p.publicToken}` : null,
      dueAt: p.dueAt?.toISOString() ?? null,
    }));
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
    await db.patientResponsibilityEstimate.update({ where: { id }, data: { acknowledgedAt: new Date() } });
    await portalAudit(tenantId, 'portal.estimate.acknowledged', id, request, undefined, { critical: true });
    return { id, acknowledged: true, deduped: false };
  });
  app.post('/payment-policy/acknowledge', async request => {
    const { tenantId, patientId, accountId } = request.portal!;
    const acct = await db.patientPortalAccount.findUnique({ where: { id: accountId }, select: { paymentPolicyAckAt: true } });
    if (acct?.paymentPolicyAckAt) return { acknowledged: true, deduped: true }; // idempotent
    await db.patientPortalAccount.update({ where: { id: accountId }, data: { paymentPolicyAckAt: new Date() } });
    await portalAudit(tenantId, 'portal.paymentPolicy.acknowledged', patientId, request, undefined, { critical: true });
    return { acknowledged: true, deduped: false };
  });

  // ===== Profile & communication preferences =============================
  app.get('/profile', async request => {
    const { patientId } = request.portal!;
    const p = await db.patient.findUnique({ where: { id: patientId }, select: { firstName: true, lastName: true, email: true, phone: true } });
    return { firstName: p?.firstName ?? '', lastName: p?.lastName ?? '', email: p?.email ?? '', phone: p?.phone ?? '' };
  });
  app.patch('/profile', async request => {
    const { tenantId, patientId } = request.portal!;
    const body = z.object({ email: z.string().email().trim().optional(), phone: z.string().trim().max(40).optional() }).parse(request.body);
    await db.patient.update({ where: { id: patientId }, data: { email: body.email, phone: body.phone } });
    await db.patientPortalAccount.updateMany({ where: { tenantId, patientId }, data: { email: body.email, phone: body.phone } });
    await portalAudit(tenantId, 'portal.profile.updated', patientId, request, undefined, { critical: true });
    return { ok: true };
  });

  app.get('/preferences', async request => {
    const { tenantId, patientId } = request.portal!;
    const [events, voiceConsents] = await Promise.all([
      db.consentEvent.findMany({ where: { tenantId, patientId }, orderBy: { occurredAt: 'desc' } }),
      db.communicationConsent.findMany({ where: { tenantId, patientId, channel: 'voice' }, orderBy: { capturedAt: 'desc' }, select: { status: true } }),
    ]);
    const latest = (purpose: string) => events.find(e => e.purpose === purpose)?.granted ?? false;
    const voice = voiceConsents[0]?.status === 'opted_in';
    return { sms: latest('SMS'), email: latest('EMAIL'), whatsapp: latest('WHATSAPP'), voice, marketing: latest('MARKETING') };
  });
  app.patch('/preferences', async request => {
    const { tenantId, patientId } = request.portal!;
    const body = z.object({ sms: z.boolean().optional(), email: z.boolean().optional(), whatsapp: z.boolean().optional(), voice: z.boolean().optional(), marketing: z.boolean().optional() }).parse(request.body);
    const updates: Array<[string, boolean]> = [];
    if (body.sms !== undefined) updates.push(['SMS', body.sms]);
    if (body.email !== undefined) updates.push(['EMAIL', body.email]);
    if (body.whatsapp !== undefined) updates.push(['WHATSAPP', body.whatsapp]);
    if (body.voice !== undefined) updates.push(['VOICE', body.voice]);
    if (body.marketing !== undefined) updates.push(['MARKETING', body.marketing]);
    for (const [purpose, granted] of updates) {
      // Append-only consent history. SMS/EMAIL/WHATSAPP/MARKETING continue to
      // use ConsentEvent; voice uses CommunicationConsent so the portal can read
      // and persist it without expanding the legacy enum. No history is erased.
      if (purpose === 'VOICE') {
        await upsertVoiceConsent(tenantId, patientId, granted);
        continue;
      }
      await db.consentEvent.create({ data: { tenantId, patientId, purpose: purpose as 'SMS' | 'EMAIL' | 'WHATSAPP' | 'MARKETING', granted, source: 'patient_portal' } });
    }
    await portalAudit(tenantId, 'portal.preference.updated', patientId, request, { changed: updates.map(u => u[0]) });
    return { ok: true };
  });

  app.get('/consents', async request => {
    const { tenantId, patientId } = request.portal!;
    const events = await db.consentEvent.findMany({ where: { tenantId, patientId }, orderBy: { occurredAt: 'desc' }, take: 50, select: { purpose: true, granted: true, occurredAt: true } });
    return events.map(e => ({ purpose: e.purpose, granted: e.granted, at: e.occurredAt.toISOString() }));
  });
};

// ---- helpers ---------------------------------------------------------------
function safeAppt(a: { id: string; service: string; startsAt: Date; endsAt: Date; status: string; providerRef: string | null }) {
  return { id: a.id, service: a.service, startsAt: a.startsAt.toISOString(), endsAt: a.endsAt.toISOString(), status: a.status, provider: a.providerRef };
}
function maskMember(m: string): string { return m.length <= 4 ? '••••' : `••••${m.slice(-4)}`; }
const insuranceSchema = z.object({ planName: z.string().trim().min(1).max(120), memberId: z.string().trim().min(2).max(80), groupNumber: z.string().trim().max(80).optional(), subscriberName: z.string().trim().max(120).optional() });
async function upsertVoiceConsent(tenantId: string, patientId: string, granted: boolean) {
  const existing = await db.communicationConsent.findFirst({ where: { tenantId, patientId, channel: 'voice' } });
  const data = {
    status: granted ? 'opted_in' : 'opted_out',
    source: 'patient_portal',
    capturedAt: new Date(),
    revokedAt: granted ? null : new Date(),
    metadata: { source: 'patient_portal', channel: 'voice' },
  };
  if (existing) await db.communicationConsent.update({ where: { id: existing.id }, data });
  else await db.communicationConsent.create({ data: { tenantId, patientId, channel: 'voice', ...data } });
}
async function firstBranch(tenantId: string): Promise<string> {
  const b = await db.branch.findFirst({ where: { tenantId }, select: { id: true } });
  return b!.id;
}
