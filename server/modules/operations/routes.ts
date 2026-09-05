import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { env } from '../../config/env';
import { eligibilityCapability, cardPaymentsCapability } from '../../lib/providerRails';
import { db } from '../../lib/db';
import { audit } from '../../lib/audit';
import { assertBranchAccess, branchScope } from '../../lib/scope';
import { runWithTenantContext } from '../../lib/tenantContext';
import { requireFeature } from '../../lib/entitlements';
import { sendMessage, type SendResult } from '../../lib/commsProvider';
import { isSuppressed, isValidE164, isValidEmail, maskDestination, toE164, type CommChannel } from '../../lib/campaigns';
import { getRequestPermissions, requirePermission } from '../../lib/permissions';
import { Prisma } from '../../generated/prisma/client';
import { ensureStaffTask } from '../../lib/staffTasks';
import { cursorPage } from '../../lib/pagination';
import {
  normalizeTaskPriority, parseReceptionistTask,
  RECEPTIONIST_TASK_KINDS, RECEPTIONIST_TASK_WORKFLOW, RECEPTIONIST_TASK_WORKFLOWS,
  taskPriorityVariants, type ReceptionistTaskKind,
} from '../../lib/receptionist/frontDeskTask';
import { projectTaskRow, taskListInclude } from '../../lib/receptionist/taskProjection';

const channel = z.enum(['WHATSAPP', 'SMS', 'EMAIL', 'PUSH', 'CALL', 'VIDEO']);
const uuid = z.string().uuid();
const listLimit = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) });
const pagedList = listLimit.extend({ cursor: uuid.optional(), page: z.literal('true').optional() });
const OPERATIONAL_REPLY_TERMS = 'operational_reply_to_recorded_inbound_conversation' as const;
const OPERATIONAL_REPLY_TERMS_SOURCE = 'carecommand_operational_reply_policy_v1' as const;
// Route guards are classified by data class + action. Avoid a shared "staff"
// role list: it previously made unrelated PHI, revenue, integration, and
// clinical-review surfaces available to every authenticated tenant role.
const operationsRead = requirePermission('operations:read');
const operationsWrite = requirePermission('operations:write');
const crmRead = requirePermission('crm:read');
const crmWrite = requirePermission('crm:write');
const campaignRead = requirePermission('campaign:read');
const campaignManage = requirePermission('campaign:manage');
const revenueRead = requirePermission('revenue:read');
const revenueWrite = requirePermission('revenue:write');
const inventoryRead = requirePermission('inventory:read');
const inventoryWrite = requirePermission('inventory:write');
const inventoryManage = requirePermission('inventory:manage');
const integrationsRead = requirePermission('integrations:read');
const integrationsManage = requirePermission('integrations:manage');
const partnerReportRead = requirePermission('partner-report:read');
const partnerReportWrite = requirePermission('partner-report:write');
const partnerReportReview = requirePermission('partner-report:review');
const staffTaskRead = requirePermission('staff:read');
const staffTaskWrite = requirePermission('staff:write');

function scopedBranch(request: FastifyRequest, branchId?: string) {
  return request.auth.branchId ?? branchId;
}

async function requireTenantBranch(request: FastifyRequest, branchId: string) {
  assertBranchAccess(request, branchId);
  const branch = await db.branch.findFirst({
    where: { id: branchId, tenantId: request.auth.tenantId },
    select: { id: true },
  });
  if (!branch) throw request.server.httpErrors.badRequest('Branch must belong to the authenticated tenant');
}

async function requireTenantPatient(request: FastifyRequest, patientId: string, branchId?: string) {
  const patient = await db.patient.findFirst({
    where: { id: patientId, tenantId: request.auth.tenantId, deletedAt: null, ...branchScope(request) },
    select: { id: true, branchId: true },
  });
  if (!patient || (branchId && patient.branchId !== branchId)) {
    throw request.server.httpErrors.badRequest('Patient must belong to the authenticated tenant and branch');
  }
}

async function requireTenantAssignee(request: FastifyRequest, assignedToId: string, branchId: string) {
  const user = await db.user.findFirst({
    where: {
      id: assignedToId,
      tenantId: request.auth.tenantId,
      active: true,
      OR: [
        { role: { notIn: ['MANAGER', 'PROVIDER', 'FRONT_DESK', 'BILLING'] } },
        { branchId },
        { clinicAccesses: { some: { tenantId: request.auth.tenantId, branchId } } },
      ],
    },
    select: { id: true },
  });
  if (!user) throw request.server.httpErrors.badRequest('Assignee must be active and authorized for the selected clinic');
}

// Map a conversation channel + patient contact to a real outbound send target.
// Returns null when no concrete sender/destination exists (PUSH/VIDEO, or a
// missing phone/email) — the caller then records the reply truthfully as
// undelivered instead of claiming an AI recovery.
function resolveReplyTarget(
  channel: string,
  patient: { phone: string | null; email: string | null } | null,
): { channel: CommChannel; destination: string } | null {
  const phone = patient?.phone?.trim() || '';
  const email = patient?.email?.trim() || '';
  switch (channel) {
    case 'SMS':
    case 'CALL': // missed-call recovery is delivered as an SMS follow-up
      return phone ? { channel: 'sms', destination: phone } : null;
    case 'WHATSAPP':
      return phone ? { channel: 'whatsapp', destination: phone } : null;
    case 'EMAIL':
      return email ? { channel: 'email', destination: email } : null;
    default: // PUSH / VIDEO — no concrete outbound sender wired
      return null;
  }
}

function isReplyDestinationFormatValid(target: { channel: CommChannel; destination: string } | null): boolean {
  if (!target) return false;
  if (target.channel === 'email') return isValidEmail(target.destination);
  return isValidE164(toE164(target.destination));
}

function evidenceHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function durableReplyPayload(result: {
  status: string;
  providerMode: string | null;
  providerMessageId: string | null;
}) {
  const accepted = result.status === 'provider_accepted';
  const deliveryStatus = result.status === 'submission_result_unknown'
    ? 'submission_result_unknown'
    : result.status === 'provider_pending'
      ? 'pending'
      : result.status === 'provider_rejected'
        ? 'failed'
        : result.status === 'suppressed'
          ? 'suppressed'
          : accepted ? 'accepted' : 'failed';
  return {
    accepted,
    delivered: false,
    deliveryStatus,
    providerMode: result.providerMode,
    providerMessageId: result.providerMessageId,
    message: deliveryStatus === 'submission_result_unknown'
      ? 'Submission result unknown. Retrying is blocked until provider evidence is reconciled.'
      : deliveryMessage(accepted, deliveryStatus, result.providerMode as SendResult['mode'] | null),
  };
}

function deliveryMessage(accepted: boolean, deliveryStatus: string, providerMode?: SendResult['mode'] | null): string {
  if (accepted && providerMode === 'mock_dev') {
    return 'Test provider accepted the simulated request. No patient delivery occurred.';
  }
  if (accepted) {
    return 'Provider accepted the message request, but delivery is not confirmed. Review provider evidence before resending.';
  }
  switch (deliveryStatus) {
    case 'suppressed': return 'Not sent: recipient has opted out / is suppressed. Nothing was delivered.';
    case 'setup_required': return 'Not sent: this channel has no messaging provider configured yet.';
    case 'no_contact': return 'Not sent: no reachable phone/email on file for this channel.';
    case 'pending': return 'Pending: provider submission and delivery are not confirmed.';
    default: return 'Not sent: delivery failed. Nothing was delivered to the patient.';
  }
}

