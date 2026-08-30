import type { Prisma } from '../../generated/prisma/client';
import type { db as DbClient } from '../db';
import { FIELD_TYPE_META, type ReceptionistFieldType } from '../../modules/receptionist/promptService';
import { MAX_INTAKE_FIELDS } from '../../modules/receptionist/intakeContract';
import { KNOWLEDGE_LIMITS } from './knowledge';
import { PLATFORM_LOCALE_PACKS } from './localePacks/defaults';
import { tenantFacingVoices, voicesCatalogSection, type TenantFacingVoice } from './catalogVoices';

// ===========================================================================
// Server-served option catalog (M27/M52). The client renders what this returns
// instead of compiling option lists into the bundle. `voices` and
// `providerMode` come from `catalogVoices`, which owns the one call into
// server/lib/retell.ts.
//
// The voice section can never fail this read: `voicesCatalogSection()` resolves
// to an empty list with a stated reason when the provider is unreachable, so a
// voice-service outage costs the catalog its voices, never its countries,
// timezones or locale packs.
// ===========================================================================

type Client = typeof DbClient | Prisma.TransactionClient;

export interface CatalogCountry {
  code: string;
  name: string;
  callingCode: string;
  /** Default offered when creating a pack; the spoken number always comes from the approved pack. */
  defaultEmergencyNumber: string;
  defaultLanguages: string[];
  currency: string;
}

export const SUPPORTED_COUNTRIES: readonly CatalogCountry[] = [
  { code: 'US', name: 'United States', callingCode: '1', defaultEmergencyNumber: '911', defaultLanguages: ['en-US'], currency: 'USD' },
  { code: 'CA', name: 'Canada', callingCode: '1', defaultEmergencyNumber: '911', defaultLanguages: ['en-US'], currency: 'CAD' },
  { code: 'GB', name: 'United Kingdom', callingCode: '44', defaultEmergencyNumber: '999', defaultLanguages: ['en-GB'], currency: 'GBP' },
  { code: 'IE', name: 'Ireland', callingCode: '353', defaultEmergencyNumber: '112', defaultLanguages: ['en-GB'], currency: 'EUR' },
  { code: 'AU', name: 'Australia', callingCode: '61', defaultEmergencyNumber: '000', defaultLanguages: ['en-GB'], currency: 'AUD' },
  { code: 'NZ', name: 'New Zealand', callingCode: '64', defaultEmergencyNumber: '111', defaultLanguages: ['en-GB'], currency: 'NZD' },
  { code: 'DE', name: 'Germany', callingCode: '49', defaultEmergencyNumber: '112', defaultLanguages: ['en-GB'], currency: 'EUR' },
  { code: 'FR', name: 'France', callingCode: '33', defaultEmergencyNumber: '112', defaultLanguages: ['en-GB'], currency: 'EUR' },
  { code: 'ES', name: 'Spain', callingCode: '34', defaultEmergencyNumber: '112', defaultLanguages: ['en-GB'], currency: 'EUR' },
  { code: 'PT', name: 'Portugal', callingCode: '351', defaultEmergencyNumber: '112', defaultLanguages: ['en-GB'], currency: 'EUR' },
  { code: 'NL', name: 'Netherlands', callingCode: '31', defaultEmergencyNumber: '112', defaultLanguages: ['en-GB'], currency: 'EUR' },
];

/** Provider capability list; server-validated on agent/clinic writes. */
// `provider` tagged each language with the supplier that speaks it and rode
// out to the browser on every catalog read, where nothing rendered it. The
// tag is the voice service, generically: which one is not the clinic's
// business, and it was never the clinic's choice.
export const SUPPORTED_AGENT_LANGUAGES: ReadonlyArray<{ id: string; label: string; provider: 'voice_service' }> = [
  { id: 'en-US', label: 'English (US)', provider: 'voice_service' },
  { id: 'en-GB', label: 'English (UK)', provider: 'voice_service' },
];

export const TONES: readonly string[] = ['Warm and professional', 'Calm and reassuring', 'Friendly and upbeat', 'Concise and efficient'];

export const CAMPAIGN_TYPES: readonly string[] = ['Reactivation', 'Recall', 'Reminder', 'New patient', 'Inbound reception'];

export const FIELD_TYPE_GROUPS: Record<ReceptionistFieldType, string> = {
  FIRST_NAME: 'Identity', LAST_NAME: 'Identity', PHONE: 'Contact', EMAIL: 'Contact',
  PREFERRED_DATE: 'Scheduling', PREFERRED_TIME: 'Scheduling', PREFERRED_LOCATION: 'Scheduling', PREFERRED_PROVIDER: 'Scheduling',
  PATIENT_STATUS: 'Visit', INSURANCE_PROVIDER: 'Visit', REASON_FOR_VISIT: 'Visit', LANGUAGE_PREFERENCE: 'Visit',
  CONSENT: 'Preferences', CUSTOM_TEXT: 'Custom', CUSTOM_DROPDOWN: 'Custom', CUSTOM_YES_NO: 'Custom',
};

