import { afterEach, describe, expect, it, vi } from 'vitest';
import { envSchema } from '../config/env';

// ===========================================================================
// The dialler's configuration, including the path that is actually dangerous.
//
// A flag that is only ever tested in its default state is a flag nobody has
// tested. The default here is OFF, so the ON path — the one where a scheduler
// gets registered and phones start ringing on a timer — is the one that needs
// a test, and it gets one below.
//
// `z.coerce.boolean()` is banned in this codebase because it turns the string
// "false" into `true`. On this particular flag that mistake means a deployment
// that explicitly disabled automatic dialling would dial, so the string
// "false" is asserted directly rather than trusted.
// ===========================================================================

const base = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  JWT_SECRET: 'x'.repeat(32),
  JWT_REFRESH_SECRET: 'y'.repeat(32),
  ELIGIBILITY_HMAC_SECRET: 'e'.repeat(32),
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('outbound dialler configuration', () => {
  it('is off unless a deployment says otherwise', () => {
    const parsed = envSchema.safeParse({ ...base });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.RECEPTIONIST_OUTBOUND_DIAL_ENABLED).toBe(false);
  });

  it('reads the string "false" as false, not as a non-empty truthy string', () => {
    const parsed = envSchema.safeParse({ ...base, RECEPTIONIST_OUTBOUND_DIAL_ENABLED: 'false' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.RECEPTIONIST_OUTBOUND_DIAL_ENABLED).toBe(false);
  });

  it('reads the string "true" as true', () => {
    const parsed = envSchema.safeParse({ ...base, RECEPTIONIST_OUTBOUND_DIAL_ENABLED: 'true' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.RECEPTIONIST_OUTBOUND_DIAL_ENABLED).toBe(true);
  });

  it('refuses a tick interval outside the sane band', () => {
    expect(envSchema.safeParse({ ...base, RECEPTIONIST_OUTBOUND_DIAL_INTERVAL_SECONDS: '1' }).success).toBe(false);
    expect(envSchema.safeParse({ ...base, RECEPTIONIST_OUTBOUND_DIAL_INTERVAL_SECONDS: '86400' }).success).toBe(false);
    expect(envSchema.safeParse({ ...base, RECEPTIONIST_OUTBOUND_DIAL_INTERVAL_SECONDS: '30' }).success).toBe(true);
  });

  it('does not upsert a scheduler while dialling is disabled', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('QUEUES_ENABLED', 'false');
    vi.stubEnv('RECEPTIONIST_OUTBOUND_DIAL_ENABLED', 'false');
    vi.resetModules();
    const queues = await import('../workers/queues');
    const upsert = vi.spyOn(queues.receptionistOutboundDialQueue, 'upsertJobScheduler');

    await queues.registerReceptionistOutboundDialSchedule();

    expect(upsert).not.toHaveBeenCalled();
    await queues.receptionistOutboundDialQueue.close();
  });

  // The path that matters. With the flag on, the repeatable scan is registered
  // at exactly the configured cadence — not a hardcoded one, and not silently
  // skipped.
  it('registers the scan at the configured cadence when dialling is enabled', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('QUEUES_ENABLED', 'false');
    vi.stubEnv('RECEPTIONIST_OUTBOUND_DIAL_ENABLED', 'true');
    vi.stubEnv('RECEPTIONIST_OUTBOUND_DIAL_INTERVAL_SECONDS', '45');
    vi.resetModules();
    const queues = await import('../workers/queues');
    const upsert = vi.spyOn(queues.receptionistOutboundDialQueue, 'upsertJobScheduler');

    await queues.registerReceptionistOutboundDialSchedule();

    expect(upsert).toHaveBeenCalledWith(
      'receptionist-outbound-dial-scan',
      { every: 45_000 },
      { name: 'scan', data: {} },
    );
    await queues.receptionistOutboundDialQueue.close();
  });

  it('is listed in the queue registry, so teardown and depth sampling cannot miss it', async () => {
    vi.stubEnv('QUEUES_ENABLED', 'false');
    vi.resetModules();
    const queues = await import('../workers/queues');
    expect(queues.ALL_QUEUES).toContain(queues.receptionistOutboundDialQueue);
    expect(queues.ALL_QUEUES.map(queue => queue.name)).toContain('receptionist-outbound-dial');
  });
});
