import type { FastifyPluginAsync } from 'fastify';
import { env, parseAllowedMockIntegrations } from '../../config/env';
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
    const ready = databaseOk && (!redisRequired || redisOk);
    const body = {
      status: ready ? 'ready' : 'not-ready',
      checks: {
        database: databaseOk ? 'ok' : 'down',
        redis: redisOk ? 'ok' : redisRequired ? 'down' : 'degraded',
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
    release: env.RELEASE ?? 'unknown',
    uptimeSeconds: Math.floor((Date.now() - BOOTED_AT) / 1000),
    time: new Date().toISOString(),
  }));

  // Truthful integration posture — the effective mode of every integration in
  // THIS environment, so an "enterprise validation" run can never silently sit
  // on mocks (docs/INTEGRATION_MODE_REGISTER.md). Same exposure policy as
  // /health/slo: unauthenticated, config identifiers only — provider names and
  // configured/not_configured flags, NEVER credentials or secret values.
  app.get('/health/integrations', async () => ({
    profile: env.DEPLOYMENT_PROFILE,
    integrations: {
      // Provider-mode integrations report their effective provider id.
      payments: env.PAYMENT_PROVIDER,
      insurance: env.INSURANCE_PROVIDER,
      ai: env.AI_PROVIDER,
      // Channel integrations are presence-derived: 'configured' only means the
      // relevant env credentials are set, not that delivery has been proven.
      email: env.EMAIL_HTTP_API_URL || env.SMTP_HOST ? 'configured' : 'not_configured',
      sms: env.TWILIO_ACCOUNT_SID ? 'configured' : 'not_configured',
      voice: env.RETELL_API_KEY ? 'configured' : 'not_configured',
    },
    // Mocks this profile has explicitly acknowledged (empty under 'demo' by
    // convention — the gate ignores it there but boot validates the tokens).
    acknowledgedMockIntegrations: parseAllowedMockIntegrations(env.ALLOWED_MOCK_INTEGRATIONS),
  }));

  // Published SLO targets — the measurable commitments the alerts fire against.
  app.get('/health/slo', async () => ({
    window: '30d',
    objectives: SLOS.map(slo => ({
      ...slo,
      ...(slo.unit === 'ratio' ? { errorBudgetMinutes: errorBudgetMinutes(slo.target) } : {}),
    })),
  }));
};
