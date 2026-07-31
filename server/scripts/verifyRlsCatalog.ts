import 'dotenv/config';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { db } from '../lib/db';

type TableRow = {
  table_name: string;
  rls_enabled: boolean;
  rls_forced: boolean;
  owner_name: string;
  has_tenant_id: boolean;
  tenant_id_not_null: boolean;
  can_select: boolean;
  can_insert: boolean;
  can_update: boolean;
  can_delete: boolean;
};

type PolicyRow = {
  table_name: string;
  policy_name: string;
  command: string;
  roles: string[];
  using_expression: string | null;
  check_expression: string | null;
};

type RoleRow = {
  role_name: string;
  is_superuser: boolean;
  bypasses_rls: boolean;
  can_create_role: boolean;
  can_create_db: boolean;
  can_replicate: boolean;
  can_create_in_public: boolean;
  public_schema_owner: string;
};

type ViewDependencyRow = {
  view_name: string;
  view_kind: string;
  view_options: string[] | null;
  table_name: string;
};

type Classification = {
  category: string;
  purpose: string;
  tenantOwned: boolean;
  phi: boolean;
  ownership: string;
  directlyQueryable: boolean;
  accessPath: string;
  supportBehavior: string;
  requiredTest: string;
  exemption: string;
  expectedPrivileges: ReadonlySet<string>;
};

const EXPECTED_RUNTIME_ROLE = 'app_rls';
const MATRIX_PATH = resolve('docs/security/RLS_COVERAGE_MATRIX.md');
const CRUD = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE']);
const READ_ONLY = new Set(['SELECT']);
const READ_APPEND = new Set(['SELECT', 'INSERT']);
const NO_PRIVILEGES = new Set<string>();
const FULL_CRUD_EVIDENCE = new Set(['AiGuardrail']);
const TENANT_APPEND_ONLY_TABLES = new Set([
  'AuditEvent',
  'NotificationDeliveryAttempt',
  'ReceptionistOutboundProviderIntent',
  'ReceptionistVoiceConsentEvent',
]);

const GLOBAL_CLASSIFICATIONS: Record<string, Classification> = {
  SubscriptionPlan: globalReference('D', 'Commercial subscription-plan catalogue.', READ_ONLY),
  SubscriptionPlanFeature: globalReference('D', 'Plan-to-feature catalogue mapping.', READ_ONLY),
  SubscriptionAddon: globalReference('D', 'Commercial add-on catalogue.', READ_ONLY),
  PlatformAnnouncement: globalReference('H', 'Deliberately shared platform announcements.', READ_ONLY),
  PlatformConfig: platformControl('D', 'Singleton platform configuration; platform-authorized routes only.'),
  PlatformIntegration: platformControl('D', 'Platform integration registry; contains platform configuration, not tenant rows.'),
  PlatformUser: platformControl('E', 'Platform authentication identity store, separated from tenant User accounts.'),
  PlatformAuditEvent: {
    category: 'F',
    purpose: 'Global append-only platform security ledger; tenantId is an optional target, not row ownership.',
    tenantOwned: false,
    phi: false,
    ownership: 'Platform-global; optional tenant target only.',
    directlyQueryable: false,
    accessPath: 'Dedicated platform control-plane connection/path only; never app_rls.',
    supportBehavior: 'Platform/support actions require an explicit separately audited control-plane path.',
    requiredTest: 'Runtime no-privilege guard plus dedicated append-only platform audit test.',
    exemption: 'RLS exemption: rows describe platform actions and may target zero or one tenant; tenant filtering is not row ownership.',
    expectedPrivileges: NO_PRIVILEGES,
  },
  _prisma_migrations: {
    category: 'G',
    purpose: 'Prisma migration history owned by the schema/migration role.',
    tenantOwned: false,
    phi: false,
    ownership: 'Migration infrastructure.',
    directlyQueryable: false,
    accessPath: 'Migration role only.',
    supportBehavior: 'No runtime or support access.',
    requiredTest: 'Runtime role has no table privileges.',
    exemption: 'RLS exemption: schema-control metadata is inaccessible to the runtime role.',
    expectedPrivileges: NO_PRIVILEGES,
  },
};

function globalReference(category: string, purpose: string, expectedPrivileges: ReadonlySet<string>): Classification {
  return {
    category,
    purpose,
    tenantOwned: false,
    phi: false,
    ownership: 'Platform-global reference data.',
    directlyQueryable: true,
    accessPath: 'Restricted runtime read path.',
    supportBehavior: 'Shared reference data; no tenant impersonation required.',
    requiredTest: 'Catalog privilege guard verifies read-only runtime access.',
    exemption: 'RLS exemption: deliberately shared, non-tenant reference data with read-only runtime access.',
    expectedPrivileges,
  };
}

