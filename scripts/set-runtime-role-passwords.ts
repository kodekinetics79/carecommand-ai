/**
 * Sets passwords for the two runtime roles (app_rls, app_platform), verifies a
 * real login as each against the POOLER endpoint the app uses, and prints the
 * exact DATABASE_URL / PLATFORM_DATABASE_URL values to paste into Render.
 *
 * Context: production boot fails with 28P01 "password authentication failed
 * for user 'app_platform'" — pg_authid showed both roles had rolpassword NULL,
 * so the URLs configured in Render carry passwords the roles never received.
 *
 *   FIX_DB_URL='postgresql://neondb_owner:...@ep-...aws.neon.tech/neondb?sslmode=require' \
 *     npx tsx scripts/set-runtime-role-passwords.ts
 */
import pg from 'pg';
import { randomBytes } from 'node:crypto';

const url = process.env.FIX_DB_URL;
if (!url) { console.error('FIX_DB_URL not set'); process.exit(1); }

// URL-safe alphanumeric password: no characters that need percent-encoding.
function genPassword(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = randomBytes(48);
  let out = '';
  for (let i = 0; i < 40; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

async function main() {
  const admin = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await admin.connect();
  const who = await admin.query('select current_user');
  console.log('connected as:', who.rows[0].current_user);

  const parsed = new URL(url);
  const directHost = parsed.hostname;                                  // ep-xxx.c-2....
  const poolerHost = directHost.replace(/^([^.]+)\./, '$1-pooler.');   // ep-xxx-pooler.c-2....
  const dbName = parsed.pathname.replace(/^\//, '') || 'neondb';

  const creds: Record<string, string> = {};
  for (const role of ['app_rls', 'app_platform']) {
    const pw = genPassword();
    // Password cannot be parameterized in ALTER ROLE; alphabet above is strictly
    // alphanumeric so embedding it in the statement is safe.
    await admin.query(`ALTER ROLE ${role} WITH LOGIN PASSWORD '${pw}'`);
    creds[role] = pw;
    console.log(`password set for ${role}`);
  }
  await admin.end();

  console.log('\nverifying real logins against the pooler endpoint the app uses...');
  for (const role of ['app_rls', 'app_platform']) {
    const testUrl = `postgresql://${role}:${creds[role]}@${poolerHost}/${dbName}?sslmode=require`;
    const t = new pg.Client({ connectionString: testUrl, ssl: { rejectUnauthorized: false } });
    try {
      await t.connect();
      const r = await t.query('select current_user');
      console.log(`  LOGIN OK as ${r.rows[0].current_user}`);
      await t.end();
    } catch (e) {
      console.error(`  LOGIN FAILED as ${role}: ${(e as Error).message}`);
      process.exit(1);
    }
  }

  console.log('\n================================================================');
  console.log('Paste these into Render (Environment tab), replacing the existing');
  console.log('values, then save. Keep DATABASE_MIGRATION_URL exactly as it is.');
  console.log('================================================================\n');
  console.log(`DATABASE_URL=postgresql://app_rls:${creds['app_rls']}@${poolerHost}/${dbName}?sslmode=require`);
  console.log();
  console.log(`PLATFORM_DATABASE_URL=postgresql://app_platform:${creds['app_platform']}@${poolerHost}/${dbName}?sslmode=require`);
  console.log();
}
await main();
