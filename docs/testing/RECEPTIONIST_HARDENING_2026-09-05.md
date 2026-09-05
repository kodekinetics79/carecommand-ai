# Receptionist implementation and live evidence — 2026-09-05

Verdict: **NO-GO for client certification; implementation in progress.** Local
regressions are not live voice, EHR, load, or multi-role acceptance evidence.

## Environment and tenant

- Source baseline: `14f7296f02529513521435213efd7d309cbab964`, branch
  `feat/today-workspace-redesign`, repository `kodekinetics79/carecommand-ai`.
- Production UI: https://carecommand.kodekinetics.com ; Render service:
  `srv-d92049kvikkc73bi4ef0`. Release SHA verification must be recorded after deployment.
- Production initially listed Test Clinic LLC and Harley Street Medical Group,
  not Bright Health. Historical local Bright Health evidence is not production evidence.
- User chose a separate tenant. Prepared Bright Health LLC / `bright-health-llc`,
  Enterprise selection, Arlington initial branch, America/New_York. User entered
  owner credentials and submitted the platform form. UI confirmed Company created.
- Clinic sign-in verified Bright Health Pilot Admin / Owner, Bright Health LLC,
  one clinic, no recorded work. Administration showed one active user, one branch,
  three audit events; Control Plane subsequently showed four events.
- Eligibility and card payments are explicitly Test data / not configured live.
- Platform reload returns to login by intentional memory-only token design
  (`src/lib/platformAdmin.ts`); not classified as a security defect and not weakened.

## Defect and gap register

### BH-VOICE-001 — P1 — contradictory emergency exit and false follow-up

- Category/module: patient safety, AI receptionist.
- Reproduction: create an approved US call fixture; invoke `report_emergency`
  with and without a configured human fallback. Inspect its message and next_action.
- Expected: immediate jurisdiction-appropriate emergency instruction, no hold or
  promise of a transfer/callback that the system has not delivered.
- Actual baseline: after saying hang up/call 911, output appended either stay on
  the line/connecting you or someone will call you straight back. Only a staff
  task had been recorded. Prompt reinforced the contradiction.
- Impact: caller could delay emergency help or rely on nonexistent follow-up.
- Evidence: `server/test/receptionistCallerSafety.integration.test.ts` and
  `server/test/receptionistCallerSafety.unit.test.ts`; baseline diff in this change.
- Root cause: configured destination and durable task conflated with confirmed
  communication; ordinary model tools remained available after an emergency.
- Remediation: terminal `end_emergency_flow`; truthful provider/task outcome fields;
  server guard blocks ordinary tools on the same call after an emergency task,
  even if completed. DNC/privacy withdrawal remain allowed. No clinic transfer
  or closing script may delay emergency exit. This is not an emergency dispatch service.
- Retest: local integration/unit PASS. Live provider speech/exit still EXTERNAL_BLOCKED
  pending approved clinic configuration, publication and controlled live call.
- Limitation: guard serializes subsequent decisions, not in-flight simultaneous
  tool executions; native provider transfer behavior requires live testing.

### BH-VOICE-002 — P1 — scripts promise unconfirmed callbacks

- Category/module: workflow truth, approved locale packs.
- Reproduction: use baseline approved default message/handoff/comprehension scripts.
- Expected: distinguish a recorded staff request from a scheduled/delivered callback.
- Actual: callbacks and human response were promised based on task creation alone.
- Impact: missed follow-up and misleading patient expectations.
- Evidence: `receptionistOutcomeTruth.unit.test.ts`, legacy-approval integration case.
- Remediation: default pack v3 uses truthful wording; validator rejects known unsafe
  English promise/hold phrases. Existing unsafe approvals fail activation and require
  revision/reapproval, without rewriting historical evidence. Live tool fallback uses
  safe platform words; existing provider prompts still require republication.
- Retest: local PASS; live approval/republication pending. Phrase detection is
  limited defense-in-depth, not a semantic guarantee for arbitrary wording/languages.

### BH-VOICE-003 — P2 — warm-transfer claim with cold-transfer configuration

- Category/module: missing capability / AI prompt.
- Reproduction: compare generated transfer instruction with Retell tool configuration.
- Expected: speech matches configured mechanism.
- Actual baseline: instructed AI to brief staff before leaving, while configuration
  specified cold_transfer.
- Impact: buyer expectation and caller continuity mismatch.
- Evidence: `receptionistCallerExperience.unit.test.ts`; prompt snapshots.
- Remediation: prompt accurately describes cold transfer and task-backed context.
  Genuine warm transfer remains a separate capability, not claimed implemented.
- Retest: local PASS; actual staff answer/failure flow not yet live-proven.

### BH-SETUP-001 — P1 for self-service multi-clinic pilot — missing branch creation UI

- Category/module: missing wiring, tenant setup.
- Reproduction: sign into new Bright Health owner; Administration > Workspace
  Overview > Practice Locations; Control Plane > Clinics & Tenants.
- Expected: owner can add a clinic/branch and configure its timezone.
- Actual observed: locations are read-only; Control Plane only exposes dependency-aware
  closure. Receptionist Studio creates a separate receptionist clinic entity.
