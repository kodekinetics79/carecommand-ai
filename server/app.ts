import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import swagger from '@fastify/swagger';
import { env } from './config/env';
import { loggerOptions } from './config/logger';
import { authPlugin } from './plugins/auth';
import { errorPlugin } from './plugins/errors';
import { metricsPlugin } from './plugins/metrics';
import { healthRoutes } from './modules/health/routes';
import { authRoutes } from './modules/auth/routes';
import { branchRoutes } from './modules/branches/routes';
import { providerRoutes } from './modules/providers/routes';
import { staffRoutes } from './modules/staff/routes';
import { patientRoutes } from './modules/patients/routes';
import { appointmentRoutes } from './modules/appointments/routes';
import { schedulingRoutes } from './modules/scheduling/routes';
import { autopilotRoutes } from './modules/autopilot/routes';
import { operationsRoutes } from './modules/operations/routes';
import { dashboardRoutes } from './modules/dashboard/routes';
import { telehealthRoutes } from './modules/telehealth/routes';
import { complianceRoutes } from './modules/compliance/routes';
import { complianceCenterRoutes } from './modules/compliance/center';
import { settingsRoutes, adminRoutes, securityRoutes } from './modules/settings/routes';
import { advisoryRoutes } from './modules/advisory/routes';
import { revenueProtectionRoutes, revenueProtectionWebhookRoutes } from './modules/revenue-protection';
import { paymentsCheckoutRoutes, paymentsPublicRoutes } from './modules/payments/checkout';
import { serviceCatalogRoutes } from './modules/services/routes';
import { crmRoutes, crmWebhookRoutes } from './modules/campaigns/routes';
import { intakeRoutes, intakePublicRoutes } from './modules/intake/routes';
import { controlPlaneRoutes } from './modules/control-plane/routes';
import { insuranceRoutes } from './modules/insurance/routes';
import { deviceRoutes } from './modules/devices/routes';
import { monitoringRoutes } from './modules/monitoring/routes';
import { connectedCareRoutes, connectedCareWebhookRoutes } from './modules/connected-care/routes';
import { aiRoutes } from './modules/ai/routes';
import { i18nRoutes } from './modules/i18n/routes';
import { receptionistRoutes, receptionistWebhookRoutes } from './modules/receptionist/routes';
import { subscriptionRoutes } from './modules/subscriptions/routes';
import { onboardingRoutes } from './modules/onboarding/routes';
import { platformRoutes } from './modules/platform/routes';
import { pilotRoutes } from './modules/platform/pilot.routes';
import { pilotPublicRoutes } from './modules/platform/pilot.public.routes';
import { platformAuthRoutes } from './modules/platform/auth';
import { portalAuthRoutes } from './modules/portal/auth';
import { portalRoutes } from './modules/portal/routes';
import { portalAdminRoutes } from './modules/portal/admin';
import { autopilotQueue } from './workers/queues';
import { assertProductionRateLimitStore, skipRateLimitStoreErrors } from './lib/rateLimitPolicy';
import { closeRetellRateStore } from './lib/receptionist/retellRateStore';

// Webhook signature verification (Stripe/Retell) needs the exact bytes that were
// signed, so we capture the raw JSON body while still parsing it normally.
declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

