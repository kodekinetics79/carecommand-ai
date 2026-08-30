import 'dotenv/config';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';

// ===========================================================================
// One command that rebuilds a demo-ready tenant from nothing:
//
//     npm run demo:provision
//
// drop -> create -> `prisma migrate deploy` -> synthetic seed (subscription +
// entitlements + the whole Growth layer) -> verify, and it prints the exact
// connection string and login to hand a salesperson.
//
// SAFETY
// ------
// This script does NOT weaken, bypass or special-case prisma/synthetic/seedSafety.ts.
// It runs the ordinary seed as a child process with NODE_ENV=test,
// SYNTHETIC_DATABASE_URL and CONFIRM_SYNTHETIC_DATABASE, so the guard evaluates
// exactly as it always does. On top of that, because this script is the thing
// that DROPS a database, it re-asserts the same disposable-name rule itself
// (a guard you are about to destroy data with is a guard you check twice) and
// additionally refuses any non-local PostgreSQL host — the seed guard alone
// would happily accept a remote database that merely had a synthetic-looking
// name, and a DROP is not something to hand to a hostname.
//
// The default target is `carecommand_synthetic_demo`, which matches the guard's
// `^(?:cc|carecommand)_(?:test|synthetic|e2e|rls)_[a-z0-9_]+$` pattern, and the
// database is deliberately LEFT STANDING so the demo can be run against it.
// ===========================================================================

/** The one rule from prisma/synthetic/seedSafety.ts, restated where a DROP happens. */
const SAFE_DATABASE_NAME = /^(?:cc|carecommand)_(?:test|synthetic|e2e|rls)_[a-z0-9_]+$/i;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const DEFAULT_DATABASE = 'carecommand_synthetic_demo';
const DEFAULT_PROFILE = 'PILOT';
const SEED_PASSWORD = 'SyntheticOnly!2026';

export interface DemoProvisionPlan {
  adminUrl: string;
  ownerUrl: string;
  runtimeUrl: string;
  databaseName: string;
  profile: string;
}

function hostnameOf(url: URL): string {
  return url.hostname.startsWith('[') && url.hostname.endsWith(']') ? url.hostname.slice(1, -1) : url.hostname;
}

export function buildDemoProvisionPlan(input: {
  migrationUrl?: string;
  databaseName?: string;
  profile?: string;
  allowRemote?: boolean;
}): DemoProvisionPlan {
  if (!input.migrationUrl) {
    throw new Error('DATABASE_MIGRATION_URL is required (it names the PostgreSQL server and the owner role)');
  }
  const profile = (input.profile ?? DEFAULT_PROFILE).toUpperCase();
  if (!['FUNCTIONAL', 'TIER1', 'PILOT', 'EDGE'].includes(profile)) {
    throw new Error('DEMO_PROFILE must be FUNCTIONAL, TIER1, PILOT, or EDGE');
  }

  const migration = new URL(input.migrationUrl);
  if (!['postgres:', 'postgresql:'].includes(migration.protocol)) throw new Error('Only PostgreSQL URLs are accepted');
  if (!input.allowRemote && !LOCAL_HOSTS.has(hostnameOf(migration))) {
    throw new Error(`Refusing to provision a demo database on non-local PostgreSQL host "${migration.hostname}"`);
  }

  const databaseName = input.databaseName ?? DEFAULT_DATABASE;
  if (!SAFE_DATABASE_NAME.test(databaseName)) {
    throw new Error(`Refusing demo provisioning for unsafe database name: ${databaseName || '<empty>'} (must match ${SAFE_DATABASE_NAME})`);
  }
  if (databaseName.length > 63) throw new Error('Demo database name exceeds the PostgreSQL identifier length');

  const admin = new URL(migration);
  admin.searchParams.delete('schema');
  admin.searchParams.delete('options');
  const owner = new URL(migration);
  owner.pathname = `/${databaseName}`;
  owner.searchParams.set('schema', 'public');
  owner.searchParams.delete('options');
  const runtime = new URL(owner);
  runtime.searchParams.set('options', '-c role=app_rls');

  return { adminUrl: admin.toString(), ownerUrl: owner.toString(), runtimeUrl: runtime.toString(), databaseName, profile };
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', env });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} failed (${signal ? `signal ${signal}` : `exit ${code ?? 'unknown'}`})`));
    });
  });
}

