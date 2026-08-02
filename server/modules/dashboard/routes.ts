import type { FastifyPluginAsync } from 'fastify';
import { db } from '../../lib/db';
import { branchScope } from '../../lib/scope';

export const dashboardRoutes: FastifyPluginAsync = async app => {
  app.get('/dashboard/summary', async request => {
    const now = new Date();
    const dayStart = new Date(now);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayEnd.getDate() + 1);
    const scope = branchScope(request);

    const [
      snapshot,
      activeCustomers,
      todaysAppointments,
      noShowRisk,
      staffCallReplyConversations,
      missedCalls,
      leadOpportunity,
      conversationOpportunity,
      pendingApprovals,
    ] = await Promise.all([
      db.revenueSnapshot.findFirst({
        where: { tenantId: request.auth.tenantId, branchId: request.auth.branchId ?? null },
        orderBy: { period: 'desc' },
      }),
      db.patient.count({
        where: { tenantId: request.auth.tenantId, ...scope, deletedAt: null, lifecycleStage: { in: ['ACTIVE', 'RETAINED'] } },
      }),
      db.appointment.count({
        where: { tenantId: request.auth.tenantId, ...scope, deletedAt: null, startsAt: { gte: dayStart, lt: dayEnd } },
      }),
      db.appointment.count({
        where: { tenantId: request.auth.tenantId, ...scope, deletedAt: null, startsAt: { gte: dayStart, lt: dayEnd }, status: { in: ['RISKY', 'NO_SHOW'] } },
      }),
      db.conversationReplyAttempt.findMany({
        where: {
          tenantId: request.auth.tenantId,
          phase: 'RESULT',
          status: { in: ['provider_accepted', 'delivered'] },
          conversation: { is: { channel: 'CALL', ...scope } },
        },
        select: { conversationId: true },
        distinct: ['conversationId'],
      }),
      db.conversation.count({
        where: { tenantId: request.auth.tenantId, ...scope, channel: 'CALL', status: 'unread' },
      }),
      db.lead.aggregate({
        where: { tenantId: request.auth.tenantId },
        _sum: { estimatedValue: true },
      }),
      db.conversation.aggregate({
        where: { tenantId: request.auth.tenantId, ...scope, status: 'unread' },
        _sum: { estimatedValue: true },
      }),
      db.autopilotApproval.count({
        where: { tenantId: request.auth.tenantId, status: 'PENDING' },
      }),
    ]);

    return {
      generatedAt: now.toISOString(),
      networkRevenue: Number(snapshot?.revenue ?? 0),
      revenueRecovered: Number(snapshot?.recovered ?? 0),
      activeCustomers,
      todaysAppointments,
      noShowRisk,
      // Legacy response key retained for compatibility. The value now has
      // actor-attributed reply-attempt evidence and is not an AI-recovery count.
      callsRecovered: staffCallReplyConversations.length,
      missedCalls,
      activeOpportunities: Number(leadOpportunity._sum.estimatedValue ?? 0) + Number(conversationOpportunity._sum.estimatedValue ?? 0),
      pendingApprovals,
    };
  });
};
