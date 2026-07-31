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
    at?: Date;
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
      where: { tenantId: input.tenantId, patientId: input.patientId, purpose, occurredAt: { lte: input.at ?? new Date() } },
      // A deny wins a timestamp tie. UUID ordering is only a final stable
      // ordering key and never determines whether permission exists.
      orderBy: [{ occurredAt: 'desc' }, { granted: 'asc' }, { id: 'desc' }],
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
  const at = input.at ?? (await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`)[0]!.now;
  const latest = await tx.receptionistVoiceConsentEvent.findFirst({
    where: {
      tenantId: input.tenantId,
      patientId: input.patientId ?? null,
      leadId: input.leadId ?? null,
      purpose: input.purpose,
      policyVersion: input.policyVersion,
      occurredAt: { lte: at },
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
    id: string;
    correlationNonceHash: string;
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
  if (!/^[0-9a-f]{64}$/.test(input.correlationNonceHash)) {
    throw new Error('outbound_provider_intent_correlation_hash_invalid');
  }
  if (!input.targetId) throw new Error('outbound_provider_intent_target_missing');

  const [{ now: databaseNow }] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
  const calls = await tx.$queryRaw<Array<{
    targetId: string | null; callerPhone: string | null;
  }>>`
    SELECT "targetId", "callerPhone"
    FROM "ReceptionistCallLog"
    WHERE "tenantId"=${input.tenantId}::uuid AND id=${input.callLogId}::uuid
      AND "outboundCampaignId"=${input.outboundCampaignId}::uuid
    FOR UPDATE
  `;
  const call = calls[0];
  if (!call || call.targetId !== input.targetId) throw new Error('outbound_provider_intent_call_boundary_mismatch');

  const targets = await tx.$queryRaw<Array<{
    patientId: string | null; leadId: string | null; phone: string;
  }>>`
    SELECT "patientId", "leadId", phone
    FROM "ReceptionistCallTarget"
    WHERE "tenantId"=${input.tenantId}::uuid AND "campaignId"=${input.outboundCampaignId}::uuid
      AND id=${input.targetId}::uuid
    FOR UPDATE
  `;
  const target = targets[0];
  if (!target) throw new Error('outbound_provider_intent_target_missing');
  if ((Number(Boolean(target.patientId)) + Number(Boolean(target.leadId))) !== 1) {
    throw new Error('outbound_provider_intent_identity_invalid');
  }
  const destinationCanonical = canonicalDncDestination(input.destination);
  if (!destinationCanonical
      || canonicalDncDestination(target.phone) !== destinationCanonical
      || canonicalDncDestination(call.callerPhone ?? '') !== destinationCanonical) {
    throw new Error('outbound_provider_intent_destination_mismatch');
  }

  // Suppression/consent writers acquire these advisory locks before their FK
  // checks. Match that order before taking the Patient/Lead row lock to avoid
  // an identity-row/advisory-lock inversion under concurrent revocation.
  await lockSuppressionFences(tx, {
    tenantId: input.tenantId,
    destinations: [destinationCanonical],
    patientId: target.patientId,
    leadId: target.leadId,
  });

  const identities = target.patientId
    ? await tx.$queryRaw<Array<{ phone: string | null; deletedAt: Date | null; updatedAt: Date }>>`
        SELECT phone, "deletedAt", "updatedAt" FROM "Patient"
        WHERE "tenantId"=${input.tenantId}::uuid AND id=${target.patientId}::uuid FOR UPDATE
      `
    : await tx.$queryRaw<Array<{ phone: string | null; deletedAt: Date | null; updatedAt: Date }>>`
        SELECT phone, "deletedAt", "updatedAt" FROM "Lead"
        WHERE "tenantId"=${input.tenantId}::uuid AND id=${target.leadId!}::uuid FOR UPDATE
      `;
  const identity = identities[0];
  if (!identity || identity.deletedAt) throw new Error('outbound_provider_intent_identity_inactive');
  if (canonicalDncDestination(identity.phone ?? '') !== destinationCanonical) {
    throw new Error('outbound_provider_intent_destination_mismatch');
  }
  if (await isChannelSuppressedTx(tx, {
    tenantId: input.tenantId,
    destination: input.destination,
    channel: 'voice',
    patientId: target.patientId,
    leadId: target.leadId,
    at: databaseNow,
  })) throw new Error('outbound_provider_intent_suppressed');

  const requiresConsent = input.legalBasis === 'EXPLICIT_CONSENT' || input.purpose === 'PATIENT_REACTIVATION';
  const consent = requiresConsent ? await compatibleVoiceConsentEventTx(tx, {
    tenantId: input.tenantId,
    patientId: target.patientId,
    leadId: target.leadId,
    purpose: input.purpose,
    policyVersion: input.policyVersion,
    at: databaseNow,
  }) : null;
  if (requiresConsent && !consent) throw new Error('outbound_provider_intent_consent_missing');

  return tx.receptionistOutboundProviderIntent.create({ data: {
    id: input.id,
    tenantId: input.tenantId,
    callLogId: input.callLogId,
    outboundCampaignId: input.outboundCampaignId,
    targetId: input.targetId ?? undefined,
    patientId: target.patientId,
    leadId: target.leadId,
    voiceConsentEventId: consent?.id,
    destinationCanonical,
    identityUpdatedAt: identity.updatedAt,
    correlationNonceHash: input.correlationNonceHash,
    purpose: input.purpose,
    policyVersion: input.policyVersion,
  } });
}
