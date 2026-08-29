import { afterEach, describe, expect, it, vi } from 'vitest';

// QUEUES_ENABLED=false is the documented Redis-less deployment mode: the app
// boots, request routes work, and background work is simply not enqueued. The
// no-op queue must therefore satisfy every method the product calls on it, or
// the "disabled" contract degrades into a 500 on the approval path.

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function importDisabledQueues() {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('QUEUES_ENABLED', 'false');
  vi.resetModules();
  return import('../workers/queues');
}

describe('queues disabled (Redis-less deployment mode)', () => {
  it('reports an autopilot enqueue as disabled instead of throwing', async () => {
    const queues = await importDisabledQueues();

    const result = await queues.enqueueAutopilotExecution({
      approvalId: '11111111-1111-4111-8111-111111111111',
      tenantId: '22222222-2222-4222-8222-222222222222',
      dispatchAttemptId: '33333333-3333-4333-8333-333333333333',
    });

    expect(result).toEqual({
      state: 'disabled',
      jobId: 'autopilot-approval-11111111-1111-4111-8111-111111111111',
      dispatchAttemptId: '33333333-3333-4333-8333-333333333333',
    });
    await queues.autopilotQueue.close();
  });

  it('resolves the deterministic job lookup to no job rather than crashing', async () => {
    const queues = await importDisabledQueues();

    await expect(queues.autopilotQueue.getJob('autopilot-approval-anything')).resolves.toBeUndefined();
    await queues.autopilotQueue.close();
  });
});
