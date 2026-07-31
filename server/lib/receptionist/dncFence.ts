import type { Prisma, ReceptionistOptOutChannel } from '../../generated/prisma/client';

type DncChannel = 'voice' | 'sms' | 'email' | 'whatsapp';

type OutboundPurpose = 'CARE_COORDINATION' | 'APPOINTMENT_REMINDER' | 'PATIENT_REACTIVATION';

const CHANNELS: Record<DncChannel, ReceptionistOptOutChannel[]> = {
  voice: ['ALL', 'VOICE'],
  sms: ['ALL', 'SMS'],
  whatsapp: ['ALL', 'SMS'],
  email: ['ALL', 'EMAIL'],
};

export function canonicalDncDestination(value: string): string {
  const trimmed = value.trim();
  if (trimmed.includes('@')) return trimmed.toLowerCase();
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return '';
  if (trimmed.startsWith('+')) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return `+${digits}`;
}

export function dncFenceKey(tenantId: string, destination: string): string {
  return `receptionist-suppression:destination:${tenantId}:${canonicalDncDestination(destination)}`;
}

export function identityFenceKey(tenantId: string, identityType: 'patient' | 'lead', identityId: string): string {
  return `receptionist-suppression:${identityType}:${tenantId}:${identityId}`;
}

/**
 * Serializes suppression mutations with the short outbound authorization
 * transaction for the same tenant and destination. The authorization commit
 * is the linearization point; no database transaction is held open across the
 * external telephony request.
 */
export async function lockDncDestinationFence(
  tx: Prisma.TransactionClient,
  tenantId: string,
  destinations: Array<string | null | undefined>,
) {
  const keys = [...new Set(destinations.filter((value): value is string => Boolean(value?.trim()))
    .map(value => dncFenceKey(tenantId, value)))]
    .sort();
  for (const key of keys) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
  }
}

export async function lockSuppressionFences(
  tx: Prisma.TransactionClient,
  input: {
    tenantId: string;
    destinations?: Array<string | null | undefined>;
    patientId?: string | null;
    leadId?: string | null;
  },
) {
  const keys = [
    ...(input.destinations ?? []).filter((value): value is string => Boolean(value?.trim())).map(value => dncFenceKey(input.tenantId, value)),
    ...(input.patientId ? [identityFenceKey(input.tenantId, 'patient', input.patientId)] : []),
    ...(input.leadId ? [identityFenceKey(input.tenantId, 'lead', input.leadId)] : []),
  ];
  for (const key of [...new Set(keys)].sort()) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
  }
}

export async function isDestinationOptedOutTx(
  tx: Prisma.TransactionClient,
  tenantId: string,
  destination: string,
  channel: DncChannel,
): Promise<boolean> {
  const canonical = canonicalDncDestination(destination);
  if (!canonical) return false;
  const isEmail = canonical.includes('@');
  const rows = await tx.receptionistOptOut.findMany({
    where: {
      tenantId,
      revokedAt: null,
      channel: { in: CHANNELS[channel] },
      ...(isEmail ? { contactEmail: { not: null } } : { contactPhone: { not: null } }),
    },
    select: { contactPhone: true, contactEmail: true },
  });
  return rows.some(row => canonicalDncDestination(isEmail ? row.contactEmail ?? '' : row.contactPhone ?? '') === canonical);
}

export async function isVoiceSuppressedTx(
  tx: Prisma.TransactionClient,
  input: { tenantId: string; destination: string; patientId?: string | null; leadId?: string | null },
): Promise<boolean> {
  return isChannelSuppressedTx(tx, { ...input, channel: 'voice' });
}

