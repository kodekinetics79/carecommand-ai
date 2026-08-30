import { listRetellVoices, retellProviderMode, type RetellVoice } from '../retell';

// ===========================================================================
// Voice catalogue — the `voices` + `providerMode` sections of the receptionist
// catalog (contract §7).
//
// The C2/C5 merge this file was waiting for is done: `buildReceptionistCatalog`
// now calls `voicesCatalogSection()` and serves the voices with the rest of the
// catalog, so one read fills the Studio's voice select.
//
// `GET /voices` stays, and is not a leftover. The catalog carries the LIST; the
// standalone route additionally carries `source`, `fetchedAt` and `error`, which
// is the only way the client can say WHY a select is empty ("the voice service
// could not be read") instead of silently showing nothing. The client reads the
// catalog first and only asks this route when the catalog came back with no
// voices — i.e. exactly when it needs the reason.
//
// The list is cached briefly in process: it changes rarely, every Studio agent
// form asks for it, and a provider outage must not empty a select the operator
// is mid-edit in. A stale-but-known list is better than a blank one — the
// response says which it is.
// ===========================================================================

export interface VoicesCatalogSection {
  providerMode: 'live' | 'mock' | 'unconfigured';
  voices: RetellVoice[];
  source: 'provider' | 'cache' | 'unavailable';
  fetchedAt: string | null;
  /** Set when the provider could not be reached, so the UI can say so instead of showing an empty list. */
  error: string | null;
}

/** What a voice looks like on the wire: the supplier that synthesised it is dropped. */
export type TenantFacingVoice = Omit<RetellVoice, 'provider'>;

/**
 * One implementation of "what a tenant may see of a voice", shared by the
 * catalog and the standalone route so the two can never disagree about which
 * fields leave the server. `provider` names one of our suppliers and nothing
 * chooses a voice on it — gender and accent are what an owner picks on.
 */
export function tenantFacingVoices(voices: readonly RetellVoice[]): TenantFacingVoice[] {
  return voices.map(({ voiceId, name, gender, accent, age, previewUrl }) => ({ voiceId, name, gender, accent, age, previewUrl }));
}

const CACHE_TTL_MS = 60 * 60 * 1_000;
let cache: { voices: RetellVoice[]; fetchedAt: number; providerMode: string } | null = null;

/** Test seam: the catalogue is process-cached, and suites switch provider keys. */
export function resetVoicesCatalogCache(): void {
  cache = null;
}

export async function voicesCatalogSection(now = Date.now()): Promise<VoicesCatalogSection> {
  const providerMode = retellProviderMode();
  if (cache && cache.providerMode === providerMode && now - cache.fetchedAt < CACHE_TTL_MS) {
    return { providerMode, voices: cache.voices, source: 'cache', fetchedAt: new Date(cache.fetchedAt).toISOString(), error: null };
  }
  const result = await listRetellVoices();
  if (!result.ok) {
    // Serve the last known list rather than an empty select, and say it is stale.
    if (cache && cache.providerMode === providerMode) {
      return { providerMode, voices: cache.voices, source: 'cache', fetchedAt: new Date(cache.fetchedAt).toISOString(), error: result.error };
    }
    return { providerMode, voices: [], source: 'unavailable', fetchedAt: null, error: result.error };
  }
  cache = { voices: result.value, fetchedAt: now, providerMode };
  return { providerMode, voices: result.value, source: 'provider', fetchedAt: new Date(now).toISOString(), error: null };
}
