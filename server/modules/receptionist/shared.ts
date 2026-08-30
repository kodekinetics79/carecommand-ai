import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env';
import { RECEPTIONIST_PERMISSIONS, requireReceptionistPermission } from '../../lib/receptionist/accessControl';
import { requireAnyPermission } from '../../lib/permissions';
import { Prisma } from '../../generated/prisma/client';
import { requireRoles } from '../../plugins/roles';
import { compileIntakeContract } from './intakeContract';

export const uuid = z.string().uuid();

export const idParam = z.object({ id: uuid });

export const writeRoles = requireReceptionistPermission(RECEPTIONIST_PERMISSIONS.MANAGE);

export const bookingReviewRoles = requireReceptionistPermission(RECEPTIONIST_PERMISSIONS.BOOKING_REVIEW);

export const callArtifactRead = requireReceptionistPermission(RECEPTIONIST_PERMISSIONS.CALL_ARTIFACTS_READ);

/**
 * Read gate for every receptionist GET (contract §9): managers keep full access,
 * FRONT_DESK/AUDITOR read the configuration without being able to mutate it.
 */
export const receptionistRead = requireAnyPermission(RECEPTIONIST_PERMISSIONS.MANAGE, RECEPTIONIST_PERMISSIONS.READ);

export const ownerAdminRoles = requireRoles('OWNER', 'ADMIN');

export const e164Phone = z.string().trim().max(40)
  .transform(value => value.replace(/[().\s-]/g, ''))
  .refine(value => /^\+[1-9]\d{7,14}$/.test(value), 'Phone must include country code in E.164 format');

// '' clears the field (M21: a fallback number must be clearable from the UI).
export const optionalE164Phone = z.preprocess(
  value => (typeof value === 'string' && value.trim() === '' ? null : value),
  e164Phone.nullable().optional(),
);

export const iso2Country = z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, 'Country must be an ISO-3166 alpha-2 code');

export const languageTag = z.string().trim().regex(/^[a-z]{2}(-[A-Za-z0-9]{2,8})?$/, 'Language must be a BCP-47 tag such as en-GB');

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD').refine(value => {
  const [y, m, d] = value.split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}, 'Date must be a real calendar date');

export const clockTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'Time must use 24-hour HH:mm format');

export function intakeConfigurationError(error: unknown): string | null {
  const message = error instanceof Error ? error.message : '';
  return message.startsWith('invalid_intake_configuration:') ? message.slice('invalid_intake_configuration:'.length) : null;
}

export function isActiveIntakeContractError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('active_intake_contract_immutable');
}

export async function compileCampaignIntakeContract(
  tx: Prisma.TransactionClient,
  campaign: { id: string; tenantId: string; clinicId: string; appointmentType: string; eligibleLocationIds: string[]; intakeSchemaRevision: number },
) {
  const [fields, locations] = await Promise.all([
    tx.receptionistIntakeField.findMany({ where: { tenantId: campaign.tenantId, campaignId: campaign.id }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] }),
    tx.receptionistLocation.findMany({
      where: {
        tenantId: campaign.tenantId,
        clinicId: campaign.clinicId,
        active: true,
        branchId: { not: null },
        ...(campaign.eligibleLocationIds.length ? { id: { in: campaign.eligibleLocationIds } } : {}),
      },
      orderBy: { id: 'asc' },
      select: { id: true, name: true },
    }),
  ]);
  return compileIntakeContract({
    campaignId: campaign.id,
    revision: campaign.intakeSchemaRevision,
    appointmentType: campaign.appointmentType,
    eligibleLocations: locations,
    fields,
    toolUrl: `${env.PUBLIC_API_URL.replace(/\/$/, '')}/v1/receptionist/webhooks/retell/fn?clinicId=${campaign.clinicId}`,
  });
}

export function isReceptionistDestinationConflict(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

export async function lockReceptionistConfiguration(tx: Prisma.TransactionClient, tenantId: string) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`receptionist-config:${tenantId}`}::text, 0))::text AS locked`;
}

export async function auditReceptionistMutation(
  tx: Prisma.TransactionClient,
  request: FastifyRequest,
  event: { action: string; resource: string; resourceId: string; metadata?: Prisma.InputJsonObject },
) {
  await tx.auditEvent.create({ data: {
    tenantId: request.auth.tenantId,
    actorUserId: request.auth.userId,
    action: event.action,
    resource: event.resource,
    resourceId: event.resourceId,
    requestId: request.id,
    ipAddress: request.ip,
    userAgent: request.headers['user-agent'],
    metadata: event.metadata,
  } });
}

export const FIELD_TYPES = [
  'FIRST_NAME', 'LAST_NAME', 'PHONE', 'EMAIL', 'PREFERRED_DATE', 'PREFERRED_TIME',
  'PREFERRED_LOCATION', 'PATIENT_STATUS', 'INSURANCE_PROVIDER', 'REASON_FOR_VISIT',
  'PREFERRED_PROVIDER', 'LANGUAGE_PREFERENCE', 'CONSENT', 'CUSTOM_TEXT',
  'CUSTOM_DROPDOWN', 'CUSTOM_YES_NO',
] as const;
