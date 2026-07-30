import { spawn } from 'node:child_process';

function run(script: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', script], { stdio: 'inherit', env: process.env });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${script} exited ${code ?? 'without a code'}`)));
  });
}

await run('prisma/seedSynthetic.ts');
await run('server/scripts/benchmarkSyntheticPilot.ts');
