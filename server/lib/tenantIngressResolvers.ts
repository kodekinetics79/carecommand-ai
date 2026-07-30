import type { UserRole } from '../generated/prisma/enums';
import { db } from './db';

/**
 * Public ingress is the only point at which the runtime is allowed to resolve a
 * tenant without an existing TenantContext. The backing functions are
 * SECURITY DEFINER, return a minimal mapping, and are executable only by the
 * restricted runtime role. Callers must verify/sign/hash opaque credentials
 * before invoking these resolvers, then activate a tenant context immediately.
 */
export type IngressTenantLookupKind =
  | 'tenant_slug'
  | 'portal_token_hash'
  | 'refresh_token_hash'
  | 'password_reset_hash'
  | 'intake_token_hash'
  | 'payment_public_token'
  | 'pilot_share_hash'
  | 'stripe_provider_reference'
  | 'retell_call_id'
  | 'retell_destination_phone'
  | 'campaign_provider_message';

interface IngressTenantRow {
  tenant_id: string;
  resource_id: string;
}

export interface IngressTenantResolution {
  tenantId: string;
  resourceId: string;
}

export interface RevokedInactiveRefresh {
  userId: string;
  tenantId: string;
  tenantStatus: string;
}

export interface DeviceWebhookVerifierResolution extends IngressTenantResolution {
  encryptedConfig: string;
}

/**
 * Resolves verifier material only. The selector is not tenant authority: the
 * caller must validate the provider HMAC over the exact raw body before it may
 * establish the returned tenant context.
 */
export async function resolveDeviceWebhookVerifier(
  tenantSelector: string,
  providerKey: string,
): Promise<DeviceWebhookVerifierResolution | null> {
  const rows = await db.$queryRaw<Array<{ tenant_id: string; resource_id: string; encrypted_config: string }>>`
    SELECT tenant_id, resource_id, encrypted_config
    FROM app_resolve_device_webhook_verifier(${tenantSelector}::uuid, ${providerKey}::text)
  `;
  if (rows.length !== 1) return null;
  return {
    tenantId: rows[0].tenant_id,
    resourceId: rows[0].resource_id,
    encryptedConfig: rows[0].encrypted_config,
  };
}

export async function revokeInactiveRefreshToken(verifiedRefreshHash: string): Promise<RevokedInactiveRefresh | null> {
  const rows = await db.$queryRaw<Array<{ user_id: string; tenant_id: string; tenant_status: string }>>`
    SELECT user_id, tenant_id, tenant_status
    FROM app_revoke_inactive_refresh_token(${verifiedRefreshHash}::text)
  `;
  if (rows.length !== 1) return null;
  return { userId: rows[0].user_id, tenantId: rows[0].tenant_id, tenantStatus: rows[0].tenant_status };
}

export async function resolveIngressTenant(
  kind: IngressTenantLookupKind,
  verifiedLookupValue: string,
): Promise<IngressTenantResolution | null> {
  const rows = await db.$queryRaw<IngressTenantRow[]>`
    SELECT tenant_id, resource_id
    FROM app_resolve_ingress_tenant(${kind}::text, ${verifiedLookupValue}::text)
  `;
  if (rows.length !== 1) return null;
  return { tenantId: rows[0].tenant_id, resourceId: rows[0].resource_id };
}

interface AuthLoginCandidateRow {
  user_id: string;
  tenant_id: string;
  email: string;
  display_name: string;
  user_role: UserRole;
  branch_id: string | null;
  password_hash: string | null;
  locked_until: Date | null;
  failed_login_count: number;
  password_changed_at: Date | null;
  mfa_enabled: boolean;
  mfa_secret_enc: string | null;
  mfa_enrolled_at: Date | null;
  tenant_name: string;
  resolved_tenant_slug: string;
  tenant_status: string;
  branch_name: string | null;
  branch_location: string | null;
}

export interface AuthLoginCandidate {
  id: string;
  tenantId: string;
  email: string;
  displayName: string;
  role: UserRole;
  branchId: string | null;
  passwordHash: string | null;
  lockedUntil: Date | null;
  failedLoginCount: number;
  passwordChangedAt: Date | null;
  mfaEnabled: boolean;
  mfaSecretEnc: string | null;
  mfaEnrolledAt: Date | null;
  active: true;
  tenant: { id: string; name: string; slug: string; status: string };
  branch: { id: string; name: string; location: string } | null;
}

/**
 * Credential bootstrap for email/password login. The database function returns
 * only the bounded fields required to verify credentials and build a session;
 * it never grants tenant access by itself.
 */
export async function resolveAuthLoginCandidates(
  email: string,
  tenantSlug?: string,
): Promise<AuthLoginCandidate[]> {
  const rows = await db.$queryRaw<AuthLoginCandidateRow[]>`
    SELECT * FROM app_auth_login_candidates(${email}::text, ${tenantSlug ?? null}::text)
  `;
  return rows.map(row => ({
    id: row.user_id,
    tenantId: row.tenant_id,
    email: row.email,
    displayName: row.display_name,
    role: row.user_role,
    branchId: row.branch_id,
    passwordHash: row.password_hash,
    lockedUntil: row.locked_until,
    failedLoginCount: row.failed_login_count,
    passwordChangedAt: row.password_changed_at,
    mfaEnabled: row.mfa_enabled,
    mfaSecretEnc: row.mfa_secret_enc,
    mfaEnrolledAt: row.mfa_enrolled_at,
    active: true,
    tenant: {
      id: row.tenant_id,
      name: row.tenant_name,
      slug: row.resolved_tenant_slug,
      status: row.tenant_status,
    },
    branch: row.branch_id && row.branch_name && row.branch_location
      ? { id: row.branch_id, name: row.branch_name, location: row.branch_location }
      : null,
  }));
}
