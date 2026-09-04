import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../../lib/db';
import { isValidE164, toE164 } from '../../lib/campaigns';
import { agentReadinessReason } from '../../lib/receptionist/agentReadiness';
import { VOICE_MUTABLE_STATUSES } from '../../lib/receptionist/appointmentContext';
import { runWithTenantContext } from '../../lib/tenantContext';
import { auditReceptionistMutation, receptionistRead, uuid, writeRoles } from './shared';

const HOUR_MS = 60 * 60 * 1000;
const WORKFORCE_POLICY_VERSION = 'carecommand-workforce-appointment-confirmation-v1';
const WORKFORCE_SOURCE = 'carecommand_ai_workforce';

function jsonRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isReceptionistTask(metadata: unknown): boolean {
  const row = jsonRecord(metadata);
  const workflow = typeof row?.workflow === 'string' ? row.workflow : '';
  return workflow.startsWith('receptionist');
}

/**
 * AI Workforce is intentionally an orchestration surface over the existing
 * production objects. It does not invent a second scheduler, call ledger, task
 * queue, patient model, or campaign engine. The counts below are therefore the
 * same records the operating modules use, and the preparation action writes a
 * normal governed outbound campaign/target set that still has to cross the
 * existing approval + consent/DNC + quiet-hours + admission fences before a
 * phone can ring.
 */
