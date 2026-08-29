import { describe, expect, it } from 'vitest';
import { activeServices, catalogGovernsBooking, durationLabel, type ServiceCatalogItem } from './services';

// resolveSchedulingService (server/lib/scheduling.ts) switches to strict
// matching the moment ONE active catalog item exists: from then on a booking
// whose service does not match an entry exactly is refused with "Select an
// active service". The booking form has to follow the same rule, or it offers a
// free-text box for a value the server will reject. These tests pin that mirror
// — the expected sentences are the behaviour, not the implementation.

function service(overrides: Partial<ServiceCatalogItem> = {}): ServiceCatalogItem {
  return {
    id: 'a', name: 'Annual exam', category: 'general',
    defaultDurationMinutes: 30, defaultAppointmentValue: null,
    depositRuleId: null, active: true,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('catalogGovernsBooking', () => {
  it('leaves booking on free text while the catalog is empty', () => {
    // Matches the server's fallback: no catalog means any service name at 30
    // minutes. Offering a dropdown here would offer nothing at all.
    expect(catalogGovernsBooking([])).toBe(false);
  });

  it('governs as soon as a single active service exists', () => {
    // The trap this is guarding: the FIRST service a clinic creates silently
    // makes every unlisted service unbookable.
    expect(catalogGovernsBooking([service()])).toBe(true);
  });

  it('does not govern when every service is switched off', () => {
    // The server counts active items only, so a catalog of retired services
    // falls back to free text and the form must do the same.
    expect(catalogGovernsBooking([
      service({ id: 'a', active: false }),
      service({ id: 'b', name: 'Cleaning', active: false }),
    ])).toBe(false);
  });

  it('governs when at least one of several is active', () => {
    expect(catalogGovernsBooking([
      service({ id: 'a', active: false }),
      service({ id: 'b', name: 'Cleaning', active: true }),
    ])).toBe(true);
  });
});

describe('activeServices', () => {
  it('offers only what the server will accept', () => {
    const rows = [service({ id: 'a' }), service({ id: 'b', name: 'Retired', active: false })];
    expect(activeServices(rows).map(s => s.id)).toEqual(['a']);
  });
});

describe('durationLabel', () => {
  it('reads the way a front desk says it', () => {
    expect(durationLabel(30)).toBe('30 min');
    expect(durationLabel(45)).toBe('45 min');
    expect(durationLabel(60)).toBe('1 hr');
    expect(durationLabel(90)).toBe('1 hr 30 min');
    expect(durationLabel(120)).toBe('2 hr');
  });
});
