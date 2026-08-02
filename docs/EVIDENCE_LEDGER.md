# Evidence Ledger

Last updated: 2026-07-31

This ledger records evidence that was actually executed in the local enterprise
readiness pass. It separates proven local/sandbox behavior from items that must
be proven in the client's connected environment.

## 2026-07-31 Final SME Convergence Snapshot

This is the current working-candidate evidence. Earlier dated sections remain
historical and must not be used as current test or migration counts.

| Evidence | Current result |
| --- | --- |
| Full application gate | PASS: Prisma validation, server typecheck, ESLint, TypeScript and production Vite build |
| Full disposable Vitest run | PASS: 106 files, 1,878/1,878 tests |
| Real-backend Playwright | PASS: 10/10 desktop/mobile journeys, including patient booking/insurance and Owner, Front Desk, and Auditor crawls |
| RLS catalog and behavior | PASS: 131 application tables, 123 protected, 8 exemptions, 522 policies, ENABLE/FORCE 123/123; 994/994 behavioral assertions |
| Database lifecycle | PASS: all 86 migrations, deterministic seed, backup/restore parity, RLS topology and 123 tenant-integrity FKs |
| Prisma drift | PASS: only 123 migration-owned composite FKs and 138 migration-owned indexes differ from the Prisma schema |
| Production engineering | PASS: 2 files, 32/32 tests; production artifact scanner passed |
| Dependency integrity | PASS: zero production vulnerabilities at moderate threshold; 575 verified signatures and 194 attestations |
| Software bill of materials | Generated CycloneDX 1.5 SBOM with 629 components at `/tmp/carecommand-ai-sbom.json` |
| Credential scan | No Retell-style credential literal in the worktree or Git history; the disclosed credential still requires external rotation |

No repository-fixable P0, P1, or P2 finding remained open after delivery-pod
and independent-challenge review. This is local synthetic evidence and
compliance readiness work, not production validation or certification. See
`docs/testing/FINAL_RELEASE_CANDIDATE_REPORT_2026-07-31.md` for the verdicts and
external activation gates.

## Environment

- Workspace: `/Users/zackkhan/carecommand-ai`
- Database: local Docker Postgres on `localhost:55432`
- Redis: local Docker Redis on `localhost:56379`
- API smoke port: `3002` because local port `3001` was occupied by another app
- Production frontend build defaults: `.env.production`
- Data classification: synthetic/demo data only; no real PHI was used

## Commands And Results

| Area | Command | Result |
| --- | --- | --- |
| Database schema | `npm run db:validate` | Passed; Prisma schema valid |
| Migrations | `npx prisma migrate status` | Passed; database schema up to date |
| Unit/integration regression | `npm test` | Passed; 29 files, 135 tests |
| Type safety | `npm run api:typecheck` | Passed |
| Lint | `npm run lint` | Passed |
| Production build | `npm run build` | Passed; production mode forced in `package.json` |
| Module demo coverage | `npm run verify:modules` | Passed; 107/107 non-ephemeral models covered |
| Pilot simulation | `npm run pilot:simulate` | Passed; 6 synthetic clinic simulations |
| Expanded simulation | `SIM_CLINICS=12 npm test -- server/test/e2e.simulation.test.ts` | Passed; 12 concurrent clinic journeys |
| Production dependency audit | `npm audit --audit-level=high --omit=dev` | Passed for high severity; one low dev-server advisory remains |
| API live smoke | `curl /health/live` on port `3002` | 200 |
| API readiness smoke | `curl /health/ready` on port `3002` | 200; database and Redis ok |
| Auth smoke | `curl /v1/auth/me` without auth on port `3002` | 401 as expected |
| Security-focused regression | `npm test -- server/test/security.integration.test.ts server/test/hardening.test.ts server/test/portalSignup.integration.test.ts` | Passed; 3 files, 11 tests |
| Legacy platform token regression | `npm test -- server/test/platformLegacyToken.test.ts server/test/security.integration.test.ts server/test/hardening.test.ts` | Passed; 3 files, 10 tests |
| Production bundle scan | `rg "jsxDEV|/Users/zackkhan/carecommand-ai|fileName:|http://localhost:3001|/v1/auth/dev-token|ChangeMe123|Provider123|Platform123|demo-sandbox-secret|11111111-1111|22222222-2222|harley-street-medical" dist -S` | No matches after production-build and portal-slug fixes |

## Synthetic Test Data Used

Pilot simulation clinics:

- Harley Street Medical Group
- Riverbend Family Health
- Southbank Dental House
- Northpoint Behavioral Health
- Cedar Point Multi-Specialty
- Harborview Multi-Location Clinic

