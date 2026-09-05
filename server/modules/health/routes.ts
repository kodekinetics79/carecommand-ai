import type { FastifyPluginAsync } from 'fastify';
import { env, isIngressProxyConfigurationReady, parseAllowedMockIntegrations } from '../../config/env';
import { metricsAccess } from '../../lib/metrics';
import { resolveReleaseIdentity } from '../../lib/releaseIdentity';
import { providerConfigured } from '../../lib/providerCredentials';
import { passwordResetDeliveryConfigured } from '../../lib/passwordResetDelivery';
import { SLOS, errorBudgetMinutes } from '../../lib/slo';
import { refreshDependencyGauges } from './checks';

const BOOTED_AT = Date.now();

export const healthRoutes: FastifyPluginAsync = async app => {
  app.get('/health/live', async () => ({ status: 'ok' }));

  app.get('/health/ready', async (_request, reply) => {
    // The probe result also feeds the dependency_up gauge so an alert can fire
    // on a dependency outage even between external probes (the /metrics scrape
    // refreshes the same gauge — see plugins/metrics.ts).
    const { databaseOk, redisOk } = await refreshDependencyGauges();
    // Redis backs rate limiting and the job queue, so it is required in
    // production. In other environments we report its state without failing.
    const redisRequired = env.NODE_ENV === 'production';
    const proxyTrustOk = isIngressProxyConfigurationReady(env);
    const ready = databaseOk && (!redisRequired || redisOk) && proxyTrustOk;
    const body = {
      status: ready ? 'ready' : 'not-ready',
      checks: {
        database: databaseOk ? 'ok' : 'down',
        redis: redisOk ? 'ok' : redisRequired ? 'down' : 'degraded',
        ingressProxy: proxyTrustOk ? 'ok' : 'trusted_proxy_cidrs_required',
      },
    };
    return ready ? body : reply.code(503).send(body);
  });

  // Human/uptime-monitor summary: one call that reports liveness, release, and
  // uptime. Point an external uptime monitor at /health/ready (which 503s on a
  // dependency outage); use this for at-a-glance status and version confirmation.
  app.get('/health', async () => ({
    status: 'ok',
    service: env.OTEL_SERVICE_NAME,
    environment: env.SERVICE_ENV ?? env.NODE_ENV,
    release: resolveReleaseIdentity(env) ?? 'unknown',
    uptimeSeconds: Math.floor((Date.now() - BOOTED_AT) / 1000),
    time: new Date().toISOString(),
  }));

  // Operational integration inventory. In production it shares the protected
  // monitoring-token boundary with /metrics so public probes cannot fingerprint
  // configured providers or deployment profile. It never returns credentials.
  app.get('/health/integrations', async (request, reply) => {
    const access = metricsAccess(request.headers.authorization);
    if (access === 'not_found') return reply.code(404).send();
    if (access === 'unauthorized') return reply.code(401).send();
    return {
    profile: env.DEPLOYMENT_PROFILE,
    integrations: {
      // Provider-mode integrations report their effective provider id.
      payments: env.PAYMENT_PROVIDER,
      insurance: env.INSURANCE_PROVIDER,
      ai: env.AI_PROVIDER,
      // Channel integrations are presence-derived: 'configured' only means the
      // relevant env credentials are set, not that delivery has been proven.
      email: providerConfigured('email') ? 'configured' : 'not_configured',
      tenantPasswordRecovery: passwordResetDeliveryConfigured() ? 'configured' : 'not_configured',
      sms: env.TWILIO_ACCOUNT_SID ? 'configured' : 'not_configured',
      voice: env.RETELL_API_KEY ? 'configured' : 'not_configured',
    },
    // Mocks this profile has explicitly acknowledged (empty under 'demo' by
    // convention — the gate ignores it there but boot validates the tokens).
    acknowledgedMockIntegrations: parseAllowedMockIntegrations(env.ALLOWED_MOCK_INTEGRATIONS),
    };
  });

  // Published SLO targets — the measurable commitments the alerts fire against.
  app.get('/health/slo', async () => ({
    window: '30d',
    objectives: SLOS.map(slo => ({
      ...slo,
      ...(slo.unit === 'ratio' ? { errorBudgetMinutes: errorBudgetMinutes(slo.target) } : {}),
    })),
  }));
};
