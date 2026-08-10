/**
 * Canonical least-privilege contract for the tenant runtime database role.
 * Keep boot enforcement and the exhaustive catalog verifier on this shared
 * manifest so a new global table or append-only evidence table fails closed.
 */
export const EXPECTED_RUNTIME_ROLE = 'app_rls';

export const CRUD_PRIVILEGES = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE']);
export const READ_ONLY_PRIVILEGES = new Set(['SELECT']);
export const READ_APPEND_PRIVILEGES = new Set(['SELECT', 'INSERT']);
export const NO_RUNTIME_PRIVILEGES = new Set<string>();

export const TENANT_APPEND_ONLY_TABLES = new Set([
  'AuditEvent',
  'ConsentEvent',
  'ConversationReplyAttempt',
  'DeviceReading',
  'NotificationDeliveryAttempt',
  'ReceptionistArtifactLifecycleEvent',
  'ReceptionistOutboundProviderIntent',
  'ReceptionistRecordingConsentEvent',
  'ReceptionistVoiceConsentEvent',
]);

/**
 * Tenant tables that remain updateable by the runtime but whose retained
 * evidence rows may only be archived/advanced, never hard-deleted. DELETE is
 * deliberately still represented by a scoped RLS policy and grant so the
 * database trigger can return an explicit denial for same-tenant attempts;
 * cross-tenant attempts remain invisible through RLS.
 */
export const TENANT_DELETE_PROTECTED_TABLES = new Set([
  'EligibilityExecution',
  'Campaign',
  'CampaignDelivery',
]);

export const GLOBAL_RUNTIME_TABLE_PRIVILEGES: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  SubscriptionPlan: READ_ONLY_PRIVILEGES,
  SubscriptionPlanFeature: READ_ONLY_PRIVILEGES,
  SubscriptionAddon: READ_ONLY_PRIVILEGES,
  PlatformAnnouncement: READ_ONLY_PRIVILEGES,
  PlatformConfig: NO_RUNTIME_PRIVILEGES,
  PlatformIntegration: NO_RUNTIME_PRIVILEGES,
  PlatformUser: NO_RUNTIME_PRIVILEGES,
  PlatformAuditEvent: NO_RUNTIME_PRIVILEGES,
  _prisma_migrations: NO_RUNTIME_PRIVILEGES,
});

export type RuntimeTableShape = {
  table_name: string;
  has_tenant_id: boolean;
  tenant_id_not_null: boolean;
};

export function expectedRuntimeTablePrivileges(table: RuntimeTableShape): ReadonlySet<string> | null {
  const global = GLOBAL_RUNTIME_TABLE_PRIVILEGES[table.table_name];
  if (global) return global;
  if (table.table_name === 'Tenant') return READ_ONLY_PRIVILEGES;
  if (table.table_name === 'IdempotencyKey') return CRUD_PRIVILEGES;
  if (table.has_tenant_id && table.tenant_id_not_null) {
    return TENANT_APPEND_ONLY_TABLES.has(table.table_name) ? READ_APPEND_PRIVILEGES : CRUD_PRIVILEGES;
  }
  return null;
}

export function isTenantRuntimeTable(table: RuntimeTableShape): boolean {
  return table.table_name === 'Tenant'
    || table.table_name === 'IdempotencyKey'
    || (table.has_tenant_id && table.tenant_id_not_null && table.table_name !== 'PlatformAuditEvent');
}