interface ReadinessRow {
  tenant_id: string;
  tenant_name: string;
  tenant_slug: string;
  owner_email: string | null;
  plan: string | null;
  subscription_status: string | null;
  entitlements: string[];
  leads: number;
  lead_stages: number;
  campaigns: number;
  campaign_deliveries: number;
  campaign_attributions: number;
  attributed_revenue: string;
  reviews: number;
  average_rating: string | null;
  reputation_cases: number;
  competitors: number;
  playbooks: number;
  automation_rules: number;
  consent_opted_in: number;
  consent_opted_out: number;
  inactive_30_60: number;
  inactive_60_90: number;
  inactive_90_180: number;
  never_visited: number;
  live_dispatch_activations: number;
  receptionist_locale_packs_approved: number;
  receptionist_clinics_with_hours: number;
  receptionist_clinics_with_country: number;
  receptionist_locations: number;
  receptionist_knowledge_approved: number;
  receptionist_after_hours_calls: number;
  receptionist_bookable_services: number;
}

/**
 * Verification is a read of what the seed actually produced, not a restatement
 * of what it intended. Every number below comes from the same columns the
 * product reads.
 */
async function verify(ownerUrl: string): Promise<ReadinessRow> {
  const pool = new Pool({ connectionString: ownerUrl, max: 1 });
  try {
    const { rows } = await pool.query<ReadinessRow>(`
      WITH demo AS (
        SELECT t.id, t.name, t.slug
        FROM "Tenant" t
        JOIN "TenantFeatureEntitlement" e
          ON e."tenantId" = t.id AND e."featureKey" = 'campaign_automation' AND e.enabled
        WHERE t.status = 'active'
        ORDER BY t.slug
        LIMIT 1
      )
      SELECT
        d.id::text AS tenant_id,
        d.name AS tenant_name,
        d.slug AS tenant_slug,
        (SELECT u.email FROM "User" u WHERE u."tenantId" = d.id AND u.role = 'OWNER' AND u.active ORDER BY u.email LIMIT 1) AS owner_email,
        (SELECT p.key FROM "TenantSubscription" s JOIN "SubscriptionPlan" p ON p.id = s."planId" WHERE s."tenantId" = d.id) AS plan,
        (SELECT s.status::text FROM "TenantSubscription" s WHERE s."tenantId" = d.id) AS subscription_status,
        COALESCE((SELECT array_agg(e."featureKey" ORDER BY e."featureKey") FROM "TenantFeatureEntitlement" e WHERE e."tenantId" = d.id AND e.enabled), '{}') AS entitlements,
        (SELECT count(*) FROM "Lead" l WHERE l."tenantId" = d.id AND l."deletedAt" IS NULL)::int AS leads,
        (SELECT count(DISTINCT l.stage) FROM "Lead" l WHERE l."tenantId" = d.id AND l."deletedAt" IS NULL)::int AS lead_stages,
        (SELECT count(*) FROM "Campaign" c WHERE c."tenantId" = d.id)::int AS campaigns,
        (SELECT count(*) FROM "CampaignDelivery" cd WHERE cd."tenantId" = d.id)::int AS campaign_deliveries,
        (SELECT count(*) FROM "CampaignAttribution" ca WHERE ca."tenantId" = d.id)::int AS campaign_attributions,
        (SELECT COALESCE(sum(c.revenue), 0)::text FROM "Campaign" c WHERE c."tenantId" = d.id) AS attributed_revenue,
        (SELECT count(*) FROM "Review" r WHERE r."tenantId" = d.id)::int AS reviews,
        (SELECT round(avg(r.rating)::numeric, 2)::text FROM "Review" r WHERE r."tenantId" = d.id) AS average_rating,
        (SELECT count(*) FROM "ReputationCase" rc WHERE rc."tenantId" = d.id)::int AS reputation_cases,
        (SELECT count(*) FROM "Competitor" c WHERE c."tenantId" = d.id)::int AS competitors,
        (SELECT count(*) FROM "AutopilotPlaybook" pb WHERE pb."tenantId" = d.id)::int AS playbooks,
        (SELECT count(*) FROM "AutomationRule" ar WHERE ar."tenantId" = d.id)::int AS automation_rules,
        (SELECT count(*) FROM "CommunicationConsent" cc WHERE cc."tenantId" = d.id AND cc.status = 'opted_in')::int AS consent_opted_in,
        (SELECT count(*) FROM "CommunicationConsent" cc WHERE cc."tenantId" = d.id AND cc.status = 'opted_out')::int AS consent_opted_out,
        (SELECT count(*) FROM "Patient" p WHERE p."tenantId" = d.id AND p."deletedAt" IS NULL
           AND floor(extract(epoch from (now()::timestamp - p."lastVisitAt")) / 86400) >= 30
           AND floor(extract(epoch from (now()::timestamp - p."lastVisitAt")) / 86400) < 60)::int AS inactive_30_60,
        (SELECT count(*) FROM "Patient" p WHERE p."tenantId" = d.id AND p."deletedAt" IS NULL
           AND floor(extract(epoch from (now()::timestamp - p."lastVisitAt")) / 86400) >= 60
           AND floor(extract(epoch from (now()::timestamp - p."lastVisitAt")) / 86400) < 90)::int AS inactive_60_90,
        (SELECT count(*) FROM "Patient" p WHERE p."tenantId" = d.id AND p."deletedAt" IS NULL
           AND floor(extract(epoch from (now()::timestamp - p."lastVisitAt")) / 86400) >= 90
           AND floor(extract(epoch from (now()::timestamp - p."lastVisitAt")) / 86400) < 180)::int AS inactive_90_180,
        (SELECT count(*) FROM "Patient" p WHERE p."tenantId" = d.id AND p."deletedAt" IS NULL AND p."lastVisitAt" IS NULL)::int AS never_visited,
        (SELECT count(*) FROM "CampaignLiveDispatchActivation")::int AS live_dispatch_activations,
        (SELECT count(*) FROM "ReceptionistLocalePack" p WHERE p."tenantId" = d.id AND p.status = 'APPROVED')::int AS receptionist_locale_packs_approved,
        (SELECT count(*) FROM "ReceptionistClinic" c WHERE c."tenantId" = d.id AND c."workingHours" IS NOT NULL)::int AS receptionist_clinics_with_hours,
        (SELECT count(*) FROM "ReceptionistClinic" c WHERE c."tenantId" = d.id AND c.country IS NOT NULL)::int AS receptionist_clinics_with_country,
        (SELECT count(*) FROM "ReceptionistLocation" l WHERE l."tenantId" = d.id)::int AS receptionist_locations,
        (SELECT count(*) FROM "ReceptionistClinicKnowledge" k WHERE k."tenantId" = d.id AND k."approvedHash" IS NOT NULL)::int AS receptionist_knowledge_approved,
        (SELECT count(*) FROM "ReceptionistCallLog" cl WHERE cl."tenantId" = d.id AND cl."outsideHours" = true)::int AS receptionist_after_hours_calls,
        (SELECT count(*) FROM "ServiceCatalogItem" s WHERE s."tenantId" = d.id AND s."bookableByVoice")::int AS receptionist_bookable_services
      FROM demo d
    `);
    const row = rows[0];
    if (!row) throw new Error('No active tenant with campaign_automation entitlement was produced; the demo would open locked');
    return row;
  } finally {
    await pool.end();
  }
}

