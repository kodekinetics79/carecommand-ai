import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Job } from 'bullmq';
import { z } from 'zod';
import { env } from '../config/env';
import type { TraceCarrier } from './traceContext';

const VERSION = 1 as const;
export const JOB_ENVELOPE_MAX_AGE_MS = 15 * 60_000;

const envelopeSchema = z.object({
  v: z.literal(VERSION),
  queue: z.enum(['campaign-scheduler', 'compliance-maintenance', 'monitoring-safety', 'eligibility-reconciliation']),
  operation: z.string().min(1).max(80),
  tenantId: z.string().uuid(),
  issuedAt: z.number().int().nonnegative(),
  nonce: z.string().uuid(),
  signature: z.string().regex(/^[a-f0-9]{64}$/),
  _otel: z.record(z.string(), z.string()).optional(),
}).strict();

export type SecureQueueName = z.infer<typeof envelopeSchema>['queue'];
export type TenantJobEnvelope = z.infer<typeof envelopeSchema> & { _otel?: TraceCarrier };

interface EnvelopeInput {
  queue: SecureQueueName;
  operation: string;
  tenantId: string;
  issuedAt?: number;
  nonce?: string;
  _otel?: TraceCarrier;
}

function signingSecret(): string {
  // A dedicated key is preferred. The refresh-token secret is a safe rollout
  // fallback and is domain-separated by the canonical "carecommand-job" tag.
  return env.JOB_ENVELOPE_SECRET ?? env.JWT_REFRESH_SECRET;
}

function canonical(value: Omit<TenantJobEnvelope, 'signature' | '_otel'>): string {
  return ['carecommand-job', value.v, value.queue, value.operation, value.tenantId, value.issuedAt, value.nonce].join('|');
}

function signature(value: Omit<TenantJobEnvelope, 'signature' | '_otel'>): string {
  return createHmac('sha256', signingSecret()).update(canonical(value)).digest('hex');
}

export function tenantJobId(value: Pick<TenantJobEnvelope, 'queue' | 'operation' | 'tenantId' | 'nonce'>): string {
  // BullMQ custom job IDs may not contain ':'. The nonce makes the ID unique;
  // binding it in the signature makes a copied payload with a new ID invalid.
  return `signed-${value.queue}-${value.operation}-${value.tenantId}-${value.nonce}`;
}

export function createTenantJobEnvelope(input: EnvelopeInput): TenantJobEnvelope {
  const unsigned = {
    v: VERSION,
    queue: input.queue,
    operation: input.operation,
    tenantId: input.tenantId,
    issuedAt: input.issuedAt ?? Date.now(),
    nonce: input.nonce ?? randomUUID(),
  } as const;
  return { ...unsigned, signature: signature(unsigned), ...(input._otel ? { _otel: input._otel } : {}) };
}

export function validateTenantJobEnvelope(
  data: unknown,
  expected: { queue: SecureQueueName; operation: string; jobId?: string },
  now = Date.now(),
): TenantJobEnvelope {
  const parsed = envelopeSchema.parse(data) as TenantJobEnvelope;
  if (parsed.queue !== expected.queue || parsed.operation !== expected.operation) {
    throw new Error('Job envelope target mismatch');
  }
  const expectedSignature = signature(parsed);
  const actual = Buffer.from(parsed.signature, 'hex');
  const wanted = Buffer.from(expectedSignature, 'hex');
  if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) {
    throw new Error('Job envelope signature invalid');
  }
  if (parsed.issuedAt > now + 30_000 || now - parsed.issuedAt > JOB_ENVELOPE_MAX_AGE_MS) {
    throw new Error('Job envelope expired or issued in the future');
  }
  if (expected.jobId !== undefined && expected.jobId !== tenantJobId(parsed)) {
    throw new Error('Job envelope replay/job-id mismatch');
  }
  return parsed;
}

export function assertSchedulerTick(
  job: Pick<Job, 'name' | 'repeatJobKey'>,
  expected: { name: string; schedulerId: string },
): void {
  if (job.name !== expected.name || job.repeatJobKey !== expected.schedulerId) {
    throw new Error('Untrusted scheduled-job tick');
  }
}
