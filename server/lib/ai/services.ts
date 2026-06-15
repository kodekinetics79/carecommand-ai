import { db } from '../db';
import { env } from '../../config/env';
import { aiGateway, AiGatewayBlockedError } from './gateway';
import { aiContextBuilder, type EvidenceRef, type OperationalSnapshot } from './context';

export const PROMPT_VERSION = 'ops-v1';

// Cheap PHI leak heuristic for evaluating AI OUTPUT (SSN / email / phone).
const PHI_PATTERNS = [/\b\d{3}-\d{2}-\d{4}\b/, /[\w.+-]+@[\w-]+\.[\w.-]+/, /\b\d{3}[.\-\s]?\d{3}[.\-\s]?\d{4}\b/];
function looksLikePhi(text: string): boolean { return PHI_PATTERNS.some(p => p.test(text)); }

// ── AIEvaluationService ─────────────────────────────────────────────────────
export const aiEvaluationService = {
  async evaluate(tenantId: string, input: { usageLogId?: string; subjectType: 'recommendation' | 'morning_briefing'; subjectId?: string; evidenceCount: number; text: string }) {
    const grounded = input.evidenceCount > 0;
    const phiSafe = !looksLikePhi(input.text);
    const withinBudget = (await aiGateway.todaySpendUsd(tenantId)) <= env.AI_COST_BUDGET_DAILY_USD;
    const score = (grounded ? 40 : 0) + (phiSafe ? 30 : 0) + (withinBudget ? 30 : 0);
    const passed = grounded && phiSafe && withinBudget;
    return db.aIEvaluation.create({
      data: { tenantId, usageLogId: input.usageLogId, subjectType: input.subjectType, subjectId: input.subjectId, evidenceCount: input.evidenceCount, grounded, phiSafe, withinBudget, score, passed, notes: passed ? 'Grounded in evidence; PHI-safe; within budget.' : `${!grounded ? 'no evidence; ' : ''}${!phiSafe ? 'possible PHI; ' : ''}${!withinBudget ? 'over budget; ' : ''}`.trim() },
    });
  },
};

// ── AIRecommendationService ─────────────────────────────────────────────────
export const aiRecommendationService = {
  async generate(tenantId: string, actorUserId?: string | null) {
    const snapshot = await aiContextBuilder.buildOperationalSnapshot(tenantId);
    const evidenceByMetric = new Map(snapshot.metrics.map(m => [m.metric, m]));
    const { result, usageLogId } = await aiGateway.generate({
      tenantId, actorUserId, operation: 'recommendation', jsonMode: true, containsPhi: false, promptVersion: PROMPT_VERSION,
      messages: aiContextBuilder.recommendationMessages(snapshot),
    });

    let parsed: { recommendations?: Array<{ title?: string; recommendationType?: string; reason?: string; confidence?: number; evidenceMetric?: string }> };
    try { parsed = JSON.parse(result.text); } catch { parsed = {}; }

    const created = [];
    for (const r of parsed.recommendations ?? []) {
      // Every AI recommendation MUST cite real backend evidence, or it's dropped.
      const evidence: EvidenceRef | undefined = r.evidenceMetric ? evidenceByMetric.get(r.evidenceMetric) : undefined;
      if (!evidence || evidence.value <= 0 || !r.title || !r.recommendationType) continue;
      const row = await db.aIRecommendation.create({
        data: {
          tenantId, title: String(r.title).slice(0, 200), recommendationType: String(r.recommendationType).slice(0, 60),
          reason: String(r.reason ?? evidence.label).slice(0, 500), confidence: Math.max(0, Math.min(100, Math.round(r.confidence ?? 60))),
          requiresHumanReview: env.AI_REQUIRE_HUMAN_APPROVAL, status: 'pending', allowedActionType: 'review',
          createdBy: 'ai', aiProvider: result.provider, aiModel: result.model, promptVersion: PROMPT_VERSION, aiUsageLogId: usageLogId,
          evidence: [evidence] as object,
        },
        select: { id: true, title: true, recommendationType: true, reason: true, confidence: true, status: true, requiresHumanReview: true, evidence: true, aiProvider: true, aiModel: true, createdAt: true },
      });
      created.push(row);
    }
    await aiEvaluationService.evaluate(tenantId, { usageLogId, subjectType: 'recommendation', evidenceCount: created.length, text: result.text }).catch(() => {});
    return { recommendations: created, usageLogId, provider: result.provider, model: result.model, evidenceConsidered: snapshot.metrics.length };
  },
};