const REQUIRED_ENTITLEMENTS = ['campaign_automation', 'patient_crm'];

function assertReady(row: ReadinessRow): string[] {
  const failures: string[] = [];
  for (const key of REQUIRED_ENTITLEMENTS) {
    if (!row.entitlements.includes(key)) failures.push(`entitlement "${key}" is not enabled — the Growth module would return feature_locked`);
  }
  if (row.lead_stages < 3) failures.push(`leads span only ${row.lead_stages} stage(s); the pipeline would render as one column`);
  if (row.inactive_30_60 < 1) failures.push('the 30-60 day inactive segment has no members');
  if (row.inactive_60_90 < 1) failures.push('the 60-90 day inactive segment has no members');
  if (row.inactive_90_180 < 1) failures.push('the 90-180 day inactive segment has no members');
  if (row.never_visited < 1) failures.push('no patient has a never-visited history, so includeNeverVisited has nothing to include');
  if (row.average_rating === null) failures.push('reviews do not aggregate to an average rating');
  if (row.consent_opted_in < 1) failures.push('no contactable consent evidence exists, so every audience preview is empty');
  if (row.consent_opted_out < 1) failures.push('no suppression evidence exists, so a preview cannot demonstrate suppression');
  if (row.campaign_attributions < 1) failures.push('no campaign attribution evidence exists, so every campaign shows zero outcomes');
  if (row.live_dispatch_activations !== 0) failures.push('live campaign dispatch is ACTIVATED; the demo must run on the mock provider path');
  // The receptionist cannot be activated, and cannot answer a single question
  // about the clinic, without these.
  if (row.receptionist_locale_packs_approved < 2) failures.push('fewer than two approved locale packs exist; an en-GB or en-US clinic could not be activated');
  if (row.receptionist_clinics_with_country < 1) failures.push('no receptionist clinic has a country, so activation is blocked and the emergency number is unknown');
  if (row.receptionist_clinics_with_hours < 1) failures.push('no receptionist clinic has working hours, so the agent cannot answer "are you open"');
  if (row.receptionist_locations < 1) failures.push('no receptionist location exists, so the prompt has no address or access notes to read');
  if (row.receptionist_knowledge_approved < 1) failures.push('no approved clinic knowledge exists, so insurance/payment/FAQ answers are all "take a message"');
  if (row.receptionist_after_hours_calls < 1) failures.push('no after-hours call evidence exists, so the front-desk after-hours card renders empty');
  if (row.receptionist_bookable_services < 1) failures.push('no service is bookable by voice, so the agent can describe nothing and book nothing');
  return failures;
}

