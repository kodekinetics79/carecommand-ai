import type { Prisma, ReceptionistOptOutChannel } from '../../generated/prisma/client';

type DncChannel = 'voice' | 'sms' | 'email' | 'whatsapp';

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
  const identity = { tenantId: input.tenantId, patientId: input.patientId ?? null, leadId: input.leadId ?? null };
  const communicationOptOut = await tx.communicationConsent.count({ where: { ...identity, channel: 'voice', status: 'opted_out' } });
  const campaignSuppression = await tx.campaignSuppression.count({ where: { ...identity, channel: 'voice', active: true } });
  if (communicationOptOut > 0 || campaignSuppression > 0) return true;

  if (input.patientId) {
    const latestMarketing = await tx.consentEvent.findFirst({
      where: { tenantId: input.tenantId, patientId: input.patientId, purpose: 'MARKETING' },
      orderBy: { occurredAt: 'desc' },
      select: { granted: true },
    });
    if (latestMarketing?.granted === false) return true;
  }
  return isDestinationOptedOutTx(tx, input.tenantId, input.destination, 'voice');
}
