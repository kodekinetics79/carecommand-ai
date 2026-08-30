import type { Prisma } from '../../generated/prisma/client';
import type { db as DbClient } from '../db';
import { isSupportedAgentLanguage } from './catalog';
import { bundleHoursConfigured, loadHoursSource } from './hoursSource';
import { resolveApprovedLocalePack } from './localePacks/resolve';
import { transferReadiness, type TransferReadiness } from './transferReadiness';

type Client = typeof DbClient | Prisma.TransactionClient;

// Pure clinic-level activation blockers (contract §6). Until C5's
// evaluateCampaignReadiness lands these are raised as 409s from today's
// assertCampaignAgent path; C5 maps them to readiness rows.

export type ClinicActivationBlocker =
  | 'clinic_country_missing'
  | 'clinic_hours_missing'
  | 'locale_pack_unapproved'
  | 'agent_language_unsupported'
  | 'transfer_loops_to_agent';

export const CLINIC_ACTIVATION_BLOCKERS: readonly ClinicActivationBlocker[] = [
  'clinic_country_missing', 'clinic_hours_missing', 'locale_pack_unapproved', 'agent_language_unsupported', 'transfer_loops_to_agent',
];

export interface ClinicActivationState {
  blockers: ClinicActivationBlocker[];
  country: string | null;
  language: string;
  hoursConfigured: boolean;
  transfer: TransferReadiness;
  localePack: { id: string; evidenceHash: string; language: string; country: string; version: number } | null;
}

export async function clinicActivationState(
  tx: Client,
  input: { tenantId: string; clinicId: string; agent: { language: string } | null },
): Promise<ClinicActivationState> {
  const clinic = await tx.receptionistClinic.findFirst({
    where: { id: input.clinicId, tenantId: input.tenantId },
    select: { id: true, phone: true, country: true, defaultLanguage: true, humanFallbackNumber: true, locations: { where: { active: true }, select: { phone: true } } },
  });
  if (!clinic) throw new Error('clinic_not_found');
  const language = input.agent?.language ?? clinic.defaultLanguage;
  const blockers: ClinicActivationBlocker[] = [];
  if (!clinic.country) blockers.push('clinic_country_missing');
  const bundle = await loadHoursSource(tx, { tenantId: input.tenantId, clinicId: clinic.id });
  const hours = bundle ? bundleHoursConfigured(bundle) : false;
  if (!hours) blockers.push('clinic_hours_missing');
  const pack = clinic.country
    ? await resolveApprovedLocalePack(tx, { tenantId: input.tenantId, language, country: clinic.country })
    : null;
  if (!pack) blockers.push('locale_pack_unapproved');
  if (!isSupportedAgentLanguage(language)) blockers.push('agent_language_unsupported');
  const transfer = transferReadiness(clinic, { inboundLineNumbers: clinic.locations.map(location => location.phone) });
  if (transfer.reason === 'loops_to_agent') blockers.push('transfer_loops_to_agent');
  return {
    blockers,
    country: clinic.country,
    language,
    hoursConfigured: hours,
    transfer,
    localePack: pack ? { id: pack.id!, evidenceHash: pack.evidenceHash, language: pack.language, country: pack.country, version: pack.version } : null,
  };
}

export async function clinicActivationBlockers(
  tx: Client,
  input: { tenantId: string; clinicId: string; agent: { language: string } | null },
): Promise<ClinicActivationBlocker[]> {
  return (await clinicActivationState(tx, input)).blockers;
}

export function isClinicActivationBlocker(value: string): value is ClinicActivationBlocker {
  return (CLINIC_ACTIVATION_BLOCKERS as readonly string[]).includes(value);
}
