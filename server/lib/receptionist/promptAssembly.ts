import type { Prisma } from '../../generated/prisma/client';
import type { db as DbClient } from '../db';
import {
  type PromptBookingRules,
  type PromptConfig,
  type PromptIntakeField,
  type PromptService,
} from '../../modules/receptionist/promptService';
import { hoursSummarySpoken, upcomingClosuresSpoken } from './clinicHours';
import { loadHoursSource } from './hoursSource';
import { parseKnowledgeDocument, type KnowledgeDocument } from './knowledge';
import { resolveLocalePackWithFallback } from './localePacks/resolve';
import { localeFormatOf } from './localePacks/render';

// ===========================================================================
// Prompt assembly — ONE place that turns a loaded campaign graph into the
// `PromptConfig` the prompt builder consumes.
//
// C2 made this a database read rather than a pure mapping: hours, approved
// clinic knowledge, bookable catalog services and the locale pack all come
// from rows, and every caller-facing string is rendered from the pack, so a
// configuration without one cannot be rendered at all rather than falling back
// to invented wording.
//
// It lives in `lib` so the export routes (`modules/receptionist/campaigns.ts`),
// deployment (`retellDeploy.ts`) and readiness (`campaignReadiness.ts`) share
// one assembly. If they did not, the prompt a preview shows, the prompt a
// deployment publishes and the prompt readiness hashes could disagree.
// ===========================================================================

export type PromptAssemblyClient = typeof DbClient | Prisma.TransactionClient;

/** The loaded campaign graph this assembly needs; structurally satisfied by
 *  both the export routes' loader and `loadCampaignGraph`. */
export interface CampaignPromptSource {
  id: string;
  name: string;
  campaignType: string;
  offerTitle: string;
  offerDescription: string;
  offerScript: string;
  appointmentType: string;
  bookingRules: unknown;
  eligibleLocationIds: string[];
  smsConfirmation: boolean;
  emailConfirmation: boolean;
  intakeSchemaRevision: number;
  clinicId: string;
  agentId: string | null;
  clinic: {
    id: string; name: string; phone: string; website: string | null; addressLine: string | null;
    country: string | null; timezone: string; defaultLanguage: string; complianceDisclosure: string | null;
    humanFallbackNumber: string | null; doNotContactPolicy: string | null;
    locations: Array<{ id: string; name: string; address: string; phone: string | null; accessNotes: string | null }>;
  };
  agent: {
    name: string; voice: string; tone: string; language: string;
    persona: string | null; greetingOverride: string | null;
  } | null;
  intakeFields: unknown[];
}

export type PromptConfigResult =
  | { ok: true; config: PromptConfig; localePackId: string | null; evidenceHash: string }
  | { ok: false; reason: 'locale_pack_unavailable' };

/**
 * Assemble the full prompt configuration: clinic facts, hours, approved
 * knowledge, catalog services and the locale pack.
 */
export async function assemblePromptConfig(
  client: PromptAssemblyClient,
  campaign: CampaignPromptSource,
  tenantId: string,
): Promise<PromptConfigResult> {
  const agent = campaign.agent;
  const language = agent?.language ?? campaign.clinic.defaultLanguage;
  const [bundle, knowledgeRow, services, resolvedPack] = await Promise.all([
    loadHoursSource(client, { tenantId, clinicId: campaign.clinic.id }),
    client.receptionistClinicKnowledge.findFirst({ where: { tenantId, clinicId: campaign.clinic.id }, select: { approved: true } }),
    client.serviceCatalogItem.findMany({
      where: { tenantId, active: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, spokenDescription: true, bookableByVoice: true, voiceDurationMinutes: true, defaultDurationMinutes: true, priceFrom: true },
    }),
    resolveLocalePackWithFallback(client, { tenantId, language, country: campaign.clinic.country }),
  ]);
  if (!resolvedPack) return { ok: false, reason: 'locale_pack_unavailable' };
  const locale = localeFormatOf(resolvedPack.strings, resolvedPack.language);
  const now = new Date();
  const knowledge: KnowledgeDocument | null = knowledgeRow?.approved ? parseKnowledgeDocument(knowledgeRow.approved) : null;
  const promptServices: PromptService[] = services.map(item => ({
    id: item.id,
    name: item.name,
    spokenDescription: item.spokenDescription,
    voiceDurationMinutes: item.voiceDurationMinutes ?? item.defaultDurationMinutes,
    priceFrom: item.priceFrom === null || item.priceFrom === undefined ? null : Number(item.priceFrom),
    bookableByVoice: item.bookableByVoice,
  }));
  const config: PromptConfig = {
    clinic: {
      id: campaign.clinic.id,
      name: campaign.clinic.name,
      phone: campaign.clinic.phone,
      website: campaign.clinic.website,
      addressLine: campaign.clinic.addressLine,
      country: campaign.clinic.country,
      timezone: campaign.clinic.timezone,
      defaultLanguage: campaign.clinic.defaultLanguage,
      complianceDisclosure: campaign.clinic.complianceDisclosure,
      humanFallbackNumber: campaign.clinic.humanFallbackNumber,
      doNotContactPolicy: campaign.clinic.doNotContactPolicy,
    },
    agent: agent ?? {
      // Preview-only fallback. Deploy refuses this config as a placeholder
      // rather than inventing an agent identity for a patient call.
      name: campaign.clinic.name, voice: '', tone: 'Warm and professional',
      language, persona: null, greetingOverride: null,
    },
    knowledge,
    services: promptServices,
    hours: bundle
      ? {
        clinicSummary: hoursSummarySpoken(bundle.source, locale),
        perLocation: bundle.locations.map(location => ({
          id: location.id,
          summary: hoursSummarySpoken(location.source, locale),
          closures: upcomingClosuresSpoken(location.source, now, 60, locale),
        })),
      }
      : null,
    localePack: { id: resolvedPack.id, strings: resolvedPack.strings, evidenceHash: resolvedPack.evidenceHash },
    campaign: {
      id: campaign.id,
      name: campaign.name,
      campaignType: campaign.campaignType,
      offerTitle: campaign.offerTitle,
      offerDescription: campaign.offerDescription,
      offerScript: campaign.offerScript,
      appointmentType: campaign.appointmentType,
      bookingRules: (campaign.bookingRules as PromptBookingRules | null) ?? null,
      eligibleLocationIds: campaign.eligibleLocationIds,
      smsConfirmation: campaign.smsConfirmation,
      emailConfirmation: campaign.emailConfirmation,
      intakeSchemaRevision: campaign.intakeSchemaRevision,
    },
    locations: campaign.clinic.locations,
    intakeFields: campaign.intakeFields as PromptIntakeField[],
  };
  return { ok: true, config, localePackId: resolvedPack.id, evidenceHash: resolvedPack.evidenceHash };
}
