import 'dotenv/config';

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  issueProviderIntentCorrelation,
  parseProviderIntentCorrelationMetadata,
  providerIntentMetadataForRetell,
  verifyProviderIntentCorrelation,
  verifyProviderIntentEnvelopeSignature,
} from '../lib/receptionist/providerIntentCorrelation';

function context() {
  return {
    tenantId: randomUUID(),
    intentId: randomUUID(),
    callLogId: randomUUID(),
    outboundCampaignId: randomUUID(),
    targetId: randomUUID(),
    purpose: 'CARE_COORDINATION',
    policyVersion: 'VOICE-2026-1',
  };
}

describe('provider-intent correlation proof', () => {
  it('authenticates and revalidates the complete persisted intent context', () => {
    const issued = issueProviderIntentCorrelation(context());
    const parsed = parseProviderIntentCorrelationMetadata(providerIntentMetadataForRetell(issued));
    expect(parsed).not.toBeNull();
    expect(verifyProviderIntentEnvelopeSignature(parsed!)).toBe(true);
    expect(verifyProviderIntentCorrelation(parsed!, { ...issued, nonceHash: issued.nonceHash })).toBe(true);
  });

  it.each([
    ['tenantId', randomUUID()],
    ['intentId', randomUUID()],
    ['callLogId', randomUUID()],
    ['outboundCampaignId', randomUUID()],
    ['targetId', randomUUID()],
    ['purpose', 'APPOINTMENT_REMINDER'],
    ['policyVersion', 'VOICE-ATTACKER'],
  ] as const)('rejects a proof transplanted onto different %s context', (field, value) => {
    const issued = issueProviderIntentCorrelation(context());
    const parsed = parseProviderIntentCorrelationMetadata(providerIntentMetadataForRetell(issued))!;
    expect(verifyProviderIntentCorrelation(parsed, {
      ...issued,
      [field]: value,
      nonceHash: issued.nonceHash,
    })).toBe(false);
  });

  it('rejects forged, malformed and nonce-replayed metadata before tenant bootstrap', () => {
    const issued = issueProviderIntentCorrelation(context());
    const providerMetadata = providerIntentMetadataForRetell(issued);
    const forged = parseProviderIntentCorrelationMetadata({
      ...providerMetadata,
      carecommand_intent_hmac: '0'.repeat(64),
    });
    expect(forged).not.toBeNull();
    expect(verifyProviderIntentEnvelopeSignature(forged!)).toBe(false);
    expect(parseProviderIntentCorrelationMetadata({
      ...providerMetadata,
      carecommand_intent_nonce: 'not-a-valid-nonce',
    })).toBeNull();

    const otherNonceHash = issueProviderIntentCorrelation(context()).nonceHash;
    const parsed = parseProviderIntentCorrelationMetadata(providerMetadata)!;
    expect(verifyProviderIntentCorrelation(parsed, { ...issued, nonceHash: otherNonceHash })).toBe(false);
  });
});