export async function isChannelSuppressedTx(
  tx: Prisma.TransactionClient,
  input: {
    tenantId: string;
    destination: string;
    channel: DncChannel;
    patientId?: string | null;
    leadId?: string | null;
  },
): Promise<boolean> {
  const identity = { tenantId: input.tenantId, patientId: input.patientId ?? null, leadId: input.leadId ?? null };
  const communicationOptOut = await tx.communicationConsent.count({ where: { ...identity, channel: input.channel, status: 'opted_out' } });
  const campaignSuppression = await tx.campaignSuppression.count({ where: { ...identity, channel: input.channel, active: true } });
  if (communicationOptOut > 0 || campaignSuppression > 0) return true;

  if (input.patientId) {
    const purpose = input.channel === 'voice' ? 'MARKETING'
      : input.channel === 'sms' ? 'SMS'
        : input.channel === 'email' ? 'EMAIL' : 'WHATSAPP';
    const latestLegacy = await tx.consentEvent.findFirst({
      where: { tenantId: input.tenantId, patientId: input.patientId, purpose },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      select: { granted: true },
    });
    if (latestLegacy?.granted === false) return true;
  }
  return isDestinationOptedOutTx(tx, input.tenantId, input.destination, input.channel);
}

export async function compatibleVoiceConsentEventTx(
  tx: Prisma.TransactionClient,
  input: {
    tenantId: string;
    patientId?: string | null;
    leadId?: string | null;
    purpose: OutboundPurpose;
    policyVersion: string;
    at?: Date;
  },
): Promise<{ id: string } | null> {
  const at = input.at ?? new Date();
  const latest = await tx.receptionistVoiceConsentEvent.findFirst({
    where: {
      tenantId: input.tenantId,
      patientId: input.patientId ?? null,
      leadId: input.leadId ?? null,
      purpose: input.purpose,
      policyVersion: input.policyVersion,
    },
    // A revocation wins a timestamp tie; UUID ordering must never decide
    // whether permission exists.
    orderBy: [{ occurredAt: 'desc' }, { granted: 'asc' }, { id: 'desc' }],
    select: { id: true, granted: true, expiresAt: true },
  });
  if (!latest?.granted || (latest.expiresAt && latest.expiresAt <= at)) return null;
  return { id: latest.id };
}

/**
 * Creates the authoritative provider-intent marker inside the caller's short
 * transaction. The database trigger independently repeats the exact ownership,
 * suppression, campaign-purpose/policy, and immutable-consent checks.
 */
export async function authorizeOutboundProviderIntentTx(
  tx: Prisma.TransactionClient,
  input: {
    tenantId: string;
    callLogId: string;
    outboundCampaignId: string;
    targetId?: string | null;
    destination: string;
    purpose: OutboundPurpose;
    policyVersion: string;
    legalBasis: 'EXPLICIT_CONSENT' | 'TREATMENT_OPERATIONS';
  },
) {
  const target = input.targetId ? await tx.receptionistCallTarget.findFirst({
    where: { id: input.targetId, tenantId: input.tenantId, campaignId: input.outboundCampaignId },
    select: { patientId: true, leadId: true, phone: true },
  }) : null;
  if (input.targetId && !target) throw new Error('outbound_provider_intent_target_missing');
  if (target && canonicalDncDestination(target.phone) !== canonicalDncDestination(input.destination)) {
    throw new Error('outbound_provider_intent_destination_mismatch');
  }

  await lockSuppressionFences(tx, {
    tenantId: input.tenantId,
    destinations: [input.destination],
    patientId: target?.patientId,
    leadId: target?.leadId,
  });
  if (await isChannelSuppressedTx(tx, {
    tenantId: input.tenantId,
    destination: input.destination,
    channel: 'voice',
    patientId: target?.patientId,
    leadId: target?.leadId,
  })) throw new Error('outbound_provider_intent_suppressed');

  const requiresConsent = input.legalBasis === 'EXPLICIT_CONSENT' || input.purpose === 'PATIENT_REACTIVATION';
  const consent = requiresConsent ? await compatibleVoiceConsentEventTx(tx, {
    tenantId: input.tenantId,
    patientId: target?.patientId,
    leadId: target?.leadId,
    purpose: input.purpose,
    policyVersion: input.policyVersion,
  }) : null;
  if (requiresConsent && !consent) throw new Error('outbound_provider_intent_consent_missing');

  return tx.receptionistOutboundProviderIntent.create({ data: {
    tenantId: input.tenantId,
    callLogId: input.callLogId,
    outboundCampaignId: input.outboundCampaignId,
    targetId: input.targetId ?? undefined,
    voiceConsentEventId: consent?.id,
    purpose: input.purpose,
    policyVersion: input.policyVersion,
  } });
}
