import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { env } from './config/env';
import { authPlugin } from './plugins/auth';
import { errorPlugin } from './plugins/errors';
import { healthRoutes } from './modules/health/routes';
import { authRoutes } from './modules/auth/routes';
import { branchRoutes } from './modules/branches/routes';
import { providerRoutes } from './modules/providers/routes';
import { staffRoutes } from './modules/staff/routes';
import { patientRoutes } from './modules/patients/routes';
import { appointmentRoutes } from './modules/appointments/routes';
import { autopilotRoutes } from './modules/autopilot/routes';
import { operationsRoutes } from './modules/operations/routes';
import { dashboardRoutes } from './modules/dashboard/routes';
import { telehealthRoutes } from './modules/telehealth/routes';
import { complianceRoutes } from './modules/compliance/routes';
import { settingsRoutes, adminRoutes, securityRoutes } from './modules/settings/routes';
import { advisoryRoutes } from './modules/advisory/routes';
import { revenueProtectionRoutes, revenueProtectionWebhookRoutes } from './modules/revenue-protection';
import { controlPlaneRoutes } from './modules/control-plane/routes';
import { insuranceRoutes } from './modules/insurance/routes';
import { receptionistRoutes, receptionistWebhookRoutes } from './modules/receptionist/routes';
import { autopilotQueue } from './workers/queues';

// Webhook signature verification (Stripe/Retell) needs the exact bytes that were
// signed, so we capture the raw JSON body while still parsing it normally.
declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

export async function buildApp() {
  const app = Fastify({
    logger: { level: env.LOG_LEVEL },
    trustProxy: true,
    requestIdHeader: 'x-request-id',
  });

  // Preserve the raw body so webhook handlers can verify HMAC signatures,
  // while still delivering parsed JSON to every other route.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
    const buffer = body as Buffer;
    request.rawBody = buffer;
    if (!buffer || buffer.length === 0) return done(null, {});
    try {
      done(null, JSON.parse(buffer.toString('utf8')) as unknown);
    } catch {
      const error = app.httpErrors.badRequest('Invalid JSON body');
      done(error, undefined);
    }
  });

  await app.register(sensible);
  await app.register(cors, {
    origin: env.CORS_ORIGINS.split(',').map(origin => origin.trim()),
    credentials: true,
  });
  await app.register(helmet);

  // Redis-backed rate limiting so limits (and brute-force protection) hold
  // across multiple API instances behind a load balancer. Reuses the BullMQ
  // Redis connection; falls back to the in-memory store if Redis is
  // unreachable (e.g. local dev without Redis) so development is never blocked.
  let rateLimitRedis: unknown;
  try {
    rateLimitRedis = await Promise.race([
      autopilotQueue.client,
      new Promise(resolve => setTimeout(() => resolve(undefined), 1500)),
    ]);
  } catch {
    rateLimitRedis = undefined;
  }
  if (!rateLimitRedis && env.NODE_ENV === 'production') {
    app.log.error('Rate limiter falling back to in-memory store in production: Redis unreachable');
  }
  await app.register(rateLimit, {
    max: 200,
    timeWindow: '1 minute',
    ...(rateLimitRedis ? { redis: rateLimitRedis } : {}),
    // Never fail a request because the rate-limit store hiccups; fail open.
    skipOnError: true,
    nameSpace: 'cc-ratelimit:',
  });

  // API docs must not be exposed unauthenticated in production.
  if (env.NODE_ENV !== 'production') {
    await app.register(swagger, {
      openapi: {
        info: { title: 'CareCommand API', version: '0.1.0' },
        tags: [
          { name: 'health', description: 'Service health' },
          { name: 'patients', description: 'Customer360 records' },
          { name: 'appointments', description: 'Scheduling records' },
          { name: 'providers', description: 'Provider productivity and utilization' },
          { name: 'staff', description: 'Staff workflow and SLA management' },
          { name: 'autopilot', description: 'Governed AI workflow actions' },
          { name: 'advisory', description: 'Premium AI advisory room' },
          { name: 'revenue-protection', description: 'Revenue protection command center' },
          { name: 'control-plane', description: 'Enterprise control plane' },
          { name: 'admin', description: 'Enterprise admin and tenant controls' },
          { name: 'security', description: 'Security posture and session controls' },
        ],
      },
    });
    await app.register(swaggerUi, { routePrefix: '/docs' });
  }
  await app.register(errorPlugin);
  await app.register(authPlugin);

  await app.register(healthRoutes);
  await app.register(authRoutes, { prefix: '/v1/auth' });
  // Retell posts call events here without a JWT, so it stays outside the
  // authenticated scope and attributes the tenant via clinic/campaign query ids.
  await app.register(receptionistWebhookRoutes, { prefix: '/v1/receptionist' });
  // Stripe posts payment events here without a JWT; the handler verifies the
  // Stripe signature and attributes the tenant via the matched payment request.
  await app.register(revenueProtectionWebhookRoutes, { prefix: '/v1/revenue-protection' });

  await app.register(async protectedApi => {
    protectedApi.addHook('preHandler', protectedApi.authenticate);
    await protectedApi.register(branchRoutes, { prefix: '/branches' });
    await protectedApi.register(providerRoutes, { prefix: '/providers' });
    await protectedApi.register(staffRoutes, { prefix: '/staff' });
    await protectedApi.register(patientRoutes, { prefix: '/patients' });
    await protectedApi.register(appointmentRoutes, { prefix: '/appointments' });
    await protectedApi.register(autopilotRoutes, { prefix: '/autopilot' });
    await protectedApi.register(telehealthRoutes, { prefix: '/telehealth' });
    await protectedApi.register(complianceRoutes, { prefix: '/compliance' });
    await protectedApi.register(settingsRoutes, { prefix: '/settings' });
    await protectedApi.register(adminRoutes, { prefix: '/admin' });
    await protectedApi.register(securityRoutes, { prefix: '/security' });
    await protectedApi.register(controlPlaneRoutes, { prefix: '/control-plane' });
    await protectedApi.register(advisoryRoutes, { prefix: '/advisory' });
    await protectedApi.register(revenueProtectionRoutes, { prefix: '/revenue-protection' });
    await protectedApi.register(insuranceRoutes, { prefix: '/insurance' });
    await protectedApi.register(receptionistRoutes, { prefix: '/receptionist' });
    await protectedApi.register(operationsRoutes);
    await protectedApi.register(dashboardRoutes);
  }, { prefix: '/v1' });

  return app;
}
