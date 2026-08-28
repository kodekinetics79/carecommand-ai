import { describe, expect, it } from 'vitest';
import {
  createRetellRateStoreManager,
  type FailFastRedisClient,
} from '../lib/receptionist/retellRateStore';

class FakeClient implements FailFastRedisClient {
  status = 'wait';
  connectCalls = 0;
  evalCalls = 0;
  disconnectCalls = 0;

  constructor(
    private readonly connectBehavior: 'ready' | 'hang',
    private readonly evalBehavior: 'success' | 'hang',
  ) {}

  async connect() {
    this.connectCalls += 1;
    if (this.connectBehavior === 'hang') return new Promise<never>(() => {});
    this.status = 'ready';
  }

  async eval() {
    this.evalCalls += 1;
    if (this.evalBehavior === 'hang') return new Promise<never>(() => {});
    return [1, 1];
  }

  disconnect() {
    this.disconnectCalls += 1;
    this.status = 'end';
  }
}

describe('dedicated Retell rate-store lifecycle', () => {
  it('disconnects a never-settling connection, opens the circuit, and recovers with a fresh client', async () => {
    let now = 1_000;
    const hanging = new FakeClient('hang', 'success');
    const recovered = new FakeClient('ready', 'success');
    const clients = [hanging, recovered];
    let created = 0;
    const manager = createRetellRateStoreManager({
      createClient: () => clients[created++],
      now: () => now,
      deadlineMs: 20,
      circuitCooldownMs: 100,
    });

    await expect(manager.store.eval('script', 2, 'tenant', 'call')).rejects.toThrow('deadline');
    expect(hanging.disconnectCalls).toBe(1);
    await expect(manager.store.eval('script', 2, 'tenant', 'call')).rejects.toThrow('circuit open');
    expect(created).toBe(1);

    now += 101;
    await expect(manager.store.eval('script', 2, 'tenant', 'call')).resolves.toEqual([1, 1]);
    expect(created).toBe(2);
    expect(recovered.evalCalls).toBe(1);
    manager.close();
    expect(recovered.disconnectCalls).toBe(1);
  });

  it('disconnects a timed-out EVAL so it cannot queue/replay, then recovers after cooldown', async () => {
    let now = 5_000;
    const stuck = new FakeClient('ready', 'hang');
    const recovered = new FakeClient('ready', 'success');
    const clients = [stuck, recovered];
    let created = 0;
    const manager = createRetellRateStoreManager({
      createClient: () => clients[created++],
      now: () => now,
      deadlineMs: 20,
      circuitCooldownMs: 100,
    });

    await expect(manager.store.eval('script', 2, 'tenant', 'call')).rejects.toThrow('deadline');
    expect(stuck.evalCalls).toBe(1);
    expect(stuck.disconnectCalls).toBe(1);
    await expect(manager.store.eval('script', 2, 'tenant', 'call')).rejects.toThrow('circuit open');
    expect(stuck.evalCalls).toBe(1);

    now += 101;
    await expect(manager.store.eval('script', 2, 'tenant', 'call')).resolves.toEqual([1, 1]);
    expect(recovered.evalCalls).toBe(1);
  });
});
