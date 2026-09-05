# Bright Health LLC Pilot Operations Packet

Date: 2026-09-02 (America/New_York)
Tenant: Bright Health LLC (`d17a7531-1196-4cf5-aac3-de73a6138a64`)
Data classification: synthetic only; no PHI authorized
Current decision: **NO-GO for an unsupervised or voice-enabled client pilot; conditional go for an attended demonstration that excludes live voice and unverified delivery providers.**

This packet is the operator control sheet for the Bright Health pilot. It does not replace the detailed certification report or create a compliance certification.

## Non-negotiable stop conditions

Stop the affected flow immediately when any of these is true:

1. A voice number, agent, prompt, tenant, clinic, deployment version, or webhook readback does not match Bright Health exactly.
2. A caller hears another clinic's identity or workflow.
3. A cross-tenant or unauthorized cross-clinic read/write succeeds.
4. The deployed release cannot identify its immutable commit SHA.
5. A core workflow has an unresolved P0/P1 defect or reports provider acceptance as delivery, connection, payment, or clinical completion.
6. The live-test run ID, tenant, approved destination, time window, expiry, call cap, minute cap, or cost cap is missing or invalid.
7. A live outbound destination is not one of the three full numbers explicitly authorized by the customer.
8. Real PHI is introduced before privacy/security approval, contracts, retention, backup, incident response, and access-review gates are signed.
9. The emergency stop state cannot be confirmed. An unavailable status is treated as stopped.

Current stop conditions are active: the Retell line ending `1177` is bound inbound to a different synthetic customer's agent; the working tree is not deployed; the live-test envelope is not valid for Bright Health; SMS/email are unconfigured; and the locally repaired self-service recovery path has not been deployed or proven through a controlled inbox. Platform Operator assisted tenant-user recovery also remains absent. The authenticated production browser currently belongs to Harley Street Medical Group, not Bright Health LLC. No live call or final Bright Health Chrome certification is permitted in this state.

## Release and activation gate

| Gate | Current state | Evidence required to close |
|---|---|---|
| Immutable release SHA | BLOCKED | Commit the certified working tree; clean CI; deploy exact SHA |
| Runtime identity | BLOCKED | Public Vercel `/health` returns the exact candidate SHA; any separately operated Render API/worker is deployed from the same SHA and identified independently |
| Metrics/alerts | BLOCKED | Real metrics response, queue/worker telemetry, alert receipt |
| Database migration | LOCAL PASS | 128-migration clean lifecycle; verify exact deployed migration table |
| Backup/restore | LOCAL PASS / MANAGED BLOCKED | Local restore parity and RLS guard pass; managed Render restore drill/receipt pending |
| Retention automation | LOCAL PASS / DEPLOYMENT BLOCKED | Daily signed, tenant-scoped purge at 03:20; focused 11/11 tests; deploy and observe job receipt |
| Tenant/RBAC/RLS | LOCAL PASS | Repeat owner, Front Desk, Billing and cross-tenant denials on deployed SHA |
| Inbound voice binding | SAFETY BLOCKED | Bright Health Studio publish; DID/agent/version/webhook readback exact match |
| Live-test envelope | BLOCKED | Bright tenant/run/window/expiry plus positive call/minute/cost caps |
| Inbound call | NOT RUN | One bounded call after all preceding gates; canonical call/audit/cost evidence |
| Outbound calls | NOT RUN | Bounded matrix to authorized full numbers only; provider/application receipts |
| SMS/email | BLOCKED | Approved provider, consent/opt-out, delivery and failure-queue receipts |
| Deployed load/recovery | BLOCKED | Staged p50/p95/p99, queue depth, rate limits, restart/recovery evidence |
| Authenticated Bright Health Chrome replay | ACCESS BLOCKED | Recover Bright Health Owner/Admin access first, then replay Intake, Connected Care, Labs, Inventory, Telehealth, Campaigns, Reviews and role-specific journeys |
| Bright Health tenant-admin access | LOCAL FIX PASS / DEPLOYMENT BLOCKED | Deploy the secure tenant self-service link flow, configure verified email delivery and `PUBLIC_APP_URL`, complete a controlled-inbox Chrome reset, and retain a governed Platform Admin assisted fallback |

## Named launch roles

People must be assigned before deployment or live integration testing. No role is inferred from a product account.

