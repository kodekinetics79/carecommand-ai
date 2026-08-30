import type { Prisma, PrismaClient } from '../generated/prisma/client';

/**
 * Period-keyed usage metering.
 *
 * The quota this feeds used to be enforced against lifetime counters that
 * nothing ever reset, so a clinic on 500 included voice minutes stopped
 * answering patient calls permanently once it had used them - part-way through
 * month two, with a 402 and no warning. Everything here exists to make "used"
 * mean "used THIS period".
 *
 * Two rules hold the ledger honest:
 *   - `occurredAt` is provider truth (when the call ended), never ingest time,
 *     so a late redelivery lands in the period the work actually happened in.
 *   - every write carries a `dedupeKey`, and the unique index is what stops a
 *     redelivered webhook billing the same minute twice. Provider redelivery is
 *     routine, so care is not a strategy.
 */

export const USAGE_METRICS = {
  voiceMinute: 'voice_minute',
  smsSend: 'sms_send',
  emailSend: 'email_send',
  aiToken: 'ai_token',
} as const;

export type UsageMetric = (typeof USAGE_METRICS)[keyof typeof USAGE_METRICS];

/** Which TenantUsageLimit key a metric is capped by, where one exists. */
export const USAGE_LIMIT_KEY_BY_METRIC: Partial<Record<UsageMetric, string>> = {
  [USAGE_METRICS.voiceMinute]: 'voice_minutes',
  [USAGE_METRICS.smsSend]: 'sms',
};

type Client = PrismaClient | Prisma.TransactionClient;

/**
 * Billing period = calendar month in UTC.
 *
 * Deliberately not the subscription's own period: nothing rolls
 * TenantSubscription.currentPeriodEnd today, so anchoring to it would make the
 * quota depend on a field that silently goes stale. A calendar month is
 * predictable for the clinic, obvious in an invoice, and easy to reconcile.
 * When subscription periods are made to roll, this is the one place to change.
 */
export function usagePeriodKey(at: Date): string {
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`;
}

export interface UsageEventInput {
  tenantId: string;
  metric: UsageMetric;
  /** Whole units. Minutes are rounded up at source, so this is already billable. */
  quantity: number;
  /** When the work happened, per the provider. */
  occurredAt: Date;
  sourceModule: string;
  sourceType: string;
  sourceId?: string | null;
  /**
   * Stable across redeliveries of the SAME work, and different across genuine
   * additional work. For voice this is the call id plus the cumulative minute
   * total, so a call that runs longer bills only the increment.
   */
  dedupeKey: string;
  /** What this cost us. Platform-only; never returned to a tenant. */
  providerCostUsd?: number | null;
}

/**
 * Record usage. Safe to call twice with the same dedupeKey: the second call is
 * a no-op rather than an error, because the caller is usually a webhook handler
 * that must still acknowledge the redelivery.
 *
 * Call this inside the same transaction as the work it describes. Usage written
 * on its own connection can survive a rollback and bill for a call that never
 * landed.
 */
export async function recordUsageEvent(client: Client, input: UsageEventInput): Promise<void> {
  if (!Number.isFinite(input.quantity) || input.quantity <= 0) return;
  await client.usageEvent.createMany({
    data: [{
      tenantId: input.tenantId,
      metric: input.metric,
      quantity: Math.max(0, Math.round(input.quantity)),
      occurredAt: input.occurredAt,
      periodKey: usagePeriodKey(input.occurredAt),
      sourceModule: input.sourceModule,
      sourceType: input.sourceType,
      sourceId: input.sourceId ?? null,
      dedupeKey: input.dedupeKey,
      providerCostUsd: input.providerCostUsd ?? null,
    }],
    skipDuplicates: true,
  });
}

/** Total of one metric for one tenant in one period. Zero when nothing is recorded. */
export async function periodUsageTotal(
  client: Client,
  tenantId: string,
  metric: UsageMetric,
  at: Date = new Date(),
): Promise<number> {
  const result = await client.usageEvent.aggregate({
    where: { tenantId, metric, periodKey: usagePeriodKey(at) },
    _sum: { quantity: true },
  });
  return result._sum.quantity ?? 0;
}

/** Every metric's total for a tenant in one period, for the usage console. */
export async function periodUsageByMetric(
  client: Client,
  tenantId: string,
  at: Date = new Date(),
): Promise<Record<string, number>> {
  const rows = await client.usageEvent.groupBy({
    by: ['metric'],
    where: { tenantId, periodKey: usagePeriodKey(at) },
    _sum: { quantity: true },
  });
  return Object.fromEntries(rows.map(row => [row.metric, row._sum.quantity ?? 0]));
}

/**
 * The dedupe key for a voice call's cumulative minutes. A call that ends at 4
 * minutes and is later corrected to 6 produces two events (4 then 2) and two
 * distinct keys; a redelivery of either produces neither.
 */
export function voiceCallDedupeKey(providerCallId: string, cumulativeMinutes: number): string {
  return `voice:${providerCallId}:${cumulativeMinutes}`;
}
