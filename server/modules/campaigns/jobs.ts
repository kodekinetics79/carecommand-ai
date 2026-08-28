import { db } from '../../lib/db';
import { channelStatus, type CommChannel } from '../../lib/campaigns';
import { dispatchCampaign } from '../../lib/campaignDispatch';

// ===========================================================================
// Scheduled campaign dispatch. Processes ONLY approved SCHEDULED campaigns whose
// scheduledAt has passed, respects quiet hours, and never sends when the channel
// provider is unconfigured. Idempotent: dispatchCampaign won't resend already-sent
// recipients, and a dispatched campaign moves to ACTIVE so it isn't picked again.
// ===========================================================================

// quietHours: { start: "HH:MM", end: "HH:MM" } (server local time). A window that
// wraps past midnight (e.g. 21:00–08:00) is supported.
export function isWithinQuietHours(quietHours: unknown, now: Date): boolean {
  if (!quietHours || typeof quietHours !== 'object') return false;
  const q = quietHours as { start?: string; end?: string };
  if (!q.start || !q.end) return false;
  const toMin = (s: string) => { const [h, m] = s.split(':').map(Number); return (h ?? 0) * 60 + (m ?? 0); };
  const cur = now.getHours() * 60 + now.getMinutes();
  const start = toMin(q.start); const end = toMin(q.end);
  return start <= end ? cur >= start && cur < end : cur >= start || cur < end;
}

export async function runScheduledCampaigns(now: Date = new Date()): Promise<{ dispatched: number; skipped: number }> {
  const due = await db.campaign.findMany({
    where: { status: 'SCHEDULED', requiresApproval: true, approvedByUserId: { not: null }, campaignType: { not: null }, scheduledAt: { not: null, lte: now } },
    take: 200,
  });
  let dispatched = 0, skipped = 0;
  for (const c of due) {
    if (!c.audienceType) { skipped++; continue; }
    if (isWithinQuietHours(c.quietHours, now)) { skipped++; continue; }
    const channel = (c.campaignChannel ?? 'sms') as CommChannel;
    // Do not send if the provider is missing — leave it SCHEDULED for later.
    if (channelStatus(channel).setupRequired) { skipped++; continue; }
    const summary = await dispatchCampaign(c.tenantId, c.id, {});
    await db.auditEvent.create({ data: { tenantId: c.tenantId, action: 'campaign.scheduled_run', resource: 'campaign', resourceId: c.id, metadata: { sent: summary.sent, suppressed: summary.suppressed, failed: summary.failed } } }).catch(() => {});
    dispatched++;
  }
  return { dispatched, skipped };
}
