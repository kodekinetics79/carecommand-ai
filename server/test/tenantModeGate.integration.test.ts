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
const { signPlatformToken } = await import('../lib/platformAuth');
const { generatePasswordHash } = await import('../lib/security');
const { liveCallingBlockReason, modeAllowsLiveCalling, TENANT_MODE_DEMO_BLOCK } = await import('../lib/tenantMode');

/**
 * A voice product needs one switch above every dial path. Until this there was
 * none: nothing distinguished a sales-demo workspace from a live clinic, so the
 * only thing standing between a demo and a real patient's phone ringing was
 * whoever happened to be clicking.
 */
describe('tenant mode', () => {
  let app: FastifyInstance;
  const adminId = randomUUID();
  const demoTenant = randomUUID();
  const pilotTenant = randomUUID();

  const auth = () => ({
    authorization: `Bearer ${signPlatformToken(app, { id: adminId, role: 'PLATFORM_ADMIN' })}`,
    'content-type': 'application/json',
  });

  beforeAll(async () => {
    app = await buildApp();
    await db.platformUser.create({
      data: {
        id: adminId, email: `mode-${adminId.slice(0, 8)}@carecommand.test`, name: 'Mode Admin',
        passwordHash: await generatePasswordHash('Tenant-mode-password-2026!'), role: 'PLATFORM_ADMIN', status: 'active',
      },
    });
    await db.tenant.create({ data: { id: demoTenant, name: 'Demo Workspace', slug: `demo-${demoTenant.slice(0, 8)}`, mode: 'demo' } });
    await db.tenant.create({ data: { id: pilotTenant, name: 'Pilot Clinic', slug: `pilot-${pilotTenant.slice(0, 8)}`, mode: 'pilot' } });
  }, 90_000);

  afterAll(async () => {
    await db.platformAuditEvent.deleteMany({ where: { platformUserId: adminId } });
    await db.platformUser.deleteMany({ where: { id: adminId } });
    await db.tenant.updateMany({ where: { id: { in: [demoTenant, pilotTenant] } }, data: { status: 'cancelled', name: 'ZZ test fixture (tenant mode)' } });
    await app.close();
  });

  describe('the rule itself', () => {
    // The client is passed explicitly, exactly as the call-admission gates do:
    // they call this inside their own tenant transaction, so the Tenant row is
    // visible. Called with a context-less client it would see nothing at all.
    it('refuses live calling for a demo workspace and allows it for a real clinic', async () => {
      expect(await liveCallingBlockReason(demoTenant, db)).toBe(TENANT_MODE_DEMO_BLOCK);
      expect(await liveCallingBlockReason(pilotTenant, db)).toBeNull();
    });

    it('fails OPEN for a tenant that does not exist, rather than becoming an outage', async () => {
      // The admission gates already refuse an unknown tenant for better
      // reasons; a lookup miss here must not silently stop every clinic.
      expect(await liveCallingBlockReason(randomUUID(), db)).toBeNull();
    });

    it('treats only demo as blocking', () => {
      expect(modeAllowsLiveCalling('demo')).toBe(false);
      expect(modeAllowsLiveCalling('pilot')).toBe(true);
      expect(modeAllowsLiveCalling('production')).toBe(true);
    });
  });

  describe('the platform control', () => {
    it('reports the mode, what it means, and whether calling is allowed', async () => {
      const res = await app.inject({ method: 'GET', url: `/v1/platform/tenants/${demoTenant}`, headers: auth() });
      expect(res.statusCode).toBe(200);
      expect(res.json().tenant).toMatchObject({ mode: 'demo', liveCallingAllowed: false });
      expect(String(res.json().tenant.modeDescription)).toMatch(/refused/i);
    });

    it('changes the mode, demands a reason, and records both sides of the change', async () => {
      const noReason = await app.inject({
        method: 'PATCH', url: `/v1/platform/tenants/${demoTenant}/mode`, headers: auth(), payload: { mode: 'pilot' },
      });
      expect(noReason.statusCode).toBe(400);

      const ok = await app.inject({
        method: 'PATCH', url: `/v1/platform/tenants/${demoTenant}/mode`, headers: auth(),
        payload: { mode: 'production', reason: 'Clinic signed off after attended pilot' },
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ mode: 'production', liveCallingAllowed: true });
      expect(await liveCallingBlockReason(demoTenant, db)).toBeNull();

      const events = await db.platformAuditEvent.findMany({ where: { tenantId: demoTenant, action: 'tenant.mode.changed' } });
      expect(events.length).toBeGreaterThan(0);
      // Assert the record, not its key order: both sides of the change and the
      // operator's reason must be recoverable from the audit trail alone.
      expect(events[0].metadata).toMatchObject({ from: 'demo', to: 'production', reason: 'Clinic signed off after attended pilot' });
    });

    it('refuses a mode that is not one of the three', async () => {
      const res = await app.inject({
        method: 'PATCH', url: `/v1/platform/tenants/${pilotTenant}/mode`, headers: auth(),
        payload: { mode: 'whatever', reason: 'Testing an invalid mode' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('404s for a tenant that does not exist', async () => {
      const res = await app.inject({
        method: 'PATCH', url: `/v1/platform/tenants/${randomUUID()}/mode`, headers: auth(),
        payload: { mode: 'pilot', reason: 'Testing an unknown tenant' },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('relationship facts on the company record', () => {
    it('stores contract date, account manager and BAA date, and reads them back as dates', async () => {
      const res = await app.inject({
        method: 'PATCH', url: `/v1/platform/tenants/${pilotTenant}/company`, headers: auth(),
        payload: {
          contractStartedAt: '2026-02-01', accountManager: 'Dana Okafor', baaSignedAt: '2026-02-03',
          reason: 'Recording the signed contract and BAA',
        },
      });
      expect(res.statusCode).toBe(200);
      const company = res.json().company;
      expect(company.accountManager).toBe('Dana Okafor');
      expect(String(company.contractStartedAt)).toContain('2026-02-01');
      expect(String(company.baaSignedAt)).toContain('2026-02-03');
      // Field NAMES only in the audit trail - the values are customer detail.
      expect(res.json().changed).toEqual(expect.arrayContaining(['contractStartedAt', 'accountManager', 'baaSignedAt']));
    });

    it('does not report an unchanged date as a change on a later edit', async () => {
      const res = await app.inject({
        method: 'PATCH', url: `/v1/platform/tenants/${pilotTenant}/company`, headers: auth(),
        payload: { contractStartedAt: '2026-02-01', reason: 'Re-saving the same contract date' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().changed).not.toContain('contractStartedAt');
    });

    it('refuses a date that is not a date', async () => {
      const res = await app.inject({
        method: 'PATCH', url: `/v1/platform/tenants/${pilotTenant}/company`, headers: auth(),
        payload: { baaSignedAt: 'last tuesday', reason: 'Testing a bad date' },
      });
      expect(res.statusCode).toBe(400);
    });
  });
});