| Responsibility | Named person | Required acknowledgement |
|---|---|---|
| Incident commander | UNASSIGNED | Owns severity, stop/go and recovery decision |
| Release owner | UNASSIGNED | Owns SHA, CI, deployment, rollback and migration evidence |
| Voice/provider owner | UNASSIGNED | Owns Retell/Twilio binding, envelope, provider receipts and emergency stop |
| Clinic operations owner | UNASSIGNED | Validates real front-desk workflow and fallback |
| Security/privacy approver | UNASSIGNED | Approves data mode, recording, retention, legal holds and vendor contracts |
| Client communicator | UNASSIGNED | Sends fact-based status and next-update time |
| Evidence scribe | UNASSIGNED | Preserves screenshots, IDs, audit records and call ledger without PHI leakage |

The visible `support@carecommand.ai` address is a product contact, not proof of staffed coverage. Confirm receipt, hours and escalation routing before handoff.

## Emergency stop procedure

1. Sign in as a Bright Health Owner or Admin.
2. Open **Receptionist Studio → Outbound → Emergency stop**.
3. Enter a reason of at least five characters and confirm the stop.
4. Treat timeout, unreadable status, or provider uncertainty as stopped; do not retry a call to test the control.
5. Preserve the requested/confirmed/failed/unconfirmed provider-stop result, quarantined/unbound calls, reconciliation tasks, critical signals and audit evidence.
6. Tenant operators may stop outbound activity but may not clear a platform safety stop. Platform clearance requires the assigned incident and release owners after root cause and exact retest evidence.

The local safety suite proves fail-closed admission and reconciliation behavior. Live active-call cancellation remains external evidence.

## Voice activation sequence

Do not reorder these steps:

1. Deploy the exact certified SHA to the public Vercel web/API and the required Render API/worker services; verify each runtime identity independently, then verify migrations, workers and metrics.
2. In Bright Health Receptionist Studio, deploy/publish the Bright Health agent to the exact clinic and line.
3. Read back the DID, tenant, agent, version and webhook from Retell; all must match the application deployment record.
4. Create one short-lived live-test execution for Bright Health with one approved destination, a valid start/end/expiry and positive call/minute/cost caps.
5. Run one inbound disclosure/consent/booking scenario. Verify canonical appointment, call log, deployment version, audit and usage/cost evidence.
6. If and only if step 5 passes, run the minimum outbound scenarios needed, using only:
   - `***-***-5555`
   - `***-***-6009`
   - `***-***-5556`
7. Stop on the first tenant/binding/consent/audit/cost discrepancy. Do not use the ambiguous four-digit destination.
8. Reactivate a campaign only after exact-deployment inbound proof and explicit operator review.

Call evidence must record timestamp, masked destination, scenario, result, duration, disconnect/provider status, application record, deployment version, cost/usage and defect reference. No repeated call is justified once a scenario is proven.

### Read-only post-deploy proof

After deployment, the release owner must run the repository's guarded verifier from the exact committed candidate against the public Vercel-served origin. It sends only `GET` requests to `/health`, `/health/ready` and `/metrics`, rejects redirects and every host except the canonical CareCommand HTTPS origin, verifies metric denial without/with a wrong token, and does not print the monitoring token.

```bash
DEPLOYED_RELEASE_VERIFY_ACK=READ_ONLY_CARECOMMAND_DEPLOYMENT \
DEPLOYED_RELEASE_BASE_URL=https://carecommand.kodekinetics.com \
DEPLOYED_RELEASE_EXPECTED_SHA=<full-40-character-deployed-sha> \
DEPLOYED_RELEASE_METRICS_TOKEN=<monitoring-token> \
npm run verify:deployed-release
```

A pass proves only the public function’s exact runtime identity, database/Redis/ingress readiness, denial of unauthenticated/invalid-token metrics requests, authenticated Prometheus output containing API-exposed queue-depth/dependency series, and effective transport/content/frame security headers. It does not prove the separate Render worker is alive or draining and does not replace migration, worker receipt, alert delivery, browser, load, rollback or provider verification.

## Incident response

| Severity | Bright Health trigger | Immediate action |
|---|---|---|
| P0 | data exposure, cross-tenant success, wrong clinic identity, duplicate charge, unsafe alert routing, outage | Stop affected flow, invoke emergency stop where relevant, preserve evidence, page incident/security owners |
| P1 | core scheduling/voice/delivery/revenue workflow broken without safe fallback | Pause pilot journey, publish workaround/status, repair and exact-journey retest before resuming |
| P2 | degraded but safe UX/report/admin workflow | Log with owner/date; continue only if customer impact is accepted |
| P3 | cosmetic or low-friction issue | Record for backlog; no safety claim affected |