export async function provisionDemoTenant(): Promise<ReadinessRow> {
  const plan = buildDemoProvisionPlan({
    migrationUrl: process.env.DATABASE_MIGRATION_URL,
    databaseName: process.env.DEMO_DATABASE_NAME,
    profile: process.env.DEMO_PROFILE,
    allowRemote: process.env.DEMO_ALLOW_REMOTE_HOST === 'true',
  });

  const admin = new Pool({ connectionString: plan.adminUrl, max: 1 });
  try {
    const connected = await admin.query<{ database: string }>('SELECT current_database() AS database');
    if (!connected.rows[0]?.database) throw new Error('Administrative connection did not report a database');
    if (connected.rows[0].database === plan.databaseName) {
      throw new Error('DATABASE_MIGRATION_URL points at the demo database itself; it must name a different administrative database');
    }
    // Checked once more immediately before the destructive statement.
    if (!SAFE_DATABASE_NAME.test(plan.databaseName)) throw new Error(`Refusing to drop non-disposable database "${plan.databaseName}"`);
    console.log(`[demo] recreating ${plan.databaseName}`);
    await admin.query(`DROP DATABASE IF EXISTS "${plan.databaseName}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${plan.databaseName}"`);
  } finally {
    await admin.end();
  }

  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  console.log('[demo] applying migrations (this installs the subscription plan catalog)');
  await run(npx, ['prisma', 'migrate', 'deploy'], {
    ...process.env,
    DATABASE_URL: plan.ownerUrl,
    DATABASE_MIGRATION_URL: plan.ownerUrl,
  });

  console.log(`[demo] seeding the ${plan.profile} profile (subscription, entitlements, Growth records)`);
  await run(npx, ['tsx', 'prisma/seedSynthetic.ts'], {
    ...process.env,
    // The seed guard evaluates unchanged: it still requires NODE_ENV=test, a
    // disposable database name and an explicit confirmation.
    NODE_ENV: 'test',
    SYNTHETIC_PROFILE: plan.profile,
    SYNTHETIC_DATABASE_URL: plan.ownerUrl,
    DATABASE_MIGRATION_URL: plan.ownerUrl,
    CONFIRM_SYNTHETIC_DATABASE: plan.databaseName,
  });

  console.log('[demo] verifying');
  const readiness = await verify(plan.ownerUrl);
  const failures = assertReady(readiness);
  console.log(JSON.stringify({ database: plan.databaseName, profile: plan.profile, readiness }, null, 2));
  if (failures.length > 0) {
    throw new Error(`Demo tenant is NOT ready:\n  - ${failures.join('\n  - ')}`);
  }

  console.log('');
  console.log('[demo] READY');
  console.log(`  database        ${plan.databaseName}`);
  console.log(`  tenant          ${readiness.tenant_name} (${readiness.tenant_slug})`);
  console.log(`  plan            ${readiness.plan} / ${readiness.subscription_status}`);
  console.log(`  login           ${readiness.owner_email ?? '<no active OWNER>'} / ${SEED_PASSWORD}`);
  console.log(`  DATABASE_URL    ${plan.runtimeUrl}`);
  console.log(`  MIGRATION_URL   ${plan.ownerUrl}`);
  console.log('');
  console.log('  Start the app against it with:');
  console.log(`    DATABASE_URL='${plan.runtimeUrl}' DATABASE_MIGRATION_URL='${plan.ownerUrl}' npm run dev:all`);
  console.log('');
  console.log('  Live campaign dispatch is OFF (no CampaignLiveDispatchActivation row).');
  console.log('  Outreach demonstrates on the dev mock provider path; nothing is contacted.');
  return readiness;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  provisionDemoTenant().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
