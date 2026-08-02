# Test Execution Evidence

Date: 2026-07-31
Environment: local macOS workspace; Node 24; PostgreSQL 17 and Redis 7 in local containers; synthetic data only. No production system or real PHI was accessed.

The 2026-07-31 table below supersedes earlier test-count snapshots. All results
are local synthetic evidence. No production system or real PHI was accessed,
and no tag, push, or deployment is represented here.

## Current completed checkpoints

| Command / probe | Result |
|---|---|
| `npm run check` | PASS: Prisma validation, API TypeScript, ESLint, application TypeScript, and Vite production build |
| `npm run verify:no-production-demo-artifacts` | PASS: production source/configuration/server/Prisma/build scan |
| `npm audit --omit=dev --audit-level=moderate` | PASS: zero vulnerabilities |
| `npm audit signatures` | PASS: 575 package signatures and 194 attestations |
| Fresh-database `npm run verify:prisma-drift` | PASS: only 123 migration-owned composite FKs and 138 migration-owned indexes differ |
| `npm run rls:verify` | PASS: 131 application tables, 123 protected, 8 exemptions, 522 policies, ENABLE/FORCE 123/123; safe runtime role |
| `RLS_DISPOSABLE_DB_ACK=CREATE_AND_DROP_LOCAL_RLS_TEST_DATABASE npm run test:rls:behavior` | PASS: 1 file, 994/994 assertions |
| `NODE_ENV=test RELEASE_DB_LIFECYCLE_ACK=CREATE_DROP_LOCAL_RELEASE_TEST_DATABASES npm run verify:db-lifecycle` | PASS: all 86 migrations; deterministic seed and backup/restore parity; 123 forced-RLS tables and 123 tenant FKs |
| Full disposable `npm test` | PASS: 106 files, 1,878/1,878 tests |
| `npm run test:e2e` | PASS: 10/10 real-backend Chromium tests across desktop and Pixel 7 |
| Content SME and independent QA challenge | PASS: regulated content, autonomy, consent, revenue, eligibility, security-claim, localization and accessible-dialog findings closed; focused content suite 48/48 |
| Authentication security challenge | PASS: focused disposable auth suite 12/12, including reset atomicity, revocation, timing and concurrent lockout cases |
| Production engineering | PASS: 2 files, 32/32 tests; production artifact verifier passed |
| SBOM | CycloneDX 1.5, 629 components, generated at `/tmp/carecommand-ai-sbom.json` |
| Final RPM focused implementation/independent challenge | PASS: 7 files, 82/82 tests; server typecheck, focused lint, Prisma validate/drift, and independent QA acceptance pass |
| Final platform-auth independent challenge | PASS: 4 files, 19/19 tests; generic response/work and fail-closed store behavior accepted with zero P0/P1 |
| Mandatory audit durability | PASS: independent challenge accepts platform/auth/pilot, production role planes, payment terminal/concurrency/reconciliation, receptionist, and intake paths with P0=0/P1=0 |
| `git diff --check` | PASS at the latest integrated-code checkpoint |

## Deterministic profiles

| Profile | Tenants | Clinics | Users | Portal users | Patients | Appointments | Calls | Payments | Documents | Notifications | Audits |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| FUNCTIONAL | 2 | 3 | 12 | 2 | 24 | 48 | 16 | 12 | 12 | 24 | 48 |
| PILOT | 4 | 8 | 40 | 4 | 2,000 | 4,000 | 1,000 | 500 | 1,000 | 2,000 | 5,000 |
| EDGE | 5 | 6 | 20 | 5 | 40 | 60 | 40 | 24 | 24 | 40 | 80 |

The scenario catalog contains 51 scenarios, 39 executable scenarios, fixed seed `20260730`, and controlled clock `2026-07-15T14:00:00.000Z`.

## Pilot performance checkpoint

PILOT generated 4 tenants, 8 clinics, 40 users, 4 portal accounts, 2,000 patients, 4,000 appointments, 1,000 calls, 500 payment requests, 1,000 documents, 2,000 notifications, and 5,000 audits. All measured query maxima were below the local 750 ms regression limit; the slowest was audit search at 49.26 ms. This is local regression evidence, not a customer-capacity statement.

## G20 committed-state checkpoint

Logical attributed commits are recorded in `CHANGE_ATTRIBUTION.md`. The committed state repeats `npm run check`, `npm test`, `npm run test:e2e`, artifact/drift/RLS guards, dependency audit, and diff/status checks before local tag `rc/pilot-convergence-2026-07-30` is applied. No push or deployment is part of this checkpoint.

No passing mock/contract test is represented as evidence of a live Retell, Twilio, Stripe, Stedi, email, or device-provider transaction.
The in-app browser bootstrap was unavailable at this checkpoint (`sandboxPolicy` metadata failure before navigation), so the Studio UI is supported by typecheck/lint/build and API integration evidence, not a claimed live browser or Retell walkthrough.
