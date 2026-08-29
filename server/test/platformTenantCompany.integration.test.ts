import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
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
// Schema-owner client: app_rls cannot INSERT into Tenant (by design), so
// fixtures are built out-of-band. Every assertion below still goes through the
// HTTP surface as a real platform actor.
const { fixtureDb: db } = await import('./helpers/fixtureDb');
const { signPlatformToken } = await import('../lib/platformAuth');
const { generatePasswordHash } = await import('../lib/security');

/**
 * Company record + the narrow directory reads the platform console needs.
 *
 * The point of these tests is not just that the fields round-trip: it is that
 * the platform plane still cannot see a tenant's staff. The console shows an
 * account owner, aggregate role counts and branches, and nothing else.
 */
describe('platform tenant company record', () => {
  let app: FastifyInstance;
  let tenantId: string;
  let ownerEmail: string;
  const adminId = randomUUID();
  const supportId = randomUUID();

  // The token must name a PlatformUser that actually exists and is active --
  // requirePlatformAccess resolves the row, so a signed token for a phantom id
  // is correctly rejected as 401.
  const auth = (role: 'PLATFORM_ADMIN' | 'PLATFORM_SUPPORT' = 'PLATFORM_ADMIN') => ({
    authorization: `Bearer ${signPlatformToken(app, { id: role === 'PLATFORM_ADMIN' ? adminId : supportId, role })}`,
    'content-type': 'application/json',
  });

  beforeAll(async () => {
    app = await buildApp();
    tenantId = randomUUID();
    const platformHash = await generatePasswordHash('Company-test-password-2026!');
    await db.platformUser.create({ data: { id: adminId, email: `company-admin-${adminId.slice(0, 8)}@carecommand.test`, name: 'Company Test Admin', passwordHash: platformHash, role: 'PLATFORM_ADMIN', status: 'active' } });
    await db.platformUser.create({ data: { id: supportId, email: `company-support-${supportId.slice(0, 8)}@carecommand.test`, name: 'Company Test Support', passwordHash: platformHash, role: 'PLATFORM_SUPPORT', status: 'active' } });
    ownerEmail = `owner-${tenantId.slice(0, 8)}@company.test`;
    await db.tenant.create({ data: { id: tenantId, name: 'Company Co', slug: `company-${tenantId.slice(0, 8)}`, status: 'active' } });
    const branch = await db.branch.create({ data: { tenantId, name: 'Main Site', location: 'London', timezone: 'Europe/London' } });
    await db.branch.create({ data: { tenantId, name: 'Old Site', location: 'Leeds', timezone: 'Europe/London', active: false } });
    const hash = await generatePasswordHash('OwnerPass123!');
    await db.user.create({ data: { tenantId, branchId: branch.id, email: ownerEmail, displayName: 'Owner Person', role: 'OWNER', passwordHash: hash, active: true } });
    await db.user.create({ data: { tenantId, branchId: branch.id, email: `fd-${tenantId.slice(0, 8)}@company.test`, displayName: 'Desk', role: 'FRONT_DESK', passwordHash: hash, active: true } });
    await db.user.create({ data: { tenantId, branchId: branch.id, email: `old-${tenantId.slice(0, 8)}@company.test`, displayName: 'Former', role: 'FRONT_DESK', passwordHash: hash, active: false } });
  }, 60_000);

  afterAll(async () => {
    await db.platformAuditEvent.deleteMany({ where: { tenantId } });
    await db.user.deleteMany({ where: { tenantId } });
    await db.branch.deleteMany({ where: { tenantId } });
    await db.tenant.deleteMany({ where: { id: tenantId } });
    await db.platformUser.deleteMany({ where: { id: { in: [adminId, supportId] } } });
    await app.close();
  });

  it('reports an empty company record as not-recorded rather than blank values', async () => {
    const res = await app.inject({ method: 'GET', url: `/v1/platform/tenants/${tenantId}/company`, headers: auth() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.company.legalName).toBeNull();
    expect(body.company.primaryContactEmail).toBeNull();
    expect(body.company.accountNotes).toBeNull();
  });

  it('exposes the account owner, aggregate role counts and branches - and no staff roster', async () => {
    const body = (await app.inject({ method: 'GET', url: `/v1/platform/tenants/${tenantId}/company`, headers: auth() })).json();

    expect(body.accountOwner).toMatchObject({ email: ownerEmail, role: 'OWNER', active: true });

    const front = body.roleBreakdown.find((r: { role: string }) => r.role === 'FRONT_DESK');
    expect(front).toEqual({ role: 'FRONT_DESK', active: 1, inactive: 1 });

    expect(body.branches).toHaveLength(2);
    expect(body.branches[0]).toMatchObject({ name: 'Main Site', location: 'London', active: true });

    // The boundary: no payload anywhere carries the non-owner staff identities.
    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain('fd-');
    expect(serialised).not.toContain('Former');
    expect(body).not.toHaveProperty('users');
  });

  it('persists a company record and reports which fields changed', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/v1/platform/tenants/${tenantId}/company`, headers: auth(),
      payload: JSON.stringify({ legalName: 'Company Co Ltd', city: 'London', primaryContactEmail: 'ops@company.test', reason: 'onboarding call' }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().changed.sort()).toEqual(['city', 'legalName', 'primaryContactEmail']);
    const after = (await app.inject({ method: 'GET', url: `/v1/platform/tenants/${tenantId}/company`, headers: auth() })).json();
    expect(after.company).toMatchObject({ legalName: 'Company Co Ltd', city: 'London', primaryContactEmail: 'ops@company.test' });
  });

  it('leaves untouched fields alone on a partial edit', async () => {
    await app.inject({
      method: 'PATCH', url: `/v1/platform/tenants/${tenantId}/company`, headers: auth(),
      payload: JSON.stringify({ mainPhone: '+44 20 7000 0000', reason: 'added switchboard' }),
    });
    const after = (await app.inject({ method: 'GET', url: `/v1/platform/tenants/${tenantId}/company`, headers: auth() })).json();
    expect(after.company.mainPhone).toBe('+44 20 7000 0000');
    expect(after.company.legalName).toBe('Company Co Ltd');
  });

  it('normalises a cleared field to null instead of an empty string', async () => {
    await app.inject({
      method: 'PATCH', url: `/v1/platform/tenants/${tenantId}/company`, headers: auth(),
      payload: JSON.stringify({ city: '   ', reason: 'city was wrong' }),
    });
    const after = (await app.inject({ method: 'GET', url: `/v1/platform/tenants/${tenantId}/company`, headers: auth() })).json();
    expect(after.company.city).toBeNull();
  });

  it('rejects an invalid contact email and a missing reason', async () => {
    const bad = await app.inject({
      method: 'PATCH', url: `/v1/platform/tenants/${tenantId}/company`, headers: auth(),
      payload: JSON.stringify({ billingContactEmail: 'not-an-email', reason: 'typo test' }),
    });
    expect(bad.statusCode).toBeGreaterThanOrEqual(400);

    const noReason = await app.inject({
      method: 'PATCH', url: `/v1/platform/tenants/${tenantId}/company`, headers: auth(),
      payload: JSON.stringify({ legalName: 'No Reason Ltd' }),
    });
    expect(noReason.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('audits the change by field name only, never by value', async () => {
    await app.inject({
      method: 'PATCH', url: `/v1/platform/tenants/${tenantId}/company`, headers: auth(),
      payload: JSON.stringify({ billingContactEmail: 'billing-secret@company.test', reason: 'billing contact set' }),
    });
    const events = await db.platformAuditEvent.findMany({ where: { tenantId, action: 'tenant.company.updated' }, orderBy: { createdAt: 'desc' }, take: 1 });
    expect(events).toHaveLength(1);
    const meta = JSON.stringify(events[0].metadata);
    expect(meta).toContain('billingContactEmail');
    expect(meta).not.toContain('billing-secret@company.test');
  });

  it('refuses a write from a read-only platform role', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/v1/platform/tenants/${tenantId}/company`, headers: auth('PLATFORM_SUPPORT'),
      payload: JSON.stringify({ legalName: 'Support Should Not Write', reason: 'attempted write' }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('404s for a tenant that does not exist', async () => {
    const res = await app.inject({ method: 'GET', url: `/v1/platform/tenants/${randomUUID()}/company`, headers: auth() });
    expect(res.statusCode).toBe(404);
  });

  describe('break-glass staff roster', () => {
    afterAll(async () => { await db.supportAccessSession.deleteMany({ where: { tenantId } }); });

    it('refuses the roster with no support session, and says how to get one', async () => {
      const res = await app.inject({ method: 'GET', url: `/v1/platform/tenants/${tenantId}/users`, headers: auth() });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('support_session_required');
      // Never an empty list that could read as "this clinic has no staff".
      expect(res.json()).not.toHaveProperty('users');
    });

    it('refuses when the only session has expired', async () => {
      const expired = await db.supportAccessSession.create({
        data: { tenantId, reason: 'expired session', expiresAt: new Date(Date.now() - 60_000) },
      });
      const res = await app.inject({ method: 'GET', url: `/v1/platform/tenants/${tenantId}/users`, headers: auth() });
      expect(res.statusCode).toBe(403);
      await db.supportAccessSession.delete({ where: { id: expired.id } });
    });

    it('refuses when the session was ended early', async () => {
      const ended = await db.supportAccessSession.create({
        data: { tenantId, reason: 'ended session', expiresAt: new Date(Date.now() + 3_600_000), endedAt: new Date() },
      });
      const res = await app.inject({ method: 'GET', url: `/v1/platform/tenants/${tenantId}/users`, headers: auth() });
      expect(res.statusCode).toBe(403);
      await db.supportAccessSession.delete({ where: { id: ended.id } });
    });

    it('returns the roster under an open session, and audits the view by count only', async () => {
      const open = await app.inject({
        method: 'POST', url: `/v1/platform/tenants/${tenantId}/support-session`, headers: auth(),
        payload: JSON.stringify({ reason: 'investigating a locked admin account', minutes: 30 }),
      });
      expect(open.statusCode).toBe(200);

      const res = await app.inject({ method: 'GET', url: `/v1/platform/tenants/${tenantId}/users`, headers: auth() });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.users).toHaveLength(3);
      expect(body.supportSession.reason).toBe('investigating a locked admin account');

      const owner = body.users.find((u: { role: string }) => u.role === 'OWNER');
      expect(owner).toMatchObject({ email: ownerEmail, active: true, branchName: 'Main Site' });

      // Credential material must never cross the boundary, even under break-glass.
      const serialised = JSON.stringify(body);
      for (const secret of ['passwordHash', 'mfaSecret', 'refreshToken', 'scrypt$']) {
        expect(serialised).not.toContain(secret);
      }

      const events = await db.platformAuditEvent.findMany({ where: { tenantId, action: 'tenant.roster.viewed' }, orderBy: { createdAt: 'desc' }, take: 1 });
      expect(events).toHaveLength(1);
      const meta = JSON.stringify(events[0].metadata);
      expect(meta).toContain('"userCount":3');
      expect(meta).not.toContain(ownerEmail);
    });

    it('refuses the roster to a read-only platform role even with a session open', async () => {
      const res = await app.inject({ method: 'GET', url: `/v1/platform/tenants/${tenantId}/users`, headers: auth('PLATFORM_SUPPORT') });
      expect(res.statusCode).toBe(403);
    });

    // Defence in depth. The route checks for a session before it queries, so the
    // tests above pass even if the database gate is removed -- a mutation run
    // confirmed exactly that. These call the function directly as app_platform,
    // so the guarantee is proven where it actually has to hold: an operator who
    // reaches the database by any other path still cannot read a roster without
    // a live session.
    it('the database function itself refuses without a live session', async () => {
      const url = process.env.PLATFORM_DATABASE_URL;
      expect(url, 'PLATFORM_DATABASE_URL must be set for this test').toBeTruthy();
      const { Client } = await import('pg');
      const c = new Client({ connectionString: url });
      await c.connect();
      try {
        await c.query(`select set_config('app.current_platform_actor_id',$1,false), set_config('app.current_platform_actor_role',$2,false)`, [adminId, 'PLATFORM_ADMIN']);
        await db.supportAccessSession.deleteMany({ where: { tenantId } });
        await expect(c.query(`select * from app_platform_tenant_user_roster($1::uuid)`, [tenantId]))
          .rejects.toThrow(/support_session_required/);
      } finally { await c.end(); }
    });

    it('the database function returns rows once a live session exists', async () => {
      const url = process.env.PLATFORM_DATABASE_URL;
      const { Client } = await import('pg');
      const c = new Client({ connectionString: url });
      await c.connect();
      try {
        await c.query(`select set_config('app.current_platform_actor_id',$1,false), set_config('app.current_platform_actor_role',$2,false)`, [adminId, 'PLATFORM_ADMIN']);
        const s = await db.supportAccessSession.create({ data: { tenantId, reason: 'db-level check', expiresAt: new Date(Date.now() + 600_000) } });
        const r = await c.query(`select * from app_platform_tenant_user_roster($1::uuid)`, [tenantId]);
        expect(r.rowCount).toBe(3);
        await db.supportAccessSession.delete({ where: { id: s.id } });
      } finally { await c.end(); }
    });

    it('the database function refuses without a platform actor, session or not', async () => {
      const url = process.env.PLATFORM_DATABASE_URL;
      const { Client } = await import('pg');
      const c = new Client({ connectionString: url });
      await c.connect();
      try {
        const s = await db.supportAccessSession.create({ data: { tenantId, reason: 'no actor check', expiresAt: new Date(Date.now() + 600_000) } });
        // No set_config: an anonymous app_platform connection.
        await expect(c.query(`select * from app_platform_tenant_user_roster($1::uuid)`, [tenantId]))
          .rejects.toThrow(/platform_actor_required/);
        await db.supportAccessSession.delete({ where: { id: s.id } });
      } finally { await c.end(); }
    });
  });
});
