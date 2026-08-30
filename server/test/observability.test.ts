import 'dotenv/config';
import { describe, it, expect, afterEach } from 'vitest';
import Fastify from 'fastify';
import { loggerOptions, REDACTED } from '../config/logger';
import { captureException, setErrorReporter, hasErrorReporter, type ErrorContext } from '../lib/observability';
import { errorPlugin } from '../plugins/errors';

afterEach(() => {
  setErrorReporter(null);
});

describe('observability — log redaction', () => {
  it('redacts auth/token/password fields from log output', async () => {
    const lines: string[] = [];
    const app = Fastify({ logger: { ...loggerOptions, level: 'info', stream: { write: (s: string) => { lines.push(s); } } } });
    // Flat object so pino's req/res serializers don't interfere — exercises the
    // redact policy directly on the sensitive key shapes it targets.
    app.log.info({ authorization: 'Bearer SUPER_SECRET_TOKEN', password: 'hunter2', token: 'tok_live_xyz', refreshToken: 'rt_secret' }, 'sensitive');
    await app.close();

    const out = lines.join('\n');
    expect(out).not.toContain('SUPER_SECRET_TOKEN');
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('tok_live_xyz');
    expect(out).not.toContain('rt_secret');
    expect(out).toContain(REDACTED);
  });

  /**
   * Request URLs used to be logged verbatim, so a patient search and every
   * single-use patient token landed in application logs at `info`. These are
   * the four shapes that leaked.
   */
  it('never writes a patient name or a one-time token from a request URL', async () => {
    const lines: string[] = [];
    const app = Fastify({ logger: { ...loggerOptions, level: 'info', stream: { write: (s: string) => { lines.push(s); } } } });
    // Own the 404 the way the app does: Fastify's built-in one logs the raw URL.
    app.setNotFoundHandler(async (request, reply) => { reply.code(404).send({ error: 'not_found', message: `Route ${request.method} not found.` }); });
    app.get('/v1/patients', async () => ({ ok: true }));
    app.get('/v1/intake/public/:token', async () => ({ ok: true }));
    await app.inject({ method: 'GET', url: '/v1/patients?search=Jane%20Doe' });
    await app.inject({ method: 'GET', url: '/v1/intake/public/6f1a2b3c4d5e6f708192a3b4c5d6e7f8' });
    // An unrouted path still has to be scrubbed: there is no route template to
    // fall back on for a 404.
    await app.inject({ method: 'GET', url: '/v1/unknown/6f1a2b3c4d5e6f708192a3b4c5d6e7f8?search=Jane%20Doe' });
    await app.close();

    const out = lines.join('\n');
    expect(out).not.toContain('Jane');
    expect(out).not.toContain('6f1a2b3c4d5e6f708192a3b4c5d6e7f8');
    // Still useful: the route template survives, so logs remain diagnosable.
    expect(out).toContain('/v1/intake/public/:token');
  });
});

describe('observability — captureException', () => {
  it('emits a structured exception log with id-only context and no reporter', () => {
    const errors: object[] = [];
    const logger = { error: (o: object) => errors.push(o), warn: () => {} };
    captureException(new Error('boom'), { requestId: 'req-1', tenantId: 't-1', statusCode: 500 }, logger);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ event: 'exception', requestId: 'req-1', tenantId: 't-1', statusCode: 500 });
  });

  it('forwards to a registered reporter with the error and context', () => {
    const seen: Array<{ error: Error; context: ErrorContext }> = [];
    setErrorReporter((error, context) => seen.push({ error, context }));
    expect(hasErrorReporter()).toBe(true);
    const err = new Error('downstream');
    captureException(err, { requestId: 'req-2', userId: 'u-9' }, { error: () => {}, warn: () => {} });
    expect(seen).toHaveLength(1);
    expect(seen[0].error).toBe(err);
    expect(seen[0].context).toMatchObject({ requestId: 'req-2', userId: 'u-9' });
  });

  it('never throws even if the reporter throws', () => {
    setErrorReporter(() => { throw new Error('reporter exploded'); });
    expect(() => captureException(new Error('x'), {}, { error: () => {}, warn: () => {} })).not.toThrow();
  });
});

describe('observability — error handler integration', () => {
  it('captures 5xx through the handler with route/method/status context, and not 4xx', async () => {
    const captured: ErrorContext[] = [];
    setErrorReporter((_error, context) => captured.push(context));

    const app = Fastify({ logger: false });
    await app.register(errorPlugin);
    app.get('/boom', async () => { throw new Error('kaboom'); });
    app.get('/bad', async () => { throw Object.assign(new Error('nope'), { statusCode: 400 }); });

    const five = await app.inject({ method: 'GET', url: '/boom' });
    expect(five.statusCode).toBe(500);
    expect(five.json().message).toBe('An unexpected error occurred'); // no internal leakage

    const four = await app.inject({ method: 'GET', url: '/bad' });
    expect(four.statusCode).toBe(400);
    expect(four.json().message).toBe('nope'); // client errors keep their message

    await app.close();

    expect(captured).toHaveLength(1); // only the 5xx was captured
    expect(captured[0]).toMatchObject({ method: 'GET', route: '/boom', statusCode: 500 });
  });
});
