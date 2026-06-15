import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../../lib/db';
import { audit } from '../../lib/audit';
import { requireRoles } from '../../plugins/roles';
import { aiGateway, AiGatewayBlockedError } from '../../lib/ai/gateway';
import { aiRecommendationService, aiUsageCostService } from '../../lib/ai/services';

const readRoles = requireRoles('OWNER', 'ADMIN', 'MANAGER', 'PROVIDER');
const manageRoles = requireRoles('OWNER', 'ADMIN', 'MANAGER');

export const aiRoutes: FastifyPluginAsync = async app => {
  app.addHook('preHandler', readRoles);

  // Generate evidence-backed AI recommendations (rate-limited; calls the model).
  app.post('/recommendations/generate', { preHandler: manageRoles, config: { rateLimit: { max: 12, timeWindow: '1 minute' } } }, async (request, reply) => {
    try {
      const out = await aiRecommendationService.generate(request.auth.tenantId, request.auth.userId);
      await audit(request, { action: 'ai.recommendation.generated', resource: 'aiUsageLog', resourceId: out.usageLogId, metadata: { provider: out.provider, model: out.model, count: out.recommendations.length } });
      return reply.code(201).send(out);
    } catch (e) {
      if (e instanceof AiGatewayBlockedError) return reply.code(e.reason === 'budget_exceeded' ? 402 : 400).send({ error: e.message, reason: e.reason });
      throw e;
    }
  });

  // List AI-generated recommendations (with evidence + approval status).
  app.get('/recommendations', async request => {
    const q = z.object({ status: z.string().optional(), limit: z.coerce.number().min(1).max(100).default(50) }).parse(request.query);
    const rows = await db.aIRecommendation.findMany({
      where: { tenantId: request.auth.tenantId, createdBy: 'ai', ...(q.status ? { status: q.status } : {}) },
      orderBy: { createdAt: 'desc' }, take: q.limit,
      select: { id: true, title: true, recommendationType: true, reason: true, confidence: true, status: true, requiresHumanReview: true, evidence: true, aiProvider: true, aiModel: true, promptVersion: true, createdAt: true },
    });
    return rows;
  });

  // AI usage + cost + budget.
  app.get('/usage', async request => aiUsageCostService.summary(request.auth.tenantId));

  // AI output evaluations (groundedness / PHI-safety / budget).
  app.get('/evaluations', async request => {
    const rows = await db.aIEvaluation.findMany({ where: { tenantId: request.auth.tenantId }, orderBy: { createdAt: 'desc' }, take: 50 });
    return rows;
  });

  // Health-check the configured provider (rate-limited).
  app.post('/providers/health-check', { preHandler: manageRoles, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async request => {
    const result = await aiGateway.healthCheck(request.auth.tenantId, request.auth.userId);
    await audit(request, { action: 'ai.provider.health_check', resource: 'aiProvider', resourceId: result.provider, metadata: { healthy: result.healthy, mode: result.mode } });
    return result;
  });
};
