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
npm ci
npm run check
npm test
npm run verify:no-production-demo-artifacts
npm run verify:prisma-drift

if [[ "${CLEAN_CLONE_RUN_DATABASE_GATES:-false}" == "true" ]]; then
  npm run rls:verify
  NODE_ENV=test RLS_DISPOSABLE_DB_ACK=CREATE_AND_DROP_LOCAL_RLS_TEST_DATABASE npm run test:rls:behavior
  NODE_ENV=test RELEASE_DB_LIFECYCLE_ACK=CREATE_DROP_LOCAL_RELEASE_TEST_DATABASES npm run verify:db-lifecycle
fi

if [[ "${CLEAN_CLONE_RUN_BROWSER:-false}" == "true" ]]; then
  npm run test:e2e
fi

if [[ -n "$(git status --porcelain=v1)" ]]; then
  echo "Clean-clone verification mutated tracked files:" >&2
  git status --short >&2
  exit 1
fi

echo "Clean-clone reproduction PASS at $actual_commit"
