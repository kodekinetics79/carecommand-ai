import { db } from '../../lib/db';
import { recordWorkflowEvent } from '../../lib/intelligence';
import type { Prisma } from '../../generated/prisma/client';

// ===========================================================================
// AI Receptionist booking handoff. Converts an outbound call's collected fields
// into an AppointmentRequest, links/creates patient or lead, and — only when
// safe — books an appointment directly. Idempotent on the Retell call id.
// The AI never makes clinical/medical decisions; this is scheduling intake only.
// ===========================================================================

const REQUIRED_FIELD_LABEL: Record<string, string> = {
  firstName: 'first_name', lastName: 'last_name', phone: 'phone', email: 'email',
  preferredBranch: 'preferred_branch', preferredService: 'preferred_service', preferredDateTime: 'preferred_datetime',
};

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function collectFields(custom: Record<string, unknown>, fallbackPhone?: string | null) {
  const dt = str(custom.preferred_datetime)
    ?? (str(custom.preferred_date) && str(custom.preferred_time) ? `${str(custom.preferred_date)} ${str(custom.preferred_time)}` : str(custom.preferred_date));
  return {
    firstName: str(custom.first_name),
    lastName: str(custom.last_name),
    phone: str(custom.phone) ?? (fallbackPhone ?? undefined),
    email: str(custom.email),
    preferredBranch: str(custom.preferred_branch),
    preferredService: str(custom.preferred_service),
    preferredDateTime: dt,
  };
}

async function auditHandoff(tenantId: string, action: string, resourceId: string | null, metadata: Prisma.InputJsonObject) {
  await db.auditEvent.create({ data: { tenantId, actorUserId: null, action, resource: 'receptionistBooking', resourceId: resourceId ?? undefined, userAgent: 'retell-webhook', metadata } });
}

async function claimOnce(tenantId: string, retellCallId: string): Promise<boolean> {
  try {
    await db.idempotencyKey.create({ data: { scope: 'receptionist.booking', key: retellCallId, tenantId } });
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === 'P2002') return false;
    throw error;
  }
}

export interface HandoffResult { handled: boolean; status?: string; appointmentRequestId?: string; reason?: string }

