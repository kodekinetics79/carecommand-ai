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

## Wave 2 — build (delivered, 2026-08-29)

Baseline was 42 unit + 24 integration. Now **123 passing across 10 suites**, all against real Postgres
with isolated tenants.

### Commits on feat/growth-module-wave1-20260828
| SHA | What |
|-----|------|
| d46d66a | Stop the module asserting things it never observed (E, D, F, K, G, H, M + device_deactivated, branch scope, N+1, pagination) |
| 8ca6971 | CY2026 CPT code ladder replaces the single pass/fail gate (A-rules) |
| 398099b | The screens the workflow needed: review timer, device binding, consent, trust primitives, WCAG |
| 34ab461 | MonitoringRule write path — thresholds configurable, missed-reading detector unblocked (C) |

### Verified fixes
- resolveRule deterministic (was heap-order → alerts fired at random)
- Alert queue orders by acuity in the DB before the limit; open-by-default; exposes total
- SpO2 100% no longer manufactures a warning (directional edge warnings)
- Review time overlap scoped to the ACTOR — one 20-min block can no longer be billed across a panel
- Review minutes summed in ms, floored once (was losing up to 59s per session)
- capturedAt lower-bounded — 16 device-days no longer mintable in one signed webhook
- Health check reports `unverified`, does a real decrypt-parse, clears on reconfigure, exposes staleness
- Device connectivity DERIVED on every read; `online` no longer human-settable
- Readings from a deactivated device excluded from billable evidence
- GET /rpm-readiness paginated + bounded concurrency (was unbounded advisory-locked txns on a pool of 10)
- --t3 contrast 2.54:1 → 4.83:1 (computed), module-wide WCAG AA
- MonitoringRule CRUD + coherence validation; delete deactivates so past alerts keep their explanation

### Competitive position (4 independent research passes agreed)
- No RPM vendor markets billing-evidence integrity — they market security certifications (HITRUST, ISO
  27001), which is a different claim. Hash-bound attestation with automatic invalidation is unoccupied.
- No competitor MEASURES clinical time; the strongest imputes minutes from event counts. The timer here
  records real start/end instants and the server recomputes from them.
- No incumbent auto-selects between the mutually exclusive CY2026 pairs (99445/99454, 99470/99457).

## Wave 3 — harness proven (2026-08-29)

`tests/e2e/connected-care.spec.ts` — **3/3 passing** on desktop-chromium against a disposable RLS
database. No longer UNPROVEN. Covers: enrol with device binding -> consent with script and
cost-sharing -> signed webhook ingest -> measured review session -> 99445 + 2 review minutes rendered.

**The harness earned its keep on first run.** It caught a defect in the connectivity work: the server
derived reachability correctly but `DeviceIntegration.tsx` still rendered the stored `status` column,
so a device that had never reported still showed a green "Online" badge. Fixed in be06e18 — the page
now renders the derived value and the labels describe observation (Reporting / Not reporting / Never
reported) rather than asserting a live connection.

## Wave 4 — the three remaining items, delivered (2026-08-29)

**152 passing across 13 server suites + 3 E2E.** Commit 3314da0.

| Was | Now |
|-----|-----|
| Alerts created a `queued` NotificationEvent that nothing ever drained; no route returned them. A critical alert notified nobody. | `GET /v1/monitoring/notifications` + `POST /:id/acknowledge`. Delivery and acknowledgement recorded as separate facts. Only rows addressed to the reader are marked delivered, so an unowned alert cannot vanish from everyone else's queue because one clinician glanced at theirs. |
| Billing period was a UTC month for every clinic. A clinic at UTC-7 could not record a review after ~17:00 on the last local day of the month. | Period is the branch's local calendar month. Unresolvable zone falls back to UTC rather than throwing. |
| Device-days bucketed by UTC date, so one local day straddling UTC midnight counted twice — 8 local days could satisfy a 16-day CMS threshold. | Bucketed by local calendar date. |
| Every call site computed the CURRENT month, so a closed month — the only kind anyone bills — was unreachable. | `periodStart` on readiness and signoff; any instant inside a month normalises to that month. |

Evidence version **v5** + migration `20260829160000_rpm_evidence_v5_local_period`, clearing prior
signoffs: local-day bucketing can reduce a recorded device-day count, so a standing attestation could
otherwise cover a period that no longer meets its own threshold.

New suites: `alertInbox.integration.test.ts` (7), `rpmPeriodBoundary.integration.test.ts` (7),
`rpmPeriod.test.ts` (15 — DST boundaries, half-hour zones, round-trips).

## Wave 5 — the last pilot blocker (2026-08-29)

`/alert-thresholds` (85f671b). The rules API had tests but no screen, so a clinic could not change a
single threshold without an engineer calling the endpoint — the one thing that actually blocked
*independent* piloting. The screen shows the bands in force (an empty list previously read as "nothing
is monitored" rather than "the defaults apply") and makes the missed-reading watch reachable, since
that cadence lives only on a rule.

**E2E now 5/5.** Added: a clinic setting its first rule and the watch turning on; the server refusing
an inverted band.

## Still open
- **Consent annual expiry.** CY2020 requires consent at least annually; `PatientConsent` has no expiry
  field. Not a pilot blocker — it becomes one at the first annual renewal, i.e. a year after go-live.
- **Nothing is deployed.** All work is on `feat/receptionist-pilot-program-20260829`. `main`
  auto-deploys to production; merging is the owner's call.
- **v5 caveat.** The evidence migration clears every prior signoff. That costs nothing today (no
  period could reach READY before this work) but stops being free once clinics start attesting.