export const operationsRoutes: FastifyPluginAsync = async app => {
  app.get('/competitors/radar', { preHandler: operationsRead }, async request => {
    const query = listLimit.extend({ branchId: uuid.optional() }).parse(request.query);
    return db.competitor.findMany({
      where: { tenantId: request.auth.tenantId, branchId: scopedBranch(request, query.branchId) },
      take: query.limit,
      orderBy: [{ googleRating: 'asc' }, { reviewVolume: 'desc' }],
      include: { branch: { select: { id: true, name: true } }, insights: { orderBy: { complaintCount: 'desc' } } },
    });
  });

  app.get('/reputation', { preHandler: crmRead }, async request => {
    const query = listLimit.extend({ branchId: uuid.optional() }).parse(request.query);
    const branchId = scopedBranch(request, query.branchId);
    const [cases, reviewRequests, unresolvedCount, averageRisk] = await Promise.all([
      db.reputationCase.findMany({
        where: { tenantId: request.auth.tenantId, branchId },
        take: query.limit,
        orderBy: [{ badReviewRisk: 'desc' }, { createdAt: 'desc' }],
        include: { branch: { select: { name: true } }, patient: { select: { firstName: true, lastName: true } } },
      }),
      db.reviewRequest.findMany({
        where: { tenantId: request.auth.tenantId, branchId },
        take: query.limit,
        orderBy: { createdAt: 'desc' },
        include: { branch: { select: { name: true } }, patient: { select: { firstName: true, lastName: true } } },
      }),
      db.reputationCase.count({ where: { tenantId: request.auth.tenantId, branchId, workflowStatus: { not: 'resolved' } } }),
      db.reputationCase.aggregate({
        where: { tenantId: request.auth.tenantId, branchId },
        _avg: { badReviewRisk: true, npsScore: true },
      }),
    ]);

    return {
      summary: {
        unresolvedCases: unresolvedCount,
        avgBadReviewRisk: Math.round(Number(averageRisk._avg.badReviewRisk ?? 0)),
        avgNpsScore: Math.round(Number(averageRisk._avg.npsScore ?? 0)),
        pendingReviewRequests: reviewRequests.filter(item => item.status !== 'SENT' && item.status !== 'DELIVERED').length,
      },
      cases,
      reviewRequests,
    };
  });

  // RLS (B-3): RevenueLeak is tenant-isolated — reads/writes run under context.
  app.get('/revenue-leaks', { preHandler: revenueRead }, async request => {
    const query = listLimit.extend({ branchId: uuid.optional() }).parse(request.query);
    return runWithTenantContext(request.auth.tenantId, tx => tx.revenueLeak.findMany({
      where: { tenantId: request.auth.tenantId, branchId: scopedBranch(request, query.branchId) },
      take: query.limit,
      orderBy: { createdAt: 'desc' },
      include: { branch: { select: { name: true } }, ownerUser: { select: { displayName: true } }, patient: { select: { firstName: true, lastName: true } } },
    }));
  });

  app.patch('/revenue-leaks/:id', { preHandler: revenueWrite }, async request => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const input = z.object({
      status: z.string().min(2).max(40).optional(),
      workflowStatus: z.string().min(2).max(40).optional(),
    }).parse(request.body);
    const row = await runWithTenantContext(request.auth.tenantId, async tx => {
      const existing = await tx.revenueLeak.findFirst({ where: { id, tenantId: request.auth.tenantId } });
      if (!existing) throw app.httpErrors.notFound('Revenue leak not found');
      if (existing.branchId) assertBranchAccess(request, existing.branchId);
      return tx.revenueLeak.update({ where: { id }, data: input });
    });
    await audit(request, { action: 'revenueLeak.workflowUpdated', resource: 'revenueLeak', resourceId: id, metadata: input });
    return row;
  });

  app.get('/opportunities', { preHandler: revenueRead }, async request => {
    const query = listLimit.extend({ branchId: uuid.optional() }).parse(request.query);
    return db.opportunity.findMany({
      where: { tenantId: request.auth.tenantId, branchId: scopedBranch(request, query.branchId) },
      take: query.limit,
      orderBy: { createdAt: 'desc' },
      include: { branch: { select: { name: true } }, ownerUser: { select: { displayName: true } }, patient: { select: { firstName: true, lastName: true } } },
    });
  });
  app.patch('/opportunities/:id', { preHandler: revenueWrite }, async request => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const input = z.object({
      status: z.string().min(2).max(40).optional(),
      ownerApprovalRequired: z.boolean().optional(),
      actualRevenue: z.coerce.number().min(0).optional(),
    }).parse(request.body);
    const existing = await db.opportunity.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!existing) throw app.httpErrors.notFound('Opportunity not found');
    if (existing.branchId) assertBranchAccess(request, existing.branchId);
    const row = await db.opportunity.update({ where: { id }, data: input });
    await audit(request, { action: 'opportunity.updated', resource: 'opportunity', resourceId: id, metadata: input });
    return row;
  });

  // Opportunity hand-offs. "Send to Front Desk" and "Assign Callback Queue" both
  // told the user the work had been handed to the front-desk team, while only
  // moving the opportunity's own status string — nobody was ever given the job.
  // Each verb now lands a real StaffTask in the same transaction as the status
  // change, so the claim and the record cannot diverge.
  const HANDOFF: Record<'send_front_desk' | 'assign_callback', { status: string; title: (t: string) => string; priority: string; dueInHours: number }> = {
    send_front_desk: { status: 'assigned', title: t => `Front desk: ${t}`, priority: 'high', dueInHours: 24 },
    assign_callback: { status: 'running', title: t => `Callback queue: ${t}`, priority: 'high', dueInHours: 4 },
  };
  app.post('/opportunities/:id/handoff', { preHandler: revenueWrite }, async (request, reply) => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const { verb } = z.object({ verb: z.enum(['send_front_desk', 'assign_callback']) }).parse(request.body);
    const spec = HANDOFF[verb];
    const existing = await db.opportunity.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!existing) throw app.httpErrors.notFound('Opportunity not found');
    assertBranchAccess(request, existing.branchId);

    const result = await runWithTenantContext(request.auth.tenantId, async tx => {
      const handoff = await ensureStaffTask(tx, {
        tenantId: request.auth.tenantId,
        branchId: existing.branchId,
        title: spec.title(existing.title).slice(0, 240),
        priority: spec.priority,
        dueAt: new Date(Date.now() + spec.dueInHours * 3_600_000),
        origin: { workflow: 'opportunity_handoff', entityType: 'opportunity', entityId: existing.id, verb },
        context: { opportunityCategory: existing.category, recommendedAction: existing.recommendedAction },
      });
      const opportunity = await tx.opportunity.update({
        where: { id: existing.id },
        data: { status: spec.status, ownerApprovalRequired: false },
        include: { branch: { select: { name: true } }, ownerUser: { select: { displayName: true } }, patient: { select: { firstName: true, lastName: true } } },
      });
      await tx.auditEvent.create({ data: {
        tenantId: request.auth.tenantId, actorUserId: request.auth.userId,
        action: 'opportunity.handoff', resource: 'opportunity', resourceId: existing.id,
        requestId: request.id, ipAddress: request.ip, userAgent: request.headers['user-agent'],
        metadata: { verb, status: spec.status, taskId: handoff.task.id, taskCreated: handoff.created },
      } });
      return { opportunity, handoff };
    });

    return reply.send({
      opportunity: result.opportunity,
      task: result.handoff.task,
      taskCreated: result.handoff.created,
      message: result.handoff.created
        ? 'Task created in Staff Tasks for the branch front desk.'
        : 'An open task for this opportunity already exists in Staff Tasks; it was not duplicated.',
    });
  });

  app.get('/leads', { preHandler: crmRead }, async request => {
    const { limit } = listLimit.parse(request.query);
    return db.lead.findMany({ where: { tenantId: request.auth.tenantId }, take: limit, orderBy: { createdAt: 'desc' } });
  });
  // The "mark lost" modal blocks the operator until they type a justification and
  // promises it is "captured for lost-reason intelligence" and "recorded in the
  // audit trail". It is therefore persisted on the lead, written into the audit
  // metadata, and recorded as a LeadActivity row. `Lead.stage` is overwritten in
  // place, so without that row a stage change leaves no trace at all and "why
  // are we losing leads?" has no answer.
  const LOST_STAGE = 'lost';
  const lostReasonInput = z.string().trim().min(3).max(500);

  app.post('/leads', { preHandler: crmWrite }, async (request, reply) => {
    const input = z.object({
      patientId: uuid.optional(), name: z.string().min(2).max(160), phone: z.string().max(40).optional(),
      email: z.string().email().optional(), channel, service: z.string().min(2).max(160),
      stage: z.string().min(2).max(40), source: z.string().min(2).max(120), estimatedValue: z.coerce.number().min(0).default(0),
      lostReason: lostReasonInput.optional(),
    }).parse(request.body);
    if (input.stage === LOST_STAGE && !input.lostReason) {
      throw app.httpErrors.badRequest('A lost reason is required when a lead is created in the lost stage.');
    }
    if (input.patientId) await requireTenantPatient(request, input.patientId);
    const row = await db.$transaction(async tx => {
      const lead = await tx.lead.create({ data: { tenantId: request.auth.tenantId, ...input } });
      await tx.leadActivity.create({
        data: {
          tenantId: request.auth.tenantId, leadId: lead.id, activityType: 'stage_change',
          fromStage: null, toStage: lead.stage, reason: input.lostReason ?? null,
          actorUserId: request.auth.userId,
        },
      });
      return lead;
    });
    await audit(request, {
      action: 'lead.created', resource: 'lead', resourceId: row.id,
      metadata: { stage: row.stage, ...(input.lostReason ? { lostReason: input.lostReason } : {}) },
    });
    return reply.code(201).send(row);
  });
  app.patch('/leads/:id', { preHandler: crmWrite }, async request => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const input = z.object({
      stage: z.string().min(2).max(40).optional(),
      estimatedValue: z.coerce.number().min(0).optional(),
      lostReason: lostReasonInput.optional(),
    }).parse(request.body);
    const existing = await db.lead.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!existing) throw app.httpErrors.notFound('Lead not found');
    const stageChanged = input.stage !== undefined && input.stage !== existing.stage;
    if (input.stage === LOST_STAGE && !input.lostReason && !existing.lostReason) {
      throw app.httpErrors.badRequest('A lost reason is required to mark a lead as lost.');
    }
    const row = await db.$transaction(async tx => {
      const updated = await tx.lead.update({ where: { id }, data: input });
      if (stageChanged) {
        await tx.leadActivity.create({
          data: {
            tenantId: request.auth.tenantId, leadId: id, activityType: 'stage_change',
            fromStage: existing.stage, toStage: updated.stage,
            reason: input.lostReason ?? updated.lostReason ?? null,
            actorUserId: request.auth.userId,
          },
        });
      }
      return updated;
    });
    await audit(request, {
      action: 'lead.updated', resource: 'lead', resourceId: id,
      metadata: { ...input, ...(stageChanged ? { fromStage: existing.stage, toStage: row.stage } : {}) },
    });
    return row;
  });

  // Campaign automation is feature-gated (campaign_automation entitlement).
  const campaignFeature = requireFeature('campaign_automation');
  /** True when a body names `status` at all, including `status: null`. */
  const hasStatusField = (body: unknown): boolean =>
    typeof body === 'object' && body !== null && 'status' in (body as Record<string, unknown>);
  // Before → after: legacy campaign reads were authenticated-only and mutations
  // were OWNER/ADMIN/MANAGER. Dedicated grants now close reads without expanding
  // mutation authority to FRONT_DESK through crm:write.
  app.get('/campaigns', { preHandler: [campaignRead, campaignFeature] }, async request => {
    const { limit } = listLimit.parse(request.query);
    return db.campaign.findMany({ where: { tenantId: request.auth.tenantId }, take: limit, orderBy: { createdAt: 'desc' } });
  });
  // Campaign STATE is not writable here.
  //
  // `Campaign` is one table serving two field families. The governed engine
  // (server/modules/campaigns/routes.ts, mounted at /v1/crm) owns
  // campaignType/audienceType/approval and moves a campaign through
  // APPROVAL_REQUIRED -> approve (bound to a launch fingerprint over the exact
  // audience, template, channel and provider) -> launch -> pause/cancel. These
  // legacy routes owned none of that and still accepted
  // `status: ACTIVE|SCHEDULED|COMPLETED` on any campaign in the tenant, with no
  // fingerprint, no approval and no audience check — so a campaign could be
  // made to READ as approved and running without ever passing the approval it
  // exists to require. The dispatch path re-checks consent and suppression, so
  // no message escaped that way, but every human and every screen reading
  // `status` was being told something the governance machine never authorized.
  //
  // The status write is therefore retired: creation is always DRAFT, and
  // transitions go through the endpoints that check them. GET stays — it is the
  // analytics read behind the dashboard's campaign panel.
  const STATUS_WRITE_RETIRED = 'Campaign status is not writable here. Use the governed campaign workflow — POST /v1/crm/campaigns/:id/approve, /launch, /pause or /cancel — which checks the approved audience, the launch fingerprint, and consent and suppression at dispatch.';
  const ENGINE_MANAGED = 'This campaign is managed by the campaign workflow at /v1/crm/campaigns/:id, which enforces approval before dispatch. Edit it there.';

  app.post('/campaigns', { preHandler: [campaignManage, campaignFeature] }, async (request, reply) => {
    // `status` is deliberately absent: a campaign cannot be born ACTIVE.
    if (hasStatusField(request.body)) throw app.httpErrors.badRequest(STATUS_WRITE_RETIRED);
    const input = z.object({
      name: z.string().min(2).max(160), goal: z.string().min(2).max(300),
      channels: z.array(channel).min(1), audienceSize: z.coerce.number().int().min(0).default(0),
      aiGenerated: z.boolean().default(false), startsAt: z.coerce.date().optional(), endsAt: z.coerce.date().optional(),
    }).parse(request.body);
    const row = await db.campaign.create({ data: { tenantId: request.auth.tenantId, ...input, status: 'DRAFT' } });
    await audit(request, { action: 'campaign.created', resource: 'campaign', resourceId: row.id });
    return reply.code(201).send(row);
  });
  app.patch('/campaigns/:id', { preHandler: [campaignManage, campaignFeature] }, async request => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    // Refused before the lookup: the answer does not depend on the record, and
    // a caller reaching for a retired field should not learn what exists.
    if (hasStatusField(request.body)) throw app.httpErrors.badRequest(STATUS_WRITE_RETIRED);
    const input = z.object({
      name: z.string().min(2).max(160).optional(),
      goal: z.string().min(2).max(300).optional(),
    }).parse(request.body);
    const existing = await db.campaign.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!existing) throw app.httpErrors.notFound('Campaign not found');
    // A campaign with a campaignType belongs to the engine, whose own PATCH
    // refuses edits once a campaign has left DRAFT/APPROVAL_REQUIRED because the
    // launch fingerprint is bound to what it edits. Renaming it from here would
    // walk around that check.
    if (existing.campaignType !== null) throw app.httpErrors.conflict(ENGINE_MANAGED);
    const row = await db.campaign.update({ where: { id }, data: input });
    await audit(request, { action: 'campaign.updated', resource: 'campaign', resourceId: id, metadata: input });
    return row;
  });

  app.get('/reviews', { preHandler: crmRead }, async request => {
    const query = listLimit.extend({ branchId: uuid.optional() }).parse(request.query);
    return db.review.findMany({ where: { tenantId: request.auth.tenantId, branchId: scopedBranch(request, query.branchId) }, take: query.limit, orderBy: { createdAt: 'desc' } });
  });
  app.post('/reviews', { preHandler: crmWrite }, async (request, reply) => {
    const input = z.object({
      patientId: uuid.optional(), branchId: uuid.optional(), rating: z.coerce.number().int().min(1).max(5),
      text: z.string().min(1).max(4000), platform: z.string().min(2).max(80), sentiment: z.string().min(2).max(40),
    }).parse(request.body);
    if (input.branchId) await requireTenantBranch(request, input.branchId);
    if (input.patientId) await requireTenantPatient(request, input.patientId, input.branchId);
    const row = await db.review.create({ data: { tenantId: request.auth.tenantId, ...input } });
    await audit(request, { action: 'review.created', resource: 'review', resourceId: row.id });
    return reply.code(201).send(row);
  });
  app.patch('/reviews/:id/respond', { preHandler: crmWrite }, async request => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const input = z.object({ response: z.string().min(1).max(4000) }).parse(request.body);
    const existing = await db.review.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!existing) throw app.httpErrors.notFound('Review not found');
    if (existing.branchId) assertBranchAccess(request, existing.branchId);
    const row = await db.review.update({
      where: { id },
      data: { responded: true, aiDraftResponse: input.response },
    });
    await audit(request, { action: 'review.responded', resource: 'review', resourceId: id });
    return row;
  });

  app.get('/inventory', { preHandler: inventoryRead }, async request => {
    const query = pagedList.extend({ branchId: uuid.optional() }).parse(request.query);
    const rows = await db.inventoryItem.findMany({
      where: { tenantId: request.auth.tenantId, branchId: scopedBranch(request, query.branchId) },
      cursor: query.cursor ? { id: query.cursor } : undefined,
      skip: query.cursor ? 1 : 0,
      take: query.limit + 1,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    const result = cursorPage(rows, query.limit);
    return query.page === 'true' || query.cursor ? result : result.data;
  });
  // Inventory creation preserves the former OWNER/ADMIN/MANAGER gate; stock
  // updates preserve the former FRONT_DESK operational membership separately.
  app.post('/inventory', { preHandler: inventoryManage }, async (request, reply) => {
    const input = z.object({
      branchId: uuid, name: z.string().min(2).max(160), category: z.string().min(2).max(100),
      currentStock: z.coerce.number().int().min(0), unit: z.string().min(1).max(40), reorderLevel: z.coerce.number().int().min(0),
      expiryDate: z.coerce.date().optional(), unitCost: z.coerce.number().min(0), usagePerWeek: z.coerce.number().int().min(0), supplier: z.string().min(2).max(160),
    }).parse(request.body);
    await requireTenantBranch(request, input.branchId);
    const row = await db.inventoryItem.create({ data: { tenantId: request.auth.tenantId, ...input } });
    await audit(request, { action: 'inventory.created', resource: 'inventoryItem', resourceId: row.id });
    return reply.code(201).send(row);
  });
  app.patch('/inventory/:id', { preHandler: inventoryWrite }, async request => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    // Either set an absolute stock level or add a restock amount.
    const input = z.object({
      currentStock: z.coerce.number().int().min(0).optional(),
      restockBy: z.coerce.number().int().min(1).optional(),
      reorderLevel: z.coerce.number().int().min(0).optional(),
    }).superRefine((value, ctx) => {
      if (value.currentStock !== undefined && value.restockBy !== undefined) {
        ctx.addIssue({ code: 'custom', path: ['restockBy'], message: 'Choose either an absolute stock count or a received quantity, not both.' });
      }
    }).parse(request.body);
    const result = await db.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`inventory-update:${request.auth.tenantId}:${id}`})::bigint)`;
      const existing = await tx.inventoryItem.findFirst({ where: { id, tenantId: request.auth.tenantId } });
      if (!existing) throw app.httpErrors.notFound('Inventory item not found');
      assertBranchAccess(request, existing.branchId);
      const nextStock = input.currentStock ?? (input.restockBy ? existing.currentStock + input.restockBy : existing.currentStock);
      const row = await tx.inventoryItem.update({
        where: { id },
        data: { currentStock: nextStock, reorderLevel: input.reorderLevel ?? existing.reorderLevel },
      });
      return { row, from: existing.currentStock, to: nextStock };
    });
    await audit(request, { action: 'inventory.restocked', resource: 'inventoryItem', resourceId: id, metadata: { from: result.from, to: result.to, received: input.restockBy ?? null } });
    return result.row;
  });

  // Partner-report policy: read OWNER/ADMIN/MANAGER/PROVIDER; create preserves
  // OWNER/ADMIN/MANAGER/FRONT_DESK; clinical review is OWNER/ADMIN/PROVIDER only.
  // operations:write does not satisfy any of these clinical guards.
  app.get('/partner-reports', { preHandler: partnerReportRead }, async request => {
    const query = pagedList.extend({ branchId: uuid.optional() }).parse(request.query);
    const rows = await db.partnerReport.findMany({
      where: { tenantId: request.auth.tenantId, branchId: scopedBranch(request, query.branchId) },
      cursor: query.cursor ? { id: query.cursor } : undefined,
      skip: query.cursor ? 1 : 0,
      take: query.limit + 1,
      orderBy: [{ orderedAt: 'desc' }, { id: 'asc' }],
      include: {
        branch: { select: { name: true } },
        patient: { select: { firstName: true, lastName: true } },
        reviewedByUser: { select: { displayName: true } },
      },
    });
    const result = cursorPage(rows, query.limit);
    return query.page === 'true' || query.cursor ? result : result.data;
  });
  app.post('/partner-reports', { preHandler: partnerReportWrite }, async (request, reply) => {
    const input = z.object({
      branchId: uuid, patientId: uuid.optional(), providerRef: z.string().max(120).optional(),
      reportType: z.string().min(2).max(160), partner: z.string().min(2).max(160),
      urgency: z.string().min(2).max(40), status: z.string().min(2).max(60), summary: z.string().max(4000).optional(),
    }).parse(request.body);
    await requireTenantBranch(request, input.branchId);
    if (input.patientId) await requireTenantPatient(request, input.patientId, input.branchId);
    const row = await db.partnerReport.create({ data: { tenantId: request.auth.tenantId, ...input } });
    await audit(request, { action: 'partnerReport.created', resource: 'partnerReport', resourceId: row.id });
    return reply.code(201).send(row);
  });

  app.patch('/partner-reports/:id/review', { preHandler: partnerReportReview }, async request => {
    const params = z.object({ id: uuid }).parse(request.params);
    const body = z.object({
      status: z.literal('doctor-reviewed').default('doctor-reviewed'),
      summary: z.string().max(4000).optional(),
    }).parse(request.body);
    const result = await db.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`partner-report-review:${request.auth.tenantId}:${params.id}`})::bigint)`;
      const row = await tx.partnerReport.findFirst({ where: { id: params.id, tenantId: request.auth.tenantId } });
      if (!row) throw request.server.httpErrors.notFound('Partner report not found');
      if (row.branchId) assertBranchAccess(request, row.branchId);
      const include = {
        branch: { select: { name: true } },
        patient: { select: { firstName: true, lastName: true } },
        reviewedByUser: { select: { displayName: true } },
      } as const;
      if (row.status === 'doctor-reviewed') {
        return { changed: false, row: await tx.partnerReport.findUniqueOrThrow({ where: { id: row.id }, include }) };
      }
      if (row.status !== 'result-received') throw request.server.httpErrors.conflict('Only a received result can be marked clinically reviewed.');
      const updated = await tx.partnerReport.update({
        where: { id: row.id },
        data: { status: body.status, reviewedAt: new Date(), reviewedByUserId: request.auth.userId, summary: body.summary ?? row.summary },
        include,
      });
      return { changed: true, row: updated };
    });
    if (result.changed) await audit(request, { action: 'partnerReport.reviewed', resource: 'partnerReport', resourceId: result.row.id });
    return result.row;
  });

  /**
   * What this clinic can do, in our own words — one row per capability, no
   * supplier named and no environment variable quoted.
   *
   * This replaces `GET /integrations/status`, which served a tenant a
   * seventeen-row supplier catalogue with operating modes, per-vendor health
   * and a missing-configuration count. The catalogue did not disappear; it
   * answers a platform JWT now, at /v1/platform/tenants/:tenantId/providers.
   *
   * Authenticated only, deliberately. The person who needs to know that card
   * payments are not set up is the one standing at the desk trying to take
   * one, and they are rarely an administrator. Nothing here is sensitive: it
   * states a capability and names us as the next step.
   */
  app.get('/capabilities', async () => {
    const insuranceConfigured = env.INSURANCE_PROVIDER === 'mock' || (env.INSURANCE_PROVIDER === 'stedi' && Boolean(env.STEDI_API_KEY));
    const paymentConfigured = env.PAYMENT_PROVIDER === 'mock' || (env.PAYMENT_PROVIDER === 'stripe' && Boolean(env.STRIPE_SECRET_KEY));
    return [
      eligibilityCapability(insuranceConfigured, env.INSURANCE_PROVIDER !== 'stedi' || env.STEDI_TEST_MODE),
      cardPaymentsCapability(paymentConfigured, !env.STRIPE_SECRET_KEY?.startsWith('sk_live_')),
    ];
  });

  // The tenant's own Integration rows. Kept: these are records the workspace
  // owns (a connection it recorded), not our supply chain, and no screen
  // enumerates them as a vendor catalogue any more.
  app.get('/integrations', { preHandler: integrationsRead }, async request => {
    return db.integration.findMany({ where: { tenantId: request.auth.tenantId }, orderBy: { name: 'asc' } });
  });
  app.patch('/integrations/:id', { preHandler: integrationsManage }, async request => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const input = z.object({
      status: z.enum(['CONNECTED', 'DISCONNECTED', 'ERROR', 'COMING_SOON']),
    }).parse(request.body);
    const existing = await db.integration.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!existing) throw app.httpErrors.notFound('Integration not found');
    const row = await db.integration.update({
      where: { id },
      data: { status: input.status, lastSyncAt: input.status === 'CONNECTED' ? new Date() : existing.lastSyncAt },
    });
    await audit(request, { action: 'integration.statusChanged', resource: 'integration', resourceId: id, metadata: { status: input.status } });
    return row;
  });

  // ===== Front desk queue ==================================================
  // Branch visibility (M14): a branch-scoped caller sees their branch AND the
  // unscoped rows, because `createSafetyTask` files a task with branchId null
  // whenever the branch is ambiguous — dropping those would hide exactly the
  // work nobody has claimed. Masking lives in lib/receptionist/taskProjection.
  const csvEnum = <T extends string>(values: readonly T[]) => z.string()
    .transform(value => value.split(',').map(part => part.trim()).filter(Boolean))
    .pipe(z.array(z.enum(values as unknown as [T, ...T[]])).min(1));

  const taskListQuery = z.object({
    cursor: uuid.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    status: csvEnum(['OPEN', 'IN_PROGRESS', 'COMPLETED', 'CANCELED'] as const).optional(),
    workflow: z.string().max(60).optional(),
    kind: csvEnum(RECEPTIONIST_TASK_KINDS).optional(),
    assignee: z.union([z.literal('me'), z.literal('unassigned'), uuid]).optional(),
    branchId: uuid.optional(),
    // D14: in a multi-clinic tenant the Emergencies and Callbacks lanes showed
    // every clinic's work while the three lanes beside them switched with the
    // selector — two scopes on one screen with nothing saying so.
    clinicId: uuid.optional(),
    callLogId: uuid.optional(),
    patientId: uuid.optional(),
    dueBefore: z.coerce.date().optional(),
    acknowledged: z.enum(['true', 'false']).optional(),
    overdue: z.enum(['true']).optional(),
  });

  function taskVisibility(request: FastifyRequest, branchId?: string): Prisma.StaffTaskWhereInput {
    const scope = request.auth.branchId ?? branchId;
    // A null clinic is tenant-wide legacy work, not shared clinic work. Showing
    // it in every branch queue leaked ambiguous tasks across locations.
    return scope ? { branchId: scope } : {};
  }

  /**
   * D14: a task belongs to a clinic either because `createSafetyTask` stamped
   * `metadata.clinicId` or because its source call did. Both are matched, so a
   * pre-C4 row with only a call link is not silently dropped from the lane.
   */
  function clinicFilter(clinicId: string): Prisma.StaffTaskWhereInput {
    return { OR: [
      { metadata: { path: ['clinicId'], equals: clinicId } },
      { callLog: { clinicId } },
    ] };
  }

  function taskFilters(request: FastifyRequest, query: z.infer<typeof taskListQuery>, now: Date): Prisma.StaffTaskWhereInput {
    const kindFilter = query.kind
      ? { OR: query.kind.map(kind => ({ metadata: { path: ['kind'], equals: kind } })) }
      : null;
    return {
      tenantId: request.auth.tenantId,
      ...taskVisibility(request, query.branchId),
      status: { in: query.status ?? ['OPEN', 'IN_PROGRESS'] },
      ...(query.callLogId ? { callLogId: query.callLogId } : {}),
      ...(query.patientId ? { patientId: query.patientId } : {}),
      ...(query.assignee === 'me' ? { assignedToId: request.auth.userId }
        : query.assignee === 'unassigned' ? { assignedToId: null }
          : query.assignee ? { assignedToId: query.assignee } : {}),
      ...(query.acknowledged === 'true' ? { acknowledgedAt: { not: null } }
        : query.acknowledged === 'false' ? { acknowledgedAt: null } : {}),
      ...(query.overdue === 'true' ? { dueAt: { lt: now } } : query.dueBefore ? { dueAt: { lte: query.dueBefore } } : {}),
      AND: [
        ...(query.workflow ? [{ metadata: { path: ['workflow'], equals: query.workflow } }] : []),
        ...(kindFilter ? [kindFilter] : []),
        // In AND, not spread at the top level: `taskVisibility` already owns the
        // top-level `OR` and a second one would silently replace it.
        ...(query.clinicId ? [clinicFilter(query.clinicId)] : []),
      ],
    };
  }

  app.get('/tasks', { preHandler: staffTaskRead }, async request => {
    const query = taskListQuery.parse(request.query);
    const now = new Date();
    const rows = await db.staffTask.findMany({
      where: taskFilters(request, query, now),
      // Soonest-due first; a task with no due date sorts last rather than first.
      orderBy: [{ dueAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }, { id: 'asc' }],
      cursor: query.cursor ? { id: query.cursor } : undefined,
      skip: query.cursor ? 1 : 0,
      take: query.limit + 1,
      include: taskListInclude,
    });
    const permissions = await getRequestPermissions(request);
    const options = {
      canReadArtifacts: permissions.has('receptionist:call-artifacts:read'),
      canReadPatient: permissions.has('patient:read'),
    };
    const page = cursorPage(rows, query.limit);
    await audit(request, { action: 'task.list', resource: 'staffTask', metadata: {
      count: page.data.length, branchScoped: Boolean(request.auth.branchId ?? query.branchId), receptionistDisclosed: options.canReadArtifacts,
    } });
    return { ...page, data: page.data.map(row => projectTaskRow(row, options)) };
  });

  // Counts for the sidebar badge, the critical banner and the queue header.
  // Titles only — no caller content, so it is safe for every staff:read holder.
  //
  // D7: the critical COUNT is a real count(), not the length of the 5-row
  // preview. With 9 unacknowledged emergencies the banner used to say 5 and
  // callers 6-9 stayed invisible until one of the first five was acknowledged.
  // D8: the critical query is scoped to the receptionist workflows and carries
  // `workflow`/`kind` per row, so a critical INSURANCE or OPS task is no longer
  // announced to the front desk as a clinical emergency.
  // D10: 'critical' and 'CRITICAL' both match, so the outbound reconciliation
  // tasks stop being invisible to the one surface staff must be able to trust.
  // D13: the kind histogram is a SQL GROUP BY, not every open row loaded into
  // JS — this is the hottest polled endpoint in the product (20s, every tab).
  app.get('/tasks/summary', { preHandler: staffTaskRead }, async request => {
    const query = z.object({ branchId: uuid.optional(), clinicId: uuid.optional() }).parse(request.query);
    const now = new Date();
    const live = {
      tenantId: request.auth.tenantId,
      ...taskVisibility(request, query.branchId),
      status: { in: ['OPEN', 'IN_PROGRESS'] as const },
    } satisfies Prisma.StaffTaskWhereInput;
    const clinicScope = query.clinicId ? [clinicFilter(query.clinicId)] : [];
    const criticalWhere = {
      ...live,
      acknowledgedAt: null,
      priority: { in: taskPriorityVariants('critical') },
      AND: [
        { OR: RECEPTIONIST_TASK_WORKFLOWS.map(workflow => ({ metadata: { path: ['workflow'], equals: workflow } })) },
        ...clinicScope,
      ],
    } satisfies Prisma.StaffTaskWhereInput;

    const branchScopeId = request.auth.branchId ?? query.branchId ?? null;
    const [kindRows, overdue, mine, dueWithin30m, criticalRows, unacknowledgedCriticalCount] = await Promise.all([
      db.$queryRaw<Array<{ kind: string | null; count: bigint }>>`
        SELECT t."metadata"->>'kind' AS kind, count(*)::bigint AS count
        FROM "StaffTask" t
        ${query.clinicId ? Prisma.sql`LEFT JOIN "ReceptionistCallLog" c ON c."id" = t."callLogId" AND c."tenantId" = t."tenantId"` : Prisma.empty}
        WHERE t."tenantId" = ${request.auth.tenantId}::uuid
          AND t."status" IN ('OPEN', 'IN_PROGRESS')
          AND t."metadata"->>'workflow' = ${RECEPTIONIST_TASK_WORKFLOW}
          ${branchScopeId ? Prisma.sql`AND t."branchId" = ${branchScopeId}::uuid` : Prisma.empty}
          ${query.clinicId ? Prisma.sql`AND (t."metadata"->>'clinicId' = ${query.clinicId} OR c."clinicId" = ${query.clinicId}::uuid)` : Prisma.empty}
        GROUP BY 1
      `,
      db.staffTask.count({ where: { ...live, dueAt: { lt: now } } }),
      db.staffTask.count({ where: { ...live, assignedToId: request.auth.userId } }),
      db.staffTask.count({ where: { ...live, dueAt: { gte: now, lte: new Date(now.getTime() + 30 * 60_000) } } }),
      db.staffTask.findMany({
        where: criticalWhere,
        orderBy: [{ createdAt: 'asc' }],
        take: 5,
        select: {
          id: true, title: true, createdAt: true, metadata: true,
          callLog: { select: { clinic: { select: { id: true, name: true } } } },
        },
      }),
      db.staffTask.count({ where: criticalWhere }),
    ]);

    const openByKind = Object.fromEntries(RECEPTIONIST_TASK_KINDS.map(kind => [kind, 0])) as Record<ReceptionistTaskKind, number>;
    let openNeedsAction = 0;
    for (const row of kindRows) {
      const count = Number(row.count);
      // `parseReceptionistTask` recovers an unrecognised kind as `message`;
      // the histogram must land on the same lane the row itself lands in.
      const kind = (RECEPTIONIST_TASK_KINDS as readonly string[]).includes(row.kind ?? '')
        ? row.kind as ReceptionistTaskKind
        : 'message';
      openByKind[kind] += count;
      openNeedsAction += count;
    }

    return {
      openByKind,
      openNeedsAction,
      overdue,
      mine,
      dueWithin30m,
      unacknowledgedCriticalCount,
      unacknowledgedCritical: criticalRows.map(row => {
        const metadata = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
          ? row.metadata as Record<string, unknown>
          : {};
        const meta = parseReceptionistTask(row);
        return {
          id: row.id,
          title: row.title,
          createdAt: row.createdAt,
          clinicName: row.callLog?.clinic?.name ?? null,
          clinicId: meta?.clinicId ?? row.callLog?.clinic?.id ?? null,
          // Which alert this is. Without them the board announced an outbound
          // reconciliation task in the same red as a chest-pain mention.
          workflow: typeof metadata.workflow === 'string' ? metadata.workflow : null,
          kind: meta?.kind ?? null,
          fixHref: meta?.fixHref ?? null,
          action: meta?.remediationAction ?? null,
        };
      }),
      // D8: which numbers reconcile with which. `openByKind`, `openNeedsAction`
      // and the critical block are receptionist-scoped; the three counters below
      // span every workflow in the tenant, so they will not add up to them.
      counterScope: {
        openByKind: 'receptionist',
        openNeedsAction: 'receptionist',
        unacknowledgedCritical: 'receptionist',
        overdue: 'all_workflows',
        mine: 'all_workflows',
        dueWithin30m: 'all_workflows',
      },
      generatedAt: now.toISOString(),
    };
  });

  app.post('/tasks', { preHandler: staffTaskWrite }, async (request, reply) => {
    const input = z.object({
      branchId: uuid.optional(), assignedToId: uuid.optional(), title: z.string().min(2).max(240),
      priority: z.string().min(2).max(40), dueAt: z.coerce.date().optional(),
    }).parse(request.body);
    const branchId = input.branchId ?? request.auth.branchId;
    if (!branchId) throw app.httpErrors.badRequest('Select a clinic before creating a staff task');
    await requireTenantBranch(request, branchId);
    if (input.assignedToId) await requireTenantAssignee(request, input.assignedToId, branchId);
    // D10: one vocabulary. 'CRITICAL' typed here used to file a row the critical
    // banner could not see.
    const priority = normalizeTaskPriority(input.priority) ?? input.priority;
    // GET /tasks scopes a branch-restricted caller to their own branch, so a task
    // created without one would be invisible to the queue that just created it.
    // Default to the creator's branch rather than filing work nobody can see.
    const row = await db.staffTask.create({
      data: { tenantId: request.auth.tenantId, ...input, priority, branchId },
      include: { branch: { select: { name: true } }, assignedTo: { select: { displayName: true } } },
    });
    await audit(request, { action: 'task.created', resource: 'staffTask', resourceId: row.id, metadata: { assigned: Boolean(row.assignedToId), branchScoped: Boolean(branchId) } });
    return reply.code(201).send(row);
  });

  app.get('/revenue-snapshots', { preHandler: revenueRead }, async request => {
    const query = listLimit.extend({ branchId: uuid.optional() }).parse(request.query);
    return db.revenueSnapshot.findMany({ where: { tenantId: request.auth.tenantId, branchId: scopedBranch(request, query.branchId) }, take: query.limit, orderBy: { period: 'desc' } });
  });

  app.get('/conversations', { preHandler: crmRead }, async request => {
    const query = listLimit.extend({ branchId: uuid.optional() }).parse(request.query);
    const rows = await db.conversation.findMany({
      where: { tenantId: request.auth.tenantId, ...branchScope(request), branchId: scopedBranch(request, query.branchId) },
      take: query.limit,
      orderBy: { updatedAt: 'desc' },
      include: {
        tenant: { select: { name: true } },
        branch: { select: { name: true } },
        patient: { select: { firstName: true, lastName: true, phone: true, email: true } },
      },
    });
    return Promise.all(rows.map(async row => {
      const target = resolveReplyTarget(row.channel, row.patient);
      const destinationFormatValid = isReplyDestinationFormatValid(target);
      const [consent, suppressed, replyAttempts] = await Promise.all([
        target && row.patientId
          ? db.communicationConsent.findFirst({
              where: { tenantId: request.auth.tenantId, patientId: row.patientId, leadId: null, channel: target.channel },
              select: { status: true, source: true, capturedAt: true },
            })
          : null,
        target
          ? isSuppressed(request.auth.tenantId, { patientId: row.patientId, destination: target.destination }, target.channel)
          : true,
        db.conversationReplyAttempt.findMany({
          where: { tenantId: request.auth.tenantId, conversationId: row.id },
          select: { clientAttemptKey: true, phase: true, status: true },
          orderBy: { createdAt: 'desc' },
          take: 30,
        }),
      ]);
      const resultKeys = new Set(replyAttempts.filter(attempt => attempt.phase === 'RESULT').map(attempt => attempt.clientAttemptKey));
      const hasUnresolvedClaim = replyAttempts.some(attempt => attempt.phase === 'SUBMISSION_CLAIM' && !resultKeys.has(attempt.clientAttemptKey));
      const hasUnknownResult = replyAttempts.some(attempt => attempt.phase === 'RESULT' && attempt.status === 'submission_result_unknown');
      const hasProviderEvidencePending = replyAttempts.some(attempt => attempt.phase === 'RESULT' && ['provider_accepted', 'provider_pending'].includes(attempt.status));
      const submissionState = hasUnresolvedClaim || hasUnknownResult
        ? 'submission_result_unknown'
        : hasProviderEvidencePending
          ? 'provider_evidence_pending'
          : 'clear';
      const ready = Boolean(row.patientId && target && destinationFormatValid && !suppressed && submissionState === 'clear');
      const readinessReason = !row.patientId
        ? 'patient_identity_not_linked'
        : !target
          ? 'destination_not_available'
          : !destinationFormatValid
            ? 'destination_format_invalid'
            : suppressed
              ? 'recipient_suppressed'
              : submissionState === 'submission_result_unknown'
                ? 'submission_result_unknown'
                : submissionState === 'provider_evidence_pending'
                  ? 'provider_evidence_pending'
                  : 'ready_for_server_recheck';
      const senderIdentity = row.branch?.name ?? row.tenant.name;
      const publicRow = { ...row, tenant: undefined };
      return {
        ...publicRow,
        patient: row.patient ? { firstName: row.patient.firstName, lastName: row.patient.lastName } : null,
        replyReadiness: {
          channel: target?.channel ?? null,
          destinationMasked: target ? maskDestination(target.destination) : null,
          identityStatus: row.patientId ? 'patient_linked' : 'not_linked',
          destinationSource: target ? 'linked_patient_record' : 'unavailable',
          destinationVerificationStatus: destinationFormatValid ? 'format_verified' : 'not_verified',
          authorizationBasis: row.patientId && target ? 'recorded_inbound_conversation_reply' : 'none',
          explicitConsentStatus: consent?.status ?? 'not_recorded',
          consentSource: consent?.source ?? null,
          consentCapturedAt: consent?.capturedAt.toISOString() ?? null,
          suppressionStatus: !target ? 'not_checked_no_destination' : suppressed ? 'suppressed' : 'not_suppressed',
          submissionState,
          ready,
          readinessReason,
          draftSource: 'rule_based_staff_review_draft',
          senderIdentity,
          channelTerms: OPERATIONAL_REPLY_TERMS,
          channelTermsSource: OPERATIONAL_REPLY_TERMS_SOURCE,
        },
      };
    }));
  });

  // HONEST outbound reply. Previously this fabricated an "AI recovery": it wrote
  // lastAgentMessage + aiHandled:true and set status 'ai-recovered' while sending
  // NOTHING to the patient. Now the reply is actually delivered through the
  // governed comms provider (consent/suppression gate + E.164/email validation).
  // Provider API acceptance is not delivery: until a receipt is ingested, the
  // conversation remains pending and must never inflate recovery metrics.
  const replyResponseInclude = {
    branch: { select: { name: true } },
    patient: { select: { firstName: true, lastName: true } },
  } as const;

  app.post('/conversations/:id/reply', { preHandler: crmWrite }, async (request, reply) => {
    const params = z.object({ id: uuid }).parse(request.params);
    const body = z.object({
      message: z.string().trim().min(1).max(2000),
      status: z.enum(['replied', 'escalated']).default('replied'),
      clientAttemptKey: uuid.optional(),
    }).parse(request.body);
    const row = await db.conversation.findFirst({
      where: { id: params.id, tenantId: request.auth.tenantId },
      include: {
        tenant: { select: { name: true } },
        branch: { select: { name: true } },
        patient: { select: { id: true, phone: true, email: true } },
      },
    });
    if (!row) throw request.server.httpErrors.notFound('Conversation not found');
    if (row.branchId) assertBranchAccess(request, row.branchId);

    // Escalation is an internal hand-off to a human — never an outbound patient
    // message, so it must not send and must not inflate AI-recovery metrics.
    if (body.status === 'escalated') {
      // "Escalated to a human" previously only rewrote the conversation's own
      // status string; no human was ever told. The hand-off now lands a real
      // StaffTask in the same transaction, so the message below is true.
      const escalation = await runWithTenantContext(request.auth.tenantId, async tx => {
        const handoff = await ensureStaffTask(tx, {
          tenantId: request.auth.tenantId,
          branchId: row.branchId,
          title: `Escalated ${row.channel.toLowerCase()} conversation needs a human reply`,
          priority: 'high',
          dueAt: new Date(Date.now() + 4 * 3_600_000),
          origin: { workflow: 'conversation_escalation', entityType: 'conversation', entityId: row.id },
          context: { channel: row.channel, patientId: row.patientId },
        });
        const conversation = await tx.conversation.update({
          where: { id: row.id },
          data: { status: 'escalated' },
          include: replyResponseInclude,
        });
        await tx.auditEvent.create({ data: {
          tenantId: request.auth.tenantId, actorUserId: request.auth.userId,
          action: 'conversation.escalated', resource: 'conversation', resourceId: row.id,
          requestId: request.id, ipAddress: request.ip, userAgent: request.headers['user-agent'],
          metadata: { taskId: handoff.task.id, taskCreated: handoff.created },
        } });
        return { conversation, handoff };
      });
      return reply.send({
        conversation: escalation.conversation, delivered: false, deliveryStatus: 'escalated', providerMode: null,
        task: escalation.handoff.task, taskCreated: escalation.handoff.created,
        message: escalation.handoff.created
          ? 'Escalated to a human: a task was created in Staff Tasks. No patient message was sent.'
          : 'Escalated to a human: an open task for this conversation already exists in Staff Tasks. No patient message was sent.',
      });
    }

    if (!body.clientAttemptKey) {
      throw request.server.httpErrors.badRequest('A durable clientAttemptKey is required for an outbound reply');
    }
    const target = resolveReplyTarget(row.channel, row.patient);
    if (!row.patientId || !target) {
      return reply.code(409).send({
        accepted: false, delivered: false, deliveryStatus: 'no_contact', providerMode: null,
        message: 'Submission blocked: no linked patient destination is available.',
      });
    }
    if (!isReplyDestinationFormatValid(target)) {
      return reply.code(409).send({
        accepted: false, delivered: false, deliveryStatus: 'invalid_destination', providerMode: null,
        message: 'Submission blocked: the linked patient destination is not valid for this channel.',
      });
    }

    // Sender identity and subject are derived only from canonical tenant data;
    // reviewed drafts cannot invent an organization identity or channel terms.
    const senderIdentity = row.branch?.name ?? row.tenant.name;
    const subject = `Message from ${senderIdentity}`;
    const evidence = {
      tenantId: request.auth.tenantId,
      conversationId: row.id,
      actorUserId: request.auth.userId,
      clientAttemptKey: body.clientAttemptKey,
      channel: target.channel,
      destinationMasked: maskDestination(target.destination) ?? '****',
      messageHash: evidenceHash(body.message),
      subjectHash: evidenceHash(subject),
      senderIdentityHash: evidenceHash(senderIdentity),
    };

    const claim = await runWithTenantContext(request.auth.tenantId, async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`conversation-reply:${request.auth.tenantId}:${row.id}`})::bigint)`;
      const attempts = await tx.conversationReplyAttempt.findMany({
        where: { tenantId: request.auth.tenantId, conversationId: row.id },
        orderBy: { createdAt: 'asc' },
      });
      const sameAttempt = attempts.filter(attempt => attempt.clientAttemptKey === body.clientAttemptKey);
      const sameResult = sameAttempt.find(attempt => attempt.phase === 'RESULT');
      const matchesEvidence = sameAttempt.every(attempt =>
        attempt.channel === evidence.channel
        && attempt.destinationMasked === evidence.destinationMasked
        && attempt.messageHash === evidence.messageHash
        && attempt.subjectHash === evidence.subjectHash
        && attempt.senderIdentityHash === evidence.senderIdentityHash,
      );
      if (sameAttempt.length > 0 && !matchesEvidence) return { kind: 'conflict' as const };
      if (sameResult) return { kind: 'replay' as const, result: sameResult };

      const resultKeys = new Set(attempts.filter(attempt => attempt.phase === 'RESULT').map(attempt => attempt.clientAttemptKey));
      const hasDanglingClaim = attempts.some(attempt => attempt.phase === 'SUBMISSION_CLAIM' && !resultKeys.has(attempt.clientAttemptKey));
      const hasUnknownResult = attempts.some(attempt => attempt.phase === 'RESULT' && attempt.status === 'submission_result_unknown');
      if (hasDanglingClaim || hasUnknownResult || sameAttempt.length > 0) return { kind: 'unknown' as const };
      const hasProviderEvidencePending = attempts.some(attempt =>
        attempt.phase === 'RESULT' && ['provider_accepted', 'provider_pending'].includes(attempt.status),
      );
      if (hasProviderEvidencePending) return { kind: 'provider_pending' as const };

      const completedAt = new Date();
      await tx.conversationReplyAttempt.create({ data: {
        ...evidence, phase: 'INTENT', status: 'authorized', completedAt,
      } });
      await tx.conversationReplyAttempt.create({ data: {
        ...evidence, phase: 'SUBMISSION_CLAIM', status: 'submission_claimed', completedAt,
      } });
      return { kind: 'claimed' as const };
    });

    if (claim.kind === 'conflict') {
      return reply.code(409).send({
        accepted: false, delivered: false, deliveryStatus: 'attempt_conflict', providerMode: null,
        message: 'This attempt key is already bound to different reviewed content. Nothing was submitted.',
      });
    }
    if (claim.kind === 'unknown') {
      return reply.code(409).send({
        accepted: false, delivered: false, deliveryStatus: 'submission_result_unknown', providerMode: null,
        message: 'Submission result unknown. Retrying is blocked until provider evidence is reconciled.',
      });
    }
    if (claim.kind === 'provider_pending') {
      return reply.code(409).send({
        accepted: false, delivered: false, deliveryStatus: 'provider_evidence_pending', providerMode: null,
        message: 'A prior submission is awaiting provider or delivery evidence. A duplicate request is blocked.',
      });
    }
    if (claim.kind === 'replay') {
      const conversation = await db.conversation.findFirst({ where: { id: row.id, tenantId: request.auth.tenantId }, include: replyResponseInclude });
      return reply.send({ conversation, ...durableReplyPayload(claim.result), replayed: true });
    }

    let send: SendResult;
    try {
      const suppressed = await isSuppressed(
        request.auth.tenantId,
        { patientId: row.patientId, destination: target.destination },
        target.channel,
      );
      send = suppressed
        ? { ok: false, status: 'suppressed', mode: 'suppressed', failureReason: 'suppressed_or_opted_out' }
        : await sendMessage(
            target.channel,
            target.destination,
            subject,
            body.message,
            `conv-reply-${request.auth.tenantId}-${row.id}-${body.clientAttemptKey}`,
            { tenantId: request.auth.tenantId, patientId: row.patientId },
          );
    } catch {
      send = { ok: false, status: 'failed', mode: 'configured_pending_provider', failureReason: 'submission_result_unknown' };
    }

    const resultStatus = send.failureReason === 'submission_result_unknown' || send.failureReason?.startsWith('transport_ambiguous:')
      ? 'submission_result_unknown'
      : send.ok && send.status === 'sent'
        ? 'provider_accepted'
        : send.status === 'pending'
          ? 'provider_pending'
          : send.status === 'suppressed'
            ? 'suppressed'
            : 'provider_rejected';
    const failureCode = resultStatus === 'submission_result_unknown'
      ? 'provider_submission_ambiguous'
      : resultStatus === 'provider_rejected'
        ? send.status === 'setup_required' ? 'provider_setup_required' : 'provider_rejected'
        : resultStatus === 'suppressed' ? 'recipient_suppressed' : null;

    try {
      const persisted = await runWithTenantContext(request.auth.tenantId, async tx => {
        const result = await tx.conversationReplyAttempt.create({ data: {
          ...evidence,
          phase: 'RESULT',
          status: resultStatus,
          providerMode: send.mode,
          providerMessageId: send.providerMessageId ?? null,
          failureCode,
          completedAt: new Date(),
        } });
        const conversation = resultStatus === 'provider_accepted'
          ? await tx.conversation.update({
              where: { id: row.id },
              data: { lastAgentMessage: body.message, lastAgentMessageAt: new Date(), status: 'pending', aiHandled: false },
              include: replyResponseInclude,
            })
          : await tx.conversation.findFirst({ where: { id: row.id, tenantId: request.auth.tenantId }, include: replyResponseInclude });
        await tx.auditEvent.create({ data: {
          tenantId: request.auth.tenantId,
          actorUserId: request.auth.userId,
          action: resultStatus === 'provider_accepted' ? 'conversation.replyProviderAccepted' : 'conversation.replySubmissionResult',
          resource: 'conversation',
          resourceId: row.id,
          requestId: request.id,
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'],
          metadata: {
            accepted: resultStatus === 'provider_accepted', delivered: false, resultStatus,
            channel: target.channel, providerMode: send.mode, providerMessageId: send.providerMessageId ?? null,
            attemptId: result.id, channelTerms: OPERATIONAL_REPLY_TERMS, channelTermsSource: OPERATIONAL_REPLY_TERMS_SOURCE,
          },
        } });
        return { conversation, result };
      });
      return reply.send({ conversation: persisted.conversation, ...durableReplyPayload(persisted.result) });
    } catch {
      // The immutable claim was committed before provider I/O. If result
      // persistence is uncertain, never retry or degrade this to normal failure.
      return reply.code(409).send({
        accepted: false, delivered: false, deliveryStatus: 'submission_result_unknown', providerMode: send.mode,
        message: 'Submission result unknown. Retrying is blocked until provider evidence is reconciled.',
      });
    }
  });

  // ===== AI-ready operational briefing (RULE-BASED — no LLM) ===============
  // Real data only: pending requests, unpaid deposits, failed/expired payments,
  // receptionist handoffs, revenue alerts/tasks, and top rule-based recs.
  // Aggregate-sensitive grant: this response intentionally combines counts from
  // appointments, payments, receptionist, insurance, CRM, and intake. It is not
  // available merely because a caller has one narrower read permission.
  app.get('/briefing', { preHandler: operationsRead }, async request => {
    const tenantId = request.auth.tenantId;
    const [
      appointmentRequestsPending, receptionistHandoffPending, unpaidDeposits,
      failedPayments, expiredPayments, revenueAlertsOpen, openTasks, recommendations, openSignals,
      insuranceGaps, priorAuthAttention, highResponsibilityEstimates, ineligibleVerifications,
      inactivePatients, noShowRecoveryCandidates, reviewRequestOpportunities, campaignDeliveryFailures, pendingCampaignApprovals,
      intakePacketsPending, intakePacketsNeedingReview, intakeConsentMissing, intakeInsuranceCardReview, intakeEstimateAckMissing, intakeHighRiskGaps,
    ] = await Promise.all([
      db.appointmentRequest.count({ where: { tenantId, status: 'PENDING_REVIEW' } }),
      db.appointmentRequest.count({ where: { tenantId, source: 'ai_receptionist', status: { in: ['PENDING_REVIEW', 'MISSING_INFO'] } } }),
      db.depositRequirement.count({ where: { tenantId, status: { in: ['required', 'requested', 'link_sent'] } } }),
      db.paymentRequest.count({ where: { tenantId, status: 'failed' } }),
      db.paymentRequest.count({ where: { tenantId, status: 'expired' } }),
      runWithTenantContext(tenantId, tx => tx.revenueProtectionAlert.count({ where: { tenantId, status: 'open' } })),
      db.staffTask.count({ where: { tenantId, status: 'OPEN' } }),
      db.aIRecommendation.findMany({ where: { tenantId, status: 'pending' }, orderBy: [{ confidence: 'desc' }, { createdAt: 'desc' }], take: 8 }),
      db.operationalSignal.count({ where: { tenantId, status: 'open' } }),
      // Insurance gaps surfaced to the briefing — real data only.
      db.operationalSignal.count({ where: { tenantId, status: 'open', signalType: 'denial_risk' } }),
      db.priorAuthorization.count({ where: { tenantId, status: { in: ['required', 'pending', 'denied', 'expired'] } } }),
      db.patientResponsibilityEstimate.count({ where: { tenantId, estimatedPatientResponsibility: { gte: 200 } } }),
      db.eligibilityVerification.count({ where: { tenantId, coverageActive: false } }),
      // CRM campaign opportunities — real data only.
      db.patient.count({ where: { tenantId, deletedAt: null, lifecycleStage: { not: 'LOST' }, OR: [{ lastVisitAt: { lt: new Date(Date.now() - 180 * 86400000) } }, { lastVisitAt: null, createdAt: { lt: new Date(Date.now() - 180 * 86400000) } }] } }),
      db.appointment.count({ where: { tenantId, status: 'NO_SHOW', deletedAt: null } }),
      db.appointment.count({ where: { tenantId, status: 'COMPLETED', deletedAt: null } }),
      db.campaignDelivery.count({ where: { tenantId, status: 'failed' } }),
      db.campaign.count({ where: { tenantId, campaignType: { not: null }, requiresApproval: true, approvedByUserId: null, status: { in: ['DRAFT', 'APPROVAL_REQUIRED'] } } }),
      // Patient intake gaps — real counts only.
      db.patientIntakePacket.count({ where: { tenantId, status: { in: ['draft', 'sent', 'in_progress'] } } }),
      db.patientIntakePacket.count({ where: { tenantId, status: { in: ['submitted', 'needs_review'] } } }),
      db.operationalSignal.count({ where: { tenantId, status: 'open', signalType: 'consent_missing' } }),
      db.operationalSignal.count({ where: { tenantId, status: 'open', signalType: 'insurance_card_missing' } }),
      db.operationalSignal.count({ where: { tenantId, status: 'open', signalType: 'estimate_ack_missing' } }),
      db.operationalSignal.count({ where: { tenantId, status: 'open', signalType: { in: ['previsit_risk', 'intake_needs_review'] } } }),
    ]);
    // Appointments tomorrow with no intake packet (real diff — no intake relation on Appointment).
    const tomorrowStart = new Date(Date.now() + 86400000); const tomorrowEnd = new Date(Date.now() + 2 * 86400000);
    const tomorrowAppts = await db.appointment.findMany({ where: { tenantId, deletedAt: null, status: { notIn: ['CANCELED', 'NO_SHOW', 'COMPLETED'] }, startsAt: { gte: tomorrowStart, lt: tomorrowEnd } }, select: { id: true } });
    let appointmentsTomorrowMissingIntake = 0;
    if (tomorrowAppts.length > 0) {
      const withIntake = new Set((await db.patientIntakePacket.findMany({ where: { tenantId, appointmentId: { in: tomorrowAppts.map(a => a.id) } }, select: { appointmentId: true } })).map(p => p.appointmentId));
      appointmentsTomorrowMissingIntake = tomorrowAppts.filter(a => !withIntake.has(a.id)).length;
    }
    return {
      label: 'Rule-based morning briefing',
      generatedAt: new Date().toISOString(),
      aiProviderConfigured: env.AI_PROVIDER !== 'mock',
      summary: {
        appointmentRequestsPending,
        receptionistHandoffPending,
        unpaidDeposits,
        failedPayments,
        expiredPayments,
        revenueAlertsOpen,
        openTasks,
        openSignals,
        insuranceGaps,
        priorAuthAttention,
        highResponsibilityEstimates,
        ineligibleVerifications,
        inactivePatients,
        noShowRecoveryCandidates,
        reviewRequestOpportunities,
        unpaidDepositFollowupCandidates: unpaidDeposits,
        appointmentRequestFollowupCandidates: appointmentRequestsPending,
        campaignDeliveryFailures,
        pendingCampaignApprovals,
        intakePacketsPending,
        intakePacketsNeedingReview,
        appointmentsTomorrowMissingIntake,
        intakeConsentMissing,
        intakeInsuranceCardReview,
        intakeEstimateAckMissing,
        intakeHighRiskGaps,
      },
      // Reports 360 hooks (lightweight pre-visit readiness summary — real data only).
      reports360Hooks: {
        intakePending: intakePacketsPending,
        intakeNeedingReview: intakePacketsNeedingReview,
        appointmentsTomorrowMissingIntake,
        consentMissing: intakeConsentMissing,
        insuranceCardReview: intakeInsuranceCardReview,
        estimateAckMissing: intakeEstimateAckMissing,
        preVisitHighRiskGaps: intakeHighRiskGaps,
      },
      topRecommendations: recommendations.map(r => ({
        id: r.id, title: r.title, recommendationType: r.recommendationType, reason: r.reason,
        expectedImpact: r.expectedImpact, confidence: r.confidence, requiresHumanReview: r.requiresHumanReview,
        allowedActionType: r.allowedActionType, createdBy: r.createdBy, status: r.status,
        deepLinkTarget: `recommendation/${r.id}`,
      })),
    };
  });

  // ===== Operational signals + AI recommendations (read + triage) =========
  app.get('/signals', { preHandler: operationsRead }, async request => {
    const query = z.object({ status: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).default(100) }).parse(request.query);
    return db.operationalSignal.findMany({ where: { tenantId: request.auth.tenantId, ...(query.status ? { status: query.status } : {}) }, orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }], take: query.limit });
  });

  app.get('/recommendations', { preHandler: operationsRead }, async request => {
    const query = z.object({ status: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).default(100) }).parse(request.query);
    return db.aIRecommendation.findMany({ where: { tenantId: request.auth.tenantId, ...(query.status ? { status: query.status } : {}) }, orderBy: [{ confidence: 'desc' }, { createdAt: 'desc' }], take: query.limit });
  });

  app.patch('/recommendations/:id', { preHandler: operationsWrite }, async request => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const input = z.object({ status: z.enum(['pending', 'accepted', 'rejected', 'executed', 'dismissed']) }).parse(request.body);
    const existing = await db.aIRecommendation.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!existing) throw app.httpErrors.notFound('Recommendation not found');
    const row = await db.aIRecommendation.update({ where: { id }, data: { status: input.status } });
    await audit(request, { action: 'aiRecommendation.statusChanged', resource: 'aiRecommendation', resourceId: id, metadata: { status: input.status } });
    return row;
  });

  app.patch('/signals/:id', { preHandler: operationsWrite }, async request => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const input = z.object({ status: z.enum(['open', 'acknowledged', 'resolved', 'dismissed']) }).parse(request.body);
    const existing = await db.operationalSignal.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!existing) throw app.httpErrors.notFound('Signal not found');
    const row = await db.operationalSignal.update({ where: { id }, data: { status: input.status } });
    await audit(request, { action: 'operationalSignal.statusChanged', resource: 'operationalSignal', resourceId: id, metadata: { status: input.status } });
    return row;
  });
};
