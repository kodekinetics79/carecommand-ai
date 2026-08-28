import 'dotenv/config';
import { db } from '../lib/db';
import { checkRlsRuntimeRole, rlsRoleMessage } from '../lib/rlsGuard';

async function main() {
  const status = await checkRlsRuntimeRole();
  console.log(`runtime role: ${status.role} (super=${status.isSuperuser}, bypassrls=${status.hasBypassRls})`);

  if (status.checkFailed) {
    console.error('RLS runtime-role verification could not be completed.');
    process.exitCode = 1;
    return;
  }

  if (status.bypassesRls) {
    console.error(rlsRoleMessage(status));
    process.exitCode = 1;
    return;
  }

  console.log('RLS runtime-role verification passed: the connected role cannot bypass row-level security.');
}

await main().finally(() => db.$disconnect());
