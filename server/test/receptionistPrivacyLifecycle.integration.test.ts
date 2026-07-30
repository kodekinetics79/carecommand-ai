import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fixtureDb as db } from './helpers/fixtureDb';
import {
  disclosureEvidenceHash,
  ingestCallArtifacts,
  purgeDueReceptionistArtifacts,
  recordRecordingConsent,
} from '../lib/receptionist/privacyLifecycle';
import { runWithWebhookTenantContext } from '../lib/tenantContext';

function trustedWebhook<T>(tenantId: string, work: () => Promise<T>): Promise<T> {
  return runWithWebhookTenantContext(tenantId, () => work(), 'webhook:test-retell-privacy');
}

async function tenant(label: string) {
  const id = randomUUID();
  await db.tenant.create({ data: { id, name: label, slug: `${label}-${id.slice(0, 8)}` } });
  return id;
}

describe('receptionist privacy lifecycle', () => {
  it('fails closed, preserves immutable evidence, honors holds, and never fabricates vendor deletion', async () => {
    const tenantA = await tenant('privacy-a');
    const tenantB = await tenant('privacy-b');
    const refused = await db.receptionistCallLog.create({ data: { tenantId: tenantA, retellCallId: `refused-${randomUUID()}` } });
    await trustedWebhook(tenantA, () => recordRecordingConsent({
      tenantId: tenantA, callLogId: refused.id, decision: 'REFUSED',
      disclosureTextHash: disclosureEvidenceHash('versioned-disclosure'),
    }));
    expect(await trustedWebhook(tenantA, () => ingestCallArtifacts({ tenantId: tenantA, callLogId: refused.id, recordingUrl: 'https://artifact.test/audio', transcriptSummary: 'sensitive summary' })))
      .toMatchObject({ recordingStored: false, transcriptStored: false, reason: 'consent_not_granted' });
    expect(await db.receptionistCallLog.findUnique({ where: { id: refused.id } })).toMatchObject({ recordingUrl: null, transcriptSummary: null });

    const evidence = await db.receptionistRecordingConsentEvent.findFirstOrThrow({ where: { tenantId: tenantA, callLogId: refused.id } });
    await expect(db.receptionistRecordingConsentEvent.update({ where: { id: evidence.id }, data: { source: 'rewritten' } })).rejects.toThrow();
    await expect(db.receptionistRecordingConsentEvent.create({
      data: {
        tenantId: tenantB, callLogId: refused.id, decision: 'REFUSED', source: 'test',
        policyVersion: 'test', disclosureTextHash: disclosureEvidenceHash('test'),
        providerStorageSetting: 'basic_attributes_only', idempotencyKey: randomUUID(),
      },
    })).rejects.toThrow();

    const held = await db.receptionistCallLog.create({ data: { tenantId: tenantA, retellCallId: `held-${randomUUID()}` } });
    await trustedWebhook(tenantA, () => recordRecordingConsent({ tenantId: tenantA, callLogId: held.id, decision: 'GRANTED', disclosureTextHash: disclosureEvidenceHash('versioned-disclosure') }));
    await trustedWebhook(tenantA, () => ingestCallArtifacts({ tenantId: tenantA, callLogId: held.id, recordingUrl: 'https://artifact.test/held', transcriptSummary: 'held summary' }));
    const past = new Date(Date.now() - 60_000);
    await db.receptionistCallLog.update({ where: { id: held.id }, data: { recordingRetentionExpiresAt: past, transcriptRetentionExpiresAt: past } });
    const hold = await db.receptionistCallLegalHold.create({ data: { tenantId: tenantA, callLogId: held.id, reason: 'Litigation preservation', authority: 'privacy-officer' } });
    expect((await trustedWebhook(tenantA, () => purgeDueReceptionistArtifacts({ now: new Date(), limit: 20 }))).localPurges).toBe(0);
    expect(await db.receptionistCallLog.findUnique({ where: { id: held.id } })).toMatchObject({ recordingUrl: 'https://artifact.test/held', transcriptSummary: 'held summary' });

    await db.receptionistCallLegalHold.update({ where: { id: hold.id }, data: { status: 'RELEASED', releasedAt: new Date(), releaseReason: 'Authority released hold' } });
    const purge = await trustedWebhook(tenantA, () => purgeDueReceptionistArtifacts({ now: new Date(), limit: 20 }));
    expect(purge.localPurges).toBe(2);
    expect(purge.vendorConfirmed).toBe(0);
    expect(await db.receptionistCallLog.findUnique({ where: { id: held.id } })).toMatchObject({ recordingUrl: null, transcriptSummary: null, vendorDeletionConfirmedAt: null });
    expect(await db.receptionistArtifactLifecycleEvent.count({ where: { callLogId: held.id, action: 'VENDOR_DELETE_FAILED' } })).toBe(2);
  }, 60_000);
});