Capture environment, SHA, tenant/clinic, role, correlation/request/job/provider IDs, timestamps, screenshots and audit records. Never put PHI, tokens, credentials, webhook secrets or raw provider payloads in client-visible channels.

## Privacy, retention and legal holds

- Keep Retell/provider storage at minimum-necessary basic attributes unless recording approval is signed.
- Recording requires affirmative versioned disclosure evidence. Refusal/withdrawal is terminal for artifact persistence.
- Local defaults are 30 days for recordings and 90 days for transcript summaries unless an active tenant policy overrides them.
- A daily signed tenant job now purges expired local artifacts at 03:20 and requests provider deletion only when no unexpired artifact or legal hold remains.
- Legal holds block the matching purge scope until an authorized release is recorded.
- Provider deletion is not complete until a provider confirmation receipt exists; failures remain visible lifecycle evidence.
- Final retention periods, state recording law analysis, BAAs/DPAs and provider contracts require the security/privacy approver.

## Backup, restore and rollback

Local evidence on 2026-09-02:

- 128 migrations applied to a clean disposable source database.
- Synthetic dump restored with exact snapshot parity: 2 tenants, 3 clinics, 14 users, 24 patients, 56 appointments, 25 calls, 12 payments, 12 intake documents, 24 notifications and 56 audit events.
- Restored runtime role was `app_rls`, non-superuser, without bypass-RLS.
- 136/136 protected tables had forced RLS, with 571 policies and 121 tenant-integrity foreign keys.

Before a client pilot, the release owner must run and time a managed-provider restore into an isolated environment, verify the same controls, record RPO/RTO and rehearse application rollback. Repository tests do not prove Render backup availability.

## Access review and daily operations

- Confirm active users, roles, branch assignments, primary clinic and dormant accounts before handoff.
- Owner/Admin permissions remain tenant-level; platform permissions are never granted to Bright Health tenant users.
- Front Desk and Billing remain restricted to assigned clinics and workflows.
- Run the weekly access review and assign every unassigned compliance item.
- Review failed delivery, reconciliation, privacy lifecycle, queue failure and critical-signal work each operating day.
- Verify audit export access belongs only to approved roles and test revocation/session expiry on the deployed SHA.

## Pilot success scorecard

| Area | Acceptance target | Current evidence |
|---|---|---|
| Booking completion without staff help | at least 85% | Local representative journey passed; client cohort not measured |
| Intake completion before appointment | at least 80% | Full public synthetic intake passed; client cohort not measured |
| Front-desk appointment accuracy | at least 99% | Local targeted correctness/race tests pass; deployed cohort not measured |
| Critical device reading routing | 100% of tested readings | Local signed sandbox critical reading created one alert; live provider unverified |
| Duplicate charges | zero | Local concurrency controls pass; live processor not activated |
| Cross-tenant access | zero successful | Local RLS/auth suites pass; deployed replay pending |
| High-severity production dependency findings | zero | Production dependency audit reported zero; deployment scan/monitor pending |
| Backup/restore | pass or formal waiver | Local pass; managed-provider drill pending |
| Customer-run scenarios without engineering | at least 90% | Not measured; attended demonstration only |
| Open P0/P1 at final review | zero unless signed workaround | Fails: live voice/release blockers remain open |

## Go/no-go sign-off

| Decision authority | Name | Decision/date | Evidence link |
|---|---|---|---|
| Release owner | UNASSIGNED |  |  |
| Security/privacy approver | UNASSIGNED |  |  |
| Voice/provider owner | UNASSIGNED |  |  |
| Clinic operations owner | UNASSIGNED |  |  |
| Bright Health customer representative | UNASSIGNED |  |  |

GO requires every blocking gate closed on one immutable deployed SHA, no unresolved P0/P1 in scoped core journeys, and the signer table completed. A conditional demonstration approval does not authorize production, PHI, live voice, live messaging or unsupervised customer operation.

## Linked evidence

- `docs/testing/BRIGHT_HEALTH_PREPILOT_CERTIFICATION_2026-09-02.md`
- `docs/BACKUP_RESTORE_ROLLBACK_RUNBOOK.md`
- `docs/INCIDENT_AND_INTEGRATION_FAILURE_RUNBOOK.md`
- `docs/PILOT_SUCCESS_METRICS.md`
- `docs/PILOT_RUNBOOK.md`
