import 'dotenv/config';

import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

const { fixtureDb } = await import('./helpers/fixtureDb');
const { applyCampaignDeliveryWebhook } = await import('../lib/campaignDeliveryWebhook');
const { runInTenantContext } = await import('../lib/tenantContext');

const tenantIds: string[] = [];

async function fixture(status = 'queued') {
  const tenantId = randomUUID();
  tenantIds.push(tenantId);
  await fixtureDb.tenant.create({ data: { id: tenantId, name: `campaign-webhook-${tenantId.slice(0, 8)}`, slug: `campaign-webhook-${tenantId.slice(0, 8)}` } });
  const campaign = await fixtureDb.campaign.create({ data: {
    tenantId, name: 'Receipt test', goal: 'test', status: 'ACTIVE', channels: [],
    campaignType: 'custom', audienceType: 'inactive_patients', campaignChannel: 'sms',
  } });
  const delivery = await fixtureDb.campaignDelivery.create({ data: {
    tenantId, campaignId: campaign.id, channel: 'sms', status,
    provider: 'twilio', providerMessageId: `SM_${randomUUID()}`,
  } });
  return { tenantId, campaign, delivery };
}

function apply(input: Parameters<typeof applyCampaignDeliveryWebhook>[0]) {
  return runInTenantContext({ tenantId: input.tenantId, actorId: 'webhook:campaign:test', actorRole: 'WEBHOOK', source: 'webhook' }, () => applyCampaignDeliveryWebhook(input));
}

async function installAuditFault(resourceId: string) {
  const suffix = randomUUID().replaceAll('-', '');
  const functionName = `test_campaign_audit_fault_${suffix}`;
  const triggerName = `test_campaign_audit_fault_${suffix}`;
  await fixtureDb.$executeRawUnsafe(`
    CREATE FUNCTION "${functionName}"() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.resource = 'campaignDelivery' AND NEW."resourceId" = '${resourceId}' THEN
        RAISE EXCEPTION 'synthetic campaign audit failure';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER "${triggerName}" BEFORE INSERT ON "AuditEvent"
      FOR EACH ROW EXECUTE FUNCTION "${functionName}"();
  `);
  return async () => {
    await fixtureDb.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON "AuditEvent"; DROP FUNCTION IF EXISTS "${functionName}"();`);
  };
}

afterAll(async () => {
  await fixtureDb.idempotencyKey.deleteMany({ where: { tenantId: { in: tenantIds } } }).catch(() => undefined);
  for (const tenantId of tenantIds) await fixtureDb.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
  await fixtureDb.$disconnect();
});

describe('campaign delivery webhook durable state', () => {
  it('atomically applies one event, acknowledges its replay, and rejects a regression', async () => {
    const f = await fixture();
    const first = await apply({
      tenantId: f.tenantId, deliveryId: f.delivery.id, providerMessageId: f.delivery.providerMessageId!,
      eventId: 'evt-accepted', providerStatus: 'accepted', normalizedStatus: 'accepted', requestId: 'req-accepted',
    });
    expect(first).toMatchObject({ duplicate: false, applied: true, transition: 'applied', status: 'accepted' });

    const duplicate = await apply({
      tenantId: f.tenantId, deliveryId: f.delivery.id, providerMessageId: f.delivery.providerMessageId!,
      eventId: 'evt-accepted', providerStatus: 'accepted', normalizedStatus: 'accepted', requestId: 'req-replay',
    });
    expect(duplicate).toMatchObject({ duplicate: true, applied: false, transition: 'duplicate_event', status: 'accepted' });

    const regression = await apply({
      tenantId: f.tenantId, deliveryId: f.delivery.id, providerMessageId: f.delivery.providerMessageId!,
      eventId: 'evt-queued-late', providerStatus: 'queued', normalizedStatus: 'queued', requestId: 'req-regression',
    });
    expect(regression).toMatchObject({ duplicate: false, applied: false, transition: 'rejected_regression', status: 'accepted' });
    expect((await fixtureDb.campaignDelivery.findUniqueOrThrow({ where: { id: f.delivery.id } })).status).toBe('accepted');
    expect(await fixtureDb.idempotencyKey.count({ where: { tenantId: f.tenantId } })).toBe(2);
    expect(await fixtureDb.auditEvent.count({ where: { tenantId: f.tenantId, resourceId: f.delivery.id } })).toBe(2);
  });

  it('keeps terminal delivery evidence from being rewritten', async () => {
    const f = await fixture('accepted');
    await apply({ tenantId: f.tenantId, deliveryId: f.delivery.id, providerMessageId: f.delivery.providerMessageId!, eventId: 'evt-delivered', providerStatus: 'delivered', normalizedStatus: 'delivered' });
    const lateFailure = await apply({ tenantId: f.tenantId, deliveryId: f.delivery.id, providerMessageId: f.delivery.providerMessageId!, eventId: 'evt-failed-late', providerStatus: 'bounced', normalizedStatus: 'failed' });
    expect(lateFailure).toMatchObject({ applied: false, transition: 'rejected_terminal', status: 'delivered' });
    const stored = await fixtureDb.campaignDelivery.findUniqueOrThrow({ where: { id: f.delivery.id } });
    expect(stored.status).toBe('delivered');
    expect(stored.deliveredAt).not.toBeNull();
    expect(stored.failureReason).toBeNull();
  });

  it('rolls back the idempotency claim and state when audit persistence fails, allowing retry', async () => {
    const f = await fixture();
    const removeFault = await installAuditFault(f.delivery.id);
    const input = { tenantId: f.tenantId, deliveryId: f.delivery.id, providerMessageId: f.delivery.providerMessageId!, eventId: 'evt-crash-retry', providerStatus: 'delivered', normalizedStatus: 'delivered' as const };
    await expect(apply(input)).rejects.toThrow('synthetic campaign audit failure');
    expect((await fixtureDb.campaignDelivery.findUniqueOrThrow({ where: { id: f.delivery.id } })).status).toBe('queued');
    expect(await fixtureDb.idempotencyKey.count({ where: { tenantId: f.tenantId, key: input.eventId } })).toBe(0);

    await removeFault();
    await expect(apply(input)).resolves.toMatchObject({ duplicate: false, applied: true, status: 'delivered' });
    expect(await fixtureDb.idempotencyKey.count({ where: { tenantId: f.tenantId, key: input.eventId } })).toBe(1);
    expect(await fixtureDb.auditEvent.count({ where: { tenantId: f.tenantId, resourceId: f.delivery.id } })).toBe(1);
  });
});
