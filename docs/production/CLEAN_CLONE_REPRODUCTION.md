# Clean-Clone Reproduction

This gate proves that the release is reproducible from committed content and
the lockfile, without relying on ignored workspace artifacts. It does not copy
`.env`, `.vercel`, `node_modules`, build output, or local test evidence.

## Automated verifier

Run from the candidate commit with a local PostgreSQL owner URL exported. The
verifier refuses to start without it, and its disposable-database wrapper
rejects non-local database hosts:

```bash
CLEAN_CLONE_DATABASE_MIGRATION_URL='postgresql://LOCAL_OWNER@localhost:55432/carecommand' \
npm run verify:clean-clone
```

For the complete release gate:

```bash
CLEAN_CLONE_DATABASE_MIGRATION_URL='postgresql://LOCAL_OWNER@localhost:55432/carecommand' \
CLEAN_CLONE_RUN_DATABASE_GATES=true CLEAN_CLONE_RUN_BROWSER=true \
npm run verify:clean-clone
```

The script creates a random temporary directory, clones the exact current
commit using `--no-hardlinks`, installs exclusively through `npm ci`, and runs:

- Prisma client generation from the committed schema before typechecking
- Prisma validation, API and frontend typechecking, lint, and production build
- the complete Vitest suite on a fresh disposable database
- the production demo/dead-artifact scanner
- Prisma drift verification on a separate fresh disposable database
- optionally, restricted-role RLS behavior and backup/restore lifecycle gates
- optionally, the real-backend desktop/mobile Playwright suite

It also rejects a commit mismatch or a tracked-file mutation. The temporary
clone is removed on exit. Credentials remain inherited process environment and
are neither copied nor printed by the verifier.

## Evidence record

Record the UTC execution time, commit SHA, Node/npm versions, selected optional
gates, test totals, and final status in `docs/testing/TEST_EXECUTION_EVIDENCE.md`.
Do not record connection strings, tokens, patient identifiers, or raw logs with
sensitive payloads.