Representative patient import rows:

- `PAT-1001`, Maya Lopez, active patient with valid email
- `PAT-1002`, Jon Adams, follow-up/risk scenario
- `PAT-2002`, Chris Nguyen, invalid email warning scenario
- duplicate patient references to prove update handling
- missing patient references to prove skip/invalid handling

Representative appointment scenarios:

- annual physical
- blood-pressure follow-up
- telehealth nutrition follow-up
- therapy intake by video
- duplicate appointment update
- invalid date and unknown status rows

Representative insurance/payment scenarios:

- Aetna, Cigna, Blue Cross Blue Shield, UnitedHealthcare, Delta Dental
- active, inactive, uncertain, invalid `active=maybe`
- missing payer/member fields
- valid Stripe webhook signature
- invalid Stripe webhook signature
- duplicate webhook redelivery/idempotency

Representative security scenarios:

- unauthenticated access
- malformed or forged token
- cross-tenant UUID access
- suspended tenant
- role denial for protected routes
- oversized request body
- bounded pagination
- DSR export role authorization and audit event

## Evidence Artifacts

- Enterprise client validation: `docs/ENTERPRISE_CLIENT_VALIDATION_RUNBOOK.md`
- Pilot handover: `docs/PILOT_HANDOVER_CHECKLIST.md`
- Production readiness: `docs/PRODUCTION_READINESS.md`
- RLS reference: `docs/RLS.md`
- Observability reference: `docs/OBSERVABILITY.md`
- Backup/restore/rollback runbook: `docs/BACKUP_RESTORE_ROLLBACK_RUNBOOK.md`
- Incident and integration-failure runbook: `docs/INCIDENT_AND_INTEGRATION_FAILURE_RUNBOOK.md`
- Role access matrix: `docs/ROLE_ACCESS_TEST_MATRIX.md`
- Patient experience test matrix: `docs/PATIENT_EXPERIENCE_TEST_MATRIX.md`
- Security abuse test matrix: `docs/SECURITY_ABUSE_TEST_MATRIX.md`
- Pilot environment checklist: `docs/PILOT_ENVIRONMENT_CHECKLIST.md`
- Known limitations register: `docs/KNOWN_LIMITATIONS_REGISTER.md`
- Pilot success metrics: `docs/PILOT_SUCCESS_METRICS.md`
- Integration mode register: `docs/INTEGRATION_MODE_REGISTER.md`
- Defect and retest tracker: `docs/DEFECT_LOG_AND_RETEST_TRACKER.md`
- Client go/no-go signoff: `docs/CLIENT_GO_NO_GO_SIGNOFF.md`
- Autonomous review summary: `docs/AUTONOMOUS_AGENT_REVIEW_SUMMARY.md`

## Not Proven In Local Pass

The following require the customer's or deployment team's connected environment:

- live Stripe payment, refund, dispute, and reconciliation with real account keys
- live eligibility payer connectivity and credential-expiry handling
- live email/SMS/voice delivery, opt-out, and failure escalation
- live device vendor event delivery and alert responder notification
- real PHI import, correction, export, retention, and deletion under signed legal agreements
- production backup restore into an isolated environment
- production alert reaching the named responder
- enterprise browser E2E traces and videos from the final deployed URL
- formal HIPAA/BAA, SOC 2, penetration test, and DPA evidence

## 2026-07-28 Supervised P0 Remediation Evidence

This record supplements, and does not rewrite, the historical evidence above.

- Source revision: `dc77a7f`; worktree was intentionally dirty with pre-existing
  portal self-service changes plus the supervised remediation changes.
- Environment: local Docker PostgreSQL (`localhost:55432`) and Redis
  (`localhost:56379`); synthetic/local data only; no real PHI.
- `npm run check`: passed Prisma validation, server typecheck, repository lint,
  and production frontend build.
- `npm test`: passed 49 test files and 285 tests.
- Receptionist combined control suite: passed 9 files and 41 tests covering
  artifact authorization/redaction, mandatory disclosure, Retell callback
  payloads, canonical booking/replay, executable safety escalation, campaign
  state, target ownership, atomic target claims, and the tenant stop control.
- `git diff --check`: passed.
- Production dependency audit: reduced from 17 findings to two high React Router
  advisories. These remain open; npm's proposed forced change is an incompatible
  downgrade that would reintroduce other Router advisories. A security owner must
  approve a time-bounded exception or a tested framework migration before P0-11
  is closed.
- Readiness decision: engineering evidence improved, but real-PHI and unattended
  autonomy remain NO-GO while blocking items in
  `docs/P0_COMPLIANCE_CONTROL_MATRIX.md` remain open.
