import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { db } from '../../lib/db';
import { audit } from '../../lib/audit';
import { assertBranchAccess, branchScope } from '../../lib/scope';
import { requireRoles } from '../../plugins/roles';

const channel = z.enum(['WHATSAPP', 'SMS', 'EMAIL', 'PUSH', 'CALL', 'VIDEO']);
const uuid = z.string().uuid();
const listLimit = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) });
const writeRoles = requireRoles('OWNER', 'ADMIN', 'MANAGER', 'FRONT_DESK');
const adminRoles = requireRoles('OWNER', 'ADMIN', 'MANAGER');

function scopedBranch(request: FastifyRequest, branchId?: string) {
  return request.auth.branchId ?? branchId;
}

export const operationsRoutes: FastifyPluginAsync = async app => {
  app.get('/competitors/radar', async request => {
    const query = listLimit.extend({ branchId: uuid.optional() }).parse(request.query);
    return db.competitor.findMany({
      where: { tenantId: request.auth.tenantId, branchId: scopedBranch(request, query.branchId) },
      take: query.limit,
      orderBy: [{ googleRating: 'asc' }, { reviewVolume: 'desc' }],
      include: { branch: { select: { name: true } }, insights: { orderBy: { complaintCount: 'desc' } } },
    });
  });

  app.get('/reputation', async request => {
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

  app.get('/revenue-leaks', async request => {
    const query = listLimit.extend({ branchId: uuid.optional() }).parse(request.query);
    return db.revenueLeak.findMany({
      where: { tenantId: request.auth.tenantId, branchId: scopedBranch(request, query.branchId) },
      take: query.limit,
      orderBy: { createdAt: 'desc' },
      include: { branch: { select: { name: true } }, ownerUser: { select: { displayName: true } }, patient: { select: { firstName: true, lastName: true } } },
    });
  });

  app.get('/opportunities', async request => {
    const query = listLimit.extend({ branchId: uuid.optional() }).parse(request.query);
    return db.opportunity.findMany({
      where: { tenantId: request.auth.tenantId, branchId: scopedBranch(request, query.branchId) },
      take: query.limit,
      orderBy: { createdAt: 'desc' },
      include: { branch: { select: { name: true } }, ownerUser: { select: { displayName: true } }, patient: { select: { firstName: true, lastName: true } } },
    });
  });

  app.get('/leads', async request => {
    const { limit } = listLimit.parse(request.query);
    return db.lead.findMany({ where: { tenantId: request.auth.tenantId }, take: limit, orderBy: { createdAt: 'desc' } });
  });
  app.post('/leads', { preHandler: writeRoles }, async (request, reply) => {
    const input = z.object({
      patientId: uuid.optional(), name: z.string().min(2).max(160), phone: z.string().max(40).optional(),
      email: z.string().email().optional(), channel, service: z.string().min(2).max(160),
      stage: z.string().min(2).max(40), source: z.string().min(2).max(120), estimatedValue: z.coerce.number().min(0).default(0),
    }).parse(request.body);
    const row = await db.lead.create({ data: { tenantId: request.auth.tenantId, ...input } });
    await audit(request, { action: 'lead.created', resource: 'lead', resourceId: row.id });
    return reply.code(201).send(row);
  });
  app.patch('/leads/:id', { preHandler: writeRoles }, async request => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const input = z.object({
      stage: z.string().min(2).max(40).optional(),
      estimatedValue: z.coerce.number().min(0).optional(),
    }).parse(request.body);
    const existing = await db.lead.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!existing) throw app.httpErrors.notFound('Lead not found');
    const row = await db.lead.update({ where: { id }, data: input });
    await audit(request, { action: 'lead.updated', resource: 'lead', resourceId: id, metadata: input });
    return row;
  });

  app.get('/campaigns', async request => {
    const { limit } = listLimit.parse(request.query);
    return db.campaign.findMany({ where: { tenantId: request.auth.tenantId }, take: limit, orderBy: { createdAt: 'desc' } });
  });
  app.post('/campaigns', { preHandler: adminRoles }, async (request, reply) => {
    const input = z.object({
      name: z.string().min(2).max(160), goal: z.string().min(2).max(300),
      status: z.enum(['DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'SCHEDULED']).default('DRAFT'),
      channels: z.array(channel).min(1), audienceSize: z.coerce.number().int().min(0).default(0),
      aiGenerated: z.boolean().default(false), startsAt: z.coerce.date().optional(), endsAt: z.coerce.date().optional(),
    }).parse(request.body);
    const row = await db.campaign.create({ data: { tenantId: request.auth.tenantId, ...input } });
    await audit(request, { action: 'campaign.created', resource: 'campaign', resourceId: row.id });
    return reply.code(201).send(row);
  });
  app.patch('/campaigns/:id', { preHandler: adminRoles }, async request => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const input = z.object({
      status: z.enum(['DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'SCHEDULED']).optional(),
      name: z.string().min(2).max(160).optional(),
      goal: z.string().min(2).max(300).optional(),
    }).parse(request.body);
    const existing = await db.campaign.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!existing) throw app.httpErrors.notFound('Campaign not found');
    const row = await db.campaign.update({ where: { id }, data: input });
    await audit(request, { action: 'campaign.updated', resource: 'campaign', resourceId: id, metadata: input });
    return row;
  });

  app.get('/reviews', async request => {
    const query = listLimit.extend({ branchId: uuid.optional() }).parse(request.query);
    return db.review.findMany({ where: { tenantId: request.auth.tenantId, branchId: scopedBranch(request, query.branchId) }, take: query.limit, orderBy: { createdAt: 'desc' } });
  });
  app.post('/reviews', { preHandler: writeRoles }, async (request, reply) => {
    const input = z.object({
      patientId: uuid.optional(), branchId: uuid.optional(), rating: z.coerce.number().int().min(1).max(5),
      text: z.string().min(1).max(4000), platform: z.string().min(2).max(80), sentiment: z.string().min(2).max(40),
    }).parse(request.body);
    if (input.branchId) assertBranchAccess(request, input.branchId);
    const row = await db.review.create({ data: { tenantId: request.auth.tenantId, ...input } });
    await audit(request, { action: 'review.created', resource: 'review', resourceId: row.id });
    return reply.code(201).send(row);
  });
  app.patch('/reviews/:id/respond', { preHandler: writeRoles }, async request => {
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

  app.get('/inventory', async request => {
    const query = listLimit.extend({ branchId: uuid.optional() }).parse(request.query);
    return db.inventoryItem.findMany({ where: { tenantId: request.auth.tenantId, branchId: scopedBranch(request, query.branchId) }, take: query.limit, orderBy: { name: 'asc' } });
  });
  app.post('/inventory', { preHandler: adminRoles }, async (request, reply) => {
    const input = z.object({
      branchId: uuid, name: z.string().min(2).max(160), category: z.string().min(2).max(100),
      currentStock: z.coerce.number().int().min(0), unit: z.string().min(1).max(40), reorderLevel: z.coerce.number().int().min(0),
      expiryDate: z.coerce.date().optional(), unitCost: z.coerce.number().min(0), usagePerWeek: z.coerce.number().int().min(0), supplier: z.string().min(2).max(160),
    }).parse(request.body);
    assertBranchAccess(request, input.branchId);
    const row = await db.inventoryItem.create({ data: { tenantId: request.auth.tenantId, ...input } });
    await audit(request, { action: 'inventory.created', resource: 'inventoryItem', resourceId: row.id });
    return reply.code(201).send(row);
  });
  app.patch('/inventory/:id', { preHandler: writeRoles }, async request => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    // Either set an absolute stock level or add a restock amount.
    const input = z.object({
      currentStock: z.coerce.number().int().min(0).optional(),
      restockBy: z.coerce.number().int().min(1).optional(),
      reorderLevel: z.coerce.number().int().min(0).optional(),
    }).parse(request.body);
    const existing = await db.inventoryItem.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!existing) throw app.httpErrors.notFound('Inventory item not found');
    assertBranchAccess(request, existing.branchId);
    const nextStock = input.currentStock ?? (input.restockBy ? existing.currentStock + input.restockBy : existing.currentStock);
    const row = await db.inventoryItem.update({
      where: { id },
      data: { currentStock: nextStock, reorderLevel: input.reorderLevel ?? existing.reorderLevel },
    });
    await audit(request, { action: 'inventory.restocked', resource: 'inventoryItem', resourceId: id, metadata: { from: existing.currentStock, to: nextStock } });
    return row;
  });

  app.get('/partner-reports', async request => {
    const query = listLimit.extend({ branchId: uuid.optional() }).parse(request.query);
    return db.partnerReport.findMany({
      where: { tenantId: request.auth.tenantId, branchId: scopedBranch(request, query.branchId) },
      take: query.limit,
      orderBy: { orderedAt: 'desc' },
      include: {
        branch: { select: { name: true } },
        patient: { select: { firstName: true, lastName: true } },
        reviewedByUser: { select: { displayName: true } },
      },
    });
  });
  app.post('/partner-reports', { preHandler: writeRoles }, async (request, reply) => {
    const input = z.object({
      branchId: uuid, patientId: uuid.optional(), providerRef: z.string().max(120).optional(),
      reportType: z.string().min(2).max(160), partner: z.string().min(2).max(160),
      urgency: z.string().min(2).max(40), status: z.string().min(2).max(60), summary: z.string().max(4000).optional(),
    }).parse(request.body);
    assertBranchAccess(request, input.branchId);
    const row = await db.partnerReport.create({ data: { tenantId: request.auth.tenantId, ...input } });
    await audit(request, { action: 'partnerReport.created', resource: 'partnerReport', resourceId: row.id });
    return reply.code(201).send(row);
  });

  app.patch('/partner-reports/:id/review', { preHandler: writeRoles }, async request => {
    const params = z.object({ id: uuid }).parse(request.params);
    const body = z.object({
      status: z.enum(['ordered', 'sample-collected', 'pending-result', 'result-received', 'doctor-reviewed']).default('doctor-reviewed'),
      summary: z.string().max(4000).optional(),
    }).parse(request.body);
    const row = await db.partnerReport.findFirst({ where: { id: params.id, tenantId: request.auth.tenantId } });
    if (!row) throw request.server.httpErrors.notFound('Partner report not found');
    if (row.branchId) assertBranchAccess(request, row.branchId);
    const updated = await db.partnerReport.update({
      where: { id: row.id },
      data: {
        status: body.status,
        reviewedAt: new Date(),
        reviewedByUserId: request.auth.userId,
        summary: body.summary ?? row.summary,
      },
      include: {
        branch: { select: { name: true } },
        patient: { select: { firstName: true, lastName: true } },
        reviewedByUser: { select: { displayName: true } },
      },
    });
    await audit(request, { action: 'partnerReport.reviewed', resource: 'partnerReport', resourceId: row.id });
    return updated;
  });

  app.get('/integrations', async request => {
    return db.integration.findMany({ where: { tenantId: request.auth.tenantId }, orderBy: { name: 'asc' } });
  });
  app.patch('/integrations/:id', { preHandler: adminRoles }, async request => {
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

  app.get('/tasks', async request => {
    const query = listLimit.extend({ branchId: uuid.optional() }).parse(request.query);
    const branchId = scopedBranch(request, query.branchId);
    return db.staffTask.findMany({
      where: { tenantId: request.auth.tenantId, branchId },
      take: query.limit,
      orderBy: { createdAt: 'desc' },
      include: {
        branch: { select: { name: true } },
        assignedTo: { select: { displayName: true } },
      },
    });
  });
  app.post('/tasks', { preHandler: adminRoles }, async (request, reply) => {
    const input = z.object({
      branchId: uuid.optional(), assignedToId: uuid.optional(), title: z.string().min(2).max(240),
      priority: z.string().min(2).max(40), dueAt: z.coerce.date().optional(),
    }).parse(request.body);
    if (input.branchId) assertBranchAccess(request, input.branchId);
    const row = await db.staffTask.create({ data: { tenantId: request.auth.tenantId, ...input } });
    await audit(request, { action: 'task.created', resource: 'staffTask', resourceId: row.id });
    return reply.code(201).send(row);
  });

  app.get('/revenue-snapshots', async request => {
    const query = listLimit.extend({ branchId: uuid.optional() }).parse(request.query);
    return db.revenueSnapshot.findMany({ where: { tenantId: request.auth.tenantId, branchId: scopedBranch(request, query.branchId) }, take: query.limit, orderBy: { period: 'desc' } });
  });

  app.get('/conversations', async request => {
    const query = listLimit.extend({ branchId: uuid.optional() }).parse(request.query);
    return db.conversation.findMany({
      where: { tenantId: request.auth.tenantId, ...branchScope(request), branchId: scopedBranch(request, query.branchId) },
      take: query.limit,
      orderBy: { updatedAt: 'desc' },
      include: {
        branch: { select: { name: true } },
        patient: { select: { firstName: true, lastName: true } },
      },
    });
  });

  app.post('/conversations/:id/reply', { preHandler: writeRoles }, async (request, reply) => {
    const params = z.object({ id: uuid }).parse(request.params);
    const body = z.object({
      message: z.string().min(1).max(2000),
      status: z.enum(['replied', 'ai-recovered', 'escalated', 'pending']).default('replied'),
    }).parse(request.body);
    const row = await db.conversation.findFirst({ where: { id: params.id, tenantId: request.auth.tenantId } });
    if (!row) throw request.server.httpErrors.notFound('Conversation not found');
    if (row.branchId) assertBranchAccess(request, row.branchId);
    const updated = await db.conversation.update({
      where: { id: row.id },
      data: {
        latestMessage: row.latestMessage,
        lastAgentMessage: body.message,
        lastAgentMessageAt: new Date(),
        status: body.status,
        aiHandled: true,
      },
      include: {
        branch: { select: { name: true } },
        patient: { select: { firstName: true, lastName: true } },
      },
    });
    await audit(request, { action: 'conversation.replied', resource: 'conversation', resourceId: row.id });
    return reply.send(updated);
  });
};
