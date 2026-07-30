import type { FastifyPluginAsync } from 'fastify';
import { activeProvider, SUPPORTED_LANGS } from '../../lib/i18n/translate';

// Public (unauthenticated) so the login screen, patient portal, and staff app
// can all translate. Rate-limited + size-capped; UI copy is non-sensitive.
export const i18nRoutes: FastifyPluginAsync = async app => {
  app.get('/languages', async () => ({ languages: SUPPORTED_LANGS, provider: activeProvider() }));

  app.post('/translate', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (_request, reply) => {
    // Arbitrary submitted text cannot be proven free of PHI. Runtime translation
    // stays disabled until the UI uses an allowlisted static message-id catalog.
    return reply.code(410).send({ error: 'runtime_translation_disabled' });
  });
};