// ── AIMorningBriefingService ────────────────────────────────────────────────
function deterministicBriefing(snapshot: OperationalSnapshot): string {
  const nonZero = snapshot.metrics.filter(m => m.value > 0);
  if (!nonZero.length) return 'No open operational items from connected-care or insurance signals this morning.';
  return 'Operational focus today: ' + nonZero.map(m => `${m.value} ${m.label.toLowerCase()}`).join('; ') + '.';
}
export const aiMorningBriefingService = {
  // Evidence-backed AI briefing. Degrades to a deterministic, evidence-backed
  // summary if the gateway is blocked/unavailable — the figures are always real.
  async generate(tenantId: string, actorUserId?: string | null) {
    const snapshot = await aiContextBuilder.buildOperationalSnapshot(tenantId);
    try {
      const { result, usageLogId } = await aiGateway.generate({
        tenantId, actorUserId, operation: 'morning_briefing', containsPhi: false, promptVersion: PROMPT_VERSION,
        messages: aiContextBuilder.briefingMessages(snapshot),
      });
      await aiEvaluationService.evaluate(tenantId, { usageLogId, subjectType: 'morning_briefing', evidenceCount: snapshot.metrics.length, text: result.text }).catch(() => {});
      return { summary: result.text, evidence: snapshot.metrics, aiGenerated: true, provider: result.provider, model: result.model, usageLogId };
    } catch (e) {
      const reason = e instanceof AiGatewayBlockedError ? e.reason : 'unavailable';
      return { summary: deterministicBriefing(snapshot), evidence: snapshot.metrics, aiGenerated: false, fallbackReason: reason, provider: env.AI_PROVIDER, model: null, usageLogId: null };
    }
  },
};

// ── AIUsageCostService ──────────────────────────────────────────────────────
export const aiUsageCostService = {
  async summary(tenantId: string) {
    const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
    const [todayAgg, totalAgg, byOperation, recent] = await Promise.all([
      db.aIUsageLog.aggregate({ where: { tenantId, createdAt: { gte: dayStart } }, _sum: { estimatedCostUsd: true, totalTokens: true }, _count: { _all: true } }),
      db.aIUsageLog.aggregate({ where: { tenantId }, _sum: { estimatedCostUsd: true, totalTokens: true }, _count: { _all: true } }),
      db.aIUsageLog.groupBy({ by: ['operation', 'status'], where: { tenantId, createdAt: { gte: dayStart } }, _count: { _all: true } }),
      db.aIUsageLog.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, provider: true, mode: true, model: true, operation: true, status: true, phiIncluded: true, totalTokens: true, estimatedCostUsd: true, latencyMs: true, error: true, createdAt: true } }),
    ]);
    const todayCost = Number(todayAgg._sum.estimatedCostUsd ?? 0);
    return {
      budgetDailyUsd: env.AI_COST_BUDGET_DAILY_USD,
      today: { requests: todayAgg._count._all, tokens: todayAgg._sum.totalTokens ?? 0, costUsd: todayCost, remainingUsd: Math.max(0, env.AI_COST_BUDGET_DAILY_USD - todayCost) },
      allTime: { requests: totalAgg._count._all, tokens: totalAgg._sum.totalTokens ?? 0, costUsd: Number(totalAgg._sum.estimatedCostUsd ?? 0) },
      byOperation: byOperation.map(b => ({ operation: b.operation, status: b.status, count: b._count._all })),
      recent: recent.map(r => ({ ...r, estimatedCostUsd: Number(r.estimatedCostUsd) })),
    };
  },
};
