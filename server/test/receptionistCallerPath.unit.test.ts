import 'dotenv/config';

import { describe, expect, it } from 'vitest';

// Pure halves of the C-voice fixes: the admission policy that replaced a
// hang-up, the callback window a tool can finally send, the clinician-name
// match that made multi-provider booking possible, and the one duration
// resolver that stopped the spoken length disagreeing with the booked one.
const { admissionDenialPolicy, MAX_TENANT_ACTIVE_CALLS } = await import('../lib/receptionist/admissionPolicy');
const { normalizeCallbackWindowArg } = await import('../lib/receptionist/liveTools');
const { matchPreferredProvider } = await import('../lib/receptionist/availability');
const { serviceVoiceDuration } = await import('../lib/scheduling');
const { compileIntakeContract, resolveBookableService, bookableServicesOf } = await import('../modules/receptionist/intakeContract');
const { platformLocalePack } = await import('../lib/receptionist/localePacks/defaults');
const { renderPackMessage } = await import('../lib/receptionist/localePacks/render');

describe('C7 — a refused caller is transferred, never hung up on', () => {
  it('raises the tenant concurrency ceiling off the hardcoded three', () => {
    // Three was below the ordinary Monday-morning rate of one multi-site
    // practice, so the limit was hit by being busy and the caller was cut off.
    expect(MAX_TENANT_ACTIVE_CALLS).toBeGreaterThan(3);
  });

  it('routes every caller-facing denial to a human with a spoken line', () => {
    for (const reason of ['concurrency_limit_reached', 'voice_minutes_limit_reached', 'kill_switch', 'feature_locked', 'tenant_mode_demo']) {
      const policy = admissionDenialPolicy(reason);
      expect(policy.disposition).toBe('transfer_to_human');
      // Stronger than a namespace check: the key must actually render out of
      // the platform pack, so a denial can never resolve to silence. C-words
      // owns these words under `admission.denied.*`; the earlier
      // `receptionist.degraded.*` guess was never a real key.
      expect(renderPackMessage(platformLocalePack('en-US', 'US')!.strings, policy.messageKey).length).toBeGreaterThan(0);
      expect(renderPackMessage(platformLocalePack('en-GB', 'GB')!.strings, policy.messageKey).length).toBeGreaterThan(0);
      expect(policy.fallbackMessage.length).toBeGreaterThan(0);
      expect(policy.admissionState).not.toBe('');
    }
  });

  it('keeps the tenant-mode demo block distinct and above the quota reasons', () => {
    expect(admissionDenialPolicy('tenant_mode_demo').admissionState).toBe('demo_workspace');
    expect(admissionDenialPolicy('concurrency_limit_reached').admissionState).toBe('at_capacity');
    expect(admissionDenialPolicy('voice_minutes_limit_reached').admissionState).toBe('quota_exhausted');
  });

  it('does not try to speak to a terminal reconciliation event', () => {
    expect(admissionDenialPolicy('terminal_without_active_call').disposition).toBe('reconcile_only');
  });
});

describe('C11 — callback_window reaches the task layer', () => {
  it('maps the tool shape {date, from, to} onto the stored {start, end}', () => {
    expect(normalizeCallbackWindowArg({ date: '2026-09-03', from: '14:00', to: '16:00' }))
      .toEqual({ start: '2026-09-03T14:00', end: '2026-09-03T16:00' });
  });

  it('passes an already-stored window through unchanged', () => {
    expect(normalizeCallbackWindowArg({ start: '2026-09-03T14:00', end: '2026-09-03T16:00' }))
      .toEqual({ start: '2026-09-03T14:00', end: '2026-09-03T16:00' });
  });

  it('refuses anything it cannot read rather than inventing a callback time', () => {
    expect(normalizeCallbackWindowArg(undefined)).toBeUndefined();
    expect(normalizeCallbackWindowArg({ date: 'thursday', from: '2pm', to: '4pm' })).toBeUndefined();
    expect(normalizeCallbackWindowArg({ date: '2026-09-03', from: '25:00', to: '16:00' })).toBeUndefined();
    expect(normalizeCallbackWindowArg({ date: '2026-09-03', from: '14:00' })).toBeUndefined();
    expect(normalizeCallbackWindowArg('tomorrow afternoon')).toBeUndefined();
  });
});