export async function buildApp() {
  const trustedProxyCidrs = env.INGRESS_MODE === 'trusted_proxy'
    ? env.TRUSTED_PROXY_CIDRS.split(',').map(value => value.trim()).filter(Boolean)
    : [];
  const app = Fastify({
    logger: loggerOptions,
    trustProxy: trustedProxyCidrs.length ? trustedProxyCidrs : false,
    requestIdHeader: 'x-request-id',
    // Explicit request-body cap (defends against oversized-payload memory
    // exhaustion). 1 MiB is ample for this JSON API; webhooks/intake stay well
    // under it. Make it intentional rather than relying on the framework default.
    bodyLimit: 1_048_576,
  });
  app.addHook('onClose', async () => { closeRetellRateStore(); });

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
    // @fastify/cors defaults to GET, HEAD and POST only. The application uses
    // browser-originated PUT/PATCH/DELETE mutations throughout, so enumerate
    // the complete API method set; otherwise the browser accepts the 204
    // preflight but refuses to send the actual mutation.
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });
  await app.register(helmet);

  // Redis-backed rate limiting so limits (and brute-force protection) hold
  // across multiple API instances behind a load balancer. Reuses the BullMQ
  // Redis connection. Local development may use the in-memory store, but a
  // production process must never silently downgrade this shared control.
  let rateLimitRedis: unknown;
  try {
    rateLimitRedis = await Promise.race([
      autopilotQueue.client,
      new Promise(resolve => setTimeout(() => resolve(undefined), 1500)),
    ]);
  } catch {
    rateLimitRedis = undefined;
  }
  const isProd = env.NODE_ENV === 'production';
  assertProductionRateLimitStore(env.NODE_ENV, rateLimitRedis);
  await app.register(rateLimit, {
    // The app shell (sidebar badges, topbar, dashboard widgets) fans out many
    // parallel calls per navigation, so a low global ceiling trips 429s during
    // normal/demo use. Keep production strict; give dev plenty of headroom.
    // The production-style browser harness intentionally exercises two full
    // user journeys from one loopback IP. Do not let that synthetic fan-out
    // consume the real production ceiling and turn later assertions into 429s.
    max: env.E2E_TEST_MODE ? 5000 : isProd ? 200 : 2000,
    timeWindow: '1 minute',
    ...(rateLimitRedis ? { redis: rateLimitRedis } : {}),
    // In non-production, never rate-limit loopback (local demos/tests).
    ...(isProd ? {} : { allowList: ['127.0.0.1', '::1'] }),
    // Production authentication and abuse controls fail closed when the shared
    // store errors. Development remains available when a local Redis is absent.
    skipOnError: skipRateLimitStoreErrors(env.NODE_ENV),
    nameSpace: 'cc-ratelimit:',
  });

  // API docs must not be exposed unauthenticated in production. Serve the raw
  // OpenAPI document in development instead of bundling Swagger UI's static-file
  // server into the production dependency tree.
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
    app.get('/docs/json', async (_request, reply) => reply.send(app.swagger()));
  }
  await app.register(errorPlugin);
  // Metrics before auth so its onRequest/onResponse hooks time EVERY route
  // (including public/webhook ones) and /metrics stays outside the JWT scope.
  await app.register(metricsPlugin);
  await app.register(authPlugin);

  await app.register(healthRoutes);
  await app.register(i18nRoutes, { prefix: '/v1/i18n' });
  await app.register(authRoutes, { prefix: '/v1/auth' });
  // Retell posts call events here without a JWT, so it stays outside the
  // authenticated scope and attributes the tenant via clinic/campaign query ids.
  await app.register(receptionistWebhookRoutes, { prefix: '/v1/receptionist' });
  // Stripe posts payment events here without a JWT; the handler verifies the
  // Stripe signature and attributes the tenant via the matched payment request.
  await app.register(revenueProtectionWebhookRoutes, { prefix: '/v1/revenue-protection' });
  await app.register(connectedCareWebhookRoutes, { prefix: '/v1/connected-care' });
  // Patient-safe, tokenized public checkout status (no JWT, no guessable ids).
  await app.register(paymentsPublicRoutes, { prefix: '/v1/payments' });
  // Placeholder comms delivery webhook (no provider integrated; never fakes state).
  await app.register(crmWebhookRoutes, { prefix: '/v1/crm' });
  // Patient-facing intake via hashed, expiring, packet-scoped token (no JWT).
  await app.register(intakePublicRoutes, { prefix: '/v1/intake' });
  // Customer-facing pilot share link (hashed token, no auth, no PHI).
  await app.register(pilotPublicRoutes, { prefix: '/v1/pilot' });
  // Retired legacy onboarding route: valid legacy operators receive a truthful
  // 410 directing them to PlatformUser-authenticated /v1/platform/tenants.
  await app.register(onboardingRoutes, { prefix: '/v1/onboarding' });
  // Platform Admin auth (PlatformUser identity) — separate from tenant auth.
  await app.register(platformAuthRoutes, { prefix: '/v1/platform/auth' });
  await app.register(platformRoutes, { prefix: '/v1/platform' });
  await app.register(pilotRoutes, { prefix: '/v1/platform' });

  // Patient / Client Portal — separate identity; portal JWT (type:'portal')
  // cannot access staff APIs and staff JWT cannot access these.
  await app.register(portalAuthRoutes, { prefix: '/v1/portal/auth' });
  await app.register(portalRoutes, { prefix: '/v1/portal' });

  await app.register(async protectedApi => {
    protectedApi.addHook('preHandler', protectedApi.authenticate);
    await protectedApi.register(branchRoutes, { prefix: '/branches' });
    await protectedApi.register(providerRoutes, { prefix: '/providers' });
    await protectedApi.register(staffRoutes, { prefix: '/staff' });
    await protectedApi.register(patientRoutes, { prefix: '/patients' });
    await protectedApi.register(appointmentRoutes, { prefix: '/appointments' });
    await protectedApi.register(schedulingRoutes, { prefix: '/scheduling' });
    await protectedApi.register(serviceCatalogRoutes, { prefix: '/services' });
    await protectedApi.register(crmRoutes, { prefix: '/crm' });
    await protectedApi.register(intakeRoutes, { prefix: '/intake' });
    await protectedApi.register(autopilotRoutes, { prefix: '/autopilot' });
    await protectedApi.register(telehealthRoutes, { prefix: '/telehealth' });
    await protectedApi.register(complianceRoutes, { prefix: '/compliance' });
    await protectedApi.register(complianceCenterRoutes, { prefix: '/compliance' });
    await protectedApi.register(settingsRoutes, { prefix: '/settings' });
    await protectedApi.register(adminRoutes, { prefix: '/admin' });
    await protectedApi.register(securityRoutes, { prefix: '/security' });
    await protectedApi.register(controlPlaneRoutes, { prefix: '/control-plane' });
    await protectedApi.register(advisoryRoutes, { prefix: '/advisory' });
    await protectedApi.register(revenueProtectionRoutes, { prefix: '/revenue-protection' });
    await protectedApi.register(paymentsCheckoutRoutes, { prefix: '/payments' });
    await protectedApi.register(insuranceRoutes, { prefix: '/insurance' });
    await protectedApi.register(deviceRoutes, { prefix: '/devices' });
    await protectedApi.register(monitoringRoutes, { prefix: '/monitoring' });
    await protectedApi.register(connectedCareRoutes, { prefix: '/connected-care' });
    await protectedApi.register(aiRoutes, { prefix: '/ai' });
    await protectedApi.register(portalAdminRoutes, { prefix: '/portal-admin' });
    await protectedApi.register(receptionistRoutes, { prefix: '/receptionist' });
    await protectedApi.register(subscriptionRoutes, { prefix: '/subscriptions' });
    await protectedApi.register(operationsRoutes);
    await protectedApi.register(dashboardRoutes);
  }, { prefix: '/v1' });

  return app;
}