export const workforceRoutes: FastifyPluginAsync = async app => {
  app.get('/workforce/overview', { preHandler: receptionistRead }, async request => {
    const tenantId = request.auth.tenantId;
    const now = new Date();
    const next24 = new Date(now.getTime() + 24 * HOUR_MS);
    const since24 = new Date(now.getTime() - 24 * HOUR_MS);

    const [
      branches,
      appointmentsDue,
      appointmentsPatientConfirmed,
      pendingAppointmentRequests,
      outboundCampaigns,
      pendingTargets,
      activeCalls,
      inboundMissedCalls,
      intakePackets,
      openTasks,
      agents,
      voiceBookableServices,
      activeProviders,
    ] = await Promise.all([
      db.branch.count({ where: { tenantId, active: true } }),
      db.appointment.count({
        where: {
          tenantId,
          deletedAt: null,
          startsAt: { gte: now, lt: next24 },
          status: { in: [...VOICE_MUTABLE_STATUSES] },
          patientConfirmedAt: null,
        },
      }),
      db.appointment.count({
        where: {
          tenantId,
          deletedAt: null,
          startsAt: { gte: now, lt: next24 },
          status: { in: [...VOICE_MUTABLE_STATUSES] },
          patientConfirmedAt: { not: null },
        },
      }),
      db.appointmentRequest.count({ where: { tenantId, status: { in: ['PENDING_REVIEW', 'MISSING_INFO'] } } }),
      db.receptionistOutboundCampaign.groupBy({
        by: ['status'],
        where: { tenantId },
        _count: { _all: true },
      }),
      db.receptionistCallTarget.count({ where: { tenantId, status: 'PENDING' } }),
      db.receptionistCallLog.count({ where: { tenantId, outcome: 'IN_PROGRESS', endedAt: null } }),
      db.receptionistCallLog.count({
        where: {
          tenantId,
          direction: 'inbound',
          createdAt: { gte: since24 },
          outcome: { in: ['NO_ANSWER', 'ESCALATED', 'FAILED'] },
        },
      }),
      db.patientIntakePacket.count({ where: { tenantId, status: { in: ['draft', 'in_progress', 'needs_review'] } } }),
      db.staffTask.findMany({
        where: { tenantId, status: { in: ['OPEN', 'IN_PROGRESS'] } },
        select: { metadata: true },
        take: 1000,
      }),
      db.receptionistAgent.findMany({ where: { tenantId, active: true } }),
      db.serviceCatalogItem.count({ where: { tenantId, active: true, bookableByVoice: true } }),
      db.providerProfile.count({ where: { tenantId, active: true } }),
    ]);

    const campaignCounts = Object.fromEntries(outboundCampaigns.map(row => [row.status, row._count._all])) as Record<string, number>;
    const readyAgents = agents.filter(agent => !agentReadinessReason(agent)).length;
    const receptionistTasks = openTasks.filter(task => isReceptionistTask(task.metadata)).length;

    return {
      generatedAt: now.toISOString(),
      workload: {
        appointmentsNeedingConfirmationNext24h: appointmentsDue,
        appointmentsPatientConfirmedNext24h: appointmentsPatientConfirmed,
        appointmentRequestsNeedingReview: pendingAppointmentRequests,
        missedOrEscalatedInboundCallsLast24h: inboundMissedCalls,
        incompleteIntakePackets: intakePackets,
        receptionistTasksNeedingStaff: receptionistTasks,
        outboundTargetsWaiting: pendingTargets,
        callsCurrentlyInProgress: activeCalls,
      },
      operations: {
        activeBranches: branches,
        outboundCampaigns: {
          draft: campaignCounts.DRAFT ?? 0,
          scheduled: campaignCounts.SCHEDULED ?? 0,
          running: campaignCounts.RUNNING ?? 0,
          paused: campaignCounts.PAUSED ?? 0,
          completed: campaignCounts.COMPLETED ?? 0,
          failed: campaignCounts.FAILED ?? 0,
        },
      },
      capabilities: {
        inboundAiReceptionist: {
          state: readyAgents > 0 ? 'ready' : 'needs_setup',
          readyAgents,
        },
        liveAppointmentBooking: {
          state: readyAgents > 0 && voiceBookableServices > 0 && activeProviders > 0 ? 'ready' : 'needs_setup',
          voiceBookableServices,
          activeProviders,
        },
        governedOutboundCalling: {
          state: readyAgents > 0 ? 'ready' : 'needs_setup',
          pendingTargets,
        },
        autonomousOutboundDialer: {
          // Current main intentionally has no unattended dispatcher. Do not let
          // a dashboard imply automation merely because a manual Call button
          // exists. The autonomous worker lands as its own gated increment.
          state: 'building',
          reason: 'unattended_dispatcher_not_yet_on_current_main',
        },
        conversationalIntake: {
          state: 'ready',
          incompletePackets: intakePackets,
        },
        universalConversationalForms: {
          state: 'building',
          reason: 'generic_survey_and_custom_form_runtime_is_next_increment',
        },
      },
    };
  });

  // Safe automation step: build the worklist and a governed DRAFT campaign,
  // but DO NOT approve it and DO NOT dial anybody. The normal outbound module
  // remains the authority for approval, consent/DNC, quiet hours, concurrency,
  // usage limits, provider intent and the actual phone call.
  app.post('/workforce/appointment-confirmations/prepare', { preHandler: writeRoles }, async (request, reply) => {
    const input = z.object({
      clinicId: uuid,
      horizonHours: z.number().int().min(6).max(168).default(48),
      maxTargets: z.number().int().min(1).max(500).default(250),
      name: z.string().trim().min(2).max(160).optional(),
      quietHoursStart: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).default('20:00'),
      quietHoursEnd: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).default('08:00'),
    }).parse(request.body ?? {});

    const tenantId = request.auth.tenantId;
    const now = new Date();
    const until = new Date(now.getTime() + input.horizonHours * HOUR_MS);

    const prepared = await runWithTenantContext(tenantId, async tx => {
      const clinic = await tx.receptionistClinic.findFirst({
        where: { id: input.clinicId, tenantId, active: true },
        select: { id: true, name: true, timezone: true },
      });
      if (!clinic) throw new Error('workforce_clinic_not_found');

      const agents = await tx.receptionistAgent.findMany({
        where: { tenantId, clinicId: clinic.id, active: true },
        orderBy: { updatedAt: 'desc' },
      });
      const agent = agents.find(candidate => !agentReadinessReason(candidate));
      if (!agent) throw new Error('workforce_no_ready_receptionist');

      const locations = await tx.receptionistLocation.findMany({
        where: { tenantId, clinicId: clinic.id, active: true, branchId: { not: null } },
        select: { branchId: true },
      });
      const branchIds = [...new Set(locations.flatMap(location => location.branchId ? [location.branchId] : []))];
      if (branchIds.length === 0) throw new Error('workforce_no_mapped_branches');

      const appointments = await tx.appointment.findMany({
        where: {
          tenantId,
          branchId: { in: branchIds },
          deletedAt: null,
          startsAt: { gt: now, lte: until },
          status: { in: [...VOICE_MUTABLE_STATUSES] },
          patientConfirmedAt: null,
          patient: { deletedAt: null, phone: { not: null } },
        },
        orderBy: { startsAt: 'asc' },
        take: Math.min(input.maxTargets * 4, 1000),
        select: {
          id: true,
          patientId: true,
          startsAt: true,
          patient: { select: { firstName: true, lastName: true, phone: true, email: true } },
        },
      });

      const seenDestinations = new Set<string>();
      const targets: Array<{
        patientId: string;
        appointmentId: string;
        firstName: string;
        lastName: string;
        phone: string;
        email: string | null;
      }> = [];
      let invalidPhoneSkipped = 0;
      let duplicateDestinationSkipped = 0;

      for (const appointment of appointments) {
        if (targets.length >= input.maxTargets) break;
        const destination = toE164(appointment.patient.phone ?? '');
        if (!isValidE164(destination)) {
          invalidPhoneSkipped += 1;
          continue;
        }
        if (seenDestinations.has(destination)) {
          duplicateDestinationSkipped += 1;
          continue;
        }
        seenDestinations.add(destination);
        targets.push({
          patientId: appointment.patientId,
          appointmentId: appointment.id,
          firstName: appointment.patient.firstName,
          lastName: appointment.patient.lastName,
          phone: destination,
          email: appointment.patient.email,
        });
      }

      const generatedName = input.name ?? `Appointment confirmations · ${now.toISOString().slice(0, 10)}`;
      const campaign = await tx.receptionistOutboundCampaign.create({
        data: {
          tenantId,
          clinicId: clinic.id,
          agentId: agent.id,
          name: generatedName,
          script: 'Confirm the exact appointment bound to this call. Use only the per-call appointment context. After recording consent and verifying identity, confirm attendance or use the governed cancel/reschedule tools if the patient asks. Never invent an appointment detail.',
          purpose: 'APPOINTMENT_REMINDER',
          legalBasis: 'TREATMENT_OPERATIONS',
          policyVersion: WORKFORCE_POLICY_VERSION,
          requiredFields: [],
          customQuestions: {
            careCommandWorkforce: {
              source: WORKFORCE_SOURCE,
              workflow: 'appointment_confirmation',
              generatedAt: now.toISOString(),
              horizonHours: input.horizonHours,
              preparedTargets: targets.length,
            },
          },
          humanHandoffInstruction: 'Create a staff handoff when the patient asks for help that cannot be completed safely by the appointment tools.',
          bookingMode: 'APPOINTMENT_REQUEST_ONLY',
          quietHoursStart: input.quietHoursStart,
          quietHoursEnd: input.quietHoursEnd,
          maxRetryAttempts: 1,
          status: 'DRAFT',
        },
      });

      if (targets.length > 0) {
        await tx.receptionistCallTarget.createMany({
          data: targets.map(target => ({
            tenantId,
            campaignId: campaign.id,
            patientId: target.patientId,
            appointmentId: target.appointmentId,
            firstName: target.firstName,
            lastName: target.lastName,
            phone: target.phone,
            email: target.email,
            status: 'PENDING',
          })),
        });
      }

      await auditReceptionistMutation(tx, request, {
        action: 'receptionist.workforce.appointmentConfirmationsPrepared',
        resource: 'receptionistOutboundCampaign',
        resourceId: campaign.id,
        metadata: {
          clinicId: clinic.id,
          workflow: 'appointment_confirmation',
          horizonHours: input.horizonHours,
          targetsPrepared: targets.length,
          invalidPhoneSkipped,
          duplicateDestinationSkipped,
          status: campaign.status,
        },
      });

      return {
        campaignId: campaign.id,
        campaignName: campaign.name,
        clinicName: clinic.name,
        targetsPrepared: targets.length,
        appointmentsConsidered: appointments.length,
        invalidPhoneSkipped,
        duplicateDestinationSkipped,
      };
    }).catch(error => {
      const reason = error instanceof Error ? error.message : 'workforce_prepare_failed';
      const known = new Set([
        'workforce_clinic_not_found',
        'workforce_no_ready_receptionist',
        'workforce_no_mapped_branches',
      ]);
      if (known.has(reason)) throw app.httpErrors.conflict(reason);
      throw error;
    });

    return reply.code(201).send({
      status: 'prepared',
      ...prepared,
      approvalRequired: true,
      callsPlaced: 0,
      nextStep: 'Review and approve the prepared outbound campaign. The existing outbound safety gates are still authoritative at launch time.',
    });
  });
};
