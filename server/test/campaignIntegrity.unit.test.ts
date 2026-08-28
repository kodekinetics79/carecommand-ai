import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  appendChannelSafetyFooter,
  campaignAuthorizationMatches,
  campaignDeliveryTransition,
  computeCampaignLaunchFingerprint,
  normalizeProviderDeliveryStatus,
  type CampaignLaunchPreview,
} from '../lib/campaignIntegrity';

describe('campaign provider delivery state machine', () => {
  it('distinguishes queued, accepted, delivered, failed, and delivery_unknown aliases', () => {
    expect(normalizeProviderDeliveryStatus('queued')).toBe('queued');
    expect(normalizeProviderDeliveryStatus('submitted')).toBe('accepted');
    expect(normalizeProviderDeliveryStatus('delivered')).toBe('delivered');
    expect(normalizeProviderDeliveryStatus('bounced')).toBe('failed');
    expect(normalizeProviderDeliveryStatus('timeout')).toBe('delivery_unknown');
    expect(normalizeProviderDeliveryStatus('opened')).toBeNull();
  });

  it('advances monotonically and rejects regressions or terminal rewrites', () => {
    expect(campaignDeliveryTransition('queued', 'accepted')).toMatchObject({ applied: true, resultingStatus: 'accepted' });
    expect(campaignDeliveryTransition('accepted', 'delivered')).toMatchObject({ applied: true, resultingStatus: 'delivered' });
    expect(campaignDeliveryTransition('accepted', 'queued')).toMatchObject({ applied: false, outcome: 'rejected_regression', resultingStatus: 'accepted' });
    expect(campaignDeliveryTransition('delivered', 'failed')).toMatchObject({ applied: false, outcome: 'rejected_terminal', resultingStatus: 'delivered' });
    expect(campaignDeliveryTransition('failed', 'delivered')).toMatchObject({ applied: false, outcome: 'rejected_terminal', resultingStatus: 'failed' });
  });

  it('allows delivery_unknown to be resolved only by a terminal provider receipt', () => {
    expect(campaignDeliveryTransition('accepted', 'delivery_unknown')).toMatchObject({ applied: true, resultingStatus: 'delivery_unknown' });
    expect(campaignDeliveryTransition('delivery_unknown', 'accepted')).toMatchObject({ applied: false, outcome: 'rejected_regression' });
    expect(campaignDeliveryTransition('delivery_unknown', 'delivered')).toMatchObject({ applied: true, resultingStatus: 'delivered' });
  });
});

describe('campaign regulated content contract', () => {
  it('adds opt-out/help wording while disclaiming unsupported reply automation', () => {
    const body = appendChannelSafetyFooter('sms', 'Appointment options are available.', 'North Clinic');
    expect(body).toContain('Reply STOP to request no further messages.');
    expect(body).toContain('For help, contact North Clinic');
    expect(body).toContain('Replies do not automatically book, pay, submit forms, confirm, or reschedule.');
  });

  it('does not promise BOOK/YES/FORM/C/R keyword workflows in the campaign backend', () => {
    const source = readFileSync(new URL('../modules/campaigns/routes.ts', import.meta.url), 'utf8');
    for (const promise of ['Reply BOOK', 'Reply YES', 'Reply FORM', 'Reply C to confirm', 'Reply R to reschedule']) {
      expect(source).not.toContain(promise);
    }
  });
});

