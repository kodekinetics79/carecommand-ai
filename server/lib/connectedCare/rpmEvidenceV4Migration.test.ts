import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RPM_EVIDENCE_VERSION } from './rpmEvidence';

const migration = readFileSync(
  new URL('../../../prisma/migrations/20260829120000_rpm_evidence_v4_review_minutes/migration.sql', import.meta.url),
  'utf8',
);

describe('RPM evidence v4 migration', () => {
  it('clears every signoff that cannot be reproduced under the new evidence definition', () => {
    expect(migration).toContain('"providerSignoffUserId" = NULL');
    expect(migration).toContain('"providerSignoffAt" = NULL');
    expect(migration).toContain('"providerSignoffEvidenceHash" = NULL');
    expect(migration).toContain('"providerSignoffEvidenceVersion" = NULL');
    expect(migration).toContain('"providerSignoffAttestationRevision" = NULL');
    expect(migration).toContain('"status" = \'MISSING_REQUIREMENTS\'');
  });

  it('grandfathers nothing — both the stale-version and the READY/NEEDS_REVIEW arms are cleared', () => {
    expect(migration).toContain("IS DISTINCT FROM 'rpm-readiness-evidence-v4'");
    expect(migration).toContain("OR \"status\" IN ('READY', 'NEEDS_REVIEW')");
  });

  it('targets the version the code actually emits', () => {
    expect(RPM_EVIDENCE_VERSION).toBe('rpm-readiness-evidence-v4');
    expect(migration).toContain(RPM_EVIDENCE_VERSION);
  });
});
