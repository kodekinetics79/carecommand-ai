import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

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
const { clinicTodayRange } = await import('../modules/telehealth/routes');

let app: FastifyInstance;
const tenantId = randomUUID();
let authorization: string;

async function collectTwoPages(path: string): Promise<Array<{ id: string }>> {
  const first = await app.inject({
    method: 'GET',
    url: `${path}${path.includes('?') ? '&' : '?'}limit=2&page=true`,
    headers: { authorization },
  });
  expect(first.statusCode, path).toBe(200);
  const firstPage = first.json() as { data: Array<{ id: string }>; nextCursor?: string };
  expect(firstPage.data, path).toHaveLength(2);
  expect(firstPage.nextCursor, path).toBeTruthy();

  const second = await app.inject({
    method: 'GET',
    url: `${path}${path.includes('?') ? '&' : '?'}limit=2&page=true&cursor=${firstPage.nextCursor}`,
    headers: { authorization },
  });
  expect(second.statusCode, path).toBe(200);
  const secondPage = second.json() as { data: Array<{ id: string }>; nextCursor?: string };
  expect(secondPage.data, path).toHaveLength(1);
  expect(secondPage.nextCursor, path).toBeUndefined();
  return [...firstPage.data, ...secondPage.data];
}

describe('complete operational list pagination', () => {
  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    await db.tenant.create({ data: { id: tenantId, name: 'Operational Pagination', slug: `operations-page-${tenantId.slice(0, 8)}` } });
    const branch = await db.branch.create({ data: { tenantId, name: 'Pagination Clinic', location: 'Test', timezone: 'UTC' } });
    const owner = await db.user.create({
      data: { tenantId, role: 'OWNER', active: true, email: `owner-${tenantId.slice(0, 8)}@pagination.test`, displayName: 'Pagination Owner' },
    });
    const patient = await db.patient.create({ data: { tenantId, branchId: branch.id, firstName: 'Page', lastName: 'Patient' } });
    authorization = `Bearer ${app.jwt.sign({ userId: owner.id, tenantId, role: 'OWNER', type: 'access' })}`;

    await db.inventoryItem.createMany({
      data: ['A', 'B', 'C'].map(name => ({
        tenantId, branchId: branch.id, name: `${name} supply`, category: 'supply', currentStock: 1,
        unit: 'box', reorderLevel: 2, supplier: 'Synthetic supplier',
      })),
    });
    await db.partnerReport.createMany({
      data: [0, 1, 2].map(index => ({
        tenantId, branchId: branch.id, patientId: patient.id, reportType: `Report ${index}`,
        partner: 'Synthetic lab', urgency: index === 2 ? 'urgent' : 'routine', status: 'result-received',
        orderedAt: new Date(`2026-09-02T12:0${index}:00.000Z`),
      })),
    });
    const range = clinicTodayRange('UTC');
    const start = range.from.getTime() + 60 * 60 * 1000;
    await db.appointment.createMany({
      data: [0, 1, 2].map(index => ({
        tenantId, branchId: branch.id, patientId: patient.id, service: `Video ${index}`,
        startsAt: new Date(start + index * 60 * 60 * 1000),
        endsAt: new Date(start + index * 60 * 60 * 1000 + 30 * 60 * 1000),
        channel: 'VIDEO',
      })),
    });
  });

  afterAll(async () => {
    await db.tenant.deleteMany({ where: { id: tenantId } });
    await app.close();
  });

  it.each([
    '/v1/inventory',
    '/v1/partner-reports',
    '/v1/telehealth/sessions',
  ])('returns every accessible %s row across stable cursor pages', async path => {
    const rows = await collectTwoPages(path);
    expect(new Set(rows.map(row => row.id)).size, path).toBe(3);
  });

  it.each([
    '/v1/inventory?limit=2',
    '/v1/partner-reports?limit=2',
    '/v1/telehealth/sessions?limit=2',
  ])('preserves the legacy array contract for %s', async path => {
    const response = await app.inject({ method: 'GET', url: path, headers: { authorization } });
    expect(response.statusCode, path).toBe(200);
    expect(Array.isArray(response.json()), path).toBe(true);
  });
});
