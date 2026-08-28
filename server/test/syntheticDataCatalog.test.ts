import { describe, expect, it } from 'vitest';
import { syntheticProfiles } from '../../prisma/synthetic/profileManifest';
import { syntheticScenarioCatalog } from '../../prisma/synthetic/scenarioCatalog';
import { assertSyntheticSeedTarget } from '../../prisma/synthetic/seedSafety';
import { existsSync } from 'node:fs';

describe('central synthetic healthcare scenarios', () => {
  it('has stable unique scenario IDs and every required expectation field', () => {
    expect(syntheticScenarioCatalog.length).toBeGreaterThanOrEqual(40);
    expect(new Set(syntheticScenarioCatalog.map(item => item.scenarioId)).size).toBe(syntheticScenarioCatalog.length);
    for (const item of syntheticScenarioCatalog) {
      expect(item.scenarioId).toMatch(/^[A-Z]+-\d{3}$/);
      expect(item.tenant).not.toBe('');
      expect(item.actors.length).toBeGreaterThan(0);
      expect(item.preconditions.length).toBeGreaterThan(0);
      expect(item.inputEvent).not.toBe('');
      expect(item.expectedDatabaseState).not.toBe('');
      expect(item.expectedApiResult).not.toBe('');
      expect(item.expectedUiResult).not.toBe('');
      expect(item.expectedAuditEvents.length).toBeGreaterThan(0);
      expect(item.expectedAuthorization).not.toBe('');
      expect(item.resetStrategy).toBe('DROP_DISPOSABLE_DATABASE');
      if (item.evidenceStatus === 'EXECUTABLE') {
        expect(item.executableEvidence.length).toBeGreaterThan(0);
        for (const evidence of item.executableEvidence) expect(existsSync(evidence), evidence).toBe(true);
      }
    }
  });

  it('defines deterministic functional, Tier 1, pilot-volume and edge profiles', () => {
    expect(Object.keys(syntheticProfiles).sort()).toEqual(['EDGE', 'FUNCTIONAL', 'PILOT', 'TIER1']);
    expect(syntheticProfiles.FUNCTIONAL.fixedSeed).toBe(syntheticProfiles.PILOT.fixedSeed);
    expect(syntheticProfiles.EDGE.controlledClock).toBe(syntheticProfiles.PILOT.controlledClock);
    expect(syntheticProfiles.TIER1).toMatchObject({ tenants: 4, clinics: 8, patients: 1_000 });
    expect(syntheticProfiles.PILOT.patients).toBeGreaterThanOrEqual(2_000);
    expect(syntheticProfiles.PILOT.appointments).toBeGreaterThanOrEqual(4_000);
  });
});

describe('synthetic seed target safety', () => {
  const safeUrl = 'postgresql://owner:secret@localhost:55432/carecommand_synthetic_profile_123?schema=public';

  it('requires explicit test mode, safe target name and exact confirmation', () => {
    expect(assertSyntheticSeedTarget({
      nodeEnv: 'test', profile: 'functional', connectionString: safeUrl,
      confirmation: 'carecommand_synthetic_profile_123',
    })).toMatchObject({ profile: 'FUNCTIONAL', databaseName: 'carecommand_synthetic_profile_123' });

    expect(() => assertSyntheticSeedTarget({ nodeEnv: 'production', profile: 'PILOT', connectionString: safeUrl, confirmation: 'carecommand_synthetic_profile_123' })).toThrow('NODE_ENV=test');
    expect(() => assertSyntheticSeedTarget({ nodeEnv: 'test', profile: 'PILOT', connectionString: 'postgresql://owner:secret@localhost/carecommand', confirmation: 'carecommand' })).toThrow('unsafe database');
    expect(() => assertSyntheticSeedTarget({ nodeEnv: 'test', profile: 'PILOT', connectionString: safeUrl, confirmation: 'different' })).toThrow('CONFIRM_SYNTHETIC_DATABASE');
  });
});
