import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { errorPlugin } from '../plugins/errors';

describe('HTTP error classification', () => {
  it.each([409, 403, 404])('does not describe expected HTTP %s as an internal failure', async statusCode => {
    const app = Fastify();
    await app.register(errorPlugin);
    app.get('/test', async () => { throw Object.assign(new Error('Request cannot proceed'), { statusCode }); });
    try {
      const response = await app.inject('/test');
      expect(response.statusCode).toBe(statusCode);
      expect(response.json()).toMatchObject({ error: `HTTP_${statusCode}`, message: 'Request cannot proceed' });
    } finally { await app.close(); }
  });

  it('preserves an explicit domain error code', async () => {
    const app = Fastify();
    await app.register(errorPlugin);
    app.get('/test', async () => { throw Object.assign(new Error('Already assigned'), { statusCode: 409, code: 'DESTINATION_CONFLICT' }); });
    try {
      expect((await app.inject('/test')).json()).toMatchObject({ error: 'DESTINATION_CONFLICT' });
    } finally { await app.close(); }
  });
});
