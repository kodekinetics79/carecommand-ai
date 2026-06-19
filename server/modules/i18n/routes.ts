import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { translateBatch, activeProvider, SUPPORTED_LANGS, type Lang } from '../../lib/i18n/translate';

// Public (unauthenticated) so the login screen, patient portal, and staff app
// can all translate. Rate-limited + size-capped; UI copy is non-sensitive.
export const i18nRoutes: FastifyPluginAsync = async app => {
  app.get('/languages', async () => ({ languages: SUPPORTED_LANGS, provider: activeProvider() }));

  app.post('/translate', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (request, reply) => {
    const body = z.object({
      targetLang: z.enum(SUPPORTED_LANGS as unknown as [Lang, ...Lang[]]),
      texts: z.array(z.string().max(2000)).max(300),
    }).parse(request.body);
    const totalChars = body.texts.reduce((s, t) => s + t.length, 0);
    if (totalChars > 60_000) return reply.code(400).send({ error: 'Batch too large (max 60k chars).' });
    const translations = await translateBatch(body.texts, body.targetLang);
    return { translations, provider: activeProvider() };
  });
};
