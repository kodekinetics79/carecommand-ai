import { db } from './db';
import { campaignDeliveryTransition, type ProviderDeliveryStatus } from './campaignIntegrity';

export type CampaignDeliveryWebhookInput = {
  tenantId: string;
  deliveryId: string;
  providerMessageId: string;
  eventId: string;
  providerStatus: string;
  normalizedStatus: ProviderDeliveryStatus;
  requestId?: string;
  ipAddress?: string;
};

export type CampaignDeliveryWebhookResult = {
  received: true;
  duplicate: boolean;
  applied: boolean;
  transition: string;
  status: string;
};

/**
 * Atomically records the provider event idempotency claim, status transition,
 * and audit evidence. A failure at any point rolls the claim back, so provider
 * retry after a crash remains processable.
 */
export async function applyCampaignDeliveryWebhook(input: CampaignDeliveryWebhookInput): Promise<CampaignDeliveryWebhookResult> {
  const scope = `campaign.delivery.webhook:${input.tenantId}`;
  return db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`campaign-delivery-event:${input.tenantId}:${input.eventId}`})::bigint)`;

    const existingEvent = await tx.idempotencyKey.findUnique({ where: { scope_key: { scope, key: input.eventId } } });
    if (existingEvent) {
      const [, status = 'unknown'] = (existingEvent.resultId ?? '').split(':');
      return { received: true, duplicate: true, applied: false, transition: 'duplicate_event', status };
    }

    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`campaign-delivery:${input.tenantId}:${input.deliveryId}`})::bigint)`;
    const delivery = await tx.campaignDelivery.findFirst({
      where: { id: input.deliveryId, tenantId: input.tenantId, providerMessageId: input.providerMessageId },
    });
    if (!delivery) throw new Error('CAMPAIGN_DELIVERY_NOT_FOUND');

    const decision = campaignDeliveryTransition(delivery.status, input.normalizedStatus);
    const now = new Date();
    if (decision.applied) {
      await tx.campaignDelivery.update({
        where: { id: delivery.id },
        data: {
          status: decision.resultingStatus,
          statusUpdatedAt: now,
          failureReason: decision.resultingStatus === 'failed' ? input.providerStatus : null,
          providerAcceptedAt: decision.resultingStatus === 'accepted' || decision.resultingStatus === 'delivered'
            ? delivery.providerAcceptedAt ?? delivery.sentAt ?? now
            : delivery.providerAcceptedAt,
          deliveredAt: decision.resultingStatus === 'delivered' ? now : delivery.deliveredAt,
        },
      });
    }

    // The claim and audit are in this same transaction. No catch-and-ignore is
    // allowed here because a missing audit row would make the evidence incomplete.
    await tx.auditEvent.create({ data: {
      tenantId: input.tenantId,
      action: decision.applied ? 'campaign.delivery.webhook.applied' : `campaign.delivery.webhook.${decision.outcome}`,
      resource: 'campaignDelivery',
      resourceId: delivery.id,
      requestId: input.requestId,
      ipAddress: input.ipAddress,
      metadata: {
        providerStatus: input.providerStatus.toLowerCase(),
        normalizedStatus: input.normalizedStatus,
        priorStatus: decision.priorStatus,
        resultingStatus: decision.resultingStatus,
        applied: decision.applied,
      },
    } });
    await tx.idempotencyKey.create({
      data: { tenantId: input.tenantId, scope, key: input.eventId, resultId: `${decision.outcome}:${decision.resultingStatus}` },
    });

    return {
      received: true,
      duplicate: false,
      applied: decision.applied,
      transition: decision.outcome,
      status: decision.resultingStatus,
    };
  });
}
