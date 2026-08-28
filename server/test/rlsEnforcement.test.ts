import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assertRlsRuntimeRole } from '../lib/rlsGuard';

function roleClient(role: string, isSuper: boolean, bypass: boolean) {
  return {
    $queryRaw: async <T>() => [{ role, super: isSuper, bypass }] as T,
  };
}

describe('RLS enforcement', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('production + unsafe role + flag unset throws', async () => {
    await expect(
      assertRlsRuntimeRole({ isProduction: true, client: roleClient('owner', false, true) }),
    ).rejects.toThrow(/BYPASSES row-level security/);
  });

  it('production + unsafe role + RLS_ENFORCE_RUNTIME_ROLE=false still throws', async () => {
    await expect(
      assertRlsRuntimeRole({
        isProduction: true,
        enforce: false,
        client: roleClient('postgres', true, false),
      }),
    ).rejects.toThrow(/BYPASSES row-level security/);
  });

  it('production + verification failure throws', async () => {
    await expect(
      assertRlsRuntimeRole({
        isProduction: true,
        client: {
          $queryRaw: async () => {
            throw new Error('db unavailable');
          },
        },
      }),
    ).rejects.toThrow(/could not verify the DB role at boot/i);
  });

  it('development + unsafe role + flag unset warns and continues', async () => {
    const warns: string[] = [];
    const status = await assertRlsRuntimeRole({
      isProduction: false,
      client: roleClient('owner', false, true),
      logger: { warn: (message: string) => warns.push(message), error: () => {} },
    });

    expect(status.bypassesRls).toBe(true);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('BYPASSES row-level security');
  });

  it('development + unsafe role + RLS_ENFORCE_RUNTIME_ROLE=true throws', async () => {
    await expect(
      assertRlsRuntimeRole({
        isProduction: false,
        enforce: true,
        client: roleClient('postgres', true, false),
      }),
    ).rejects.toThrow(/BYPASSES row-level security/);
  });

  it('worker boot path uses the same guard behavior', async () => {
    vi.resetModules();

    const guard = vi.fn().mockRejectedValue(new Error('guard blocked boot'));
    vi.doMock('../config/env', () => ({
      env: {
        QUEUES_ENABLED: true,
        METRICS_ENABLED: false,
        REDIS_URL: 'redis://localhost:6379',
      },
    }));
    vi.doMock('../lib/db', () => ({ db: { $disconnect: vi.fn() } }));
    vi.doMock('../lib/observability', () => ({
      registerSentry: vi.fn().mockResolvedValue(true),
      captureException: vi.fn(),
    }));
    vi.doMock('../lib/metrics', () => ({
      sampleQueueDepths: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('../lib/rlsGuard', () => ({ assertRlsRuntimeRole: guard }));
    vi.doMock('../workers/queues', () => ({
      autopilotQueue: { close: vi.fn().mockResolvedValue(undefined) },
      campaignQueue: { close: vi.fn().mockResolvedValue(undefined), upsertJobScheduler: vi.fn().mockResolvedValue(undefined) },
      complianceQueue: { close: vi.fn().mockResolvedValue(undefined), upsertJobScheduler: vi.fn().mockResolvedValue(undefined) },
      registerCampaignSchedules: vi.fn().mockResolvedValue(undefined),
      registerComplianceSchedules: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('../workers/autopilot.worker', () => ({ createAutopilotWorker: vi.fn(() => ({ close: vi.fn() })) }));
    vi.doMock('../workers/campaign.worker', () => ({ createCampaignWorker: vi.fn(() => ({ close: vi.fn() })) }));
    vi.doMock('../workers/compliance.worker', () => ({ createComplianceWorker: vi.fn(() => ({ close: vi.fn() })) }));
    vi.doMock('../workers/metricsServer', () => ({ startWorkerMetricsServer: vi.fn(() => null) }));
    vi.doMock('../workers/otelDefaults', () => ({}));

    const { startWorkers } = await import('../workers/index');

    await expect(startWorkers()).rejects.toThrow('guard blocked boot');
    expect(guard).toHaveBeenCalledTimes(1);
    expect(guard).toHaveBeenCalledWith();
  });
});
