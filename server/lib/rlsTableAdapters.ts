import { readFileSync } from 'node:fs';
import { TENANT_APPEND_ONLY_TABLES } from './rlsRuntimeManifest';

export type RlsBehaviorMode = 'MUTABLE' | 'APPEND_ONLY' | 'READ_ONLY';

export type RlsTableAdapter = {
  table: string;
  ownershipColumn: 'id' | 'tenantId';
  mode: RlsBehaviorMode;
};

function schemaProtectedTables(): string[] {
  const schema = readFileSync(new URL('../../prisma/schema.prisma', import.meta.url), 'utf8');
  const tables = ['Tenant'];
  for (const match of schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const [, modelName, body] = match;
    const tenantField = body.match(/^\s*tenantId\s+String(\?)?\s+[^\n]*@db\.Uuid/m);
    if (!tenantField) continue;
    if (tenantField[1] && modelName !== 'IdempotencyKey') continue;
    if (modelName === 'PlatformAuditEvent') continue;
    tables.push(body.match(/^\s*@@map\("([^"]+)"\)/m)?.[1] ?? modelName);
  }
  return [...new Set(tables)].sort();
}

export const RLS_TABLE_ADAPTERS: readonly RlsTableAdapter[] = schemaProtectedTables().map(table => ({
  table,
  ownershipColumn: table === 'Tenant' ? 'id' : 'tenantId',
  mode: table === 'Tenant' ? 'READ_ONLY' : TENANT_APPEND_ONLY_TABLES.has(table) ? 'APPEND_ONLY' : 'MUTABLE',
}));
