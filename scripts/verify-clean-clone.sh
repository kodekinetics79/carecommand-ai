#!/usr/bin/env bash
set -euo pipefail

repository_root="$(git rev-parse --show-toplevel)"
expected_commit="$(git -C "$repository_root" rev-parse HEAD)"
temporary_root="$(mktemp -d "${TMPDIR:-/tmp}/carecommand-clean-clone.XXXXXX")"
checkout="$temporary_root/checkout"

cleanup() {
  rm -rf "$temporary_root"
}
trap cleanup EXIT

git clone --quiet --local --no-hardlinks "$repository_root" "$checkout"
actual_commit="$(git -C "$checkout" rev-parse HEAD)"
if [[ "$actual_commit" != "$expected_commit" ]]; then
  echo "Clean-clone commit mismatch: expected $expected_commit, got $actual_commit" >&2
  exit 1
fi

cd "$checkout"
: "${CLEAN_CLONE_DATABASE_MIGRATION_URL:?Set CLEAN_CLONE_DATABASE_MIGRATION_URL to a local PostgreSQL owner URL}"
export DATABASE_MIGRATION_URL="$CLEAN_CLONE_DATABASE_MIGRATION_URL"
export DATABASE_URL="$CLEAN_CLONE_DATABASE_MIGRATION_URL"
npm ci
npm run db:generate
npm run check
RLS_DISPOSABLE_DB_ACK=CREATE_AND_DROP_LOCAL_RLS_TEST_DATABASE \
  npx tsx server/scripts/withDisposableRlsDatabase.ts -- npm test
npm run verify:no-production-demo-artifacts
RLS_DISPOSABLE_DB_ACK=CREATE_AND_DROP_LOCAL_RLS_TEST_DATABASE \
  npx tsx server/scripts/withDisposableRlsDatabase.ts -- npm run verify:prisma-drift

if [[ "${CLEAN_CLONE_RUN_DATABASE_GATES:-false}" == "true" ]]; then
  npm run rls:verify
  NODE_ENV=test RLS_DISPOSABLE_DB_ACK=CREATE_AND_DROP_LOCAL_RLS_TEST_DATABASE npm run test:rls:behavior
  NODE_ENV=test RELEASE_DB_LIFECYCLE_ACK=CREATE_DROP_LOCAL_RELEASE_TEST_DATABASES npm run verify:db-lifecycle
fi

if [[ "${CLEAN_CLONE_RUN_BROWSER:-false}" == "true" ]]; then
  RLS_DISPOSABLE_DB_ACK=CREATE_AND_DROP_LOCAL_RLS_TEST_DATABASE npm run test:e2e
fi

if [[ -n "$(git status --porcelain=v1)" ]]; then
  echo "Clean-clone verification mutated tracked files:" >&2
  git status --short >&2
  exit 1
fi

echo "Clean-clone reproduction PASS at $actual_commit"
