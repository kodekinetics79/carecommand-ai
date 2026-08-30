import 'dotenv/config';
import { describe, it, expect, afterAll } from 'vitest';
import { db } from '../lib/db';
import { checkRlsRuntimeRole, assertRlsRuntimeRole, rlsRoleMessage } from '../lib/rlsGuard';
import {
  GLOBAL_RUNTIME_TABLE_PRIVILEGES,
  TENANT_APPEND_ONLY_TABLES,
  TENANT_DELETE_PROTECTED_TABLES,
} from '../lib/rlsRuntimeManifest';

// Proves the RLS runtime-role guard correctly classifies the connecting role and
// fails closed when enforcement is on. The bypass paths (superuser / rolbypassrls)
// are driven by a deterministic stub client so the test holds regardless of which
// role the local/CI DATABASE_URL happens to use; the restricted (safe) path is
// exercised against the real database connection.

afterAll(async () => {
  await db.$disconnect();
});

/** A fake query client that returns a fixed pg_roles row. */
function roleClient(role: string, isSuper: boolean, bypass: boolean, sessionRole = role) {
  const tables = ['Tenant', ...Object.keys(GLOBAL_RUNTIME_TABLE_PRIVILEGES)].map(tableName => {
    const privileges = tableName === 'Tenant'
      ? new Set(['SELECT'])
      : GLOBAL_RUNTIME_TABLE_PRIVILEGES[tableName];
    return {
      table_name: tableName,
      owner_name: 'carecommand',
      rls_enabled: tableName === 'Tenant',
      rls_forced: tableName === 'Tenant',
      has_tenant_id: false,
      tenant_id_not_null: false,
      can_select: privileges.has('SELECT'),
      can_insert: privileges.has('INSERT'),
      can_update: privileges.has('UPDATE'),
      can_delete: privileges.has('DELETE'),
    };
  });
  return {
    $queryRaw: async <T>(query: TemplateStringsArray) => {
      const sql = query.join(' ');
      if (sql.includes('FROM pg_roles runtime')) return [{
        role,
        session_role: sessionRole,
        super: isSuper,
        bypass,
        can_create_role: false,
        can_create_db: false,
        can_replicate: false,
        can_create_in_public: false,
        public_schema_owner: 'carecommand',
        owns_public_objects: 0,
      }] as T;
      if (sql.includes('FROM pg_auth_members')) return [] as T;
      if (sql.includes("c.relkind IN ('r', 'p')")) return tables as T;
      if (sql.includes('FROM pg_policies')) return [{
        table_name: 'Tenant',
        command: 'SELECT',
        roles: ['app_rls'],
        using_expression: 'app_rls_tenant_allowed(id)',
        check_expression: null,
      }] as T;
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

describe('RLS runtime-role guard', () => {
  it('shares the complete DB-enforced append-only evidence manifest with the behavioral harness and boot guard', () => {
    expect([...TENANT_APPEND_ONLY_TABLES].sort()).toEqual([
      'AuditEvent',
      'ConsentEvent',
      'ConversationReplyAttempt',
      'DeviceReading',
      'NotificationDeliveryAttempt',
      'ReceptionistArtifactLifecycleEvent',
      'ReceptionistOutboundProviderIntent',
      'ReceptionistRecordingConsentEvent',
      'ReceptionistVoiceConsentEvent',
      // Billing ledger: append-only by grant and by trigger, so a recorded
      // charge can never be quietly rewritten.
      'UsageEvent',
    ]);
    expect([...TENANT_DELETE_PROTECTED_TABLES].sort()).toEqual([
      'Campaign',
      'CampaignDelivery',
      'EligibilityExecution',
    ]);
    expect(TENANT_APPEND_ONLY_TABLES.has('EligibilityExecution')).toBe(false);
    expect(TENANT_DELETE_PROTECTED_TABLES.has('EligibilityExecution')).toBe(true);
  });
  it('classifies a superuser connection as bypassing RLS', async () => {
    const status = await checkRlsRuntimeRole(roleClient('postgres', true, false));
    expect(status.bypassesRls).toBe(true);
    expect(status.isSuperuser).toBe(true);
  });

  it('classifies a rolbypassrls connection as bypassing RLS', async () => {
    const status = await checkRlsRuntimeRole(roleClient('owner', false, true));
    expect(status.bypassesRls).toBe(true);
    expect(status.hasBypassRls).toBe(true);
    expect(status.isSuperuser).toBe(false);
  });

  it('classifies a NOSUPERUSER NOBYPASSRLS role as NOT bypassing RLS', async () => {
    const status = await checkRlsRuntimeRole(roleClient('app_rls', false, false));
    expect(status.bypassesRls).toBe(false);
  });

  it('requires direct app_rls authentication except for the explicit disposable-harness seam', async () => {
    const switchedRoleClient = roleClient('app_rls', false, false, 'carecommand');
    const directOnly = await checkRlsRuntimeRole(switchedRoleClient);
    expect(directOnly.postureDefects).toContain(
      'session_user is carecommand, expected direct app_rls authentication',
    );

    const disposable = await checkRlsRuntimeRole(switchedRoleClient, {
      allowDisposableRoleSwitch: true,
    });
    expect(disposable.postureDefects).not.toContain(
      'session_user is carecommand, expected direct app_rls authentication',
    );
  });

  it('throws (fails closed) when enforcing and the role can bypass RLS', async () => {
    await expect(
      assertRlsRuntimeRole({ enforce: true, client: roleClient('postgres', true, false) }),
    ).rejects.toThrow(/BYPASSES row-level security/);
  });

  it('in production, unsafe roles always throw even if enforcement is disabled', async () => {
    const logger = { warn: () => {}, error: () => {} };
    await expect(assertRlsRuntimeRole({
      enforce: false,
      isProduction: true,
      logger,
      client: roleClient('owner', false, true),
    })).rejects.toThrow(/BYPASSES row-level security/);
  });

  it('a restricted role is silent and never throws, even when enforced', async () => {
    const logs: string[] = [];
    const logger = { warn: (m: string) => logs.push(m), error: (m: string) => logs.push(m) };
    const status = await assertRlsRuntimeRole({
      enforce: true,
      isProduction: true,
      logger,
      client: roleClient('app_rls', false, false),
    });
    expect(status.bypassesRls).toBe(false);
    expect(logs).toHaveLength(0);
  });

  it('reads the real database connection role without error', async () => {
    const status = await checkRlsRuntimeRole();
    expect(status.role).toBeTruthy();
    expect(typeof status.bypassesRls).toBe('boolean');
  });

  it('produces an actionable message naming app_rls and the enforce flag', () => {
    const message = rlsRoleMessage({ role: 'owner', isSuperuser: false, hasBypassRls: true, bypassesRls: true, postureDefects: [] });
    expect(message).toContain('app_rls');
    expect(message).toContain('RLS_ENFORCE_RUNTIME_ROLE');
  });
});
