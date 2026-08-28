import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

// Proves the HIPAA right-of-access / data-subject export is backend-enforced:
// least-privilege (owner/admin/compliance), tenant-isolated, and audited as a
// disclosure — and that it actually compiles the patient's cross-domain record.
vi.mock('../workers/queues', () => ({
  redisConnection: {},
  autopilotQueue: { client: Promise.resolve(undefined), add: async () => undefined },
  enqueueAutopilotExecution: async () => undefined,
  complianceQueue: { add: async () => undefined },
  registerComplianceSchedules: async () => undefined,
  campaignQueue: { add: async () => undefined },
  registerCampaignSchedules: async () => undefined,
}));

const { buildApp } = await import('../app');
const { fixtureDb: db } = await import('./helpers/fixtureDb');

let app: FastifyInstance;
const createdTenantIds: string[] = [];

type Role = 'ADMIN' | 'PROVIDER' | 'FRONT_DESK' | 'COMPLIANCE_OFFICER';

async function makeTenant() {
  const id = randomUUID();
  await db.tenant.create({ data: { id, name: `dsr-${id.slice(0, 6)}`, slug: `dsr-${id.slice(0, 8)}` } });
  createdTenantIds.push(id);
  const branch = await db.branch.create({ data: { tenantId: id, name: 'b', location: 'x' } });
  const patient = await db.patient.create({ data: { tenantId: id, branchId: branch.id, firstName: 'Jane', lastName: 'Roe', lifecycleStage: 'ACTIVE' } });
  await db.consentEvent.create({ data: { tenantId: id, patientId: patient.id, purpose: 'SMS', granted: true, source: 'intake' } });
  const users: Record<Role, string> = {} as Record<Role, string>;
  for (const role of ['ADMIN', 'PROVIDER', 'FRONT_DESK', 'COMPLIANCE_OFFICER'] as Role[]) {
    const u = await db.user.create({ data: { tenantId: id, role, active: true, email: `${role}-${id.slice(0, 8)}@dsr.test`, displayName: role } });
    users[role] = u.id;
  }
  return { id, branchId: branch.id, patientId: patient.id, users };
}

const tok = (tenantId: string, userId: string) => app.jwt.sign({ userId, tenantId, role: 'OWNER', type: 'access' });
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const exportUrl = (patientId: string) => `/v1/patients/${patientId}/data-export`;

beforeAll(async () => { app = await buildApp(); }, 60_000);

afterAll(async () => {
  for (const id of createdTenantIds) await db.tenant.delete({ where: { id } }).catch(() => {});
  await app?.close();
  await db.$disconnect();
});

describe('HIPAA data-access export — least-privilege, tenant-isolated, audited', () => {
  it('rejects unauthenticated access (401)', async () => {
    const t = await makeTenant();
    const res = await app.inject({ method: 'GET', url: exportUrl(t.patientId) });
    expect(res.statusCode).toBe(401);
  });

  it('denies roles without patient:export (PROVIDER, FRONT_DESK → 403)', async () => {
    const t = await makeTenant();
    for (const role of ['PROVIDER', 'FRONT_DESK'] as Role[]) {
      const res = await app.inject({ method: 'GET', url: exportUrl(t.patientId), headers: auth(tok(t.id, t.users[role])) });
      expect(res.statusCode).toBe(403);
      expect(res.json().permission).toBe('patient:export');
    }
  });

  it('allows ADMIN and COMPLIANCE_OFFICER, returns the compiled record, and audits the disclosure', async () => {
    const t = await makeTenant();
    for (const role of ['ADMIN', 'COMPLIANCE_OFFICER'] as Role[]) {
      const res = await app.inject({ method: 'GET', url: exportUrl(t.patientId), headers: auth(tok(t.id, t.users[role])) });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.exportType).toBe('patient_data_access');
      expect(body.patient.id).toBe(t.patientId);
      expect(body.records.consents.events.length).toBe(1); // the seeded consent
      expect(body.counts.consentEvents).toBe(1);
      expect(body.records).toHaveProperty('insurance');
      expect(body.records).toHaveProperty('payments');
    }
    const disclosures = await db.auditEvent.count({ where: { tenantId: t.id, action: 'patient.data_exported', resourceId: t.patientId } });
    expect(disclosures).toBe(2); // one per successful export
  });

  it('does not allow exporting another tenant\'s patient (404, no existence leak)', async () => {
    const [a, b] = [await makeTenant(), await makeTenant()];
    const res = await app.inject({ method: 'GET', url: exportUrl(b.patientId), headers: auth(tok(a.id, a.users.ADMIN)) });
    expect(res.statusCode).toBe(404);
  });
});
