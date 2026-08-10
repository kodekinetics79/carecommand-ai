# Test Execution Evidence

## 2026-08-10 authoritative Tier 1 P1 closure (final)

Environment: authoritative branch `fix/tier1-p1-authoritative-20260810`, local PostgreSQL/Redis, guarded disposable databases, synthetic fixtures, mock/disabled providers. No live call, payer request, payment, claim, production data, or PHI.

| Gate | Result |
|---|---|
| `npm run check` | PASS: Prisma validation, API typecheck, ESLint, client typecheck, production build |
| Focused Tier 1 preservation regression | PASS: 12 files, 115/115 tests |
| AI/queue focused final run | PASS: 6 files, 57/57; independent final probes 7/7 plus overlapping-scanner probe |
| Eligibility focused final run | PASS: 61/61; execution 12/12; frontend/env 29/29 |
| Full RLS behavioral suite | PASS: 1002/1002; corrective eligibility evidence later reported 1007/1007 |
| RLS catalog/runtime role | PASS: 132 application tables, 124 protected, 526 policies; restricted runtime role |
| Prisma drift | PASS: 123 migration-owned composite FKs, 135 migration-owned indexes |
| Zero-to-head migration | PASS: all 87 migrations; RLS verification passed; disposable database dropped |
| Authoritative upgrade | PASS: genuine 86→87; only `20260810090000_eligibility_execution_integrity` applied; RLS/FORCE and four policies verified |
| Playwright portal-insurance smoke | PASS: 2/2, desktop Chromium 4.7 s and Pixel 7 4.4 s; 57.0 s total |
| Chrome manual observation | PASS, scoped: real Chrome rendered login without console warnings; protected eligibility deep link redirected to login; absent API produced visible `Failed to fetch` on synthetic sign-in |
| Full normal disposable regression | **FAIL**: 111/112 files, 1,945/1,946 tests; `server/test/rlsGuard.test.ts:82` manifest mismatch for `EligibilityExecution`; no timeout override; 240.25 s wall |
| `git diff --check` | PASS before evidence reconciliation |

Full-regression log: `/tmp/carecommand-full-regression-1a37610-20260810.log`, SHA-256 `65932de380a455ee5a749461bcba0f974c9477a66edb1073720f284533e39923`. Playwright log: `/tmp/carecommand-eligibility-playwright-1a37610.log`, SHA-256 `907022ce006215dc12992cd610e381d95d95b1867c39dfbe5c87c4c36dfe08b6`.

Independent distributed-systems review: PASS for internal scope; actual emergency audio/event ordering remains external evidence only. Independent eligibility/RCM review: REJECTED. Stale `PROVIDER_IN_FLIGHT` executions have no production scanner and are excluded from operator listing; `manual_evidence_pending` is returned without a durable state/audit/task; in-memory browser keys do not survive reload after an ambiguous result. The portal Playwright spec does not cover staff eligibility checks, effective-date rendering, or reconciliation UI.

## 2026-08-10 Tier 1 simulation checkpoint (current)

This section supersedes older snapshots for the current dirty tree. Environment: local macOS, Node 24, PostgreSQL 17 and Redis 7 containers, synthetic data only; no production/PHI/provider transaction.

| Command / probe | Result |
|---|---|
| Zero-to-head migrations plus `TIER1` seed through disposable wrapper | PASS: 86 migrations; 4 tenants, 8 clinics, 40 users, 1,000 patients, 1,600 appointments, 400 calls, 250 payments, 500 documents, 1,000 notifications, 2,000 audits; database dropped |
| `npx vitest run prisma/synthetic/...` focused catalog suite | PASS: 3/3 |
| Core clinic disposable regression | PASS: 5 files, 36/36 tests, 77.67 s |
| Finance post-fix regression | PASS: 3 files, 42/42 tests, 70.09 s |
| Worker real Postgres/Redis regression | PASS: 4/4 tests |
| Autopilot route/recovery regression | PASS: 11/11 only with explicit 30 s timeout; 101-row recovery took about 17.5 s |
| Voice consent/DNC disposable race suite | PASS: 13/13 |
| `server/test/appContentIntegrity.unit.test.ts` | PASS: 14/14 |
| Branch-scope focused foundation test | PASS: 1/1 selected test |
| `npx tsc -p tsconfig.app.json --noEmit` | PASS |
| `npm run verify:no-production-demo-artifacts` | PASS |
| Real local Chrome desktop/mobile scenarios | Completed; three defects reproduced and corrected, with corrected behavior observed |
| Full disposable `npm test` | FAIL: 106 files passed / 3 timed out; 1,899 tests passed / 3 timed out (1,902 total), 1,039.75 s |
| Focused rerun of the three timed-out files with 30 s ceiling | PASS: 3 files, 60/60 tests, 125.50 s; demonstrates functional pass but default performance gate failure |
| `npm run check` | FAIL at lint after Prisma validation and API typecheck passed: two pre-existing `no-explicit-any` errors in untracked `.playwright-no-server.config.ts`; build stage not reached |

Chrome used the real local API and web app. Live telephony, real payments/claims, object upload, and email delivery were not exercised. Full logs are retained at `/tmp/carecommand-wave-full-test.log` for this local session only. The full-regression timeouts were `autopilotRecovery.integration` (101-row page), `endpointAuthorization.integration`, and `receptionistBooking.integration`; none failed an assertion under the focused 30-second rerun.

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
