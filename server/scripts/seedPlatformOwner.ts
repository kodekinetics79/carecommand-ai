import 'dotenv/config';
import { ensurePlatformOwnerSeed } from '../lib/platformAuth';
import { env } from '../config/env';

/**
 * Creates the first PLATFORM_OWNER from PLATFORM_OWNER_EMAIL / _NAME / _PASSWORD.
 *
 * ensurePlatformOwnerSeed() is the intended production path for this, but nothing
 * in the boot sequence calls it, and the only other caller
 * (modules/platform/platformAdmin.verify.ts) overwrites the three env vars with
 * its own throwaway test values. So on a fresh database there is no supported way
 * to create the first operator, and /v1/platform/auth/login has no bootstrap
 * route -- every credential returns invalid_credentials. This script closes that
 * gap without weakening the "no weak default in production" rule: it seeds only
 * from the environment, and only when the environment is explicitly set.
 *
 * Idempotent: a second run finds the existing user and reports already_exists
 * rather than resetting the password. To rotate a forgotten password, delete the
 * PlatformUser row (or change it through the console) rather than re-running.
 *
 * Writes through platformDb, so PLATFORM_DATABASE_URL must be configured and
 * authenticate as app_platform.
 *
 *   PLATFORM_OWNER_EMAIL=you@example.com \
 *   PLATFORM_OWNER_PASSWORD='...' \
 *   PLATFORM_DATABASE_URL='postgresql://app_platform:...' \
 *     npx tsx server/scripts/seedPlatformOwner.ts
 */
async function main() {
  if (!env.PLATFORM_DATABASE_URL) {
    console.error('PLATFORM_DATABASE_URL is not set; the platform plane has no connection to seed into.');
    process.exitCode = 1;
    return;
  }
  if (!env.PLATFORM_OWNER_EMAIL || !env.PLATFORM_OWNER_PASSWORD) {
    console.error('Set PLATFORM_OWNER_EMAIL and PLATFORM_OWNER_PASSWORD. There is deliberately no default owner.');
    process.exitCode = 1;
    return;
  }

  const result = await ensurePlatformOwnerSeed();

  if (result.seeded) {
    console.log(`seeded PLATFORM_OWNER ${env.PLATFORM_OWNER_EMAIL}`);
    console.log('First sign-in returns mfaSetupRequired: TOTP enrolment is mandatory and cannot be skipped.');
    return;
  }

  if (result.reason === 'already_exists') {
    console.log(`PLATFORM_OWNER ${env.PLATFORM_OWNER_EMAIL} already exists; nothing changed.`);
    return;
  }

  console.error(`platform owner not seeded (${result.reason}).`);
  process.exitCode = 1;
}

await main();
