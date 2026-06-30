import fp from 'fastify-plugin';
import { ZodError } from 'zod';
import { captureException } from '../lib/observability';

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
    const statusCode = handledError.statusCode ?? 500;

    // 4xx are expected client errors (log, don't page). 5xx are real faults:
    // capture them to the error tracker with id-only context (no bodies/PHI).
    if (statusCode >= 500) {
      captureException(handledError, {
        requestId: request.id,
        route: request.routeOptions?.url ?? request.url,
        method: request.method,
        tenantId: request.auth?.tenantId,
        userId: request.auth?.userId,
        statusCode,
      }, request.log);
    } else {
      request.log.warn({ err: error, statusCode }, 'request failed');
    }

    return reply.code(statusCode).send({
      error: handledError.code ?? 'INTERNAL_SERVER_ERROR',
      message: statusCode < 500 ? handledError.message : 'An unexpected error occurred',
      requestId: request.id,
    });
  });
});
