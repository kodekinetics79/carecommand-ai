#!/usr/bin/env bash
set -euo pipefail

required_ack="APPLY_REVIEWED_CARECOMMAND_MIGRATIONS"
if [[ "${RELEASE_MIGRATION_ACK:-}" != "$required_ack" ]]; then
  echo "Refusing migration: set RELEASE_MIGRATION_ACK=$required_ack after release approval." >&2
  exit 1
fi
if [[ -z "${DATABASE_MIGRATION_URL:-}" ]]; then
  echo "Refusing migration: DATABASE_MIGRATION_URL is required for the isolated release job." >&2
  exit 1
fi
if [[ -z "${DATABASE_MIGRATION_PRINCIPAL:-}" ]]; then
  echo "Refusing migration: DATABASE_MIGRATION_PRINCIPAL is required for the isolated release job." >&2
  exit 1
fi

node --input-type=module <<'NODE'
  const connections = [
    ['migration', process.env.DATABASE_MIGRATION_URL],
    ['tenant', process.env.DATABASE_URL],
    ['platform', process.env.PLATFORM_DATABASE_URL],
  ];
  const users = {};
  for (const [name, raw] of connections) {
    if (!raw) continue;
    let url;
    try { url = new URL(raw); } catch { throw new Error(`Refusing migration: ${name} database URL is invalid.`); }
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error(`Refusing migration: ${name} database URL must use PostgreSQL.`);
    users[name] = decodeURIComponent(url.username || '');
    if (!users[name]) throw new Error(`Refusing migration: ${name} database principal is missing.`);
  }
  if (['app_rls', 'app_platform'].includes(users.migration)) {
    throw new Error('Refusing migration: runtime principals app_rls/app_platform cannot own schema migrations.');
  }
  if (users.migration !== process.env.DATABASE_MIGRATION_PRINCIPAL) {
    throw new Error('Refusing migration: URL principal does not match DATABASE_MIGRATION_PRINCIPAL.');
  }
  if ((users.tenant && users.migration === users.tenant) || (users.platform && users.migration === users.platform)) {
    throw new Error('Refusing migration: schema-owner and runtime database principals must be distinct.');
  }
NODE

DATABASE_URL="$DATABASE_MIGRATION_URL" npx prisma migrate deploy
