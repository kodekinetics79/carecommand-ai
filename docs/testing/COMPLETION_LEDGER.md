# Completion Ledger

Authoritative local release-convergence ledger for 2026-07-30. “Closed” means the repository root cause has executable local evidence and independent review; it is not a compliance certification or proof of a live provider/production environment.

| ID | Finding | State | Root-cause fix | Executable evidence |
|---|---|---|---|---|
| DEMO-01 | Production-visible mocks, demo metrics and dead controls | CLOSED | Removed production mock datasets/legacy seeds, replaced fabricated states with persisted API data or truthful empty/setup states, added source/build scanner | `verify:no-production-demo-artifacts`; role/action Playwright crawl |
| DATA-01 | Fragmented fixtures and accumulating test tenants | CLOSED | Deterministic FUNCTIONAL/PILOT/EDGE profiles, fixed clock/seed, guarded disposable-database lifecycle | synthetic catalog test; release DB lifecycle and backup/restore drill |
| PLAT-01 | Tenant and platform operations shared one unsafe database plane | CLOSED | Dedicated `app_platform` role/client/context with curated grants and aggregate functions | platform database-plane integration tests; role posture probes |
| PLAT-02 | `app_rls` held platform-table privileges | CLOSED | Revoked platform User/Config/Integration/Audit access from tenant runtime | `rls:verify`; negative platform-table probes |
| DB-01 | Prisma diff proposed destructive removal of tenant FKs/indexes | CLOSED | Reconciled representable schema objects; versioned manifest guards 120 composite FKs and 149 SQL-owned indexes | `verify:prisma-drift`; clean migration lifecycle |
| RLS-01 | Only representative behavioral RLS proof existed | CLOSED | Table-driven restricted-role adapters for all 119 protected tables | 962/962 behavioral assertions; catalog and pool-context suites |
| REC-01 | First-ever inbound call could not resolve trusted tenant context | CLOSED | Exact raw signature verification and unique persisted destination mapping; unknown/ambiguous mappings fail to manual review | inbound bootstrap integration suite |
| REC-02 | Receptionist admission, consent, lifecycle and protected tools could race or overclaim | CLOSED | Atomic capacity reservation and stale lease closure; exact disclosure evidence; active-call gate; server-held change confirmations; canonical booking/audit requirement | receptionist focused suites; independent QA and clinical review |
| AUTH-01 | Cross-origin refresh/logout and portal logout/session replay | CLOSED | Rotating response/bootstrap CSRF kept in memory; portal bearer shortened, stored only in memory, server-side HMAC-JTI session required and logout revokes/audits | cross-origin auth, single-flight, portal logout/replay and independent QA review |
| CLIN-01 | Minor guardian approval lacked a real proxy authority model | CLOSED | Guardian/minor approval disabled fail-closed; request remains pending and audited | portal signup/access-request tests |
| INTAKE-01 | Authenticated intake lacked branch/permission controls; acknowledgement could default true | CLOSED | Dedicated intake permissions, branch scope, audits, canonical versioned explicit acknowledgements | intake authorization and atomicity suites |
| PAY-01 | Checkout was cross-branch and payment-link finalization was race-prone | CLOSED | Branch/permission guards, advisory reservation, durable provider reconciliation, atomic local state/audits/events | checkout concurrency, rollback and cross-branch tests |
| CC-01 | Connected-care/RPM branch and readiness provenance gaps | CLOSED | Branch isolation, validated mappings, immutable UTC-month evidence, AuditEvent-derived review totals, evidence-hash-bound provider signoff, current consumer recomputation, and offline/backdated invalidation | 82/82 focused tests; independent QA acceptance with zero P0/P1 |
| REV-01 | Revenue-protection PHI/payment reads lacked billing permission/branch enforcement | CLOSED | Billing read/write permissions, branch/object guards and minimum-necessary read audits across authenticated revenue surfaces | revenue authorization/money tests and independent QA review |
| AUDIT-01 | Mandatory audit failures could allow privileged/sensitive actions to report success without durable evidence | CLOSED | Atomic/fail-closed evidence, serialized money transitions, two-plane pilot intents/receipts, concurrency CAS, and immutable idempotent response receipts | forced failure/race/retry suites; independent audit acceptance P0=0/P1=0/P2=0 |
| PAUTH-01 | Platform account state and rate-limit-store failures could weaken enumeration resistance | CLOSED | Constant-work generic auth, MFA-success-only state reset, attributed audit context, atomic seed evidence, and production fail-closed distributed throttling | response/work/store-failure tests; independent cross-review P0=0/P1=0 |
| DEP-01 | High React Router advisories | CLOSED | Compatible React/Router upgrade and router import migration | production audit reports zero high/critical; build/E2E suites |
| RC-01 | No attributed immutable local release candidate | CLOSED | Reviewed work grouped into logical local commits; committed-state suite repeated; clean status verified; annotated local RC tag applied | `CHANGE_ATTRIBUTION.md`; `TEST_EXECUTION_EVIDENCE.md`; tag `rc/pilot-convergence-2026-07-30` |

## State progression

Each closed row followed: OPEN → ASSIGNED → REPRODUCED → TEST ADDED → ROOT CAUSE FIXED → REGRESSION PASS → INDEPENDENTLY VERIFIED → CLOSED. Rows not yet independently verified remain explicitly non-closed.