describe('campaign scheduled dispatch authority', () => {
  const preview: CampaignLaunchPreview = {
    campaignId: 'campaign-1',
    fingerprint: 'a'.repeat(64),
    templateRevision: 'b'.repeat(64),
    providerMode: 'mock_dev',
    provider: 'twilio',
    channel: 'sms',
    scheduledAt: null,
    audience: { total: 3, eligible: 1, suppressed: 1, missingContact: 1, authorityRequired: 0, atomicBoundaryBlocked: 0 },
    liveDispatchActivated: true,
    activationNotice: null,
    finalConfirmationRequired: true,
    confirmationStatement: 'reviewed',
  };

  it('requires an exact fingerprint plus durable operator and timestamp evidence', () => {
    expect(campaignAuthorizationMatches({
      dispatchAuthorizationFingerprint: preview.fingerprint,
      dispatchAuthorizedByUserId: '00000000-0000-4000-8000-000000000001',
      dispatchAuthorizedAt: new Date(),
    }, preview)).toBe(true);
    expect(campaignAuthorizationMatches({
      dispatchAuthorizationFingerprint: 'c'.repeat(64),
      dispatchAuthorizedByUserId: '00000000-0000-4000-8000-000000000001',
      dispatchAuthorizedAt: new Date(),
    }, preview)).toBe(false);
    expect(campaignAuthorizationMatches({
      dispatchAuthorizationFingerprint: preview.fingerprint,
      dispatchAuthorizedByUserId: null,
      dispatchAuthorizedAt: null,
    }, preview)).toBe(false);
  });

  it('keeps authorize-then-dispatch stable but invalidates every rendered/provider input change', () => {
    const material = {
      campaignId: 'campaign-1',
      campaignType: 'custom',
      audienceType: 'inactive_patients',
      channel: 'sms' as const,
      scheduledAt: '2026-08-01T14:00:00.000Z',
      templateRevision: 'template-v1',
      subjectHash: 'subject-v1',
      templateHash: 'body-v1',
      provider: 'twilio',
      providerMode: 'mock_dev' as const,
      clinicNameHash: 'clinic-v1',
      audienceRows: [{ identity: 'patient:1', destinationHash: 'destination-1', eligibility: 'eligible', renderInputHash: 'first-name-and-clinic-v1' }],
    };
    const authorized = computeCampaignLaunchFingerprint(material);
    expect(campaignAuthorizationMatches({
      dispatchAuthorizationFingerprint: authorized,
      dispatchAuthorizedByUserId: '00000000-0000-4000-8000-000000000001',
      dispatchAuthorizedAt: new Date(),
    }, { ...preview, fingerprint: authorized })).toBe(true);
    expect(computeCampaignLaunchFingerprint({ ...material, templateRevision: 'template-v2' })).not.toBe(authorized);
    expect(computeCampaignLaunchFingerprint({ ...material, scheduledAt: '2026-08-01T15:00:00.000Z' })).not.toBe(authorized);
    expect(computeCampaignLaunchFingerprint({ ...material, providerMode: 'configured_pending_provider' })).not.toBe(authorized);
    expect(computeCampaignLaunchFingerprint({ ...material, clinicNameHash: 'clinic-v2' })).not.toBe(authorized);
    expect(computeCampaignLaunchFingerprint({ ...material, audienceRows: [{ ...material.audienceRows[0], renderInputHash: 'first-name-and-clinic-v2' }] })).not.toBe(authorized);
    expect(computeCampaignLaunchFingerprint({ ...material, audienceRows: [...material.audienceRows, { identity: 'patient:2', destinationHash: 'destination-2', eligibility: 'eligible', renderInputHash: 'render-v2' }] })).not.toBe(authorized);
  });

  it('installs runtime hard-delete guards while retaining schema-owner lifecycle access', () => {
    const migration = readFileSync(new URL('../../prisma/migrations/20260730280000_campaign_integrity/migration.sql', import.meta.url), 'utf8');
    expect(migration).toContain('Campaign_runtime_delete_guard');
    expect(migration).toContain('CampaignDelivery_runtime_delete_guard');
    expect(migration).toContain("current_user = 'app_rls'");
    expect(migration).not.toContain('BEFORE UPDATE OR DELETE ON "CampaignDelivery"');
  });

  it('fails an upgrade before replacing the legacy unique index when duplicate evidence exists', () => {
    const migration = readFileSync(new URL('../../prisma/migrations/20260730280000_campaign_integrity/migration.sql', import.meta.url), 'utf8');
    const preflight = migration.indexOf('CampaignDelivery integrity preflight found');
    const drop = migration.indexOf('DROP INDEX "CampaignDelivery_campaignId_patientId_leadId_channel_key"');
    expect(preflight).toBeGreaterThan(-1);
    expect(drop).toBeGreaterThan(preflight);
    expect(migration).toContain('HAVING count(*) > 1');
    expect(migration).toContain('preserve provider/audit evidence');
  });

  it('makes the scheduler recompute and compare the durable exact preview before dispatch', () => {
    const jobs = readFileSync(new URL('../modules/campaigns/jobs.ts', import.meta.url), 'utf8');
    expect(jobs).toContain('buildCampaignLaunchPreview(tenantId, c)');
    expect(jobs).toContain('campaignAuthorizationMatches(c, currentPreview)');
    expect(jobs).toContain('authorizationFingerprint: currentPreview.fingerprint');
  });
});
