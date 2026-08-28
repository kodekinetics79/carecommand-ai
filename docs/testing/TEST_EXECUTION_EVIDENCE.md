# Test Execution Evidence

## 2026-08-10 final eligibility recovery closure — final evidence

Environment: branch `fix/eligibility-reconciliation-final-20260810`, guarded disposable PostgreSQL databases, uniquely namespaced local Redis, synthetic fixtures, and mock/disabled providers. No production, real payer, live provider request, real PHI, claim, payment, push, deployment, or new worktree was used.

Implementation commits: `9d240de` (durable reconciliation, worker registration, row fencing, clinic workflow, migration), `78723fd` (SDET recovery/browser/namespace coverage), `2470b2c` (scheduler contract), `3f8f238` and `ce1b9a4` (Playwright lint/fixture corrections). Final migration count: 88; latest `20260810160000_eligibility_reconciliation_workflow`.

| Gate | Result |
|---|---|
| Baseline delete-protection manifest | Reproduced FAIL: 1 failed/9 passed; fixed result PASS 10/10 with lifecycle behavior reviewed |
| Consolidated eligibility/reconciliation suite | PASS: 11 files, 103/103 tests; 10.50 s Vitest, 13.00 s wall |
| Scoped payment/appointment/AI-queue preservation regression | PASS: 10 files, 93/93 tests; 31.11 s |
| Reconciliation concurrency/performance | Correctness PASS: 101 rows produced 101 tasks and 101 audits, zero provider lookups/errors/residual row leases; independent review found duplicate page scanning across two instances (P2) |
| Staff real-backend Playwright | PASS: 2/2; desktop Chromium 2.2 s, Pixel 7 2.4 s, 14.4 s total |
| Full RLS behavior | PASS: 1002/1002; 6.79 s |
| RLS catalog/runtime role | PASS: 132 application tables, 124 protected, 526 policies; restricted runtime role |
| Prisma drift | PASS: 123 migration-owned composite FKs and 135 migration-owned indexes |
| Zero-to-head migration | PASS: all 88 migrations applied in a guarded disposable database |
| Authoritative upgrade | PASS: genuine 87→88; only `20260810160000_eligibility_reconciliation_workflow` applied; new states, forced RLS, and task FK verified |
| Prisma validation/typecheck/lint/build | PASS; `npm run check` and production build completed successfully |
| Full normal disposable regression | PASS: 118 files, 1,967/1,967 tests; 168.71 s Vitest, 171.11 s wall; no timeout override |
| Independent Eligibility/RCM review | **REJECTED**: four P1 truthfulness/continuity defects and four P2 capability/operability gaps remain |

Primary logs: `/tmp/carecommand-elig-recon-cycle2-combined-9d240de.log` (SHA-256 `75c5983f0fcdbeea91796c79e30bdcb6481906bcb9bde6c5c781d5e37a61a69e`), `/tmp/carecommand-eligibility-final-playwright-rerun.log` (`0acd8af9402994c8fa8d91422a329c7312e45b8da9dc06335af3e2b376a8a6f6`), `/tmp/carecommand-eligibility-final-scoped-regression.log` (`3365becce35ecddc3282b9a15cc57f6e6161d139971f6eea1c58cb75fc52330b`), `/tmp/carecommand-eligibility-final-rls.log` (`bcdf291f88aa25e0eedf225654cc2353cd7007a5dea7e5cffbf06b6e42d48fae`), `/tmp/carecommand-eligibility-final-drift.log` (`69e307d70a575d13a510f97feab37818228fae13162c57896269ada63ece00b4`), and `/tmp/carecommand-eligibility-final-full-regression.log` (`52c0811074dc0374cd8a601e0122c02fdbc03eb0b4d579f674093f0f7d805d23`).

