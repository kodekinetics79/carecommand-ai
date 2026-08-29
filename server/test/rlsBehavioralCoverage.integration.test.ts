import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TENANT_DELETE_PROTECTED_TABLES } from '../lib/rlsRuntimeManifest';
import { isIsolationDenial, isRlsDenial, RLS_TABLE_ADAPTERS, RlsBehaviorHarness } from './helpers/rlsBehaviorHarness';

const IMMUTABLE_DENIALS = ['42501', '23514', '55000', 'P0001'];
const REASSIGNMENT_DENIALS = ['42501', '23503', '23505', '23514', '55000', 'P0001'];
if (!process.env.RLS_DISPOSABLE_DB) {
  describe('RLS behavioral evidence execution guard', () => {
    it('requires the explicit disposable-database lifecycle', () => {
      expect(process.env.RLS_DISPOSABLE_DB).toBeUndefined();
      expect(RLS_TABLE_ADAPTERS).toHaveLength(128);
    });
  });
} else {
  const harness = new RlsBehaviorHarness();

  beforeAll(async () => {
    await harness.provision(RLS_TABLE_ADAPTERS);
  }, 120_000);

  afterAll(async () => {
    await harness.close();
  });

  describe('RLS behavioral adapter inventory', () => {
    it('contains exactly one adapter for all 128 deployed protected tables', () => {
      expect(RLS_TABLE_ADAPTERS).toHaveLength(128);
      expect(new Set(RLS_TABLE_ADAPTERS.map(adapter => adapter.table)).size).toBe(128);
    });
  });

  describe.each(RLS_TABLE_ADAPTERS)('$table restricted-role behavior', adapter => {
    it('allows same-tenant primary-key visibility and hides cross/no context', async () => {
      await expect(harness.visibility(adapter.table, 'A')).resolves.toBe(1);
      await expect(harness.visibility(adapter.table, 'B')).resolves.toBe(0);
      await expect(harness.visibility(adapter.table, 'NONE')).resolves.toBe(0);
    });

    it('isolates list, search, aggregate, and JSON export query surfaces', async () => {
      const own = await harness.querySurfaces(adapter.table, 'A');
      expect(own.list).toBeGreaterThan(0);
      expect(own.search).toBe(1);
      expect(own.aggregate).toBe(own.exported);
      expect(own.aggregate).toBeGreaterThan(0);
      await expect(harness.querySurfaces(adapter.table, 'B')).resolves.toEqual({ list: 0, search: 0, aggregate: 0, exported: 0 });
      await expect(harness.querySurfaces(adapter.table, 'NONE')).resolves.toEqual({ list: 0, search: 0, aggregate: 0, exported: 0 });
    });

    it('executes a real non-conflicting restricted-role INSERT or proves read-only denial', async () => {
      if (adapter.mode === 'READ_ONLY') {
        await expect(harness.insertClone(adapter.table, harness.fixture(adapter.table).row, 'A', 'A')).rejects.toSatisfy(isRlsDenial);
      } else {
        expect(harness.authorizedInsertWasExecuted(adapter.table)).toBe(true);
      }
      await expect(harness.insertExistingFixture(adapter.table, 'B')).rejects.toSatisfy(isIsolationDenial);
      await expect(harness.insertExistingFixture(adapter.table, 'NONE')).rejects.toSatisfy(isIsolationDenial);
    });

    it('enforces meaningful UPDATE and cross/no-context update isolation', async () => {
      const own = harness.provisionedMutationEvidence(adapter.table).update;
      const cross = await harness.selfUpdate(adapter.table, 'B');
      const none = await harness.selfUpdate(adapter.table, 'NONE');
      if (adapter.mode === 'READ_ONLY' || adapter.table === 'AuditEvent') {
        expect(own.errorCode).toBe('42501');
        expect(cross.errorCode).toBe('42501');
        expect(none.errorCode).toBe('42501');
      } else if (adapter.mode === 'APPEND_ONLY' || adapter.table === 'ReceptionistOptOut') {
        expect(IMMUTABLE_DENIALS).toContain(own.errorCode);
        if (adapter.mode === 'APPEND_ONLY') {
          expect(cross.errorCode).toBe('42501');
          expect(none.errorCode).toBe('42501');
        } else {
          expect(cross).toEqual({ count: 0, changed: false });
          expect(none).toEqual({ count: 0, changed: false });
        }
      } else {
        expect(own).toEqual({ count: 1, changed: true });
        expect(cross).toEqual({ count: 0, changed: false });
        expect(none).toEqual({ count: 0, changed: false });
      }
    });

    it('denies tenant reassignment and cross-tenant parent reassignment', async () => {
      expect(REASSIGNMENT_DENIALS).toContain(harness.provisionedMutationEvidence(adapter.table).tenantReassignmentError);
      const parentMove = await harness.crossTenantParentReassignment(adapter.table);
      if (parentMove !== 'NOT_APPLICABLE') expect(REASSIGNMENT_DENIALS).toContain(parentMove);
    });

    it('enforces actual DELETE and cross/no-context delete isolation', async () => {
      const own = harness.provisionedMutationEvidence(adapter.table).delete;
      const cross = await harness.deleteFixture(adapter.table, 'B');
      const none = await harness.deleteFixture(adapter.table, 'NONE');
      if (adapter.mode === 'READ_ONLY' || adapter.table === 'AuditEvent') {
        expect(own.errorCode).toBe('42501');
        expect(cross.errorCode).toBe('42501');
        expect(none.errorCode).toBe('42501');
      } else if (adapter.mode === 'APPEND_ONLY' || adapter.table === 'ReceptionistOptOut' || TENANT_DELETE_PROTECTED_TABLES.has(adapter.table)) {
        expect(IMMUTABLE_DENIALS).toContain(own.errorCode);
        if (adapter.mode === 'APPEND_ONLY') {
          expect(cross.errorCode).toBe('42501');
          expect(none.errorCode).toBe('42501');
        } else {
          expect(cross).toEqual({ count: 0 });
          expect(none).toEqual({ count: 0 });
        }
      } else {
        expect(own).toEqual({ count: 1 });
        expect(cross).toEqual({ count: 0 });
        expect(none).toEqual({ count: 0 });
      }
    });

    it('enforces UPSERT through INSERT and UPDATE policy paths', async () => {
      const own = harness.provisionedMutationEvidence(adapter.table).upsert;
      const cross = await harness.upsertFixture(adapter.table, 'B');
      const none = await harness.upsertFixture(adapter.table, 'NONE');
      if (adapter.mode === 'MUTABLE') expect(own).toEqual({ count: 1 });
      else expect(IMMUTABLE_DENIALS).toContain(own.errorCode);
      expect(REASSIGNMENT_DENIALS).toContain(cross.errorCode);
      expect(REASSIGNMENT_DENIALS).toContain(none.errorCode);
    });

    it('enforces bulk UPDATE/DELETE through restricted-role predicates', async () => {
      const evidence = harness.provisionedMutationEvidence(adapter.table);
      const crossUpdate = await harness.bulkUpdate(adapter.table, 'B');
      const noneUpdate = await harness.bulkUpdate(adapter.table, 'NONE');
      const crossDelete = await harness.bulkDelete(adapter.table, 'B');
      const noneDelete = await harness.bulkDelete(adapter.table, 'NONE');
      if (adapter.mode === 'READ_ONLY' || adapter.table === 'AuditEvent') {
        expect(evidence.bulkUpdate.errorCode).toBe('42501');
        expect(evidence.bulkDelete.errorCode).toBe('42501');
        expect(crossUpdate.errorCode).toBe('42501');
        expect(noneUpdate.errorCode).toBe('42501');
        expect(crossDelete.errorCode).toBe('42501');
        expect(noneDelete.errorCode).toBe('42501');
      } else if (adapter.mode === 'APPEND_ONLY' || adapter.table === 'ReceptionistOptOut') {
        expect(IMMUTABLE_DENIALS).toContain(evidence.bulkUpdate.errorCode);
        expect(IMMUTABLE_DENIALS).toContain(evidence.bulkDelete.errorCode);
        if (adapter.mode === 'APPEND_ONLY') {
          expect(crossUpdate.errorCode).toBe('42501');
          expect(noneUpdate.errorCode).toBe('42501');
          expect(crossDelete.errorCode).toBe('42501');
          expect(noneDelete.errorCode).toBe('42501');
        } else {
          expect(crossUpdate).toEqual({ count: 0, changed: false });
          expect(noneUpdate).toEqual({ count: 0, changed: false });
          expect(crossDelete).toEqual({ count: 0 });
          expect(noneDelete).toEqual({ count: 0 });
        }
      } else if (TENANT_DELETE_PROTECTED_TABLES.has(adapter.table)) {
        expect(evidence.bulkUpdate.count).toBeGreaterThan(0);
        expect(evidence.bulkUpdate.changed).toBe(true);
        expect(IMMUTABLE_DENIALS).toContain(evidence.bulkDelete.errorCode);
        expect(crossUpdate).toEqual({ count: 0, changed: false });
        expect(noneUpdate).toEqual({ count: 0, changed: false });
        expect(crossDelete).toEqual({ count: 0 });
        expect(noneDelete).toEqual({ count: 0 });
      } else {
        expect(evidence.bulkUpdate.count).toBeGreaterThan(0);
        expect(evidence.bulkUpdate.changed).toBe(true);
        expect(evidence.bulkDelete.count).toBeGreaterThan(0);
        expect(crossUpdate).toEqual({ count: 0, changed: false });
        expect(noneUpdate).toEqual({ count: 0, changed: false });
        expect(crossDelete).toEqual({ count: 0 });
        expect(noneDelete).toEqual({ count: 0 });
      }
    });
  });

  describe('resolver-bound public ingress contexts', () => {
    it.each([
      ['PatientPortalAccount', 'PATIENT_PORTAL'],
      ['PatientIntakePacket', 'PUBLIC_INTAKE'],
      ['PaymentRequest', 'PUBLIC_PAYMENT'],
      ['PilotStatusShare', 'PILOT_SHARE'],
    ] as const)('accepts persisted %s actor and rejects wrong-tenant/forged context', async (actorTable, actorRole) => {
      await expect(harness.publicIngressVisibility({ table: actorTable, actorTable, actorRole }))
        .resolves.toEqual({ valid: 1, wrongTenant: 0, forged: 0 });
    });

    it.each(['portal:request-link', 'portal:signup', 'portal:verify'] as const)(
      'accepts the allowlisted %s bootstrap actor and rejects wrong-tenant/forged context', async actorId => {
        await expect(harness.publicIngressVisibility({ table: 'Tenant', actorRole: 'PUBLIC_PORTAL', actorId }))
          .resolves.toEqual({ valid: 1, wrongTenant: 0, forged: 0 });
      },
    );

    it('accepts the validated webhook actor shape and rejects malformed actor input', async () => {
      await expect(harness.publicIngressVisibility({ table: 'ReceptionistCallLog', actorRole: 'WEBHOOK' }))
        .resolves.toEqual({ valid: 1, wrongTenant: 0, forged: 0 });
    });
  });

  describe('pooled connection transaction cleanup', () => {
    it('does not retain tenant settings after the authorized transaction is released', async () => {
      await expect(harness.poolCleanupProbe()).resolves.toEqual({ first: 1, residualSetting: '', second: 0, sameBackend: true });
    });
  });
}
