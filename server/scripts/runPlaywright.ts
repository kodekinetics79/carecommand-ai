import 'dotenv/config';

import { spawn } from 'node:child_process';
import { ensurePlatformTestDatabaseUrl } from '../test/helpers/platformTestDatabase';

const platformUrl = await ensurePlatformTestDatabaseUrl();
const child = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['playwright', 'test', ...process.argv.slice(2)], {
  env: { ...process.env, PLATFORM_DATABASE_URL: platformUrl },
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
