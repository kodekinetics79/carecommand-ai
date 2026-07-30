# Release Readiness Report

Date: 2026-07-30  
Scope: local repository and disposable local databases using synthetic data only.

This is the authoritative current checkpoint. Older dated entries in the evidence ledger are historical observations, not current defects.

## Three separate verdicts

| Decision | Current verdict | Basis |
|---|---|---|
| Internal engineering release candidate | GO | G1-G20 pass; logical attributed commits, committed-state verification, and the annotated local RC tag are complete |
| Supervised synthetic-data pilot | GO | Synthetic data only, accountable human supervision, rehearsed stop path, and no live external transactions |
| Production PHI or unattended autonomous receptionist | NO-GO | Live-provider, legal, clinical, privacy, security-operations, backup/restore, and organizational compliance evidence are external prerequisites |

No document in this repository is a HIPAA, SOC 2, or GDPR certification or legal opinion.

## Current engineering evidence

- Production artifact scanner passes source, configuration, Prisma, server, and built assets.
- The production dependency audit reports zero vulnerabilities at the configured high-severity gate; package signatures pass.
- The tenant and platform database planes use separate roles, clients, grants, and runtime context.
- The catalog contains 127 application tables: 119 protected and 8 explicit exemptions. All 119 protected tables have ENABLE and FORCE RLS, 522 policies are installed, and `app_rls` is non-superuser/non-BYPASSRLS and owns no protected table.
- Restricted-role behavioral coverage passes 962/962 assertions across all 119 protected tables, including same-tenant, cross-tenant, no-context, and pool-reuse behavior.
- The Prisma drift guard recognizes migration-owned objects and reports no unexpected destructive change; 120 composite tenant foreign keys remain protected.
- The current disposable clean/upgrade lifecycle passes all 69 migrations, deterministic seeding, tenant-integrity checks, and teardown.
- Two consecutive final-tree full regressions pass 78 files and 469/469 tests each.
- Real-backend Playwright passes 10/10 across desktop and Pixel 7 profiles, including the golden patient/staff journey and 93 role-route traversals over 32 unique staff routes.
- Independent security/RLS, clinical/operational, and QA/release challenges report zero known P0/P1/P2 after cross-review and receipt replay closure.
- The PILOT profile benchmark passes its local 750 ms/query regression budget; observed maxima were 18.90 ms patient search, 33.67 ms appointment calendar, 32.11 ms dashboard aggregate, 49.26 ms audit search, 9.39 ms receptionist events, 8.23 ms documents, 15.56 ms notifications, 15.80 ms pagination, and 2.73 ms platform overview. This is not a customer-capacity claim.

## Release gates

| Gate | Status | Evidence |
|---|---|---|
| G1-G2 demo/build artifacts | PASS | `npm run verify:no-production-demo-artifacts`; production build |
| G3 route/action certification | PASS | 32 unique staff routes / 93 role-route traversals plus patient, public, and platform journeys; 15 action-defect classes repaired or removed |
| G4-G5 database-plane separation and grants | PASS | platform-plane integration tests and `rls:verify` |
| G6 RLS catalog | PASS | current 69-migration result: 119/119 protected, 522 policies, forced/enabled 119 |
| G7-G8 drift and protected objects | PASS | drift guard; 120 migration-owned composite FKs protected |
| G9-G10 behavioral RLS/context | PASS | current 69-migration disposable result: 962/962 restricted-role assertions |
| G11 first inbound Retell | PASS locally | signed unique destination mapping; unknown/ambiguous input fails to manual review |
| G12 dependency remediation | PASS | production audit: zero vulnerabilities |
| G13-G14 synthetic profiles | PASS | deterministic FUNCTIONAL, PILOT, and EDGE profiles/scenario catalog |
| G15 browser E2E | PASS | 10/10 real-backend desktop/mobile golden and role-aware route/action journeys |
| G16 migration/seed/restore | PASS locally | disposable 69-migration clean/upgrade/seed/teardown lifecycle and prior isolated backup/restore drill |
| G17 repeated full regression | PASS | two consecutive final-tree runs: 78 files, 469/469 tests each |
| G18 zero internal P0/P1 | PASS | independent challenges report P0=0, P1=0; final receipt review also reports P2=0 |
| G19 independent acceptance | PASS | security/RLS, clinical/operational, and QA/release challenge reviews pass |
| G20 immutable local RC | PASS | logical attributed commits; committed-state release suite; clean status; annotated local tag `rc/pilot-convergence-2026-07-30` |

## Scope boundary

The product is an operational clinic-management system, not an EHR, diagnostic, prescribing, or autonomous clinical-decision system. No production deployment, database access, remote push, real PHI, call, message, appointment, eligibility check, claim, or payment was performed.