- Impact: new multi-location customer cannot complete branch setup in discovered UI.
- Evidence: production browser views; `server/modules/branches/routes.ts` has a
  create endpoint, while discovered administration controls do not expose it.
- Root-cause hypothesis: backend branch creation is not wired into tenant setup UI.
- Remediation: narrow owner/admin branch creation form using existing scoped API,
  validation, audit, and duplicate-submit protection; no backend seed workaround.
- Remediation implemented: owner/admin Add clinic form in Administration and
  Control Plane; existing scoped branch endpoint now serializes duplicate names
  per tenant and writes branch plus audit atomically. Form blocks in-flight
  duplicates, retains failed input, and makes timezone explicit.
- Retest: 13 tests PASS across branch API, new form, existing Settings journey.
  Includes concurrent duplicate requests (201/409, one row/audit), identical names
  in different tenants, rejected foreign tenant input, front-desk 403, invalid
  timezone 400, form success/failure and disabled duplicate submit. Browser retest pending.

## Verification performed

### BH-SETUP-002 — P2 — destination conflict mislabeled as server error

- Reproduction: Bright Health > Receptionist Studio > Create Clinic; US/en-US,
  America/New_York, supplied DID +15717391177; submit.
- Expected: safe destination conflict, no reassignment or duplicate clinic.
- Actual: assignment refused with correct explanatory text, but code
  INTERNAL_SERVER_ERROR. Existing assignment was preserved; no provider action.
- Impact: confusing support diagnosis; live Bright Health setup blocked by the
  existing number assignment (not by lack of number input).
- Root cause: global error handler uses INTERNAL_SERVER_ERROR for code-less 4xx.
- Remediation: preserve explicit domain codes; use HTTP_<status> for expected 4xx.
- Evidence/retest: `httpErrorClassification.unit.test.ts`, four tests PASS;
  production retest pending. Server typecheck and lint rerun PASS after this fix.
- User clarified the number model: +15717391177 is outbound-only and customer
  numbers are inbound. Do not reassign this outbound number to Bright Health's
  inbound configuration. User created the receptionist clinic using the authorized
  number ending 5555 as its public phone; dedicated AI voice line remains blank.
  Actual customer-number routing/import/forwarding still needs provider verification.

## Release and setup update

- Safety release `6b73aedf30a4e595bd03e1da48842c50a1d5351b` pushed to main and live
  on Render (`dep-dae0gkc9v7es73ao9m1g`, auto-deploy, 1m11s).
- `/health` confirmed that SHA at 2026-09-05T12:20:03Z; `/health/ready` reports
  database, Redis, and ingressProxy OK. This is service health, not live-call proof.
- Bright Health receptionist profile exists, public phone ending 5555; synthetic
  Arlington address, US/en-US, America/New_York, weekday 09:00–17:00, weekends closed.
  Fallback is authorized test destination ending 6009. No calls initiated.
- Architecture check: `RETELL_FROM_NUMBER` is separate from clinic inbound binding
  in `retellDeploy.ts`. Preserve this distinction. A shared outbound number's return
  calls cannot automatically identify a tenant; never guess using caller identity.
- Confirmed number roadmap: +15717391177 is a shared outbound-only caller ID for
  now. Each customer uses its own verified inbound number. Later, each customer
  also receives a separately configured, provider-verified outbound caller ID.
  This future per-tenant outbound selection is a requirement, not a completed
  capability: the current `createPhoneCall` payload uses the process-wide default.
  Acceptance for that change must prove server-side tenant ownership, the correct
  caller ID and agent on calls and retries, tenant-scoped logs, and rejection of
  unverified or cross-tenant numbers. A failed dedicated-number configuration must
  not silently substitute another customer's number. Shared fallback, if retained
  during migration, must be explicit and auditable. Do not bind the shared outbound
  number as any customer's inbound receptionist line.

- `npm run check`: PASS (schema validation, server typecheck, lint, production build).
- Final focused suite: 10 files / 122 tests PASS, 16.44 s; disposable local Postgres
  on 55432 with 129 migrations, local Redis 56379. No production load generated.
- Separate campaign readiness / fixture / prompt run: 3 files / 49 tests PASS;
  four intended prompt snapshots updated. Counts overlap; do not sum as unique tests.
- Browser: company provisioning, owner login, tenant identity, empty-state dashboard,
  administration/control-plane reads PASS. Synthetic-only tenant, no patient data yet.
- Call ledger: **no calls placed in this run**. No duration/status/transcript evidence.
- Allowed outbound destinations only: ending 5555, 6009, 5556 from the user's full
  authorized numbers. Suffix 9695 is incomplete and must not be dialed. Receptionist
  DID +15717391177 is not an additional outbound test destination.

## First EHR decision and acceptance boundary

CTO selection: **athenahealth athenaOne** as the first connector target, subject to
the actual pilot customer's installed system. This is a product prioritization
decision, not a claim of working integration or compatibility with every athena product.

Official sources reviewed 2026-09-05:

- https://www.athenahealth.com/developer-portal describes APIs, interfaces and developer resources.
- https://docs.athenahealth.com/api/api-ref/appointment (read in Chrome after static
  extraction returned empty). Documents booking, read-back, cancellation and rescheduling.
  Booking is PUT `/v1/{practiceid}/appointments/{appointmentid}` with form-encoded
  patient ID and appropriate reason. Web scheduling requires patient appointment
  reasons, not staff-only appointment-type selection. Rescheduling requires a
  replacement slot ID. Preserve schedulability restrictions and department-local time.
  The page also announces Fall 2026 breaking-change testing due October 1.
- https://mydata.athenahealth.com/access-the-apis covers athenaPractice/athenaFlow
  sandboxes, not proof of athenaOne booking write-back. Do not substitute those APIs.

No connector has been called or marked connected. EXTERNAL_BLOCKED evidence needs:
authorized developer app/sandbox credentials, exact athenaOne practice/department,
provider and appointment-type mappings, approved scopes, and vendor access terms.
Never place secrets in this document or browser-visible logs.

First acceptance slice: read mapped providers/services/open slots; verify synthetic
patient; book once; read back provider appointment ID; reschedule/cancel with reread;
reconcile ambiguous timeouts before retry; prove cross-tenant mapping isolation,
rate-limit handling and staff recovery. Local booking must not pretend EHR write-back
succeeded. Clinical decisions, prescriptions and coverage determinations remain human-owned.

## Remaining delivery sequence

### Continued customer run: clinic provisioning and release recovery

- Clinic release `fdbb97cdc2c552d43a7d252379c237c37dcf9b05` pushed to main;
  Render health confirmed that exact production SHA at 2026-09-05T12:44:47Z.
  Production owner UI created **Bright Health — Irvine**. Duplicate submission
  was refused with a useful conflict message and retained form values; two
  branches remained. Local branch/HTTP/component suite: 13 passed, zero failed.
- Receptionist location mappings now show Arlington / America/New_York and
  Irvine / America/Los_Angeles. Both have explicitly synthetic addresses and
  access notes. Contact numbers are authorized destinations ending 5555/5556;
  neither this setup nor the shared outbound number is proof of inbound binding.
- Live calls remain blocked by `agent_linked` and
  `live_test_tenant_not_authorized`. The configured attended-test scope is not
  Bright Health. No calls placed and no admission/security checks bypassed.

#### BH-UI-001 — P1 — deployment entry failure leaves a blank workspace

- Category/module: reliability defect / application startup.
- Reproduction: keep the production app open across the frontend release;
  reload Administration while the old document still references the prior entry.
- Expected: current app or actionable recovery UI. Actual: blank root, no message.
- Evidence: CUA blank-page screenshot and empty DOM; requested entry
  `/assets/index-B29ql2ZS.js` returned HTTP 200 **text/html**, not JavaScript, at
  12:44:46Z. A second reload after deployment settled recovered Administration.
- Impact: staff cannot operate the application during this version-skew failure.
- Root-cause hypothesis: missing old entry asset meets SPA catch-all; existing
  dynamic-import recovery lives inside the entry and cannot run if it never loads.
- Remediation: independent early bootstrap, one reload per entry signature,
  visible static fallback/manual reload, and fail-safe behavior if storage is denied.
  No CSP relaxation, credential access, data mutation or infinite retry loop.
- Retest: local Chrome fault injection using built HTML and a deliberately missing
  entry showed the recovery message. Server observed exactly two document requests
  (initial plus one automatic retry), not a loop. Five unit tests PASS. Production
  normal-startup retest pending the follow-up release; historical stale documents
  without the bootstrap still need manual reload.
- Reference: https://vite.dev/guide/build#load-error-handling distinguishes dynamic
  import errors; this change handles the earlier entry-load failure separately.

#### BH-UI-002 — P2 — Administration overflows a narrow workspace

- Category/module: responsive UX defect / Administration navigation.
- Reproduction: open Settings at a measured 675px viewport; open Add clinic and
  focus fields. Expected: contained tabs and fully visible form. Actual: a 1062px
  navigation grid stretched content; root scrollWidth 1077px and scrollLeft 48px
  clipped the left side. Evidence: CUA screenshot and DOM bounding measurements.
- Impact: narrow-window users lose labels and working space.
- Root cause: automatic grid minimum and non-shrinkable navigation item.
- Remediation: explicit single-column minmax grid on narrow screens and min-w-0
  navigation; desktop content track also minmax(0,1fr).
- Retest: structural regression test PASS; exact rendered retest pending deployment.

1. Release safety fixes; approve revised locale pack and republish provider prompt.
2. Complete Bright Health branch/provider/service/hours setup through owner UI.
3. Prove authorized live call, task handoff, booking and provider failure recovery.
4. Configure approved transactional delivery; prove password reset and confirmation delivery.
5. Build and prove athenaOne connector with vendor sandbox access.
6. Add structured waitlist, refill/referral staff workflows and omnichannel continuity.
7. Retest multi-role/tenancy/concurrency, accessibility and measured operational reporting.

Do not label these pending items complete, imply legal/HIPAA certification, or claim
superiority over all competitors from this evidence.