The independent reviewer rejected release closure because: the reconciliation UI lacks payer/service/date/request/attempt/audit context needed for its attestation; manual evidence is mislabeled in visible history; unknown nullable benefits can render as `$0`/`null%`; and a successfully persisted provider result followed by lost HTTP/browser identity can create a second execution. P2 findings are duplicate multi-instance page scans, an unimplemented safe-lookup adapter path, incomplete proof of the required close-before-delete Redis cleanup sequence, and production scheduler numeric defaults that are bounded but not explicit. Therefore the final verdict is **NO-GO**. No closure tag was created.

## 2026-08-10 final eligibility recovery closure — starting state

- Starting branch: `fix/tier1-p1-authoritative-20260810`
- Starting HEAD: `165c903d591cc500efae55e770ae0b5933b64d9f`
- Focused closure branch: `fix/eligibility-reconciliation-final-20260810`
- Starting migration count: 87; latest `20260810090000_eligibility_execution_integrity`
- Starting worktree: clean
- Recovery bundle: `/Users/zackkhan/Desktop/carecommand-recovery/carecommand-all-refs-tier1-p1-final-20260810.bundle`; verified before branch creation
- Known baseline regression: `server/test/rlsGuard.test.ts:82` expects the shared delete-protection manifest to classify `EligibilityExecution`

This closure is limited to eligibility reconciliation, server-authoritative action continuity, the staff reconciliation workflow, delete-protection classification, and directly related distributed-scan/Redis test hygiene. No Tier 2, live provider, production, donor migration, worktree, push, or deployment is authorized.

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

## 2026-08-11 provider-stop race closure

Environment: `fix/release-hardening-retell-eligibility-20260811`, guarded disposable PostgreSQL databases, isolated Redis namespace, installed Google Chrome, and synthetic data only. No live Retell call, production deployment, production migration, phone number, credential, PHI, recording, or transcript was used.

| Gate | Result |
|---|---|
| Deterministic provider-stop matrix | PASS: 11/11; confirmed stop remains `OUTBOUND_STOPPED`, no-evidence failures remain `RECONCILIATION_REQUIRED`, stale/cross-identity attempts are fenced, and matching open reconciliation artifacts are resolved exactly once |
| Exact concurrent race repetition | PASS: 20/20 consecutive runs using deterministic barriers and the disposable database wrapper |
| Complete outbound-target suite | PASS: 66/66 |
| Adjacent receptionist/queue suite | PASS: 8 files, 54/54 |
| `npm run check` | PASS: Prisma validation, API typecheck, lint, client typecheck, and production build |
| `npm run verify:no-production-demo-artifacts` | PASS |
| Full disposable `npm test` | PASS: 120/120 files, 1,986/1,986 tests, default timeouts |
| Full RLS behavioral suite | PASS: 1,002/1,002 |
| RLS catalog/runtime role | PASS: 132 application tables, 124 protected, 526 policies, ENABLE/FORCE 124/124; restricted runtime role |
| Prisma drift | PASS: 123 migration-owned composite FKs and 135 migration-owned indexes |
| Zero-to-head migration | PASS: all 89 migrations applied to the disposable E2E database |
| Installed Chrome E2E | PASS for every authorized scenario: 14/14 across desktop Chrome and Pixel 7; real local frontend/backend; live-call case gated off once per project because authorization and provider credentials were absent |
| Dependency audits | PASS: production and complete dependency trees report zero vulnerabilities after compatible patch updates |
| `git diff --check` | PASS |

Evidence logs: `/tmp/provider-stop-repeat20-summary.log` SHA-256 `4c64f101d5652e5329b101f6eedb240ca3a3e0ea9f1d235dea52473cf8a48e48`; `/tmp/provider-stop-full-regression-final.log` SHA-256 `d592f3649a99fcda96d076620c459e2e40e8565e0b758a9acce5793f057b6d4d`; `/tmp/provider-stop-chrome.log` SHA-256 `183aa5897436302358b7fe03e3422ad92abece4da5100df2692ad8897b4f9c80`. The installed-Chrome result is not live-call evidence.
