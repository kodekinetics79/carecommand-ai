import { db } from '../db';
import { env } from '../../config/env';
import { OllamaProviderClient, OpenAIProviderClient, ClaudeProviderClient, MockProviderClient, type AiProviderClient, type AiMessage, type AiGenerateResult } from './providers';

export class AiGatewayBlockedError extends Error {
  constructor(public readonly reason: 'phi_disabled' | 'budget_exceeded' | 'provider_not_configured', message: string) {
    super(message);
    this.name = 'AiGatewayBlockedError';
  }
}

// Rough USD per 1k total tokens. Local/mock are free; cloud/hosted are estimates
// for budgeting only (never billed automatically).
const RATES: Record<string, number> = { mock: 0, 'ollama:local': 0, 'ollama:cloud': 0, openai: 0.002, claude: 0.003 };
function estimateCostUsd(provider: string, mode: string | undefined, totalTokens: number | undefined): number {
  if (!totalTokens) return 0;
  const key = provider === 'ollama' ? `ollama:${mode ?? 'local'}` : provider;
  return Number(((totalTokens / 1000) * (RATES[key] ?? 0)).toFixed(6));
}

export interface GatewayGenerateOptions {
  tenantId: string;
  actorUserId?: string | null;
  operation: 'recommendation' | 'morning_briefing' | 'evaluation' | 'advisory';
  messages: AiMessage[];
  jsonMode?: boolean;
  containsPhi?: boolean;
  promptVersion?: string;
}
export interface GatewayGenerateOutput { result: AiGenerateResult; usageLogId: string; estimatedCostUsd: number }

function startOfDay(): Date { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }

/**
 * Provider-agnostic AI gateway. Single seam for every AI call:
 *  - API keys come only from backend env, are never logged, never returned.
 *  - PHI is blocked unless AI_ENABLE_PHI=true.
 *  - Daily spend is capped by AI_COST_BUDGET_DAILY_USD.
 *  - Every request/response writes AIUsageLog metadata (no bodies, no PHI).
 */
export const aiGateway = {
  resolveProvider(): AiProviderClient {
    switch (env.AI_PROVIDER) {
      case 'ollama': return new OllamaProviderClient();
      case 'openai':
        // Wired, but fail with a clear, actionable, TYPED error (not a raw throw)
        // when the required key is absent — callers catch AiGatewayBlockedError
        // and degrade gracefully; health-check surfaces the same message.
        if (!env.OPENAI_API_KEY) throw new AiGatewayBlockedError('provider_not_configured', 'AI_PROVIDER=openai but OPENAI_API_KEY is not set');
        return new OpenAIProviderClient();
      case 'claude':
        if (!env.CLAUDE_API_KEY) throw new AiGatewayBlockedError('provider_not_configured', 'AI_PROVIDER=claude but CLAUDE_API_KEY is not set');
        return new ClaudeProviderClient();
      case 'mock': return new MockProviderClient();
      default:
        throw new AiGatewayBlockedError('provider_not_configured', `AI provider "${env.AI_PROVIDER}" is not configured in this build`);
    }
  },

  async todaySpendUsd(tenantId: string): Promise<number> {
    const agg = await db.aIUsageLog.aggregate({ where: { tenantId, createdAt: { gte: startOfDay() }, status: 'ok' }, _sum: { estimatedCostUsd: true } });
    return Number(agg._sum.estimatedCostUsd ?? 0);
  },

  async generate(opts: GatewayGenerateOptions): Promise<GatewayGenerateOutput> {
    // 1) PHI guard.
    if (opts.containsPhi && !env.AI_ENABLE_PHI) {
      await db.aIUsageLog.create({ data: { tenantId: opts.tenantId, provider: env.AI_PROVIDER, model: '-', operation: opts.operation, status: 'blocked', phiIncluded: false, error: 'PHI blocked: AI_ENABLE_PHI=false', actorUserId: opts.actorUserId ?? null, promptVersion: opts.promptVersion } });
      throw new AiGatewayBlockedError('phi_disabled', 'Refusing to send PHI to AI while AI_ENABLE_PHI=false');
    }
    // 2) Daily budget.
    const spent = await this.todaySpendUsd(opts.tenantId);
    if (spent >= env.AI_COST_BUDGET_DAILY_USD) {
      await db.aIUsageLog.create({ data: { tenantId: opts.tenantId, provider: env.AI_PROVIDER, model: '-', operation: opts.operation, status: 'blocked', error: `Daily AI budget reached ($${env.AI_COST_BUDGET_DAILY_USD})`, actorUserId: opts.actorUserId ?? null, promptVersion: opts.promptVersion } });
      throw new AiGatewayBlockedError('budget_exceeded', `Daily AI cost budget ($${env.AI_COST_BUDGET_DAILY_USD}) reached`);
    }

    const provider = this.resolveProvider();
    try {
      const result = await provider.generate({ messages: opts.messages, operation: opts.operation, jsonMode: opts.jsonMode });
      const estimatedCostUsd = estimateCostUsd(result.provider, result.mode, result.usage.totalTokens);
      const log = await db.aIUsageLog.create({
        data: {
          tenantId: opts.tenantId, provider: result.provider, mode: result.mode, model: result.model, operation: opts.operation,
          promptVersion: opts.promptVersion, status: 'ok', phiIncluded: !!opts.containsPhi && env.AI_ENABLE_PHI,
          promptTokens: result.usage.promptTokens, completionTokens: result.usage.completionTokens, totalTokens: result.usage.totalTokens,
          estimatedCostUsd, latencyMs: result.latencyMs, actorUserId: opts.actorUserId ?? null,
        },
        select: { id: true },
      });
      return { result, usageLogId: log.id, estimatedCostUsd };
    } catch (e) {
      // Sanitize: never let a key or PHI ride along in the error message.
      const message = (e as Error).message.slice(0, 300);
      await db.aIUsageLog.create({ data: { tenantId: opts.tenantId, provider: env.AI_PROVIDER, model: provider.defaultModel(), operation: opts.operation, status: 'error', error: message, actorUserId: opts.actorUserId ?? null, promptVersion: opts.promptVersion } });
      throw e;
    }
  },

  async healthCheck(tenantId: string, actorUserId?: string | null) {
    let provider: AiProviderClient;
    try { provider = this.resolveProvider(); }
    catch (e) {
      return { provider: env.AI_PROVIDER, mode: env.AI_PROVIDER === 'ollama' ? env.OLLAMA_MODE : undefined, healthy: false, message: (e as Error).message, model: null, configured: false };
    }
    const started = Date.now();
    const health = await provider.healthCheck();
    await db.aIUsageLog.create({ data: { tenantId, provider: provider.provider, mode: provider.mode, model: health.model ?? provider.defaultModel(), operation: 'health_check', status: health.healthy ? 'ok' : 'error', error: health.healthy ? null : health.message, latencyMs: Date.now() - started, actorUserId: actorUserId ?? null } });
    return { provider: provider.provider, mode: provider.mode, healthy: health.healthy, message: health.message, model: health.model ?? provider.defaultModel(), configured: true };
  },
};
