import { useResource, type UseResourceResult } from '../hooks/useResource';
import { CATALOG_PATH, type Catalog, type CatalogLocalePackStatus } from './receptionistClinic';

/**
 * The receptionist catalog (contract §7): timezones, countries, languages,
 * tones, campaign types, pack statuses and limits are SERVED, never compiled
 * into the client. The hook is the shared screen-state contract, so a panel
 * that needs the catalog distinguishes loading / error / ready and never
 * renders an empty select as if the tenant had no options.
 */
export function useReceptionistCatalog(): UseResourceResult<Catalog> {
  return useResource<Catalog>(CATALOG_PATH);
}

/**
 * Options for a select whose stored value may no longer be in the list (a
 * timezone the catalog stopped recommending, a language the provider dropped).
 * The stored value is kept — first, marked — so the select shows what the row
 * actually holds instead of silently snapping to the first option.
 */
export function optionsOrCurrent<T>(
  items: readonly T[],
  current: string | null | undefined,
  toValue: (item: T) => string,
  makeCurrent: (value: string) => T,
): T[] {
  const list = [...items];
  if (current && !list.some(item => toValue(item) === current)) list.unshift(makeCurrent(current));
  return list;
}

export interface SelectOption { value: string; label: string; group?: string; outOfList?: boolean }

/** Grouped timezones with the tenant's recommended zones first. */
export function timezoneOptions(catalog: Catalog | null, current: string | null | undefined): SelectOption[] {
  const recommended = catalog?.timezones.recommended ?? [];
  const seen = new Set<string>();
  const out: SelectOption[] = [];
  for (const zone of recommended) {
    if (seen.has(zone)) continue;
    seen.add(zone);
    out.push({ value: zone, label: zone, group: 'Recommended' });
  }
  for (const group of catalog?.timezones.groups ?? []) {
    for (const zone of group.zones) {
      if (seen.has(zone)) continue;
      seen.add(zone);
      out.push({ value: zone, label: zone, group: group.region });
    }
  }
  return optionsOrCurrent(out, current, option => option.value, value => ({ value, label: `${value} (not in catalog)`, group: 'Current', outOfList: true }));
}

export function countryOptions(catalog: Catalog | null, current: string | null | undefined): SelectOption[] {
  const list = (catalog?.countries ?? []).map(country => ({ value: country.code, label: `${country.name} (${country.code})` }));
  return optionsOrCurrent(list, current, option => option.value, value => ({ value, label: `${value} (not in catalog)`, outOfList: true }));
}

export function packStatusFor(catalog: Catalog | null, language: string | null | undefined, country: string | null | undefined): CatalogLocalePackStatus | null {
  if (!catalog || !language || !country) return null;
  return catalog.localePacks.find(pack => pack.language === language && pack.country === country) ?? null;
}

const PACK_SUFFIX: Record<CatalogLocalePackStatus['status'], string> = {
  APPROVED: 'pack approved',
  DRAFT: 'pack in draft',
  MISSING: 'pack missing',
};

/** "English (UK) — pack approved" so the reason activation fails is visible in the select. */
export function languageOptions(catalog: Catalog | null, current: string | null | undefined, country: string | null | undefined): SelectOption[] {
  const list = (catalog?.languages ?? []).map(language => {
    const pack = packStatusFor(catalog, language.id, country);
    const suffix = pack ? PACK_SUFFIX[pack.status] : country ? PACK_SUFFIX.MISSING : null;
    return { value: language.id, label: suffix ? `${language.label} — ${suffix}` : language.label };
  });
  return optionsOrCurrent(list, current, option => option.value, value => ({ value, label: `${value} (not in catalog)`, outOfList: true }));
}

export function languageLabel(catalog: Catalog | null, id: string): string {
  return catalog?.languages.find(language => language.id === id)?.label ?? id;
}

export function countryName(catalog: Catalog | null, code: string | null | undefined): string {
  if (!code) return 'Not set';
  return catalog?.countries.find(country => country.code === code)?.name ?? code;
}
