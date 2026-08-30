import type { Prisma } from '../../../generated/prisma/client';
import type { db as DbClient } from '../../db';
import { platformLocalePack, platformLocalePackForCountry, platformLocalePackHash } from './defaults';
import { isLocalePackStrings, localeFormatOf } from './render';
import type { LocaleFormat, LocalePackStrings } from './types';

type Client = typeof DbClient | Prisma.TransactionClient;

export interface ResolvedLocalePack {
  /** Tenant pack id, or null when a platform default is standing in. */
  id: string | null;
  language: string;
  country: string;
  version: number;
  strings: LocalePackStrings;
  evidenceHash: string;
  source: 'approved' | 'platform_default';
  /**
   * Keys the approved pack did not carry, filled in from the platform default
   * for its (language, country). A pack approved before a key existed must not
   * make the agent throw mid-call, so the missing key falls back rather than
   * failing. `evidenceHash` is deliberately still the hash of what was
   * APPROVED: a backfilled key was never part of that attestation, and this
   * list is what says so.
   */
  backfilledKeys: string[];
}

function withPlatformDefaults(
  strings: LocalePackStrings,
  language: string,
  country: string,
): { strings: LocalePackStrings; backfilledKeys: string[] } {
  const platform = platformLocalePack(language, country) ?? platformLocalePackForCountry(country);
  if (!platform) return { strings, backfilledKeys: [] };
  const backfilledKeys = Object.keys(platform.strings.messages)
    .filter(key => typeof strings.messages[key] !== 'string' || !strings.messages[key].trim());
  if (!backfilledKeys.length) return { strings, backfilledKeys: [] };
  return {
    // Platform text first, the approved pack's own words on top: a tenant
    // override always wins, and only a genuinely absent key is filled.
    strings: { ...strings, messages: { ...platform.strings.messages, ...strings.messages } },
    backfilledKeys,
  };
}

/** APPROVED tenant pack for (language, country); DRAFT and RETIRED packs are never returned. */
export async function resolveApprovedLocalePack(
  client: Client,
  input: { tenantId: string; language: string; country: string },
): Promise<ResolvedLocalePack | null> {
  const row = await client.receptionistLocalePack.findFirst({
    where: { tenantId: input.tenantId, language: input.language, country: input.country, status: 'APPROVED' },
    select: { id: true, language: true, country: true, version: true, strings: true, evidenceHash: true },
  });
  if (!row || !isLocalePackStrings(row.strings)) return null;
  const filled = withPlatformDefaults(row.strings, row.language, row.country);
  return {
    id: row.id, language: row.language, country: row.country, version: row.version,
    strings: filled.strings, evidenceHash: row.evidenceHash, source: 'approved', backfilledKeys: filled.backfilledKeys,
  };
}

/**
 * Approved pack, else the platform default for (language, country), else the
 * platform default for the country. Used for prompt previews and legacy calls;
 * activation itself still requires an APPROVED pack.
 */
export async function resolveLocalePackWithFallback(
  client: Client,
  input: { tenantId: string; language: string; country: string | null },
): Promise<ResolvedLocalePack | null> {
  if (!input.country) return null;
  const approved = await resolveApprovedLocalePack(client, { tenantId: input.tenantId, language: input.language, country: input.country });
  if (approved) return approved;
  const fallback = platformLocalePack(input.language, input.country) ?? platformLocalePackForCountry(input.country);
  if (!fallback) return null;
  return {
    id: null, language: fallback.language, country: fallback.country, version: fallback.version,
    strings: fallback.strings, evidenceHash: platformLocalePackHash(fallback), source: 'platform_default', backfilledKeys: [],
  };
}

/**
 * The pack for a live call: the pack stamped on the call log when present,
 * else clinic country + agent language (trusted provider agent, else the
 * campaign agent, else the clinic default language) through the fallback
 * chain above.
 */
export async function resolveCallLocalePack(
  client: Client,
  input: { tenantId: string; callId: string | null | undefined; trustedProviderAgentId?: string | null },
): Promise<ResolvedLocalePack | null> {
  if (!input.callId) return null;
  const call = await client.receptionistCallLog.findFirst({
    where: { tenantId: input.tenantId, retellCallId: input.callId },
    select: {
      localePack: { select: { id: true, language: true, country: true, version: true, strings: true, evidenceHash: true, status: true } },
      clinic: { select: { id: true, country: true, defaultLanguage: true } },
      campaign: { select: { agent: { select: { language: true } } } },
    },
  });
  if (!call?.clinic) return null;
  const stamped = call.localePack;
  if (stamped?.status === 'APPROVED' && isLocalePackStrings(stamped.strings)) {
    const filled = withPlatformDefaults(stamped.strings, stamped.language, stamped.country);
    return {
      id: stamped.id, language: stamped.language, country: stamped.country, version: stamped.version,
      strings: filled.strings, evidenceHash: stamped.evidenceHash, source: 'approved', backfilledKeys: filled.backfilledKeys,
    };
  }
  const trustedAgent = input.trustedProviderAgentId
    ? await client.receptionistAgent.findFirst({ where: { id: input.trustedProviderAgentId, tenantId: input.tenantId, clinicId: call.clinic.id }, select: { language: true } })
    : null;
  const language = trustedAgent?.language ?? call.campaign?.agent?.language ?? call.clinic.defaultLanguage;
  return resolveLocalePackWithFallback(client, { tenantId: input.tenantId, language, country: call.clinic.country });
}

export function resolvedLocaleFormat(pack: ResolvedLocalePack | null, fallbackLanguage: string): LocaleFormat {
  return pack ? localeFormatOf(pack.strings, pack.language) : { language: fallbackLanguage, timeStyle: '24h', dateStyle: 'weekday-day-month' };
}
