import type { PrismaClient } from '../../generated/prisma/client';

// ===========================================================================
// Compliance Readiness Center baseline seeding — reusable by the seed script
// and tenant onboarding. Idempotent per tenant; statuses are TRUTHFUL (no
// fabricated passing controls, no certification claims).
// ===========================================================================

const COMPLIANCE_FRAMEWORKS = [
  { key: 'soc2_readiness', name: 'SOC 2 Readiness', description: 'Readiness alignment to SOC 2 Trust Services Criteria. This is a readiness posture, not a certification.', weight: 1 },
  { key: 'hipaa_alignment', name: 'HIPAA Security Rule Alignment', description: 'Alignment to HIPAA Security Rule administrative, physical, and technical safeguards. Not a certification.', weight: 1 },
  { key: 'internal_baseline', name: 'Internal Security Baseline', description: 'CareCommand internal security baseline controls.', weight: 1 },
] as const;

const COMPLIANCE_CATEGORIES = [
  { key: 'access_control', title: 'Access control', status: 'IMPLEMENTED', notes: 'RBAC enforced via requireRoles with per-tenant scoping.' },
  { key: 'mfa_password_policy', title: 'MFA & password policy', status: 'IN_PROGRESS', notes: 'TOTP MFA, account lockout, and password reset are available; enforce per tenant policy.' },
  { key: 'audit_logging', title: 'Audit logging', status: 'IMPLEMENTED', notes: 'AuditEvent records actor, resource, IP, and user-agent on writes (append-only).' },
  { key: 'tenant_isolation', title: 'Tenant isolation', status: 'IN_PROGRESS', notes: 'Restricted app_rls runtime role active; RLS enabled on selected tables, expansion in progress.' },
  { key: 'encryption', title: 'Encryption', status: 'IN_PROGRESS', notes: 'TLS in transit; encryption at rest is infrastructure-dependent and not yet verified here.' },
  { key: 'backup_recovery', title: 'Backup and recovery', status: 'NOT_IMPLEMENTED', notes: 'No automated backup verification recorded yet.' },
  { key: 'incident_response', title: 'Incident response', status: 'NOT_IMPLEMENTED', notes: 'No formal incident response process recorded yet.' },
  { key: 'vendor_management', title: 'Vendor management', status: 'NOT_IMPLEMENTED', notes: 'No vendor risk register or BAA tracking yet.' },
  { key: 'change_management', title: 'Change management', status: 'IN_PROGRESS', notes: 'CI pipeline and versioned migrations exist; no formal change-approval workflow.' },
  { key: 'risk_management', title: 'Risk management', status: 'NOT_IMPLEMENTED', notes: 'Risk register not yet populated.' },
  { key: 'data_retention', title: 'Data retention', status: 'IN_PROGRESS', notes: 'Retention policy settings introduced; automated enforcement pending.' },
  { key: 'monitoring_alerting', title: 'Monitoring and alerting', status: 'IN_PROGRESS', notes: 'Health/readiness checks and security posture available; alerting pipeline pending.' },
] as const;

const COMPLIANCE_BASELINE_EXTRA = [
  { controlKey: 'signed_webhooks', categoryKey: 'monitoring_alerting', title: 'Signed webhook verification', status: 'IMPLEMENTED', notes: 'Retell and Stripe webhooks verified by signature; unsigned rejected in production.' },
  { controlKey: 'rate_limiting', categoryKey: 'monitoring_alerting', title: 'Redis-backed rate limiting', status: 'IMPLEMENTED', notes: 'Distributed rate limiting via Redis for multi-instance correctness.' },
  { controlKey: 'idempotency', categoryKey: 'change_management', title: 'Idempotent writes', status: 'IMPLEMENTED', notes: 'DB-backed idempotency keys protect payment and webhook writes.' },
  { controlKey: 'secrets_env', categoryKey: 'encryption', title: 'Secrets via environment', status: 'IMPLEMENTED', notes: 'No secrets committed to the repository; injected via environment.' },
] as const;

const COMPLIANCE_RETENTION = [
  { dataClass: 'patient', retentionDays: 2555, legalBasis: 'HIPAA-aligned minimum retention (configurable per jurisdiction).' },
  { dataClass: 'appointment', retentionDays: 2555, legalBasis: 'Clinical record retention.' },
  { dataClass: 'payment', retentionDays: 2555, legalBasis: 'Financial records retention.' },
  { dataClass: 'audit', retentionDays: 2555, legalBasis: 'Audit-trail retention for accountability.' },
  { dataClass: 'evidence', retentionDays: 3650, legalBasis: 'Compliance evidence retention.' },
  { dataClass: 'security', retentionDays: 1095, legalBasis: 'Security telemetry retention.' },
] as const;

export async function seedComplianceBaseline(db: PrismaClient, tenantId: string) {
  for (const framework of COMPLIANCE_FRAMEWORKS) {
    const fw = await db.complianceFramework.upsert({
      where: { tenantId_key: { tenantId, key: framework.key } },
      update: { name: framework.name, description: framework.description, weight: framework.weight },
      create: { tenantId, key: framework.key, name: framework.name, description: framework.description, weight: framework.weight },
    });
    for (const category of COMPLIANCE_CATEGORIES) {
      await db.complianceControl.upsert({
        where: { tenantId_frameworkId_controlKey: { tenantId, frameworkId: fw.id, controlKey: category.key } },
        update: { title: category.title, categoryKey: category.key, description: category.notes },
        create: { tenantId, frameworkId: fw.id, categoryKey: category.key, controlKey: category.key, title: category.title, description: category.notes, status: category.status, notes: category.notes },
      });
    }
    if (framework.key === 'internal_baseline') {
      for (const extra of COMPLIANCE_BASELINE_EXTRA) {
        await db.complianceControl.upsert({
          where: { tenantId_frameworkId_controlKey: { tenantId, frameworkId: fw.id, controlKey: extra.controlKey } },
          update: { title: extra.title, categoryKey: extra.categoryKey, description: extra.notes },
          create: { tenantId, frameworkId: fw.id, categoryKey: extra.categoryKey, controlKey: extra.controlKey, title: extra.title, description: extra.notes, status: extra.status, notes: extra.notes },
        });
      }
    }
  }

  await db.tenantSecurityPolicy.upsert({
    where: { tenantId },
    update: {},
    create: {
      tenantId, requireMfa: false, passwordExpiryDays: null, sessionTimeoutMinutes: 15,
      failedLoginLockout: false, allowedIpRanges: [], dataRetentionDays: 2555,
      backupFrequency: 'daily', evidenceReviewFrequency: 'quarterly',
    },
  });

  for (const retention of COMPLIANCE_RETENTION) {
    await db.dataRetentionPolicy.upsert({
      where: { tenantId_dataClass: { tenantId, dataClass: retention.dataClass } },
      update: { retentionDays: retention.retentionDays, legalBasis: retention.legalBasis },
      create: { tenantId, dataClass: retention.dataClass, retentionDays: retention.retentionDays, legalBasis: retention.legalBasis },
    });
  }
}
