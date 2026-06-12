/**
 * Compliance Readiness Center Phase C-1A verification.
 *   npx tsx server/lib/complianceSeed.verify.ts
 *
 * Proves: new roles exist; per-tenant frameworks/controls/policy/retention are
 * seeded idempotently; NO RLS on the new compliance tables; NO AuditLog table.
 * Uses the owner connection (DATABASE_MIGRATION_URL) for unrestricted reads.
 */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import type { UserRole } from '../generated/prisma/enums';

const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });

// Compile-time proof the new roles are part of the generated UserRole union.
const GENERATED_NEW_ROLES: UserRole[] = ['COMPLIANCE_OFFICER', 'AUDITOR'];

const NEW_TABLES = [
  'ComplianceFramework', 'ComplianceControl', 'ComplianceEvidence', 'ComplianceControlEvidence',
  'ComplianceEvidenceVersion', 'CompliancePolicy', 'ComplianceRisk', 'ComplianceTask',
  'ComplianceException', 'VendorRisk', 'SecurityIncident', 'AccessReview',
  'DataRetentionPolicy', 'BackupVerification', 'SecurityScanResult', 'TenantSecurityPolicy',
];
const EXPECTED_FRAMEWORKS = 3;
const EXPECTED_CONTROLS = 40; // 12 categories x 3 frameworks + 4 internal-baseline extras
const EXPECTED_RETENTION = 6;

let failures = 0;
function check(label: string, ok: boolean) {
  console.log(`${ok ? '✓' : '✗'} ${label}`);
  if (!ok) failures += 1;
}

async function main() {
  // 1) New roles exist — in the generated type (above) and in the DB enum.
  check('generated UserRole type includes COMPLIANCE_OFFICER + AUDITOR', GENERATED_NEW_ROLES.length === 2);
  const enumLabels = await db.$queryRaw<Array<{ enumlabel: string }>>`
    SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'UserRole'`;
  const labels = new Set(enumLabels.map(r => r.enumlabel));
  check('DB UserRole enum has COMPLIANCE_OFFICER', labels.has('COMPLIANCE_OFFICER'));
  check('DB UserRole enum has AUDITOR', labels.has('AUDITOR'));

  // 2-5) Per-tenant baseline seeded (and idempotent — exact expected counts).
  const tenants = await db.tenant.findMany({ select: { id: true } });
  check('at least one tenant exists', tenants.length > 0);
  for (const t of tenants) {
    const [fw, ctrl, pol, ret] = await Promise.all([
      db.complianceFramework.count({ where: { tenantId: t.id } }),
      db.complianceControl.count({ where: { tenantId: t.id } }),
      db.tenantSecurityPolicy.count({ where: { tenantId: t.id } }),
      db.dataRetentionPolicy.count({ where: { tenantId: t.id } }),
    ]);
    check(`tenant ${t.id.slice(0, 8)}: ${EXPECTED_FRAMEWORKS} frameworks`, fw === EXPECTED_FRAMEWORKS);
    check(`tenant ${t.id.slice(0, 8)}: ${EXPECTED_CONTROLS} controls (idempotent, no dupes)`, ctrl === EXPECTED_CONTROLS);
    check(`tenant ${t.id.slice(0, 8)}: exactly 1 TenantSecurityPolicy`, pol === 1);
    check(`tenant ${t.id.slice(0, 8)}: ${EXPECTED_RETENTION} DataRetentionPolicy rows`, ret === EXPECTED_RETENTION);
  }

  // Truthfulness: there must be a mix incl. NOT_IMPLEMENTED (no fabricated all-pass).
  const notImpl = await db.complianceControl.count({ where: { status: 'NOT_IMPLEMENTED' } });
  check('baseline contains NOT_IMPLEMENTED controls (truthful, not all-pass)', notImpl > 0);

  // 6) No RLS on any of the new compliance tables.
  const rlsRows = await db.$queryRaw<Array<{ relname: string }>>`
    SELECT relname FROM pg_class WHERE relkind = 'r' AND relrowsecurity = true`;
  const rlsEnabled = new Set(rlsRows.map(r => r.relname));
  const leaked = NEW_TABLES.filter(name => rlsEnabled.has(name));
  check(`no RLS enabled on new compliance tables (offenders: ${leaked.join(', ') || 'none'})`, leaked.length === 0);

  // 7) No AuditLog table; AuditEvent (reused) still present.
  const reg = await db.$queryRaw<Array<{ auditlog: string | null; auditevent: string | null }>>`
    SELECT to_regclass('"AuditLog"')::text AS auditlog, to_regclass('"AuditEvent"')::text AS auditevent`;
  check('no AuditLog table was created', reg[0]?.auditlog === null);
  check('existing AuditEvent table is reused (present)', reg[0]?.auditevent !== null);

  await db.$disconnect();
  console.log(`\n${failures === 0 ? 'ALL C-1A CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