function platformControl(category: string, purpose: string): Classification {
  return {
    category,
    purpose,
    tenantOwned: false,
    phi: false,
    ownership: 'Platform-global control plane.',
    directlyQueryable: false,
    accessPath: 'Dedicated platform control-plane connection/path only; never app_rls.',
    supportBehavior: 'Requires separate least-privilege platform authorization and platform audit.',
    requiredTest: 'Runtime no-privilege guard plus dedicated platform-role RBAC test.',
    exemption: 'RLS exemption: platform-control object has no tenant row owner; application RBAC and platform audit remain mandatory.',
    expectedPrivileges: NO_PRIVILEGES,
  };
}

function classify(table: TableRow): Classification | null {
  const explicit = GLOBAL_CLASSIFICATIONS[table.table_name];
  if (explicit) return explicit;
  if (table.table_name === 'Tenant') {
    return {
      category: 'B',
      purpose: 'Tenant root and lifecycle record.',
      tenantOwned: true,
      phi: false,
      ownership: 'Primary key id is the tenant boundary.',
      directlyQueryable: true,
      accessPath: 'Verified TenantContext; runtime SELECT only.',
      supportBehavior: 'Explicit scoped platform/support context; lifecycle mutation remains outside runtime role.',
      requiredTest: 'Same-tenant SELECT; cross/no/inactive-context denial; runtime write denial.',
      exemption: '',
      expectedPrivileges: READ_ONLY,
    };
  }
  if (table.table_name === 'IdempotencyKey') {
    return {
      category: 'G',
      purpose: 'Tenant-scoped replay and duplicate-processing guard.',
      tenantOwned: true,
      phi: true,
      ownership: 'Nullable legacy tenantId column; app_rls policies reject NULL and require the active tenant.',
      directlyQueryable: true,
      accessPath: 'Verified webhook/request/receptionist TenantContext; claims occur only after tenant mapping.',
      supportBehavior: 'No unscoped runtime access; owner-only maintenance remains separate.',
      requiredTest: 'Same-tenant CRUD/replay plus cross/no-context and NULL-tenant write denial.',
      exemption: '',
      expectedPrivileges: CRUD,
    };
  }
  if (table.has_tenant_id && table.tenant_id_not_null) {
    const appendOnly = TENANT_APPEND_ONLY_TABLES.has(table.table_name);
    return {
      category: appendOnly ? 'F' : 'A',
      purpose: appendOnly ? `${table.table_name} tenant append-only evidence.` : `${table.table_name} tenant application data.`,
      tenantOwned: true,
      // Conservative classification: tenant application rows may contain PHI
      // directly or through JSON/relationship-derived operational context.
      phi: true,
      ownership: 'Direct non-null tenantId; tenant-consistent foreign keys where applicable.',
      directlyQueryable: true,
      accessPath: 'Verified request/portal/worker/webhook TenantContext through app_rls.',
      supportBehavior: 'Only explicit, reasoned, time-bounded support context; policy validation and audit required.',
      requiredTest: appendOnly
        ? 'Same-tenant SELECT/INSERT; cross/no-context denial; UPDATE/DELETE privilege denial.'
        : 'Table-driven same-tenant CRUD plus cross/no/inactive-context denial.',
      exemption: '',
      expectedPrivileges: appendOnly ? READ_APPEND : CRUD,
    };
  }
  return null;
}

function policyFor(policies: PolicyRow[], table: string, command: string): PolicyRow | undefined {
  return policies.find(policy =>
    policy.table_name === table
    && policy.command === command
    && policy.roles.length === 1
    && policy.roles[0] === EXPECTED_RUNTIME_ROLE,
  );
}

function actualPrivileges(row: TableRow): Set<string> {
  return new Set([
    row.can_select ? 'SELECT' : null,
    row.can_insert ? 'INSERT' : null,
    row.can_update ? 'UPDATE' : null,
    row.can_delete ? 'DELETE' : null,
  ].filter((value): value is string => value !== null));
}

function setEquals(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every(value => b.has(value));
}

function policyNames(policies: PolicyRow[], table: string, command: string): string {
  const names = policies.filter(policy => policy.table_name === table && policy.command === command).map(policy => policy.policy_name);
  return names.length ? names.join(', ') : '—';
}

function escapeCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function matrixDocument(tables: TableRow[], policies: PolicyRow[], role: RoleRow, failures: string[]): string {
  const protectedCount = tables.filter(table => classify(table)?.tenantOwned).length;
  const applicationTables = tables.filter(table => table.table_name !== '_prisma_migrations');
  const exemptCount = applicationTables.length - protectedCount;
  const enabled = tables.filter(table => classify(table)?.tenantOwned && table.rls_enabled).length;
  const forced = tables.filter(table => classify(table)?.tenantOwned && table.rls_forced).length;
  const pendingCrud = tables.filter(table => classify(table)?.tenantOwned && !FULL_CRUD_EVIDENCE.has(table.table_name)).length;
  const lines = [
    '# RLS Coverage Matrix',
    '',
    '> Generated by `npm run rls:docs` from the PostgreSQL catalog. Do not hand-edit table rows.',
    '',
    `Catalog snapshot: **${applicationTables.length} application tables** plus **1 Prisma migration-metadata table**, **${protectedCount} tenant/PHI protected**, **${enabled} RLS enabled**, **${forced} FORCE RLS**, **${exemptCount} application-table exemptions**. Runtime role: \`${role.role_name}\`. Catalog guard: **${failures.length ? 'FAIL' : 'PASS'}**. Full per-table CRUD evidence pending: **${pendingCrud}**.`,
    '',
    '| Physical / Prisma model | Purpose | Class | Tenant-owned | PHI-bearing | Ownership | App-queryable | RLS | FORCE | SELECT | INSERT | UPDATE | DELETE | WITH CHECK | Runtime role / privileges | Worker/webhook path | Platform/support behavior | Required test | Final status | Exemption rationale |',
    '|---|---|---:|:---:|:---:|---|:---:|:---:|:---:|---|---|---|---|---|---|---|---|---|:---:|---|',
  ];

  for (const table of [...tables].sort((a, b) => a.table_name.localeCompare(b.table_name))) {
    const c = classify(table);
    const privileges = [...actualPrivileges(table)].join('/') || 'none';
    const checks = policies
      .filter(policy => policy.table_name === table.table_name && policy.check_expression)
      .map(policy => policy.policy_name)
      .join(', ') || '—';
    const tableFailures = failures.filter(failure => failure.includes(`"${table.table_name}"`));
    const evidenceStatus = tableFailures.length
      ? 'FAIL'
      : c?.tenantOwned
        ? FULL_CRUD_EVIDENCE.has(table.table_name) ? 'PASS' : 'POLICY PASS / CRUD PENDING'
        : 'CATALOG PASS';
    lines.push(`| \`${escapeCell(table.table_name)}\` | ${escapeCell(c?.purpose ?? 'UNCLASSIFIED')} | ${c?.category ?? '—'} | ${c?.tenantOwned ? 'YES' : 'NO'} | ${c?.phi ? 'YES' : 'NO'} | ${escapeCell(c?.ownership ?? '—')} | ${c?.directlyQueryable ? 'YES' : 'NO'} | ${table.rls_enabled ? 'YES' : 'NO'} | ${table.rls_forced ? 'YES' : 'NO'} | ${policyNames(policies, table.table_name, 'SELECT')} | ${policyNames(policies, table.table_name, 'INSERT')} | ${policyNames(policies, table.table_name, 'UPDATE')} | ${policyNames(policies, table.table_name, 'DELETE')} | ${checks} | \`${role.role_name}\`: ${privileges} | ${escapeCell(c?.accessPath ?? '—')} | ${escapeCell(c?.supportBehavior ?? '—')} | ${escapeCell(c?.requiredTest ?? '—')} | **${evidenceStatus}** | ${escapeCell(c?.exemption || '—')} |`);
  }
  lines.push('', '## Guard failures', '', failures.length ? failures.map(failure => `- ${failure}`).join('\n') : '- None.', '');
  return lines.join('\n');
}