export async function runBookingHandoff(retellCallId: string, custom: Record<string, unknown>): Promise<HandoffResult> {
  const callLog = await db.receptionistCallLog.findFirst({ where: { retellCallId }, select: { id: true, tenantId: true, outboundCampaignId: true, targetId: true, callerPhone: true } });
  if (!callLog || !callLog.outboundCampaignId) return { handled: false };
  const tenantId = callLog.tenantId;

  // Idempotent on the call id — webhook redelivery never duplicates a request.
  if (!(await claimOnce(tenantId, retellCallId))) {
    const existing = await db.appointmentRequest.findFirst({ where: { tenantId, callLogId: callLog.id }, select: { id: true, status: true } });
    return { handled: true, status: existing?.status, appointmentRequestId: existing?.id, reason: 'duplicate_webhook' };
  }

  const campaign = await db.receptionistOutboundCampaign.findFirst({ where: { id: callLog.outboundCampaignId, tenantId } });
  if (!campaign) return { handled: false };

  const collected = collectFields(custom, callLog.callerPhone);
  const required = campaign.requiredFields.length ? campaign.requiredFields : ['firstName', 'lastName', 'phone'];
  const missingFields = required.filter(key => !(collected as Record<string, string | undefined>)[key]);

  // Best-effort patient/lead linking by phone/email (minimum-necessary lookup).
  const matchOr: Prisma.PatientWhereInput[] = [];
  if (collected.phone) matchOr.push({ phone: collected.phone });
  if (collected.email) matchOr.push({ email: collected.email });
  const patient = matchOr.length ? await db.patient.findFirst({ where: { tenantId, deletedAt: null, OR: matchOr }, select: { id: true, branchId: true } }) : null;

  const baseData = {
    tenantId,
    campaignId: campaign.id,
    callLogId: callLog.id,
    requestedService: collected.preferredService ?? campaign.defaultService ?? null,
    collectedName: [collected.firstName, collected.lastName].filter(Boolean).join(' ') || null,
    collectedPhone: collected.phone ?? null,
    collectedEmail: collected.email ?? null,
    rawCollectedFields: custom as Prisma.InputJsonValue,
    source: 'ai_receptionist',
  };

  // Missing required fields → flag for staff, do not book.
  if (missingFields.length > 0) {
    const reason = `Missing required fields: ${missingFields.join(', ')}`;
    const request = await db.appointmentRequest.create({
      data: { ...baseData, patientId: patient?.id, status: 'MISSING_INFO', missingFields, outcomeReason: reason },
    });
    await auditHandoff(tenantId, 'receptionist.appointmentRequest.created', request.id, { status: 'MISSING_INFO', missingFields });
    await recordWorkflowEvent(tenantId, { eventType: 'receptionist.appointmentRequest.created', entityType: 'appointmentRequest', entityId: request.id, sourceModule: 'receptionist', payload: { status: 'MISSING_INFO' } });
    return { handled: true, status: 'MISSING_INFO', appointmentRequestId: request.id, reason };
  }

  // Parse requested time; resolve a branch for booking.
  const requestedDateTime = collected.preferredDateTime ? new Date(collected.preferredDateTime) : null;
  const validDateTime = requestedDateTime && !Number.isNaN(requestedDateTime.getTime()) ? requestedDateTime : null;
  const branchId = campaign.defaultBranchId ?? patient?.branchId ?? null;

  const requestedLegacyDirect = campaign.bookingMode === 'DIRECT_BOOKING_IF_SLOT_AVAILABLE';
  // This legacy analysis handoff has no signed/version-attested inbound booking
  // campaign. It is therefore request-only even for pre-existing rows that
  // still carry the retired direct-booking enum value.
  const wantsDirect = false;

  // Decide whether a safe direct booking is possible. No service/availability
  // model exists, so we validate: branch exists, a parseable time, an existing
  // or creatable patient, and no conflicting appointment.
  if (wantsDirect && branchId && validDateTime) {
    const branch = await db.branch.findFirst({ where: { id: branchId, tenantId }, select: { id: true } });
    if (branch) {
      let bookPatientId = patient?.id ?? null;
      if (!bookPatientId && collected.firstName && collected.lastName) {
        const created = await db.patient.create({
          data: { tenantId, branchId, firstName: collected.firstName, lastName: collected.lastName, phone: collected.phone, email: collected.email, lifecycleStage: 'NEW' },
        });
        bookPatientId = created.id;
      }
      if (bookPatientId) {
        const endsAt = new Date(validDateTime.getTime() + 30 * 60000);
        const conflict = await db.appointment.findFirst({ where: { tenantId, branchId, deletedAt: null, startsAt: { lt: endsAt }, endsAt: { gt: validDateTime } }, select: { id: true } });
        if (!conflict) {
          const appointment = await db.appointment.create({
            data: { tenantId, branchId, patientId: bookPatientId, service: baseData.requestedService ?? 'Consultation', startsAt: validDateTime, endsAt, status: 'CONFIRMED', channel: 'CALL' },
          });
          const request = await db.appointmentRequest.create({
            data: { ...baseData, branchId, patientId: bookPatientId, requestedDateTime: validDateTime, status: 'BOOKED', missingFields: [], bookedAppointmentId: appointment.id, outcomeReason: 'Booked directly from AI receptionist call' },
          });
          await auditHandoff(tenantId, 'receptionist.appointmentRequest.created', request.id, { status: 'BOOKED' });
          await auditHandoff(tenantId, 'receptionist.appointment.booked', appointment.id, { appointmentRequestId: request.id, branchId });
          return { handled: true, status: 'BOOKED', appointmentRequestId: request.id };
        }
      }
    }
  }

  // Fallback: pending review (request-only mode, or direct booking not safely possible).
  const reason = requestedLegacyDirect
    ? 'Unattested direct booking mode was downgraded to staff review.'
    : 'Appointment request only — routed to staff review.';
  // Create a lead for tracking if no patient matched.
  let leadId: string | null = null;
  if (!patient?.id && collected.phone) {
    const lead = await db.lead.create({
      data: { tenantId, name: baseData.collectedName ?? 'AI receptionist lead', phone: collected.phone, email: collected.email, channel: 'CALL', service: baseData.requestedService ?? 'Consultation', stage: 'new', source: 'ai_receptionist' },
    });
    leadId = lead.id;
  }
  const request = await db.appointmentRequest.create({
    data: { ...baseData, branchId, patientId: patient?.id, leadId, requestedDateTime: validDateTime, status: 'PENDING_REVIEW', missingFields: [], outcomeReason: reason },
  });
  await auditHandoff(tenantId, 'receptionist.appointmentRequest.created', request.id, { status: 'PENDING_REVIEW' });
  await recordWorkflowEvent(tenantId, { eventType: 'receptionist.appointmentRequest.created', entityType: 'appointmentRequest', entityId: request.id, sourceModule: 'receptionist', payload: { status: 'PENDING_REVIEW' } });
  return { handled: true, status: 'PENDING_REVIEW', appointmentRequestId: request.id, reason };
}

export { REQUIRED_FIELD_LABEL };
