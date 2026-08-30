import { describe, expect, it } from 'vitest';
import { receptionistFixtures } from '../test/fixtures/receptionist';
import { countryOptions, languageOptions, optionsOrCurrent, packStatusFor, timezoneOptions } from './receptionistCatalog';
import { groupPacks, previewValuesFor, renderPackTemplate, transferReadinessOf, unknownPlaceholdersIn } from './receptionistClinic';

// The client used to compile the timezone, language, voice and tone lists into
// the bundle, so a workspace whose stored value was not one of the eight
// hardcoded zones silently rendered the FIRST option as if it were the saved
// one. The catalog is now served; these tests hold the rule that replaced that
// defect: a stored value the catalog does not list is still shown, marked.

const catalog = receptionistFixtures.catalog();

describe('optionsOrCurrent', () => {
  it('keeps a stored value the catalog does not list, first and marked', () => {
    const options = timezoneOptions(catalog, 'Pacific/Chatham');
    expect(options[0]).toMatchObject({ value: 'Pacific/Chatham', outOfList: true });
    expect(options[0].label).toContain('not in catalog');
  });

  it('does not duplicate a stored value the catalog does list', () => {
    const options = timezoneOptions(catalog, 'Europe/London');
    expect(options.filter(option => option.value === 'Europe/London')).toHaveLength(1);
    expect(options.some(option => option.outOfList)).toBe(false);
  });

  it('is generic over the option shape', () => {
    const kept = optionsOrCurrent([{ id: 'a' }], 'b', item => item.id, value => ({ id: value }));
    expect(kept).toEqual([{ id: 'b' }, { id: 'a' }]);
  });
});

describe('timezoneOptions', () => {
  it('puts the tenant branch zones first under Recommended, without repeating them', () => {
    const options = timezoneOptions(catalog, 'Europe/London');
    expect(options[0]).toMatchObject({ value: 'Europe/London', group: 'Recommended' });
    expect(options.filter(option => option.value === 'Europe/London')).toHaveLength(1);
    expect(options.some(option => option.group === 'America')).toBe(true);
  });

  it('offers nothing but the stored value when the catalog failed to load', () => {
    expect(timezoneOptions(null, 'Europe/London')).toEqual([{ value: 'Europe/London', label: 'Europe/London (not in catalog)', group: 'Current', outOfList: true }]);
  });
});

describe('countryOptions / languageOptions', () => {
  it('names countries by their catalog label', () => {
    expect(countryOptions(catalog, 'GB').map(option => option.label)).toContain('United Kingdom (GB)');
  });

  it('says the pack status next to each language, so the activation blocker is visible before saving', () => {
    const labels = languageOptions(catalog, 'en-GB', 'GB').map(option => option.label);
    expect(labels).toContain('English (UK) — pack approved');
    // en-US has no pack for GB in the catalog: it must read as missing, not approved.
    expect(labels).toContain('English (US) — pack missing');
  });

  it('omits the pack suffix while the country is unknown', () => {
    expect(languageOptions(catalog, 'en-GB', null).map(option => option.label)).toContain('English (UK)');
  });
});

describe('packStatusFor', () => {
  it('finds the row for a (language, country) pair and nothing for an unknown pair', () => {
    expect(packStatusFor(catalog, 'en-GB', 'GB')?.status).toBe('APPROVED');
    expect(packStatusFor(catalog, 'en-US', 'US')?.status).toBe('MISSING');
    expect(packStatusFor(catalog, 'fr-FR', 'FR')).toBeNull();
  });
});

describe('transferReadinessOf', () => {
  it('trusts the server readiness when it is present', () => {
    const clinics = receptionistFixtures.clinics();
    expect(transferReadinessOf(clinics[0].readiness, clinics[0].humanFallbackNumber)).toEqual({ ready: true, reason: null });
    expect(transferReadinessOf(clinics[1].readiness, clinics[1].humanFallbackNumber)).toEqual({ ready: false, reason: 'missing' });
  });

  it('applies the same E.164 rule locally when the server did not send readiness', () => {
    expect(transferReadinessOf(undefined, '+14155550100')).toEqual({ ready: true, reason: null });
    expect(transferReadinessOf(undefined, '(415) 555-0100')).toEqual({ ready: false, reason: 'not_e164' });
    expect(transferReadinessOf(undefined, null)).toEqual({ ready: false, reason: 'missing' });
  });
});

describe('locale pack rendering (client-side preview)', () => {
  const packs = receptionistFixtures.localePacks();
  const clinic = receptionistFixtures.clinics()[0];

  it('leaves no placeholder unresolved for a known template', () => {
    const pack = packs.packs[0];
    const rendered = renderPackTemplate(pack.strings.messages['disclosure.recording'], previewValuesFor(clinic, pack.strings));
    expect(rendered).not.toContain('{{');
    expect(rendered).toContain('Harley Street Medical Group');
  });

  it('speaks the pack emergency number, not a hardcoded 911', () => {
    const pack = packs.packs[0];
    const rendered = renderPackTemplate(pack.strings.messages['emergency.instruction'], previewValuesFor(clinic, pack.strings));
    expect(rendered).toContain('999');
    expect(rendered).not.toContain('911');
  });

  it('leaves an unknown placeholder in place so the reviewer sees what would fail validation', () => {
    expect(renderPackTemplate('Call {{mystery}} now', previewValuesFor(clinic, packs.packs[0].strings))).toBe('Call {{mystery}} now');
    expect(unknownPlaceholdersIn('Hi {{agent_name}}, {{mystery}} and {{other}}')).toEqual(['mystery', 'other']);
  });
});

describe('groupPacks', () => {
  it('groups by language and country with the newest version first', () => {
    const groups = groupPacks(receptionistFixtures.localePacks().packs);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ language: 'en-GB', country: 'GB' });
    expect(groups[0].packs.map(pack => pack.version)).toEqual([2, 1]);
  });
});
