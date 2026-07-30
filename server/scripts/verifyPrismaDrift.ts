import { spawnSync } from 'node:child_process';

import { TENANT_INTEGRITY_MANIFEST } from '../modules/platform/prismaDriftGuard';

const result = spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['prisma', 'migrate', 'diff', '--from-config-datasource', '--to-schema', 'prisma/schema.prisma', '--script'],
  { encoding: 'utf8' },
);

if (result.status !== 0) {
  process.stderr.write(result.stderr);
  throw new Error(`Prisma migrate diff failed with exit code ${result.status ?? 'unknown'}.`);
}

const statements = result.stdout
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n')
  .split(';')
  .map((statement) => statement.trim())
  .filter(Boolean);

const foreignKeys = new Set<string>();
const indexes = new Set<string>();
const unexpected: string[] = [];

for (const statement of statements) {
  const foreignKey = statement.match(
    /^ALTER TABLE "[^"]+" DROP CONSTRAINT "(rls_fk_[0-9a-f]+)"$/,
  );
  if (foreignKey) {
    foreignKeys.add(foreignKey[1]);
    continue;
  }

  const index = statement.match(/^DROP INDEX "(rls_(?:ix|uq)_[0-9a-f]+)"$/);
  if (index) {
    indexes.add(index[1]);
    continue;
  }

  unexpected.push(statement);
}

const expected = TENANT_INTEGRITY_MANIFEST;
if (foreignKeys.size !== expected.compositeForeignKeys) {
  unexpected.push(
    `managed composite FK count ${foreignKeys.size} != ${expected.compositeForeignKeys}`,
  );
}
if (indexes.size !== expected.prismaDiffManagedIndexes) {
  unexpected.push(
    `migration-only index diff count ${indexes.size} != ${expected.prismaDiffManagedIndexes}`,
  );
}

if (unexpected.length > 0) {
  console.error('Unexpected Prisma drift detected:');
  for (const item of unexpected) console.error(`- ${item}`);
  process.exitCode = 1;
} else {
  console.log(
    `Prisma drift guard PASS: only ${foreignKeys.size} migration-owned composite FKs and ${indexes.size} migration-owned indexes differ from the Prisma schema.`,
  );
}