describe('C1 — a caller who names a clinician', () => {
  const roster = [
    { id: 'a', displayName: 'Dr. Anita Patel' },
    { id: 'b', displayName: 'Dr. Michael Chen' },
  ];

  it('matches a surname the caller actually says', () => {
    expect(matchPreferredProvider(roster, 'Dr Patel')?.id).toBe('a');
    expect(matchPreferredProvider(roster, 'chen')?.id).toBe('b');
    expect(matchPreferredProvider(roster, 'Dr. Anita Patel')?.id).toBe('a');
  });

  it('refuses to guess rather than booking a caller with a stranger', () => {
    expect(matchPreferredProvider(roster, 'Dr Smith')).toBeNull();
    expect(matchPreferredProvider(roster, 'doctor')).toBeNull();
    expect(matchPreferredProvider(roster, '')).toBeNull();
    expect(matchPreferredProvider([
      { id: 'a', displayName: 'Dr. Anita Patel' },
      { id: 'b', displayName: 'Dr. Sunil Patel' },
    ], 'Dr Patel')).toBeNull();
  });
});

describe('C9 — one service menu, one duration', () => {
  it('speaks and books the same number of minutes', () => {
    expect(serviceVoiceDuration({ voiceDurationMinutes: 60, defaultDurationMinutes: 30 })).toBe(60);
    expect(serviceVoiceDuration({ voiceDurationMinutes: null, defaultDurationMinutes: 45 })).toBe(45);
    // Out-of-range voice overrides fall back rather than blocking a whole day.
    expect(serviceVoiceDuration({ voiceDurationMinutes: 0, defaultDurationMinutes: 30 })).toBe(30);
    expect(serviceVoiceDuration({ voiceDurationMinutes: 900, defaultDurationMinutes: 30 })).toBe(30);
  });

  it('compiles an enum over every voice-bookable service, not one pinned const', () => {
    const contract = compileIntakeContract({
      campaignId: '11111111-1111-4111-8111-111111111111',
      revision: 1,
      appointmentType: 'Cleaning',
      eligibleLocations: [],
      fields: [],
      toolUrl: 'https://api.example.test/v1/receptionist/webhooks/retell/fn',
      bookableServices: ['Crown fitting', 'Emergency visit', 'Cleaning'],
    });
    const properties = (contract.snapshot.bookAppointmentToolContract.parameters as { properties: Record<string, { enum?: string[]; const?: string }> }).properties;
    expect(properties.service.const).toBeUndefined();
    expect(properties.service.enum).toEqual(['Cleaning', 'Crown fitting', 'Emergency visit']);
    expect(contract.snapshot.bookableServices).toEqual(['Cleaning', 'Crown fitting', 'Emergency visit']);
  });

  it('always keeps the campaign type offerable and deduplicates the menu', () => {
    const contract = compileIntakeContract({
      campaignId: '11111111-1111-4111-8111-111111111111',
      revision: 1,
      appointmentType: 'Cleaning',
      eligibleLocations: [],
      fields: [],
      toolUrl: 'https://api.example.test/v1/receptionist/webhooks/retell/fn',
      bookableServices: ['Cleaning'],
    });
    expect(contract.snapshot.bookableServices).toEqual(['Cleaning']);
  });

  it('resolves the caller’s spelling back to the catalogue’s, and refuses anything off the menu', () => {
    const snapshot = { appointmentType: 'Cleaning', bookableServices: ['Cleaning', 'Crown fitting'] };
    expect(resolveBookableService(snapshot, 'crown FITTING')).toBe('Crown fitting');
    expect(resolveBookableService(snapshot, '  Cleaning ')).toBe('Cleaning');
    expect(resolveBookableService(snapshot, 'Teeth whitening')).toBeNull();
    expect(resolveBookableService(snapshot, undefined)).toBeNull();
  });

  it('keeps a campaign attested before this change on its single service', () => {
    // Snapshots persisted without `bookableServices` must not lose their menu.
    const legacy = { appointmentType: 'Consultation' } as { appointmentType: string; bookableServices: string[] };
    expect(bookableServicesOf(legacy)).toEqual(['Consultation']);
    expect(resolveBookableService(legacy, 'Consultation')).toBe('Consultation');
    expect(resolveBookableService(legacy, 'Crown fitting')).toBeNull();
  });

  it('refuses a service name carrying provider template syntax', () => {
    expect(() => compileIntakeContract({
      campaignId: '11111111-1111-4111-8111-111111111111',
      revision: 1,
      appointmentType: 'Cleaning',
      eligibleLocations: [],
      fields: [],
      toolUrl: 'https://api.example.test/v1/receptionist/webhooks/retell/fn',
      bookableServices: ['{{per_call_service}}'],
    })).toThrow(/dynamic-variable templates/i);
  });
});
