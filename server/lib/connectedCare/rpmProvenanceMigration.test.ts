import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('../../../prisma/migrations/20260801120000_rpm_device_provenance_v3/migration.sql', import.meta.url),
  'utf8',
);

describe('RPM device provenance v3 migration', () => {
  it('invalidates every uncertain v2 signoff/readiness result without grandfathering', () => {
    expect(migration).toContain('"providerSignoffUserId" = NULL');
    expect(migration).toContain('"providerSignoffEvidenceVersion" = NULL');
    expect(migration).toContain('"providerSignoffAttestationRevision" = NULL');
    expect(migration).toContain('"status" = \'MISSING_REQUIREMENTS\'');
    expect(migration).toContain("OR \"status\" IN ('READY', 'NEEDS_REVIEW')");
  });

  it('enforces tenant-scoped linkage, provenance shape, and immutable reading identity', () => {
    expect(migration).toContain('FOREIGN KEY ("tenantId", "sourceEnrollmentId")');
    expect(migration).toContain('"source" = \'webhook\'');
    expect(migration).toContain('AND "deviceId" IS NOT NULL');
    expect(migration).toContain('"validationStatus" IN (\'valid\', \'suspect\', \'invalid\')');
    expect(migration).toContain('NEW."receivedAt" IS DISTINCT FROM OLD."receivedAt"');
    expect(migration).toContain('DeviceReading_provenance_immutable');
    expect(migration).toContain("RAISE EXCEPTION 'DeviceReading provenance is immutable after insert'");
    expect(migration).toContain('REVOKE UPDATE, DELETE ON TABLE "DeviceReading" FROM app_rls');
  });
});