export const CATALOG_LIMITS = {
  maxIntakeFields: MAX_INTAKE_FIELDS,
  faqMax: KNOWLEDGE_LIMITS.faqMax,
  payersMax: KNOWLEDGE_LIMITS.payersMax,
  closureMaxDays: 366,
  knowledgeTextMax: KNOWLEDGE_LIMITS.textMax,
  closureReasonMax: 160,
  accessNotesMax: 600,
} as const;

export function findCountry(code: string | null | undefined): CatalogCountry | null {
  if (!code) return null;
  return SUPPORTED_COUNTRIES.find(country => country.code === code.toUpperCase()) ?? null;
}

export function isSupportedCountry(code: string): boolean {
  return findCountry(code) !== null;
}

/** Used by C3's default-prefix phone normaliser. */
export function countryCallingCode(code: string): string | null {
  return findCountry(code)?.callingCode ?? null;
}

export function countryDefaultLanguage(code: string): string | null {
  return findCountry(code)?.defaultLanguages[0] ?? null;
}

export function countryCurrency(code: string | null | undefined): string | null {
  return findCountry(code)?.currency ?? null;
}

export function isSupportedAgentLanguage(language: string): boolean {
  return SUPPORTED_AGENT_LANGUAGES.some(item => item.id === language);
}

export function timezoneGroups(): Array<{ region: string; zones: string[] }> {
  const zones = Intl.supportedValuesOf('timeZone');
  const groups = new Map<string, string[]>();
  for (const zone of zones) {
    const region = zone.includes('/') ? zone.slice(0, zone.indexOf('/')) : 'Other';
    groups.set(region, [...(groups.get(region) ?? []), zone]);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([region, list]) => ({ region, zones: list.sort() }));
}

export interface ReceptionistCatalog {
  generatedAt: string;
  fieldTypes: Array<{ type: ReceptionistFieldType; label: string; question: string; validation: string; group: string; hasOptions: boolean; sensitive: boolean }>;
  timezones: { groups: Array<{ region: string; zones: string[] }>; recommended: string[] };
  countries: CatalogCountry[];
  languages: Array<{ id: string; label: string; provider: string }>;
  tones: string[];
  campaignTypes: string[];
  localePacks: Array<{ language: string; country: string; status: 'APPROVED' | 'DRAFT' | 'MISSING'; packId: string | null; hasPlatformDefault: boolean; platformDefaultVersion: number | null }>;
  limits: typeof CATALOG_LIMITS;
  /** Contract §7: the voice select is filled by this read, not by a second one. */
  voices: TenantFacingVoice[];
  providerMode: 'live' | 'mock' | 'unconfigured';
}

export async function buildReceptionistCatalog(client: Client, tenantId: string, now = new Date()): Promise<ReceptionistCatalog> {
  const [branches, packs, voices] = await Promise.all([
    client.branch.findMany({ where: { tenantId, active: true }, select: { timezone: true } }),
    client.receptionistLocalePack.findMany({
      where: { tenantId, status: { in: ['APPROVED', 'DRAFT'] } },
      select: { id: true, language: true, country: true, status: true, version: true },
      orderBy: [{ status: 'asc' }, { version: 'desc' }],
    }),
    voicesCatalogSection(),
  ]);
  const pairs = new Map<string, { language: string; country: string; hasPlatformDefault: boolean; platformDefaultVersion: number | null }>();
  for (const pack of PLATFORM_LOCALE_PACKS) pairs.set(`${pack.language}:${pack.country}`, { language: pack.language, country: pack.country, hasPlatformDefault: true, platformDefaultVersion: pack.version });
  for (const pack of packs) {
    const key = `${pack.language}:${pack.country}`;
    if (!pairs.has(key)) pairs.set(key, { language: pack.language, country: pack.country, hasPlatformDefault: false, platformDefaultVersion: null });
  }
  const localePacks = [...pairs.values()].map(pair => {
    const approved = packs.find(pack => pack.language === pair.language && pack.country === pair.country && pack.status === 'APPROVED');
    const draft = packs.find(pack => pack.language === pair.language && pack.country === pair.country && pack.status === 'DRAFT');
    return {
      ...pair,
      status: approved ? 'APPROVED' as const : draft ? 'DRAFT' as const : 'MISSING' as const,
      packId: approved?.id ?? draft?.id ?? null,
    };
  });
  return {
    generatedAt: now.toISOString(),
    fieldTypes: (Object.keys(FIELD_TYPE_META) as ReceptionistFieldType[]).map(type => ({
      type,
      label: FIELD_TYPE_META[type].label,
      question: FIELD_TYPE_META[type].question,
      validation: FIELD_TYPE_META[type].validation,
      group: FIELD_TYPE_GROUPS[type],
      hasOptions: type === 'CUSTOM_DROPDOWN',
      sensitive: FIELD_TYPE_META[type].sensitive === true,
    })),
    timezones: { groups: timezoneGroups(), recommended: [...new Set(branches.map(branch => branch.timezone))].sort() },
    countries: [...SUPPORTED_COUNTRIES],
    languages: SUPPORTED_AGENT_LANGUAGES.map(item => ({ ...item })),
    tones: [...TONES],
    campaignTypes: [...CAMPAIGN_TYPES],
    localePacks,
    limits: CATALOG_LIMITS,
    voices: tenantFacingVoices(voices.voices),
    providerMode: voices.providerMode,
  };
}