- External acceptance still required from security/privacy, clinical operations,
  legal/compliance, and the business pilot owner. No certification is claimed.

## 2026-07-28 Wave 3/4 Local Engineering Evidence

- Source revision remains `dc77a7f`; the shared worktree is intentionally dirty
  with pre-existing portal work and the supervised remediation changes.
- Environment: local Docker PostgreSQL/Redis; synthetic data only; no real PHI.
- A fresh temporary PostgreSQL database successfully applied all 59 migrations.
  The temporary database was deleted after rehearsal. The local rehearsal
  database received the authorized pre-release migration checksum reconciliation
  only after the follow-up migration made its final schema/data equivalent.
- Focused scheduling/receptionist verification: 8 files, 44 tests passed,
  including DST gap/fold conversion, local-day UTC boundaries, canonical service
  duration, staff/portal/receptionist collisions and ambiguous-provider refusal.
- Focused insurance/provider verification: 3 files, 15 tests passed, including
  primary/secondary coexistence, overlapping-order rejection, invalid effective
  ranges, tenant/payer/policy isolation, exact verification foreign keys, and
  fail-closed production provider mode.
- Root independently repeated the fresh 59-migration rehearsal and removed its
  temporary database; an additional combined focused run passed 5 files and 23
  tests.
- `npm run db:validate`, server typecheck and focused diff checks passed. The root
  integration owner subsequently completed the final full repository gates:
  `npm run check` passed schema validation, server typecheck, lint and production
  build; `npm test` passed 53 files and 301 tests; and `git diff --check` passed.
- `npm audit --omit=dev --audit-level=high` still reports two high React Router
  findings. The offered forced downgrade is not accepted as remediation; P0-11
  remains open for a patched compatible release, tested migration, or an
  owner-approved time-bounded exception.
- Open limitations: RLS is not fully enabled; live Stedi credentials remain
  deployment-managed; connected provider deletion receipts and production voice
  lifecycle traces are absent; two high React Router advisories remain under
  P0-11; P0-10/P0-12 operational and approval evidence is incomplete.
- Decision remains NO-GO for real PHI or unattended autonomous operation. An
  attended synthetic demo still requires a rehearsed stop path and accountable
  human supervision. No HIPAA, SOC 2 or GDPR certification/conformity claim is made.

## 2026-07-30 Release-Convergence Candidate

This record supersedes the readiness status and test totals in earlier historical entries; it does not erase them.

- Branch: `feat/complete-rls-isolation`; baseline `dc77a7f`.
- Implementation commits: `34e527b`, `0e54bb6`, `61e865f`, `aed5b51`; final evidence/CI commit follows them.
- Local annotated tag: `rc/pilot-convergence-2026-07-30`, applied only after the committed-state release suite.
- Recovery: exact start-state stash `41567d7204d18bdba53f300b265cab862fa5b1ee`, earlier RLS stash `d70c8aeef49767cf740c37a12cbadf3edb2e868e`, and external recovery patch documented in `testing/CHANGE_ATTRIBUTION.md`.
- Data classification: deterministic synthetic data only; no production system or real PHI accessed.
- Database: 69 clean migrations; 127 application tables; 119/119 protected with ENABLE + FORCE RLS; 522 policies; 8 reviewed exemptions; safe non-bypass runtime role; 120 protected composite tenant FKs.
- Behavioral isolation: 962/962 restricted-role same/cross/no-context/pool assertions pass.
- Full regression: two consecutive final-tree runs at 78 files and 469/469 tests; committed-state run repeated before tagging.
- Browser: 10/10 real-backend desktop/Pixel 7 tests; 32 unique staff routes and 93 role-route traversals plus public, platform and patient golden journeys.
- Security/build: `npm run check`, production-artifact guard, Prisma drift guard, production dependency audit (zero vulnerabilities), registry signatures (576) and attestations (194), and `git diff --check` pass.
- PILOT volume: 4 tenants, 8 clinics, 40 users, 4 portal accounts, 2,000 patients, 4,000 appointments, 1,000 calls, 500 payments, 1,000 documents, 2,000 notifications and 5,000 audits. All benchmarked queries remain below the local 750 ms regression threshold; this is not a capacity claim.
- Independent acceptance: security/RLS, clinical/operational and QA/release challenges finish with no known unresolved internal P0/P1/P2.
- Decision: GO for an attended, supervised, synthetic-data-only pilot. NO-GO for real PHI, unattended autonomous calls, or production compliance claims until the external prerequisites in the release report are independently satisfied.
- No security exception was used. No compliance certification or legal opinion is claimed.
