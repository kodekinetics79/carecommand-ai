import fp from 'fastify-plugin';
import { ZodError } from 'zod';
import { captureException } from '../lib/observability';

export interface ValidationDetails {
  /** Keyed by the full dotted path ("bookingRules.hoursStart"), one list per field. */
  fieldErrors: Record<string, string[]>;
  /** Issues with no path (object-level refinements). */
  formErrors: string[];
}

/**
 * Flattens a ZodError keyed by the FULL path. `error.flatten()` only keys by
 * the top-level property, so a nested failure ("bookingRules.hoursStart")
 * would be reported against "bookingRules" and the client could not point at
 * the input that is actually wrong.
 */
export function validationDetails(error: ZodError): ValidationDetails {
  const fieldErrors: Record<string, string[]> = {};
  const formErrors: string[] = [];
  for (const issue of error.issues) {
    const path = issue.path.map(segment => (typeof segment === 'symbol' ? segment.description ?? '' : String(segment))).join('.');
    if (!path) {
      formErrors.push(issue.message);
      continue;
    }
    (fieldErrors[path] ??= []).push(issue.message);
  }
  return { fieldErrors, formErrors };
}

/**
 * One sentence naming the first failing field, e.g. "phone: Phone must include
 * country code in E.164 format". The bare "Request validation failed" told a
 * clinic user nothing about what to change.
 */
export function validationMessage(details: ValidationDetails): string {
  const first = Object.entries(details.fieldErrors)[0];
  if (first) return `${first[0]}: ${first[1][0]}`;
  if (details.formErrors[0]) return details.formErrors[0];
  return 'Request validation failed';
}

export const errorPlugin = fp(async app => {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      const details = validationDetails(error);
      return reply.code(400).send({
        error: 'VALIDATION_ERROR',
        message: validationMessage(details),
        requestId: request.id,
        details,
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
