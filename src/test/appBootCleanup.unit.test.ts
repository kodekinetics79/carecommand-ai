import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { withAppCleanupOnFailure } from '../../server/lib/appBootCleanup';

describe('application boot cleanup', () => {
  it('closes the partially initialized app when a later boot step fails', async () => {
    let closeCount = 0;
    const app = { close: async () => { closeCount += 1; } };

    await expect(withAppCleanupOnFailure(app, async () => {
      throw new Error('later plugin failed');
    })).rejects.toThrow('later plugin failed');
    expect(closeCount).toBe(1);
  });

  it('runs Fastify onClose hooks after a plugin fails during registration', async () => {
    const app = Fastify({ logger: false });
    let resourceClosed = 0;
    app.addHook('onClose', async () => { resourceClosed += 1; });

    await expect(withAppCleanupOnFailure(app, async () => {
      await app.register(async () => { throw new Error('registration failed'); });
      await app.ready();
    })).rejects.toThrow('registration failed');
    expect(resourceClosed).toBe(1);
  });
});
