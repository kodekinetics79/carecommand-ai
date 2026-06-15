import { db } from './db';
import { buildAudience, isSuppressed, channelStatus, maskDestination, type AudienceType, type CommChannel } from './campaigns';
import { sendMessage } from './commsProvider';
import { emitBusinessEvent } from './intelligence';

// ===========================================================================
// Campaign dispatch: builds the audience, really sends through the provider
// abstraction (or dev mock / setup_required), writes idempotent delivery rows,
// and emits one PHI-safe BusinessEvent per recipient. Shared by the launch
// route and the scheduler worker.
// ===========================================================================

export interface DispatchSummary { total: number; sent: number; suppressed: number; skipped: number; setupRequired: number; pending: number; failed: number }

function renderBody(template: string | null, name: string, clinicName: string): { subject: string; body: string } {
  const firstName = (name || 'there').split(' ')[0];
  const body = (template ?? 'Hi {{firstName}}, a message from {{clinicName}}.').replace(/\{\{firstName\}\}/g, firstName).replace(/\{\{clinicName\}\}/g, clinicName);
  return { subject: `${clinicName}`, body };
}

export async function dispatchCampaign(tenantId: string, campaignId: string, opts: { force?: boolean; clinicName?: string } = {}): Promise<DispatchSummary & { channel: CommChannel; provider: ReturnType<typeof channelStatus> }> {
  const campaign = await db.campaign.findFirstOrThrow({ where: { id: campaignId, tenantId } });
  const channel = (campaign.campaignChannel ?? 'sms') as CommChannel;
  const status = channelStatus(channel);
  const audienceType = campaign.audienceType as AudienceType;
  const clinicName = opts.clinicName ?? (await db.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }))?.name ?? 'your clinic';
  const candidates = await buildAudience(tenantId, audienceType);

  const s: DispatchSummary = { total: candidates.length, sent: 0, suppressed: 0, skipped: 0, setupRequired: 0, pending: 0, failed: 0 };

  for (const cand of candidates) {
    const contact = channel === 'email' ? cand.email : cand.phone;
    const key = `${campaignId}:${cand.patientId ?? cand.leadId ?? 'x'}:${channel}`;
    const existing = await db.campaignDelivery.findFirst({ where: { tenantId, campaignId, patientId: cand.patientId, leadId: cand.leadId, channel } });
    // Idempotent: never resend an already-sent recipient unless forced.
    if (existing && existing.status === 'sent' && !opts.force) { s.sent++; continue; }

    let deliveryStatus: string;
    let providerMessageId: string | null = existing?.providerMessageId ?? null;
    let failureReason: string | null = null;
    if (await isSuppressed(tenantId, cand, channel)) {
      deliveryStatus = 'suppressed';
    } else if (!contact) {
      deliveryStatus = 'skipped';
    } else {
      const { subject, body } = renderBody(campaign.messageTemplate, cand.name, clinicName);
      const result = await sendMessage(channel, contact, subject, body, key); // real provider / dev mock / setup_required
      deliveryStatus = result.status; // sent | pending | failed | setup_required
      providerMessageId = result.providerMessageId ?? providerMessageId;
      failureReason = result.failureReason ?? null;
    }

    const data = { status: deliveryStatus, destinationMasked: maskDestination(contact), provider: status.provider, providerMessageId, failureReason, idempotencyKey: key, sentAt: deliveryStatus === 'sent' ? new Date() : existing?.sentAt ?? null };
    const delivery = existing
      ? await db.campaignDelivery.update({ where: { id: existing.id }, data })
      : await db.campaignDelivery.create({ data: { tenantId, campaignId, patientId: cand.patientId, leadId: cand.leadId, channel, ...data } });

    if (deliveryStatus === 'sent') s.sent++;
    else if (deliveryStatus === 'suppressed') s.suppressed++;
    else if (deliveryStatus === 'skipped') s.skipped++;
    else if (deliveryStatus === 'setup_required') s.setupRequired++;
    else if (deliveryStatus === 'failed') s.failed++;
    else s.pending++;

    // One PHI-safe BusinessEvent per recipient (ids/status only — no destination).
    if (deliveryStatus === 'sent' || deliveryStatus === 'failed' || deliveryStatus === 'suppressed') {
      await emitBusinessEvent(tenantId, { eventType: `campaign.delivery.${deliveryStatus}` as 'campaign.delivery.sent', entityType: 'campaignDelivery', entityId: delivery.id, sourceModule: 'crm', payload: { campaignId, channel, status: deliveryStatus } }).catch(() => {});
    }
  }

  const newStatus = s.sent > 0 ? 'ACTIVE' : 'SCHEDULED';
  await db.campaign.update({ where: { id: campaignId }, data: { status: newStatus as never, audienceSize: candidates.length, sent: s.sent } });
  return { ...s, channel, provider: status };
}
