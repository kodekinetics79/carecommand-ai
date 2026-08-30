import { listRetellVoices, retellProviderMode, type RetellVoice } from '../retell';

// ===========================================================================
// Voice catalogue — C5's contribution to the receptionist catalog.
//
// TODO(merge C2): C2 owns `server/lib/receptionist/catalog.ts` and the
// `GET /v1/receptionist/catalog` route (contract §7). When that lands, fold
// `voicesCatalogSection()` into it as the `voices` + `providerMode` sections
// and drop the standalone `/voices` route in deployment.ts. This file exists
// so the two streams never edit the same file.
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
