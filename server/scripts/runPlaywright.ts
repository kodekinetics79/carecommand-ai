import 'dotenv/config';

import { spawn } from 'node:child_process';
import { ensurePlatformTestDatabaseUrl } from '../test/helpers/platformTestDatabase';
import { buildPlaywrightEnvironment } from './playwrightEnvironment';

const platformUrl = await ensurePlatformTestDatabaseUrl();
const playwrightEnv = buildPlaywrightEnvironment({ ...process.env, PLATFORM_DATABASE_URL: platformUrl });
const child = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['playwright', 'test', ...process.argv.slice(2)], {
  env: playwrightEnv,
  stdio: 'inherit',
});

child.once('error', (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  if (signal) console.error(`Playwright terminated by ${signal}.`);
  process.exitCode = code ?? 1;
});
