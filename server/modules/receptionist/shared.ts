import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env';
import { RECEPTIONIST_PERMISSIONS, requireReceptionistPermission } from '../../lib/receptionist/accessControl';
import { Prisma } from '../../generated/prisma/client';
import { requireRoles } from '../../plugins/roles';
import { compileIntakeContract } from './intakeContract';

export const uuid = z.string().uuid();

export const idParam = z.object({ id: uuid });

export const writeRoles = requireReceptionistPermission(RECEPTIONIST_PERMISSIONS.MANAGE);

export const bookingReviewRoles = requireReceptionistPermission(RECEPTIONIST_PERMISSIONS.BOOKING_REVIEW);

export const callArtifactRead = requireReceptionistPermission(RECEPTIONIST_PERMISSIONS.CALL_ARTIFACTS_READ);

export const ownerAdminRoles = requireRoles('OWNER', 'ADMIN');

export const e164Phone = z.string().trim().max(40)
  .transform(value => value.replace(/[().\s-]/g, ''))
  .refine(value => /^\+[1-9]\d{7,14}$/.test(value), 'Phone must include country code in E.164 format');

export const optionalE164Phone = e164Phone.optional().nullable();

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
