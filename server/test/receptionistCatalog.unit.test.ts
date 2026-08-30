import { describe, expect, it } from 'vitest';
import {
  CATALOG_LIMITS,
  FIELD_TYPE_GROUPS,
  SUPPORTED_AGENT_LANGUAGES,
  SUPPORTED_COUNTRIES,
  countryCallingCode,
  countryCurrency,
  countryDefaultLanguage,
  findCountry,
  isSupportedAgentLanguage,
  isSupportedCountry,
  timezoneGroups,
} from '../lib/receptionist/catalog';
import { FIELD_TYPE_META, type ReceptionistFieldType } from '../modules/receptionist/promptService';
import { PLATFORM_LOCALE_PACKS } from '../lib/receptionist/localePacks/defaults';
import { MAX_INTAKE_FIELDS } from '../modules/receptionist/intakeContract';

describe('receptionist catalog', () => {
  it('describes every field type the prompt knows about', () => {
    const metaKeys = Object.keys(FIELD_TYPE_META).sort();
    expect(Object.keys(FIELD_TYPE_GROUPS).sort()).toEqual(metaKeys);
    // Every field type must belong to a group, or the Studio renders it nowhere.
    for (const type of metaKeys as ReceptionistFieldType[]) {
      expect(FIELD_TYPE_GROUPS[type], type).toBeTruthy();
    }
  });

  it('gives every supported country a calling code, emergency number and language', () => {
    for (const country of SUPPORTED_COUNTRIES) {
      expect(country.code, country.name).toMatch(/^[A-Z]{2}$/);
      expect(country.callingCode, country.code).toMatch(/^\d{1,4}$/);
      expect(country.defaultEmergencyNumber, country.code).toMatch(/^\d{2,4}$/);
      expect(country.defaultLanguages.length, country.code).toBeGreaterThan(0);
      expect(country.currency, country.code).toMatch(/^[A-Z]{3}$/);
      // The default language a country offers must be one the provider speaks.
      for (const language of country.defaultLanguages) expect(isSupportedAgentLanguage(language), `${country.code} ${language}`).toBe(true);
    }
  });

  it('resolves country facts used by phone normalisation and pricing', () => {
    expect(countryCallingCode('GB')).toBe('44');
    expect(countryCallingCode('ZZ')).toBeNull();
    expect(countryDefaultLanguage('GB')).toBe('en-GB');
    expect(countryDefaultLanguage('US')).toBe('en-US');
    expect(countryCurrency('GB')).toBe('GBP');
    expect(countryCurrency(null)).toBeNull();
    expect(findCountry('gb')?.code).toBe('GB');
    expect(isSupportedCountry('US')).toBe(true);
    expect(isSupportedCountry('ZZ')).toBe(false);
  });

  it('offers a platform default pack for every country whose default language has one', () => {
    for (const pack of PLATFORM_LOCALE_PACKS) {
      expect(isSupportedCountry(pack.country), pack.country).toBe(true);
      expect(isSupportedAgentLanguage(pack.language), pack.language).toBe(true);
    }
  });

  it('groups timezones by region and keeps them sorted', () => {
    const groups = timezoneGroups();
    const europe = groups.find(group => group.region === 'Europe');
    expect(europe?.zones).toContain('Europe/London');
    expect(groups.map(group => group.region)).toEqual([...groups.map(group => group.region)].sort());
    expect(europe?.zones).toEqual([...(europe?.zones ?? [])].sort());
  });

  it('serves the limits the client would otherwise hardcode', () => {
    expect(CATALOG_LIMITS.maxIntakeFields).toBe(MAX_INTAKE_FIELDS);
    expect(CATALOG_LIMITS.faqMax).toBeGreaterThan(0);
    expect(CATALOG_LIMITS.closureMaxDays).toBe(366);
  });

  it('marks only the dropdown field type as having options', () => {
    // The tag is generic on purpose: the catalog is served to the browser and
    // which house speaks a language is not the clinic's business (see
    // server/test/receptionistVendorNeutrality.lint.test.ts).
    expect(SUPPORTED_AGENT_LANGUAGES.every(item => item.provider === 'voice_service')).toBe(true);
  });
});
