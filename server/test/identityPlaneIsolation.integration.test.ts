import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

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

beforeAll(async () => {
  app = await buildApp();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db.$disconnect();
});

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe('staff and patient-portal identity planes remain non-interchangeable', () => {
  it('rejects a portal JWT on a staff API before any patient data is returned', async () => {
    const token = app.jwt.sign({
      portalAccountId: '00000000-0000-4000-8000-000000000001',
      patientId: '00000000-0000-4000-8000-000000000002',
      tenantId: '00000000-0000-4000-8000-000000000003',
      type: 'portal',
    });
    const response = await app.inject({ method: 'GET', url: '/v1/patients', headers: bearer(token) });

    expect(response.statusCode).toBe(401);
    expect(response.body).not.toContain('00000000-0000-4000-8000-000000000002');
  });

  it('rejects a staff access JWT on the portal identity endpoint', async () => {
    const token = app.jwt.sign({
      userId: '00000000-0000-4000-8000-000000000011',
      tenantId: '00000000-0000-4000-8000-000000000012',
      role: 'ADMIN',
      type: 'access',
    });
    const response = await app.inject({ method: 'GET', url: '/v1/portal/auth/me', headers: bearer(token) });

    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe('portal_unauthorized');
  });

  it.each([
    ['portal-typed token carrying staff claims', {
      userId: '00000000-0000-4000-8000-000000000021',
      role: 'ADMIN',
      portalAccountId: '00000000-0000-4000-8000-000000000022',
      patientId: '00000000-0000-4000-8000-000000000023',
      tenantId: '00000000-0000-4000-8000-000000000024',
      type: 'portal',
    }, '/v1/patients'],
    ['access-typed token carrying portal claims', {
      userId: '00000000-0000-4000-8000-000000000031',
      role: 'ADMIN',
      portalAccountId: '00000000-0000-4000-8000-000000000032',
      patientId: '00000000-0000-4000-8000-000000000033',
      tenantId: '00000000-0000-4000-8000-000000000034',
      type: 'access',
    }, '/v1/portal/auth/me'],
  ] as const)('does not permit claim-confusion: %s', async (_label, claims, url) => {
    const response = await app.inject({ method: 'GET', url, headers: bearer(app.jwt.sign(claims)) });
    expect(response.statusCode).toBe(401);
  });
});
