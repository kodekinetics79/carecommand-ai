import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  assertSchedulerTick,
  createTenantJobEnvelope,
  JOB_ENVELOPE_MAX_AGE_MS,
  tenantJobId,
  validateTenantJobEnvelope,
} from '../lib/jobEnvelope';

const tenantId = randomUUID();

describe('signed tenant job envelopes', () => {
  it('accepts a fresh envelope only for its signed queue, operation, tenant, and BullMQ job ID', () => {
    const issuedAt = Date.now();
    const envelope = createTenantJobEnvelope({
      queue: 'campaign-scheduler', operation: 'dispatch-scheduled', tenantId, issuedAt,
      _otel: { traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01' },
    });
    const parsed = validateTenantJobEnvelope(envelope, {
      queue: 'campaign-scheduler', operation: 'dispatch-scheduled', jobId: tenantJobId(envelope),
    }, issuedAt + 1);

    expect(parsed.tenantId).toBe(tenantId);
    expect(JSON.stringify(envelope)).not.toContain(process.env.JOB_ENVELOPE_SECRET ?? process.env.JWT_REFRESH_SECRET);
  });

  it.each([
    ['tenant', (value: ReturnType<typeof createTenantJobEnvelope>) => ({ ...value, tenantId: randomUUID() })],
    ['operation', (value: ReturnType<typeof createTenantJobEnvelope>) => ({ ...value, operation: 'vendor-review-reminder' })],
    ['signature', (value: ReturnType<typeof createTenantJobEnvelope>) => ({ ...value, signature: '0'.repeat(64) })],
  ] as const)('rejects a payload with a tampered %s', (_field, mutate) => {
    const envelope = createTenantJobEnvelope({ queue: 'compliance-maintenance', operation: 'readiness-recalc', tenantId });
    expect(() => validateTenantJobEnvelope(mutate(envelope), {
      queue: 'compliance-maintenance', operation: 'readiness-recalc', jobId: tenantJobId(envelope),
    })).toThrow();
  });

  it('rejects replaying a valid envelope under a different BullMQ job ID', () => {
    const envelope = createTenantJobEnvelope({ queue: 'monitoring-safety', operation: 'missed-reading-scan', tenantId });
    expect(() => validateTenantJobEnvelope(envelope, {
      queue: 'monitoring-safety', operation: 'missed-reading-scan', jobId: `copied-${tenantJobId(envelope)}`,
    })).toThrow('replay/job-id mismatch');
  });

  it('rejects stale and future-dated envelopes while permitting normal retry age', () => {
    const now = Date.now();
    const retry = createTenantJobEnvelope({ queue: 'monitoring-safety', operation: 'device-offline-scan', tenantId, issuedAt: now - 60_000 });
    expect(() => validateTenantJobEnvelope(retry, {
      queue: 'monitoring-safety', operation: 'device-offline-scan', jobId: tenantJobId(retry),
    }, now)).not.toThrow();

    const stale = createTenantJobEnvelope({ queue: 'monitoring-safety', operation: 'device-offline-scan', tenantId, issuedAt: now - JOB_ENVELOPE_MAX_AGE_MS - 1 });
    expect(() => validateTenantJobEnvelope(stale, {
      queue: 'monitoring-safety', operation: 'device-offline-scan', jobId: tenantJobId(stale),
    }, now)).toThrow('expired or issued in the future');

    const future = createTenantJobEnvelope({ queue: 'monitoring-safety', operation: 'device-offline-scan', tenantId, issuedAt: now + 30_001 });
    expect(() => validateTenantJobEnvelope(future, {
      queue: 'monitoring-safety', operation: 'device-offline-scan', jobId: tenantJobId(future),
    }, now)).toThrow('expired or issued in the future');
  });
});

describe('scheduler tick provenance', () => {
  it('accepts only the operation/scheduler-id pair installed by upsertJobScheduler', () => {
    expect(() => assertSchedulerTick(
      { name: 'readiness-recalc', repeatJobKey: 'compliance-readiness-recalc' },
      { name: 'readiness-recalc', schedulerId: 'compliance-readiness-recalc' },
    )).not.toThrow();
    expect(() => assertSchedulerTick(
      { name: 'readiness-recalc', repeatJobKey: undefined },
      { name: 'readiness-recalc', schedulerId: 'compliance-readiness-recalc' },
    )).toThrow('Untrusted scheduled-job tick');
    expect(() => assertSchedulerTick(
      { name: 'vendor-review-reminder', repeatJobKey: 'compliance-readiness-recalc' },
      { name: 'readiness-recalc', schedulerId: 'compliance-readiness-recalc' },
    )).toThrow('Untrusted scheduled-job tick');
  });
});
