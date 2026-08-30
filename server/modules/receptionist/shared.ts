import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { RECEPTIONIST_PERMISSIONS, requireReceptionistPermission } from '../../lib/receptionist/accessControl';
import { requireAnyPermission } from '../../lib/permissions';
import { expectedRetellToolUrl } from '../../lib/retell';
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
    toolUrl: expectedRetellToolUrl(campaign.clinicId),
  });
}

// ===========================================================================
// Unique-constraint conflicts, named one at a time.
//
// `isReceptionistDestinationConflict` used to answer true for ANY P2002, and
// four call sites each turned that into their own confident sentence. So a
// clinic-name collision on the agent path told the operator "This active
// provider deployment is already assigned to another agent", and a duplicate
// phone number on the verify path said the same — a message about a thing the
// operator had not touched, pointing at a screen that could not fix it.
//
// A P2002 is only actionable if you know WHICH index bit, and Prisma says so in
// two different shapes depending on how it is talking to Postgres. The engine
// sets `meta.target` — a field list, or the raw index name for the partial
// indexes this schema declares in migrations. The pg driver adapter this
// project runs sets no `target` at all and instead carries the driver's own
// error: `meta.driverAdapterError.cause` with the 23505 message naming the
// constraint, plus `constraint.fields` (quoted as Postgres spells them).
// `uniqueConflictTarget` collects every identifier either shape offers.
//
// Anything unrecognised is deliberately NOT claimed. An unknown conflict must
// surface as a 500 with a real stack rather than as a confident, wrong 409.
// ===========================================================================

const RECEPTIONIST_UNIQUE_INDEXES = {
  /** One active CareCommand configuration owns one live provider version. Global by design. */
  activeProviderDeployment: 'ReceptionistAgent_active_provider_deployment_unique',
  /** One tenant-scoped provider deployment drives one ACTIVE Studio campaign. */
  activeCampaignDeployment: 'ReceptionistCampaign_tenant_active_provider_deployment_unique',
  /** One active clinic per advertised destination number. Global by design. */
  activeClinicPhone: 'ReceptionistClinic_active_phone_unique',
  /** One active clinic per inbound line (A1). Global by design. */
  activeClinicInboundNumber: 'ReceptionistClinic_active_inbound_number_unique',
  /** One clinic name per tenant. */
  clinicName: 'ReceptionistClinic_tenantId_name_key',
} as const;

/** Every index name and column name a P2002 names, in either shape, unquoted. */
function uniqueConflictTarget(error: unknown): string[] | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') return null;
  const identifiers: string[] = [];
  const unquote = (value: string) => value.replace(/^"|"$/g, '');

  const target = error.meta?.target;
  if (Array.isArray(target)) identifiers.push(...target.map(item => unquote(String(item))));
  else if (typeof target === 'string') identifiers.push(unquote(target));

  const cause = (error.meta as { driverAdapterError?: { cause?: unknown } } | undefined)?.driverAdapterError?.cause as {
    originalMessage?: unknown;
    constraint?: { fields?: unknown; index?: unknown };
  } | undefined;
  if (cause) {
    if (Array.isArray(cause.constraint?.fields)) identifiers.push(...cause.constraint.fields.map(item => unquote(String(item))));
    if (typeof cause.constraint?.index === 'string') identifiers.push(unquote(cause.constraint.index));
    // `duplicate key value violates unique constraint "<name>"`
    const named = typeof cause.originalMessage === 'string' ? /unique constraint "([^"]+)"/.exec(cause.originalMessage) : null;
    if (named) identifiers.push(named[1]!);
  }
  return identifiers;
}

function conflictsWith(error: unknown, index: string, fields: string[] = []): boolean {
  const target = uniqueConflictTarget(error);
  if (!target) return false;
  if (target.includes(index)) return true;
  // Prisma names modelled indexes by their fields rather than by the index
  // name, so accept that spelling too where the schema declares one.
  return fields.length > 0 && fields.every(field => target.includes(field));
}

/**
 * A second active agent claims the same published provider agent and version.
 * The index is deliberately CROSS-TENANT — its migration says why: two live
 * configurations sharing one provider version share its webhook and response
 * engine blast radius. That is right, and it also means the conflicting row is
 * usually invisible to the tenant looking at the error, so the message must
 * name the fact and the next action rather than a row they cannot find.
 */
export function isProviderDeploymentConflict(error: unknown): boolean {
  return conflictsWith(error, RECEPTIONIST_UNIQUE_INDEXES.activeProviderDeployment, ['providerAgentId', 'providerVersion']);
}

/** One provider deployment may drive only one ACTIVE Studio campaign in a tenant. */
export function isActiveCampaignDeploymentConflict(error: unknown): boolean {
  return conflictsWith(error, RECEPTIONIST_UNIQUE_INDEXES.activeCampaignDeployment, [
    'tenantId', 'intakeSchemaProviderAgentId', 'intakeSchemaProviderVersion',
  ]);
}

/** Two active clinics cannot answer on the same advertised or inbound number. */
export function isInboundDestinationConflict(error: unknown): boolean {
  return conflictsWith(error, RECEPTIONIST_UNIQUE_INDEXES.activeClinicPhone, ['phone'])
    || conflictsWith(error, RECEPTIONIST_UNIQUE_INDEXES.activeClinicInboundNumber, ['inboundNumber']);
}

/** Two clinics in one tenant cannot share a name. */
export function isClinicNameConflict(error: unknown): boolean {
  return conflictsWith(error, RECEPTIONIST_UNIQUE_INDEXES.clinicName, ['tenantId', 'name']);
}

/**
 * The operator sentence for a provider-deployment conflict. It says "another
 * CareCommand configuration" rather than "another agent" because the winner may
 * belong to a tenant this operator cannot see, and it names the one action that
 * actually resolves it: publish a fresh version, which deploying does.
 */
export const PROVIDER_DEPLOYMENT_CONFLICT_MESSAGE =
  'This published Retell agent version is already in use by another CareCommand configuration, which may be outside this tenant. One live provider version answers for one configuration, because they would otherwise share a webhook and a response engine. Deploy from Studio to publish a version of your own, or unlink this agent.';

export const INBOUND_DESTINATION_CONFLICT_MESSAGE =
  'This inbound destination is already assigned to an active receptionist clinic. One number answers for one clinic; give this clinic its own line, or deactivate the clinic that holds it.';

/**
 * @deprecated Package A narrowing, kept only so the two call sites it still has
 * keep compiling: `campaigns.ts` (Package B) and `clinics.ts`. Both must move to
 * the specific predicate for the constraint they actually provoke —
 * `isActiveCampaignDeploymentConflict` and `isInboundDestinationConflict` — and
 * this alias is then deleted.
 *
 * It is already strictly better than what it replaces: it answers true for the
 * receptionist uniqueness rules and no longer for every P2002 in the process,
 * so an unrelated duplicate somewhere in the same request stops being reported
 * as a destination conflict.
 */
export function isReceptionistDestinationConflict(error: unknown): boolean {
  return isProviderDeploymentConflict(error)
    || isActiveCampaignDeploymentConflict(error)
    || isInboundDestinationConflict(error);
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
