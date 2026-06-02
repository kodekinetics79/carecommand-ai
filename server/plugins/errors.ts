import fp from 'fastify-plugin';
import { ZodError } from 'zod';

export const errorPlugin = fp(async app => {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        requestId: request.id,
        details: error.flatten(),
      });
    }

    const handledError = error as Error & { statusCode?: number; code?: string };
    request.log.error({ err: error }, 'request failed');
    return reply.code(handledError.statusCode ?? 500).send({
      error: handledError.code ?? 'INTERNAL_SERVER_ERROR',
      message: handledError.statusCode && handledError.statusCode < 500 ? handledError.message : 'An unexpected error occurred',
      requestId: request.id,
    });
  });
});