async function main() {
  const [tables, policies, roles, viewDependencies] = await Promise.all([
    db.$queryRaw<TableRow[]>`
      SELECT c.relname::text AS table_name,
             c.relrowsecurity AS rls_enabled,
             c.relforcerowsecurity AS rls_forced,
             owner.rolname::text AS owner_name,
             EXISTS (
               SELECT 1 FROM pg_attribute a
               WHERE a.attrelid = c.oid AND a.attname = 'tenantId' AND NOT a.attisdropped
             ) AS has_tenant_id,
             EXISTS (
               SELECT 1 FROM pg_attribute a
               WHERE a.attrelid = c.oid AND a.attname = 'tenantId'
                 AND NOT a.attisdropped AND a.attnotnull
             ) AS tenant_id_not_null,
             has_table_privilege(current_user, c.oid, 'SELECT') AS can_select,
             has_table_privilege(current_user, c.oid, 'INSERT') AS can_insert,
             has_table_privilege(current_user, c.oid, 'UPDATE') AS can_update,
             has_table_privilege(current_user, c.oid, 'DELETE') AS can_delete
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_roles owner ON owner.oid = c.relowner
      WHERE n.nspname = 'public' AND c.relkind = 'r'
      ORDER BY c.relname
    `,
    db.$queryRaw<PolicyRow[]>`
      SELECT tablename::text AS table_name, policyname::text AS policy_name, cmd::text AS command,
             roles::text[] AS roles, qual::text AS using_expression, with_check::text AS check_expression
      FROM pg_policies
      WHERE schemaname = 'public'
      ORDER BY tablename, cmd, policyname
    `,
    db.$queryRaw<RoleRow[]>`
      SELECT current_user::text AS role_name,
             r.rolsuper AS is_superuser,
             r.rolbypassrls AS bypasses_rls,
             r.rolcreaterole AS can_create_role,
             r.rolcreatedb AS can_create_db,
             r.rolreplication AS can_replicate,
             has_schema_privilege(current_user, 'public', 'CREATE') AS can_create_in_public,
             schema_owner.rolname::text AS public_schema_owner
      FROM pg_roles r
      JOIN pg_namespace n ON n.nspname = 'public'
      JOIN pg_roles schema_owner ON schema_owner.oid = n.nspowner
      WHERE r.rolname = current_user
    `,
    db.$queryRaw<ViewDependencyRow[]>`
      SELECT DISTINCT view_class.relname::text AS view_name,
             view_class.relkind::text AS view_kind,
             view_class.reloptions AS view_options,
             table_class.relname::text AS table_name
      FROM pg_depend dependency
      JOIN pg_rewrite rewrite ON rewrite.oid = dependency.objid
      JOIN pg_class view_class ON view_class.oid = rewrite.ev_class
      JOIN pg_namespace view_ns ON view_ns.oid = view_class.relnamespace
      JOIN pg_class table_class ON table_class.oid = dependency.refobjid
      JOIN pg_namespace table_ns ON table_ns.oid = table_class.relnamespace
      WHERE view_ns.nspname = 'public' AND table_ns.nspname = 'public'
        AND view_class.relkind IN ('v', 'm') AND table_class.relkind = 'r'
    `,
  ]);

  const role = roles[0];
  if (!role) throw new Error('RLS catalog guard could not inspect current PostgreSQL role.');
  const failures: string[] = [];

  if (role.role_name !== EXPECTED_RUNTIME_ROLE) failures.push(`Runtime connection must use "${EXPECTED_RUNTIME_ROLE}"; connected as "${role.role_name}".`);
  if (role.is_superuser) failures.push(`Runtime role "${role.role_name}" is SUPERUSER.`);
  if (role.bypasses_rls) failures.push(`Runtime role "${role.role_name}" has BYPASSRLS.`);
  if (role.can_create_role) failures.push(`Runtime role "${role.role_name}" has CREATEROLE.`);
  if (role.can_create_db) failures.push(`Runtime role "${role.role_name}" has CREATEDB.`);
  if (role.can_replicate) failures.push(`Runtime role "${role.role_name}" has REPLICATION.`);
  if (role.can_create_in_public) failures.push(`Runtime role "${role.role_name}" can CREATE in schema public.`);
  if (role.public_schema_owner === role.role_name) failures.push(`Runtime role "${role.role_name}" owns schema public.`);

  for (const table of tables) {
    const classification = classify(table);
    if (!classification) {
      failures.push(`Table "${table.table_name}" is unclassified; add an explicit global exemption or tenant ownership rule.`);
      continue;
    }
    const actual = actualPrivileges(table);
    if (!setEquals(actual, classification.expectedPrivileges)) {
      failures.push(`Table "${table.table_name}" runtime privileges are [${[...actual].join(', ') || 'none'}], expected [${[...classification.expectedPrivileges].join(', ') || 'none'}].`);
    }
    if (!classification.tenantOwned) continue;
    if (!table.rls_enabled) failures.push(`Protected table "${table.table_name}" does not have RLS enabled.`);
    if (!table.rls_forced) failures.push(`Protected table "${table.table_name}" does not have FORCE RLS enabled.`);
    if (table.owner_name === role.role_name) failures.push(`Runtime role "${role.role_name}" owns protected table "${table.table_name}".`);

    const commands = ['SELECT', 'INSERT', 'UPDATE', 'DELETE']
      .filter(command => classification.expectedPrivileges.has(command));
    const publicPolicies = policies.filter(policy =>
      policy.table_name === table.table_name && policy.roles.includes('public'),
    );
    if (publicPolicies.length) {
      failures.push(`Protected table "${table.table_name}" has a PUBLIC policy: ${publicPolicies.map(policy => policy.policy_name).join(', ')}.`);
    }
    for (const command of commands) {
      const runtimePolicies = policies.filter(policy =>
        policy.table_name === table.table_name
        && policy.command === command
        && policy.roles.includes(EXPECTED_RUNTIME_ROLE),
      );
      if (runtimePolicies.length !== 1) {
        failures.push(`Protected table "${table.table_name}" must have exactly one ${command} policy for ${EXPECTED_RUNTIME_ROLE}; found ${runtimePolicies.length}.`);
      }
      const policy = policyFor(policies, table.table_name, command);
      if (!policy) {
        failures.push(`Protected table "${table.table_name}" is missing ${command} policy for ${EXPECTED_RUNTIME_ROLE}.`);
        continue;
      }
      if (!`${policy.using_expression ?? ''} ${policy.check_expression ?? ''}`.includes('app_rls_tenant_allowed')) {
        failures.push(`Protected table "${table.table_name}" ${command} policy does not call app_rls_tenant_allowed.`);
      }
      if ((command === 'INSERT' || command === 'UPDATE') && !policy.check_expression) {
        failures.push(`Protected table "${table.table_name}" ${command} policy is missing WITH CHECK.`);
      }
      if ((command === 'SELECT' || command === 'UPDATE' || command === 'DELETE') && !policy.using_expression) {
        failures.push(`Protected table "${table.table_name}" ${command} policy is missing USING.`);
      }
    }
  }

  const protectedNames = new Set(tables.filter(table => classify(table)?.tenantOwned).map(table => table.table_name));
  for (const dependency of viewDependencies) {
    if (!protectedNames.has(dependency.table_name)) continue;
    const securityInvoker = dependency.view_options?.includes('security_invoker=true') ?? false;
    if (dependency.view_kind === 'm' || !securityInvoker) {
      failures.push(`View "${dependency.view_name}" reaches protected table "${dependency.table_name}" without a security-invoker boundary.`);
    }
  }

  let matrix = '';
  try {
    matrix = await readFile(MATRIX_PATH, 'utf8');
  } catch {
    failures.push('Coverage matrix docs/security/RLS_COVERAGE_MATRIX.md is missing.');
  }
  if (matrix) {
    for (const table of tables) {
      if (!matrix.includes(`| \`${table.table_name}\` |`)) failures.push(`Coverage matrix does not classify table "${table.table_name}".`);
    }
  }

  if (process.argv.includes('--write-docs')) {
    await mkdir(dirname(MATRIX_PATH), { recursive: true });
    await writeFile(MATRIX_PATH, matrixDocument(tables, policies, role, failures.filter(failure => !failure.startsWith('Coverage matrix'))), 'utf8');
    // Re-generation resolves documentation-presence failures for this run.
    for (let i = failures.length - 1; i >= 0; i--) {
      if (failures[i].startsWith('Coverage matrix') || failures[i].startsWith('Coverage matrix docs/')) failures.splice(i, 1);
    }
  }

  const protectedCount = tables.filter(table => classify(table)?.tenantOwned).length;
  const applicationTableCount = tables.filter(table => table.table_name !== '_prisma_migrations').length;
  const exemptionCount = applicationTableCount - protectedCount;
  const rlsEnabled = tables.filter(table => classify(table)?.tenantOwned && table.rls_enabled).length;
  const rlsForced = tables.filter(table => classify(table)?.tenantOwned && table.rls_forced).length;
  console.log(`RLS catalog: applicationTables=${applicationTableCount} metadataTables=${tables.length - applicationTableCount} protected=${protectedCount} exemptions=${exemptionCount} policies=${policies.length} enabled=${rlsEnabled} forced=${rlsForced} views=${new Set(viewDependencies.map(row => row.view_name)).size}`);
  console.log(`Runtime role: ${role.role_name} super=${role.is_superuser} bypassrls=${role.bypasses_rls} ownerProtected=${tables.filter(table => classify(table)?.tenantOwned && table.owner_name === role.role_name).length}`);
  if (failures.length) {
    for (const failure of failures) console.error(`FAIL: ${failure}`);
    process.exitCode = 1;
  } else {
    console.log('RLS catalog guard passed.');
  }
}

await main().finally(() => db.$disconnect());
