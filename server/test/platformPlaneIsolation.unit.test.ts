import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const run = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, '../..');

// The platform plane is a vendor-only console. The clinic-facing API — patients,
// scheduling, check-in, the receptionist — never touches it. It used to build its
// Prisma client at MODULE SCOPE, so an unset PLATFORM_DATABASE_URL threw while the
// module was still being imported, and app.ts imports the platform routes on every
// boot. One missing variable therefore took the entire product down for every
// clinic: a real production deploy died at startup with "PLATFORM_DATABASE_URL is
// required" while nothing a clinic actually uses was broken.
//
// Two properties, and the fix is only correct if BOTH hold: importing must not
// throw, and using it without configuration must still refuse absolutely.
//
// This runs in a child process on purpose. The variable cannot be unset in-process:
// the suite's own setup assigns it, and dotenv/config restores it from .env on
// every vi.resetModules(). Only a fresh process pointed at an env file without the
// line reproduces the deployed condition, which is exactly the condition that broke.
async function importPlatformDbWithoutTheVariable() {
  const dir = mkdtempSync(join(tmpdir(), 'platform-plane-'));
  try {
    const envFile = join(dir, 'env');
    const stripped = readFileSync(join(repoRoot, '.env'), 'utf8')
      .split('\n').filter(line => !line.startsWith('PLATFORM_DATABASE_URL')).join('\n');
    writeFileSync(envFile, stripped);

    const probe = join(dir, 'probe.mjs');
    writeFileSync(probe, [
      `const m = await import(${JSON.stringify(join(repoRoot, 'server/lib/platformDb.ts'))});`,
      `console.log('CONFIGURED=' + m.platformDatabaseConfigured());`,
      `try { void m.platformDb.platformUser; console.log('USE=no-throw'); }`,
      `catch (e) { console.log('USE=' + e.message); }`,
    ].join('\n'));

    const env = { ...process.env, DOTENV_CONFIG_PATH: envFile };
    delete env.PLATFORM_DATABASE_URL;
    const { stdout } = await run('npx', ['tsx', probe], { cwd: repoRoot, env, timeout: 120_000 });
    return stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('platform plane isolation', () => {
  it('imports without PLATFORM_DATABASE_URL instead of killing the process at boot', async () => {
    // Reaching this output at all is the assertion: a module-scope throw makes the
    // child exit non-zero and execFile reject before anything is printed.
    const out = await importPlatformDbWithoutTheVariable();
    expect(out).toContain('CONFIGURED=false');
  }, 180_000);

  it('still refuses to serve the platform plane, deferred to first use', async () => {
    const out = await importPlatformDbWithoutTheVariable();
    expect(out).toContain('PLATFORM_DATABASE_URL is required');
    expect(out).toContain('never fall back to the tenant runtime role');
    expect(out).not.toContain('USE=no-throw');
  }, 180_000);
});
