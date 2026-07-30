import type { FastifyPluginAsync } from 'fastify';
import { requirePlatformOperator } from '../../lib/platform';

// Retired compatibility endpoint. The legacy static-token actor is not a real
// PlatformUser and therefore cannot safely enter the dedicated platform DB
// plane. Tenant creation is exclusively handled by /v1/platform/tenants under
// an authenticated PlatformUser session.
export const onboardingRoutes: FastifyPluginAsync = async app => {
  app.post('/tenant', { preHandler: requirePlatformOperator, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    reply.header('link', '</v1/platform/tenants>; rel="successor-version"');
    return reply.code(410).send({
      error: 'legacy_onboarding_retired',
      message: 'This legacy onboarding endpoint is retired. Sign in to the Platform Admin Console and use the authenticated tenant provisioning workflow.',
      successor: { method: 'POST', path: '/v1/platform/tenants', authentication: 'PlatformUser session' },
    });
  });
};
