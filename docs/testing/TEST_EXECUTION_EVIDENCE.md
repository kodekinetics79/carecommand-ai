# Test Execution Evidence

Date: 2026-07-30  
Environment: local macOS workspace; Node 24; PostgreSQL 17 and Redis 7 in local containers; synthetic data only. No production system or real PHI was accessed.

This file supersedes earlier same-day test-count snapshots. All results below are local synthetic evidence and are reproduced from the committed release-candidate state before the annotated local tag.

## Current completed checkpoints

| Command / probe | Result |
|---|---|
| `npm run check` | PASS: Prisma validation, API TypeScript, ESLint, application TypeScript, and Vite production build |
| `npm run verify:no-production-demo-artifacts` | PASS: production source/configuration/server/Prisma/build scan |
| `npm audit --omit=dev --audit-level=high` | PASS: zero vulnerabilities |
| `npm audit signatures` | PASS: 576 package signatures and 194 attestations |
| `npm run verify:prisma-drift` | PASS at the 71-migration M09-F02 checkpoint: no unexpected destructive drift; 121 migration-owned composite FKs and 143 migration-owned indexes recognized |
| `npm run rls:verify` | PASS at the 71-migration M09-F02 checkpoint: 127 application tables, 119 protected, 8 exemptions, 522 policies, ENABLE/FORCE 119/119; safe runtime role |
| `RLS_DISPOSABLE_DB_ACK=CREATE_AND_DROP_LOCAL_RLS_TEST_DATABASE npm run test:rls:behavior` | PASS at the 71-migration M09-F02 checkpoint: 1 file, 962/962 assertions; E.164 fixture generation corrected so the suite executes rather than skips at setup |
| M09-F02 immutable provider-agent readiness candidate | PASS: 6 focused files, 60/60; all receptionist 15 files, 115/115; exact Retell GET/auth/tag and outbound request/response ID/version contract, immediate mismatch stop, durable INVALID/PAUSED critical-signal circuit under stop success/failure and injected StaffTask outage, no second dial, V0, unsafe-state matrix, tenant/clinic/branch database scope, durable drift evidence, activation/dial freshness, concurrency and audit rollback. Independent re-review pending |
| `NODE_ENV=test RELEASE_DB_LIFECYCLE_ACK=CREATE_DROP_LOCAL_RELEASE_TEST_DATABASES npm run verify:db-lifecycle` | PASS at current 69-migration checkpoint: deterministic seed; 2 tenants, 3 clinics, 12 users, 24 patients, 48 appointments, 16 calls, 12 payments, 12 documents, 24 notifications, 48 audits; 119 forced-RLS tables; 120 tenant FKs |
| `npm test` repeated twice | PASS: 78 files, 469/469 tests on each consecutive final-tree run |
| `npm run test:e2e` | PASS: 10/10 real-backend Chromium tests across desktop and Pixel 7 |
| Independent QA focused challenge | PASS runtime review: 22 files, 145/145 tests; API typecheck, lint, production audit, and diff check pass |
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
