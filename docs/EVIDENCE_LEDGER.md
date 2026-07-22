# Evidence Ledger

Last updated: 2026-07-20

This ledger records evidence that was actually executed in the local enterprise
readiness pass. It separates proven local/sandbox behavior from items that must
be proven in the client's connected environment.

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
