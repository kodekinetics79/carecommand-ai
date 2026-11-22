import type { FastifyInstance } from 'fastify';
import type { DependencyCheckOptions } from './checks';

export interface DependencyCheckResult {
  databaseOk: boolean;
  redisOk: boolean;
  queueRedisOk: boolean;
}

interface ReadinessRouteOptions extends DependencyCheckOptions {
  nodeEnv: string;
  proxyTrustOk: boolean;
  refreshDependencies(options: DependencyCheckOptions): Promise<DependencyCheckResult>;
}

export async function registerReadinessRoute(app: FastifyInstance, options: ReadinessRouteOptions) {
  app.get('/health/ready', async (_request, reply) => {
    const dependencyOptions: DependencyCheckOptions = {
      rateLimitRedis: options.rateLimitRedis,
      queuesEnabled: options.queuesEnabled,
      queueProbe: options.queueProbe,
    };
    const { databaseOk, redisOk, queueRedisOk } = await options.refreshDependencies(dependencyOptions);
    const redisRequired = options.nodeEnv === 'production';
    const queuesEnabled = options.queuesEnabled ?? false;
    const ready = databaseOk
      && (!redisRequired || redisOk)
      && (!queuesEnabled || queueRedisOk)
      && options.proxyTrustOk;
    const body = {
      status: ready ? 'ready' : 'not-ready',
      checks: {
        database: databaseOk ? 'ok' : 'down',
        redis: redisOk ? 'ok' : redisRequired ? 'down' : 'degraded',
        queueRedis: queuesEnabled ? (queueRedisOk ? 'ok' : 'down') : 'disabled',
        ingressProxy: options.proxyTrustOk ? 'ok' : 'trusted_proxy_cidrs_required',
      },
    };
    return ready ? body : reply.code(503).send(body);
  });
}
