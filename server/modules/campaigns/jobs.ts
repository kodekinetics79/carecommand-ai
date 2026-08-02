import { db } from '../../lib/db';
import { channelStatus, type CommChannel } from '../../lib/campaigns';
import { dispatchCampaign } from '../../lib/campaignDispatch';
import { buildCampaignLaunchPreview, campaignAuthorizationMatches } from '../../lib/campaignIntegrity';
import { forEachActiveJobTenant } from '../../lib/jobTenantResolver';

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

export async function runScheduledCampaigns(now: Date = new Date(), only?: string): Promise<{ dispatched: number; skipped: number }> {
  let dispatched = 0, skipped = 0;
  await forEachActiveJobTenant(only, 'worker:campaign-scheduler', async tenantId => {
    const due = await db.campaign.findMany({
      where: { tenantId, status: 'SCHEDULED', requiresApproval: true, approvedByUserId: { not: null }, campaignType: { not: null }, scheduledAt: { not: null, lte: now } },
      take: 200,
    });
    for (const c of due) {
      if (!c.audienceType) { skipped++; continue; }
      if (isWithinQuietHours(c.quietHours, now)) { skipped++; continue; }
      const currentPreview = await buildCampaignLaunchPreview(tenantId, c);
      if (!campaignAuthorizationMatches(c, currentPreview)) {
        const reason = c.dispatchAuthorizationFingerprint ? 'stale' : 'missing';
        await db.$transaction(async tx => {
          await tx.campaign.updateMany({ where: { id: c.id, tenantId, status: 'SCHEDULED' }, data: { status: 'APPROVAL_REQUIRED' } });
          await tx.auditEvent.create({ data: {
            tenantId,
            action: `campaign.scheduled_authorization_${reason}`,
            resource: 'campaign',
            resourceId: c.id,
            userAgent: 'campaign-scheduler',
            metadata: { reason, currentFingerprint: currentPreview.fingerprint, authorizedFingerprint: c.dispatchAuthorizationFingerprint ?? null },
          } });
        });
        skipped++;
        continue;
      }
      const channel = (c.campaignChannel ?? 'sms') as CommChannel;
      // Do not send if the provider is missing — leave it SCHEDULED for later.
      if (channelStatus(channel).setupRequired) { skipped++; continue; }
      // Atomically claim this campaign so concurrent scheduler instances cannot
      // both cross the provider boundary for the same authorization.
      const claim = await db.campaign.updateMany({
        where: { id: c.id, tenantId, status: 'SCHEDULED', dispatchAuthorizationFingerprint: currentPreview.fingerprint },
        data: { status: 'ACTIVE' },
      });
      if (claim.count !== 1) { skipped++; continue; }
      try {
        const summary = await dispatchCampaign(tenantId, c.id, { authorizationFingerprint: currentPreview.fingerprint });
        await db.auditEvent.create({ data: { tenantId, action: 'campaign.scheduled_run', resource: 'campaign', resourceId: c.id, metadata: { accepted: summary.accepted, deliveryUnknown: summary.deliveryUnknown, suppressed: summary.suppressed, failed: summary.failed, authorityBlocked: summary.authorityBlocked, atomicBoundaryBlocked: summary.atomicBoundaryBlocked, launchFingerprint: currentPreview.fingerprint } } });
        if (summary.authorityBlocked > 0 || summary.atomicBoundaryBlocked > 0) skipped++;
        else dispatched++;
      } catch (error) {
        await db.$transaction(async tx => {
          await tx.campaign.updateMany({ where: { id: c.id, tenantId, status: 'ACTIVE' }, data: { status: 'FAILED' } });
          await tx.auditEvent.create({ data: {
            tenantId,
            action: 'campaign.scheduled_run_failed',
            resource: 'campaign',
            resourceId: c.id,
            userAgent: 'campaign-scheduler',
            metadata: { reason: error instanceof Error ? error.message : 'unknown_error', launchFingerprint: currentPreview.fingerprint },
          } });
        });
        skipped++;
      }
    }
  });
  return { dispatched, skipped };
}
