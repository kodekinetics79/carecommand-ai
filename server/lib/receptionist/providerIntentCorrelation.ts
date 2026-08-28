import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { env } from '../../config/env';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NONCE = /^[A-Za-z0-9_-]{43}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export const PROVIDER_INTENT_METADATA = Object.freeze({
  tenantId: 'carecommand_tenant_id',
  intentId: 'carecommand_intent_id',
  callLogId: 'carecommand_call_log_id',
  outboundCampaignId: 'carecommand_outbound_campaign_id',
  targetId: 'carecommand_target_id',
  purpose: 'carecommand_outbound_purpose',
  policyVersion: 'carecommand_policy_version',
  nonce: 'carecommand_intent_nonce',
  signature: 'carecommand_intent_hmac',
});

export type ProviderIntentCorrelationContext = {
  tenantId: string;
  intentId: string;
  callLogId: string;
  outboundCampaignId: string;
  targetId: string | null;
  purpose: string;
  policyVersion: string;
};

export type ProviderIntentCorrelationMetadata = {
  tenantId: string;
  intentId: string;
  callLogId: string;
  outboundCampaignId: string;
  targetId: string | null;
  purpose: string;
  policyVersion: string;
  nonce: string;
  signature: string;
};

function correlationPayload(context: ProviderIntentCorrelationContext, nonce: string): string {
  // Length-prefix every value so the authenticated tuple is unambiguous even
  // if a future policy/version value contains a delimiter.
  return [
    'carecommand-retell-provider-intent-v1',
    context.tenantId,
    context.intentId,
    context.callLogId,
    context.outboundCampaignId,
    context.targetId ?? '',
    context.purpose,
    context.policyVersion,
    nonce,
  ].map(value => `${Buffer.byteLength(value, 'utf8')}:${value}`).join('|');
}

function correlationSignature(context: ProviderIntentCorrelationContext, nonce: string): string {
  // JWT_SECRET is a required, high-entropy application secret and remains
  // stable across Retell API-key rotation. The domain-separated payload keeps
  // this proof independent from authentication/session token use.
  return createHmac('sha256', env.JWT_SECRET).update(correlationPayload(context, nonce)).digest('hex');
}

export function providerIntentNonceHash(nonce: string): string {
  return createHash('sha256').update(nonce).digest('hex');
}

export function issueProviderIntentCorrelation(
  context: ProviderIntentCorrelationContext,
): ProviderIntentCorrelationMetadata & { nonceHash: string } {
  const nonce = randomBytes(32).toString('base64url');
  return {
    ...context,
    intentId: context.intentId,
    nonce,
    nonceHash: providerIntentNonceHash(nonce),
    signature: correlationSignature(context, nonce),
  };
}

export function parseProviderIntentCorrelationMetadata(
  metadata: unknown,
): ProviderIntentCorrelationMetadata | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const record = metadata as Record<string, unknown>;
  const tenantId = record[PROVIDER_INTENT_METADATA.tenantId];
  const intentId = record[PROVIDER_INTENT_METADATA.intentId];
  const callLogId = record[PROVIDER_INTENT_METADATA.callLogId];
  const outboundCampaignId = record[PROVIDER_INTENT_METADATA.outboundCampaignId];
  const rawTargetId = record[PROVIDER_INTENT_METADATA.targetId];
  const purpose = record[PROVIDER_INTENT_METADATA.purpose];
  const policyVersion = record[PROVIDER_INTENT_METADATA.policyVersion];
  const nonce = record[PROVIDER_INTENT_METADATA.nonce];
  const signature = record[PROVIDER_INTENT_METADATA.signature];
  if (typeof tenantId !== 'string' || !UUID.test(tenantId)
    || typeof intentId !== 'string' || !UUID.test(intentId)
    || typeof callLogId !== 'string' || !UUID.test(callLogId)
    || typeof outboundCampaignId !== 'string' || !UUID.test(outboundCampaignId)
    || !((typeof rawTargetId === 'string' && UUID.test(rawTargetId)) || rawTargetId === '')
    || typeof purpose !== 'string' || !/^[A-Z_]{3,40}$/.test(purpose)
    || typeof policyVersion !== 'string' || !policyVersion.trim() || policyVersion.length > 100
    || typeof nonce !== 'string' || !NONCE.test(nonce)
    || typeof signature !== 'string' || !SHA256.test(signature)) return null;
  return {
    tenantId: tenantId.toLowerCase(), intentId: intentId.toLowerCase(), callLogId: callLogId.toLowerCase(),
    outboundCampaignId: outboundCampaignId.toLowerCase(), targetId: rawTargetId || null,
    purpose, policyVersion, nonce, signature,
  };
}

/** Verify app-issued authority before using its tenant selector for RLS. */
export function verifyProviderIntentEnvelopeSignature(metadata: ProviderIntentCorrelationMetadata): boolean {
  const expected = Buffer.from(correlationSignature(metadata, metadata.nonce), 'hex');
  const actual = Buffer.from(metadata.signature, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function verifyProviderIntentCorrelation(
  metadata: ProviderIntentCorrelationMetadata,
  context: ProviderIntentCorrelationContext & { nonceHash: string },
): boolean {
  if (metadata.tenantId !== context.tenantId.toLowerCase()
    || metadata.intentId !== context.intentId.toLowerCase()
    || metadata.callLogId !== context.callLogId.toLowerCase()
    || metadata.outboundCampaignId !== context.outboundCampaignId.toLowerCase()
    || metadata.targetId !== context.targetId
    || metadata.purpose !== context.purpose
    || metadata.policyVersion !== context.policyVersion
    || !SHA256.test(context.nonceHash)) return false;
  const actualNonceHash = Buffer.from(providerIntentNonceHash(metadata.nonce), 'hex');
  const storedNonceHash = Buffer.from(context.nonceHash, 'hex');
  if (actualNonceHash.length !== storedNonceHash.length || !timingSafeEqual(actualNonceHash, storedNonceHash)) return false;
  const expected = Buffer.from(correlationSignature(context, metadata.nonce), 'hex');
  const actual = Buffer.from(metadata.signature, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function providerIntentMetadataForRetell(metadata: ProviderIntentCorrelationMetadata): Record<string, string> {
  return {
    [PROVIDER_INTENT_METADATA.tenantId]: metadata.tenantId,
    [PROVIDER_INTENT_METADATA.intentId]: metadata.intentId,
    [PROVIDER_INTENT_METADATA.callLogId]: metadata.callLogId,
    [PROVIDER_INTENT_METADATA.outboundCampaignId]: metadata.outboundCampaignId,
    [PROVIDER_INTENT_METADATA.targetId]: metadata.targetId ?? '',
    [PROVIDER_INTENT_METADATA.purpose]: metadata.purpose,
    [PROVIDER_INTENT_METADATA.policyVersion]: metadata.policyVersion,
    [PROVIDER_INTENT_METADATA.nonce]: metadata.nonce,
    [PROVIDER_INTENT_METADATA.signature]: metadata.signature,
  };
}
