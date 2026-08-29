# Connected Care — Pilot Readiness Ledger
Owner: CTO/CIO/Sales Director (acting). Branch: feat/growth-module-wave1-20260828
Cycle per feature: SDET audit → Consultant SME verdict → CTO decision → Design → Build → CTO review → SDET re-audit → Sign or iterate.

## Module surfaces in scope
| # | Feature | Route | Server | Status |
|---|---------|-------|--------|--------|
| F1 | Remote Monitoring | /monitoring | modules/monitoring/routes.ts | AUDIT |
| F2 | Device Integration | /devices | modules/devices/routes.ts | AUDIT |
| F3 | Device Enrollments | /enrollments | connected-care/routes.ts | AUDIT |
| F4 | RPM Billing Readiness | /rpm-readiness | connected-care + rpmEvidence.ts | AUDIT |
| F5 | Provider Sync Logs | /sync-logs | connected-care/routes.ts | AUDIT |
| F6 | Integration Setup | /integration-setup | devices/routes.ts providers | AUDIT |

## CTO pre-audit findings (established directly, not delegated)
- **P0-A — RPM review-time endpoint is unreachable.** `PATCH /v1/connected-care/rpm-readiness/:patientId/review`
  (connected-care/routes.ts:239) is the only writer of `reviewMinutes` + `communicationFlag`. Zero UI callers.
  2 of 5 RPM requirements can never be met. Screenshot confirms "0 review min - no comms" for every patient.
- **P0-B — Enrollment cannot bind a device, so no reading can ever qualify.** rpmEvidence.ts classifier requires
  `enrollment.deviceId` non-null AND `reading.deviceId === enrollment.deviceId` AND `enrollment.branchId` match.
  The enroll UI (PatientEnrollments.tsx) posts only {patientId, providerKey, programType}. Result: 0/16 device-days forever.
- Net: the evidence-integrity engine is excellent; the human workflow that feeds it does not exist. The module
  is a closed loop with no on-ramp. This is the pilot blocker.

## Cycle log
(appended per wave)

## Wave 1 — harness baseline (CTO-verified directly, 2026-08-29)
- `npx vitest run server/lib/connectedCare/connectedCare.test.ts server/lib/monitoring.test.ts server/test/monitoringNormalization.unit.test.ts` → **42/42 pass**
- `npx vitest run server/test/connectedCare.integration.test.ts` → **24/24 pass** (real Fastify + real Postgres, isolated tenants)
- Monitoring safety worker EXISTS and is scheduled: `server/workers/monitoring.worker.ts` runs `missed-reading-scan` +
  `device-offline-scan` via `detectMissedReadings`/`detectOfflineDevices`. Not a gap.
- **E2E GAP: zero Playwright coverage for any Connected Care route.** `tests/e2e/` has no monitoring/devices/
  enrollments/rpm-readiness spec. The backend is well tested; the customer-facing journey is untested end to end.
- **Production data-quality defect:** the live /devices list contains lorem-ipsum rows ("Cum labore ea eum mo",
  vendor "Dolor ullamco volupt"). No lorem/ipsum/faker generator exists anywhere in the repo, so these were
  hand-entered through the Register device form against production. Implies: (a) no meaningful validation on
  device registration, (b) no cleanup affordance in the UI.

## Wave 1 verdict — CTO decision (all findings independently re-verified before acceptance)

### Accepted P0 (pilot blockers)
| ID | Finding | Verified at |
|----|---------|-------------|
| A | RPM review-time endpoint has no UI caller — 2 of 5 requirements unreachable | connected-care/routes.ts:239 |
| B | Enrollment UI sends no deviceId; classifier requires device+branch match | PatientEnrollments.tsx:20; rpmEvidence.ts:152 |
| B2 | UI defaults providerKey='manual'; manual enrollments are excluded outright — fixing B alone does NOT unblock | rpmEvidence.ts:149 |
| C | MonitoringRule has NO write path (no route/UI/seeder). Every threshold is hardcoded | grep: only tests write it |
| D | Alert queue take:100 with no status filter, severity sorted AFTER truncation → open criticals invisible | monitoring/routes.ts:185-211 |
| E | resolveRule findMany has no orderBy → ties resolve by heap order; alerts fire at random | monitoring.ts:69 |
| F | SpO2 100% (ideal) emits a warning alert; band-edge rule fires on physiological ceilings | monitoring.ts:107 |
| G | health-check makes NO external call; 'healthy' means "a row exists". No TTL, never invalidated | devices/routes.ts:272-275 |
| H | Device.status is human-set from a dropdown, rendered as "Connected now" telemetry | devices/routes.ts:138; DeviceDetailDrawer.tsx:181 |
| I | Monitoring NotificationEvents are never drained — no alert notifies anyone | only drainer is appointment-scoped confirmationOutbox.ts |
| J | Consent: one click voids a physician attestation; no state shown, no revoke, method 'verbal' fabricated | PatientEnrollments.tsx:51; routes.ts:183 |
| K | Review time: overlap check is per-PATIENT only — one 20-min block attestable across a whole panel | connected-care/routes.ts:261 (billing-fraud vector) |
| L | GET /rpm-readiness: no take, unbounded Promise.all of advisory-locked txns on a pool of 10 | connected-care/routes.ts:217 |
| M | capturedAt has no lower bound — 16 device-days mintable in one signed webhook | deviceAdapters.ts:27 |
| N | UI never adopted useResource/ResourceSection: prints 0 for requests that never answered | RemoteMonitoring.tsx:134 |
| O | --t3 #9CA3AF = 2.54:1 — module-wide WCAG AA failure on every table header | index.css:27 |

### Rejected / corrected agent claims (verified false or overstated)
- "No missed-reading/offline worker exists" — FALSE. monitoring.worker.ts is real and scheduled. The true defect is C (no rules to evaluate).
- "Consent re-grant breaks the audit match" — FALSE. Traced grant/revoke/re-grant; the match holds.
- "Readings accrue after discharge" — FALSE. Ingest correctly blocks non-active enrollments. The real bug is the inverse (P1-4).
- "Health: healthy + NOT_CONFIGURED simultaneously" — unreachable for device providers. The reachable, equally damaging state is a stale green verdict.
