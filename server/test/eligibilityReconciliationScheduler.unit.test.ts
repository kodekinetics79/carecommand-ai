import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from '../config/env';
import { validateTenantJobEnvelope } from '../lib/jobEnvelope';
import { eligibilityProviderReconciliationCapability } from '../modules/revenue-protection';
import {
  eligibilityReconciliationQueue,
  enqueueEligibilityReconciliationTenantJob,
  registerEligibilityReconciliationSchedule,
} from '../workers/queues';

afterEach(() => vi.restoreAllMocks());

describe('eligibility reconciliation scheduler contract', () => {
  it('upserts one stable scheduler identity at the configured interval', async () => {
    const upsert = vi.spyOn(eligibilityReconciliationQueue, 'upsertJobScheduler').mockResolvedValue({} as never);
    await registerEligibilityReconciliationSchedule();
    expect(upsert).toHaveBeenCalledOnce();
    expect(upsert).toHaveBeenCalledWith(
      'eligibility-reconciliation-scan',
      { every: env.ELIGIBILITY_RECONCILIATION_INTERVAL_SECONDS * 1000 },
      { name: 'scan', data: {} },
    );
  });

  it('enqueues tenant scans only as signed tenant envelopes', async () => {
    const tenantId = '00000000-0000-4000-8000-000000000014';
    const add = vi.spyOn(eligibilityReconciliationQueue, 'add').mockResolvedValue({} as never);
    await enqueueEligibilityReconciliationTenantJob(tenantId);
    const [name, data, options] = add.mock.calls[0]!;
    expect(name).toBe('scan-tenant');
    expect(validateTenantJobEnvelope(data, {
      queue: 'eligibility-reconciliation', operation: 'scan', jobId: options?.jobId,
    }).tenantId).toBe(tenantId);
  });

  it('truthfully reports no verified retrieval API for every shipped adapter and unknown history', () => {
    for (const provider of ['mock', 'stedi', 'availity', 'pverify', 'optum', 'legacy-provider']) {
      expect(eligibilityProviderReconciliationCapability(provider)).toEqual({
        verifiedResponseLookupSupported: false,
        resolutionPath: 'manual_payer_evidence',
      });
    }
  });
});
