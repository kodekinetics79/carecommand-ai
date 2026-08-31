# Outbound test coverage audit — what the suite actually asserts

SDET audit, 2026-08-31, branch `main`. Scope: **what the existing test suite genuinely
asserts about the OUTBOUND path, and where the holes are.** This is not an architecture
document, a reliability review, or a post-mortem — those are
`OUTBOUND_CAMPAIGN_DESIGN.md`, `OUTBOUND_RELIABILITY_REVIEW.md` and
`PROVIDER_TEST_STRATEGY.md` respectively. It is also deliberately silent on the stuck-call,
reconciliation and active-call-blocking scenarios being written into
`server/test/receptionistOutboundCallLifecycle.integration.test.ts`.

Method: static reachability analysis of every test that touches the outbound path, read
against `server/modules/receptionist/outbound.ts` (2,903 lines),
`server/modules/receptionist/webhooks.ts` (1,814 lines),
`server/lib/receptionist/dncFence.ts`, `server/lib/receptionist/liveCallUat.ts` and
`prisma/migrations/20260730250000_receptionist_delivery_consent_integrity/migration.sql`.
The "delete the guard" claims in section 3 are **argued statically, not executed** — each
one names the exact line to delete and the exact assertion that would (not) catch it, so
they are cheap to confirm.

---

## 0. Headline

The outbound suite is **much stronger than its reputation on the provider boundary and much
weaker than its reputation everywhere else.** Concretely:

| | |
|---|---|
| Repo-wide declared test blocks | **2,198** across 195 server + 55 client test files (≈2,400 executed cases after `it.each` expansion) |
| Test files with material outbound coverage | **16** (13 under `server/test`, 2 client component, 1 Playwright) — plus ~6 more carrying only incidental `direction: 'outbound'` fixtures |
| Outbound `expect()` calls in those 16 files | **≈500**, of which **275 sit in one file** |
| Outbound assertions that are **skipped by default** | **57** (`receptionistDeliveryConsentIntegrity.integration.test.ts`, 13 tests, gated on `RLS_DISPOSABLE_DB`) |
| Outbound assertions that are **source-string greps, not behaviour** | **37 of 37** in `receptionistLiveUatContract.unit.test.ts` |
| Distinct `blocked`/`skipped` reasons `/call` can emit | **25** |
| …of those with **zero** reference in any test file | **17** |
| Times any test observes a `ReceptionistCallTarget` reach `COMPLETED` | **0** |
| Times any test observes a target reach `OPTED_OUT` | **0** |
| Tests that drive a target through a terminal `call_ended` webhook | **0** |
| Executing tests for `POST …/call-logs/:id/provider-sync` (≈190 lines) | **0** |

The suite's centre of gravity is the ~1,100 lines between "reserve the attempt" and
"the provider said yes" (`outbound.ts:1540-2620`). That stretch is genuinely, unusually well
tested — deterministic interleaving hooks, 11 parameterised provider-HTTP-status cases,
kill-switch races at four distinct points. **Everything on either side of it is thin:**
target selection is untested, quiet hours at dispatch is untested, the whole
post-call half of the lifecycle (webhook → outcome → target status → appointment effect) is
untested, and the campaign concept itself (select many, dial many, write results back) does
not exist to be tested.

---

## 1. Inventory

### 1.1 Server tests

| File | Blocks / `expect()` | What it genuinely asserts | What it only appears to assert |
|---|---|---|---|
| `server/test/receptionistOutboundTargets.integration.test.ts` (2,401 lines) | 46 declared / **275** (≈66 cases after 7 `it.each`) | The real spine. Real Fastify + real Postgres + real `createPhoneCall` with `fetch` stubbed at the HTTP boundary. Provider-acceptance semantics for 11 HTTP statuses; kill-switch racing at `before_suppression_fence`, `provider_intent_committed`, `before_provider_binding_lock`, `provider_binding_committed`; provider-ID collision and reuse; stale-stop application; client-attempt token fencing; concurrency and voice-minute ceilings; deployment-mismatch circuit; cross-tenant isolation. | Quiet hours: 5 of its 8 quiet-hours assertions are on the **pure function** `quietHoursConfigurationReason`/`isWithinQuietHours`; the one dispatch-level test (`:1571`) only reaches the *misconfiguration* branch (`quiet_hours_timezone_invalid`). Nothing dials into a live quiet window. Suppression: both DNC tests (`:569`, `:603`) assert `shared_suppression_gate`, which is produced by the **provider-intent layer** (`outbound.ts:1902`, `providerIntentBlockReason`), not the front-door gates. Webhooks: only 4 injects, 3 of them intent-recovery; the single terminal-outcome webhook (`:2383`) has **no `targetId`**, so the target-status branch never runs. |
| `server/test/receptionistDeliveryConsentIntegrity.integration.test.ts` (616 lines) | 13 / **57** | The best tests in the module — direct exercise of `authorizeOutboundProviderIntentTx` and its DB trigger: DNC ordered before/after intent, consent purpose/policy exactness, revocation precedence on tied timestamps, DB-clock evaluation, identity re-read under a concurrent phone update, raw-SQL forgery under `app_rls`, append-only enforcement. | **`describeDisposable = process.env.RLS_DISPOSABLE_DB ? describe : describe.skip` (`:25`).** `npm test` is plain `vitest run` with no such variable, so all 13 tests and all 57 assertions **skip silently on every ordinary run**. Already flagged as `A6-F21` in `PILOT_PROGRAM_PHASE1_A6_OUTBOUND_2026-08-29.md:61`; the coverage consequence is that the consent/DNC layer is unpinned in normal CI. |
| `server/test/receptionistOutboundSignedBooking.integration.test.ts` (266 lines) | 1 / 22 | The **only** end-to-end journey: create → approve → add target → launch → signed in-call `record_recording_preference` / `verify_patient_identity` / `book_appointment` → canonical `Appointment` + `AppointmentRequest(BOOKED)` + `ReceptionistOutboundProviderIntent`. Genuinely covers the direct-booking authority chain. | **Stops one step short of the product outcome.** It never sends `call_ended`, so `targetStatusAfterOutcome` never runs and the test never asserts the target's terminal status — the target is left `CALLING` at the end of the only happy-path journey the suite has. |
| `server/test/receptionistOutboundCompliance.unit.test.ts` (22 lines) | 2 / 10 | `isTargetDialable` and `targetStatusAfterOutcome` as pure functions, including the retry-allowance boundary. Correct and cheap. | This is the **entire** coverage of target-state transitions. The function is never observed driving a real row from any of its three call sites (`webhooks.ts:1176`, `outbound.ts:2256`, `outbound.ts:2738`). |
| `server/test/receptionistP0Reliability.unit.test.ts` (272 lines) | 11 / 34 | The `POST /v2/create-phone-call` wire contract: `override_agent_id`, `override_agent_version`, `agent_override.agent.{webhook_url,webhook_events,data_storage_setting,opt_in_signed_url,max_call_duration_ms}`, loopback-webhook omission, deployment-mismatch stop-and-reject. Real body parsing, not a stub. | Inputs are hand-written literals (`toNumber: '+12125550101'`, `dynamicVariables: { first_name: 'Taylor' }`). **Nothing connects this to what the route actually assembles** — no test asserts that `/call` puts the *target's* number in `to_number` or the *campaign's* script/first_name/appointment context in `retell_llm_dynamic_variables`. Grep for `to_number` across `server/test/` returns only inbound webhook fixtures. |
| `server/test/receptionistLiveUatContract.unit.test.ts` (77 lines) | 5 / **37** | Nothing behavioural. | **37 of 37 `expect()` calls are `toContain()` against `readFileSync` of source files.** See §3.6 — this is the sole "coverage" of the live-test call cap, single-active-call, minute cap, cost cap and the entire `provider-sync` route, and each grep matches an unrelated line that survives deleting the enforcement. |
| `server/test/receptionistLiveCallUat.unit.test.ts` (126 lines) | 5 / 19 | `evaluateLiveCallAdmission`, `authorizeLiveCallDestination`, `liveCallUatStatus`, `maskPhone`/`maskProviderId` as pure functions with `env` stubbed. Genuinely correct. | Never reaches the route. `LIVE_TEST_CALLS_AUTHORIZED` defaults `false` (`server/config/env.ts:243`) and is set `true` only here and in `envSchema.test.ts`, so `outbound.ts:1416-1441` and `:1566-1596` (the live-test branch of `/call`) execute in **zero** vitest runs. |
| `server/test/receptionistProviderIntentCorrelation.unit.test.ts` (70 lines) | 3 / 8 | Signed provider-intent metadata: authentication, revalidation of the full persisted context, rejection of forged/malformed/nonce-replayed metadata. Good. | Pure-function scope; the crash-window recovery that consumes it is covered separately at `receptionistOutboundTargets:680`. |
| `server/test/receptionistArtifactAccess.compliance.integration.test.ts` (256 lines) | 7 / 31 | Real read-authorisation coverage of the outbound read surfaces: recording-URL redaction, `RoleDefinition` grant/revoke, tenant isolation on call detail, and `:230` enumerates "every outbound read surface that can return contact or collected patient data". | Read-side only. Says nothing about write or dial authorisation. |
| `server/test/receptionistBooking.integration.test.ts` (1,082 lines) | 26 / 161 | `:1155-1170` is the **only** test of the plain (non-racing) opt-out skip: `{status:'skipped', reason:'opted_out'}` and no `IN_PROGRESS` call log. `:1172-1180` is its negative contrast. Also the whole signed in-call tool surface. | The opt-out test's own title claims it "records OPTED_OUT" — **it asserts neither the `OPTED_OUT` call log nor the target status change**, and (see §3.1) neither actually happens. The contrast test only proves the gate is specific up to `setup_required`, because Retell is unconfigured in that file. |
| `server/test/receptionistSecurity.integration.test.ts` (383 lines) | 14 / 61 | Retell webhook signature verification, per-call event rate limiting, terminal-state idempotency under redelivery (205 concurrent calls; `call_analyzed` ×2 → one minute increment). Real and valuable. | Every one of its `direction: 'outbound'` call logs is created with **no `targetId` and no `outboundCampaignId`**, so the outbound target-status branch (`webhooks.ts:1171-1186`) is never entered. This is the file that *looks* like it covers outbound webhook lifecycle and does not. |
| `server/test/receptionistConfiguration.integration.test.ts` (1,076 lines) | 14 / 148 | `:873-925` — an unverified/stale agent cannot activate an outbound campaign; PATCH→RUNNING is refused with `outbound_authority_approval_required`; approve is refused. Genuine authority coverage. | Configuration-time only. |
| `server/test/receptionistAfterHours.integration.test.ts`, `frontDeskBoardCounts`, `commsDelivery`, `operationsReply`, `receptionistRemediation*` | — | Incidental `direction: 'outbound'` fixtures for other subjects. | Contribute no outbound-path coverage. |

**Adjacent but not outbound-voice:** `optOutFence.integration.test.ts` (17 tests) and
`campaignDispatchFence.integration.test.ts` (16 tests) are thorough suppression-fence and
dispatch-claim suites for the **CRM/SMS campaign engine**, not the receptionist voice path.
They are frequently miscounted as outbound coverage. They do prove the shared
`lockDncDestinationFence` / `lockSuppressionFences` primitives work, which the voice path
reuses.

### 1.2 Client tests

1,388 lines of outbound UI under `src/components/receptionist/outbound/`; two test files.

| File | Blocks / `expect()` | Genuine | Apparent |
|---|---|---|---|
| `src/components/receptionist/outbound/TargetList.test.tsx` (94 lines) | 3 / 16 | Distinguishes the three candidate-load states (409 policy-missing → guided state; 500 → alert + retry; `[]` → empty). Real jsdom rendering. | Never touches `readyCandidates = candidates.filter(c => c.voiceAuthorizationReady)` (`TargetList.tsx:100`) or the `disabled={!canCall || t.status !== 'PENDING' || !consentReady}` call button (`:154`). Every render passes `targets={[]}` and `canCall={false}`, so **the only authorisation logic in the component is never exercised**. |
| `src/components/receptionist/outbound/VoiceLineStatusCard.test.tsx` (116 lines) | 7 / 18 | Blocker rendering, live-test block presence/absence, mock badge, verification-expiry auto-renew wording. Good. | Presentation only. |
| `server/test/receptionistFrontendContract.unit.test.ts` (170 lines) | 11 / 36 | `parseLaunchResult` / `presentLaunchResult` fail closed on unknown and malformed statuses; `launchCall` turns a lost response into `transport_ambiguous`; reconciliation-warning persistence. Strong client-side discipline. | Every server shape is a **hand-written literal**. Nothing pins the server to them — if `/call` renamed a reason or added one, this file stays green and the UI silently degrades to "unknown_response". It is the only place the string `'quiet_hours'` (the runtime skip reason) appears in any test. |

**Untested outbound UI:** `CampaignBuilder.tsx` (146), `CampaignDetail.tsx` (337 — the file
that contains the entire launch flow), `OutboundPanel.tsx` (146), `BookingRequestQueue.tsx`
(141), `ConfirmationDeliveryQueue.tsx` (55), `OutboundStopCard.tsx` (56),
`campaignPayload.ts` (32). **905 of 1,388 lines, including every mutation the operator can
perform, have no test.**

### 1.3 Playwright

`tests/e2e/receptionist-live-uat.spec.ts` (287 lines, 2 tests, 36 assertions) —
`test.skip(!LIVE_RUN_REQUESTED)` at `:182`, gated on `RUN_LIVE_VOICE_UAT=true` plus nine
required env vars, a **real** Retell key, `E2E_USE_INSTALLED_CHROME=true` and
`E2E_HEADLESS=false`. It never runs unattended. There is no headless E2E of the outbound
Studio flow.

---

## 2. Coverage matrix against the real outbound flow

Legend: **W** well covered (a behavioural test fails if the behaviour breaks) · **S** shallow
(covered only as a pure function, a source grep, a UI-only guard, or in a skipped suite) ·
**U** untested.

| # | Step | Implementation | Verdict | Evidence / why |
|---|---|---|---|---|
| 1 | Campaign create | `outbound.ts:793-826` | **W** | `receptionistOutboundTargets:1693` (empty-string→null), `:1571` (quiet-hours syntax/equal), `receptionistConfiguration:889` (unverified agent). |
| 2 | Campaign edit / pause | `outbound.ts:827-899` | **S** | `receptionistOutboundTargets:1656` covers the Zod-`.partial()` one-field PATCH regression. No test of the `authorityChanged` matrix (16 fields, `:850-866`) beyond that one. No UI test at all. |
| 3 | Approve (OWNER/ADMIN + frozen fingerprint) | `outbound.ts:900-954` | **W** | `:1620` (MANAGER refused, authority frozen), `:1735` (direct-booking attestation frozen), `receptionistConfiguration:904`. |
| 4 | Target candidate selection | `outbound.ts:956-1030` | **S** | `TargetList.test.tsx` covers only the three *load* states. Nothing asserts the `voiceAuthorizationReady` / `voiceAuthorizationReason` computation (`isChannelSuppressedTx` + `compatibleVoiceConsentEventTx` per candidate), the `take: 50` + `take: 50` cap, or the `q` filter. |
| 5 | Target add (identity binding, dedupe) | `outbound.ts:1037-1092` | **W** | `:1859` (exactly one tenant-owned identity, canonical phone, DB constraint), `:1896` (duplicate within batch and against existing). |
| 6 | Authorisation / DNC at target-add time | — | **U** | **There is no server-side suppression or consent check on `POST /targets`.** The filter lives only in the browser (`TargetList.tsx:100`). No test covers the API accepting a suppressed identity as a target. |
| 7 | Launch attempt (client token) | `outbound.ts:1242-1344` | **W** | `:1962` (cleared token rejects every late submission), `:1992` (dispatch claims first, then clears on definitive rejection). |
| 8 | Pre-dial gates: status, authority, agent readiness | `outbound.ts:1365-1402` | **S** | The paths execute inside other tests but **no test asserts their reasons**: `campaign_not_running`, `outbound_authority_unapproved`, `agent_required` have **zero** references anywhere (§3.7 table). |
| 9 | Pre-dial gates: destination and identity binding | `outbound.ts:1432-1466` | **U** | `invalid_e164_destination`, `adhoc_call_not_authorized`, `target_identity_unbound`, `target_identity_mismatch`: **zero** test references. Only `target_not_dialable` is pinned (`:2090`). |
| 10 | DNC / suppression at dial | `outbound.ts:1470-1494` | **S** | One test (`receptionistBooking:1156`). It asserts status/reason only — and the 16-line "compliance gate" block below it is unreachable (§3.1). |
| 11 | Quiet hours at dial | `outbound.ts:1500-1522`, `:1856-1865` | **U** | Only the *misconfiguration* reasons are asserted. **No test dials into an active quiet window** (§3.2). |
| 12 | Capacity: kill switch, concurrency, voice minutes, demo mode | `outbound.ts:1403`, `:1620-1640` | **W** | `:2131` (429 concurrency at exactly `MAX_TENANT_ACTIVE_CALLS`, 402 minutes, target stays `PENDING`/`attempts:0`), `:2194` (emergency stop). `TENANT_MODE_DEMO_BLOCK` is the exception: zero references. |
| 13 | Boundary re-check before provider submit | `outbound.ts:1729-1795` | **W** | `:1754` (Studio pause serialises ahead of the intent), `:991` (campaign pause releases target and attempt). |
| 14 | Provider-intent authorisation (suppression + consent linearisation) | `dncFence.ts:158-279` + DB trigger | **W but layered — see §3.3** | Behaviour pinned by `:569`, `:603`, `:635`, `:852`; the trigger and the app check are individually deletable. Direct unit coverage is in the **skipped** suite. |
| 15 | Provider submit (payload contract) | `retell.ts:271-345` | **S** | `receptionistP0Reliability` pins the wire shape from synthetic inputs. **No test asserts what the route puts in it** — `to_number`, `first_name`, `script`, `appointment_type`, `booking_mode`, `consent_text`, `disclosure`, the hours dynamic variables. |
| 16 | Provider accept / reject semantics | `outbound.ts:1900-2410` | **W** | 11 parameterised HTTP-status cases (`:2048`, `:2097`) with correct `rejected` vs `unknown` acceptance, target state and review evidence. Best-covered code in the module. |
| 17 | Provider binding + collision | `outbound.ts:2418-2500` | **W** | `:421` (reused bound call ID), `:1210` (stop snapshot vs atomic binding), `:680` (crash-window recovery from signed metadata). |
| 18 | Lifecycle webhooks (`call_started`/`ended`/`analyzed`) for an outbound target | `webhooks.ts:1058-1190` | **U** | 4 webhook injects in the outbound suite; 3 are intent-recovery, 1 is a terminal `OPTED_OUT` with **no target**. `receptionistSecurity`'s outbound webhook tests likewise have no target. |
| 19 | Terminal outcome → target status | `webhooks.ts:1171-1186`, `outbound.ts:2738-2750` | **U** | `targetStatusAfterOutcome` is tested only as a pure function. **No test ever observes a target reach `COMPLETED` or `OPTED_OUT`** — grep across all test files returns only `PENDING`, `CALLING` and `FAILED`. |
| 20 | Provider polling fallback (`provider-sync`) | `outbound.ts:2623-2815` (~190 lines) | **U** | **Zero executing tests.** The only reference is `expect(outboundSource).toContain("call-logs/:id/provider-sync")` (`receptionistLiveUatContract:53`). This is the only code path that can resolve a call when no webhook arrives. |
| 21 | Appointment effect (confirm / cancel write-back) | — | **N/A — does not exist** | `CallOutcome` is `IN_PROGRESS \| BOOKED \| NOT_INTERESTED \| NO_ANSWER \| VOICEMAIL \| ESCALATED \| OPTED_OUT \| FAILED` (`webhooks.ts:1019`). There is no `CONFIRMED`/`CANCELLED`/`RESCHEDULED`. `ReceptionistCallTarget` (`schema.prisma:3180-3207`) has `patientId`/`leadId` but **no `appointmentId`**. `confirmationOutbox.ts:14` is `'sms' \| 'email'` only. Nothing to test. |
| 22 | Dialler / scheduler | — | **N/A — does not exist** | No worker references `ReceptionistOutboundCampaign` or `ReceptionistCallTarget` (`server/workers/*`). The only caller of `/call` is a per-row button in `CampaignDetail.tsx:91`. `SCHEDULED` appears only in enums. |

Nine of the twenty-two implemented steps are **W**; all nine sit in the provider-boundary
stretch. The clinic-facing halves — *choose who to call* and *record what happened* — are
shallow or untested end to end.

---

## 3. The safety claims, adversarially

For each claim: can I delete a named guard and keep the suite green? Each verdict names the
exact deletion and the exact assertion that fails to catch it.

### 3.1 DNC fence — **the front-door evidence path is dead code and nothing notices**

`outbound.ts:1470-1477` calls `isSuppressed(tenantId, {patientId, leadId, destination}, 'voice')`.
`isSuppressed` (`server/lib/campaigns.ts:612-626`) already ends with
`if (target.destination && await isDestinationOptedOut(tenantId, target.destination, channel)) return true;`.

The very next block, `outbound.ts:1479-1494`, calls
`isDestinationOptedOut(tenantId, canonicalDialDestination, 'voice')` — **the identical call
with the identical arguments**. It is unreachable. Its comment ("Record + skip, no dial")
describes behaviour that never happens: the `ReceptionistCallLog` with `outcome: 'OPTED_OUT'`
is never created, and `receptionistCallTarget.updateMany({... status: 'OPTED_OUT' ...})`
(`:1491`) never runs. **A suppressed target is never terminalised.** It stays `PENDING`
forever and every launch returns `skipped/opted_out` again. (Independently observed in
`PILOT_PROGRAM_PHASE1_A6_OUTBOUND_2026-08-29.md` — this audit adds *why the suite cannot see
it*.)

- **Delete `outbound.ts:1479-1494` entirely → green.** `receptionistBooking:1156` asserts only
  `statusCode === 200`, `status === 'skipped'`, `reason === 'opted_out'` and
  `count({outcome:'IN_PROGRESS'}) === 0`. All four still hold, because the earlier gate
  answers identically.
- **Delete `outbound.ts:1470-1477` (the live gate) → still green.** `isSuppressed` is called
  again at the boundary re-check (`:1782`) and the same suppression is re-evaluated inside
  `authorizeOutboundProviderIntentTx` and by the DB trigger. No call escapes — but the
  response contract silently changes from `200 skipped/opted_out` to `409 blocked/shared_suppression_gate`,
  a reason the client maps to a red "do not retry" state (`receptionistFrontendContract:50`),
  and `receptionistBooking:1156` would then fail. So this one *is* pinned. Good.
- **What is not pinned:** the DNC *evidence* (the `OPTED_OUT` call log and the audit event)
  and the target terminalisation. No assertion anywhere covers either.

### 3.2 Quiet hours — **the runtime gate can be deleted twice over and the suite stays green**

Two enforcement points: `outbound.ts:1515` (`isWithinQuietHours(campaign…)` → `200 skipped/quiet_hours`)
and `outbound.ts:1863` (same check inside the provider-intent transaction → `blocked: 'quiet_hours'`).

Every quiet-hours test in the repo asserts one of five *configuration* reasons
(`quiet_hours_missing/incomplete/invalid/equal/timezone_invalid`), which come from
`quietHoursConfigurationReason` — a different function. Grep confirms it: the string
`'quiet_hours'` (the runtime skip) appears in exactly one test file,
`receptionistFrontendContract.unit.test.ts:50,83` — and there it is a **hand-written literal
fed to the client-side parser**, never a server response.

Worse, the integration harness actively prevents the case from arising:
`quietWindowOutsideNow()` (`receptionistOutboundTargets:43-54`) computes a window starting
60 minutes from now, so **every dispatch test in the suite runs with quiet hours provably
inactive.**

- **Delete `outbound.ts:1515-1518` → green.**
- **Delete `outbound.ts:1863-1865` → green.**
- **Delete both → green.** The clinic dials patients at 03:00 and every test passes.
- Deleting the *configuration* gates is caught: `:1571` asserts `409 quiet_hours_timezone_invalid`
  at dispatch — though even there, deleting only the first gate (`:1506`) leaves the in-transaction
  copy (`:1856`) producing the same reason and status, so that test also cannot distinguish which
  layer holds.

**This is the single most valuable finding in the report.** Quiet hours is the module's most
prominently claimed compliance control and its runtime enforcement has zero behavioural coverage.

### 3.3 Suppression / consent at the provider boundary — **two layers, neither individually pinned**

The strongest control in the module is `authorizeOutboundProviderIntentTx`
(`dncFence.ts:158-279`), backed by an independent PL/pgSQL trigger
`receptionist_outbound_provider_intent_guard`
(`prisma/migrations/20260730250000_.../migration.sql:290-417`) that repeats ownership,
call-boundary, campaign-authority, suppression, legacy-consent and immutable-voice-consent
checks. Genuine defence in depth.

But `providerIntentBlockReason` (`outbound.ts:405-428`) maps **both** the application sentinel
`outbound_provider_intent_suppressed` **and** the trigger message
`'Outbound provider intent is suppressed at the linearization point'` to the same wire reason,
`shared_suppression_gate`. The only tests that observe it (`receptionistOutboundTargets:569`,
`:603`) assert the wire reason.

- **Delete the app check at `dncFence.ts:244-252` → green.** The trigger raises, the reason is
  identical, both tests pass.
- **Drop the trigger from the schema → green.** The app check throws, the reason is identical,
  both tests pass.
- **Only removing both turns the suite red.** The suite pins the *outcome*, never the *layer* —
  so a redesign that "simplifies away" one layer gets no signal, and the surviving layer might be
  the wrong one for the new architecture.
- The tests that *would* discriminate — `receptionistDeliveryConsentIntegrity:150,167,256,311,343,498`,
  which call `authorizeOutboundProviderIntentTx` directly and separately probe the trigger with
  raw SQL under `app_rls` — are the 13 tests that **skip unless `RLS_DISPOSABLE_DB` is set**
  (`:25`). On `npm test` they contribute nothing.

Same structure applies to consent: `positive_voice_consent_missing` is emitted by both layers
and is asserted only via `receptionistOutboundTargets:852` ("launches explicit reactivation only
with exact immutable grant evidence").

### 3.4 Kill switch — **well covered at depth, redundant at the front**

Five re-checks: `outbound.ts:1403`, `:1730`, `:1822`, `:1953`, `:2227`, `:2433`, `:2490`.

- **Delete `outbound.ts:1403` (the front-door check) → green.** `receptionistOutboundTargets:2194`
  asserts `423 / blocked / outbound_stopped`; the boundary re-check at `:1787-1793` produces the
  identical status and reason (plus a `callLogId` the test does not inspect).
- **Delete the deep checks → red.** `:953` (kill switch wins after intent commit → `423 cancelled`,
  call `ESCALATED`, `providerFetch` never called), `:1026` (kill switch during provider flight →
  `stop-call` issued, target `FAILED/OUTBOUND_STOPPED`) and `:1074` (unconfirmed stop → `202
  reconciliation_required` + critical signal + staff task, and the retry is refused) genuinely pin
  the ones that matter.

**Verdict: the strongest safety claim in the module, and honestly earned.** The redundant
front-door check is the only unpinned layer, and it is the least consequential.

### 3.5 Concurrency and voice-minute cost cap — **genuinely covered**

- **Delete `outbound.ts:1626` (`activeCalls >= activeCallLimit`) → red.**
  `receptionistOutboundTargets:2131` fills the tenant to exactly `MAX_TENANT_ACTIVE_CALLS`
  (read from `admissionPolicy.ts:43`, not restated) and asserts `429 / concurrency_limit_reached`
  **and** that the target is still `PENDING` with `attempts: 0` — proving the ceiling is enforced
  *before* the target claim.
- **Delete `outbound.ts:1636` (the minutes gate) → red.** Same test asserts `402 /
  voice_minutes_limit_reached` against period usage (`UsageEvent`), not the lifetime counter.
- **Delete the `+ activeCalls` reservation term at `:1636` → green.** Nothing tests two parallel
  launches racing for the final minute; the test exhausts the allowance serially.
- Metering idempotency is covered (`:2351`: `call_ended` sent twice → `receptionistMinutes: 2`, not 4).

Note for the redesign: `MAX_TENANT_ACTIVE_CALLS = 25` (`admissionPolicy.ts:40`) is a
**tenant-wide** ceiling with no per-campaign or per-minute rate limit. A campaign dialler would
be bounded only by 25 simultaneous calls — untested at that scale and almost certainly the wrong
control for outbound.

### 3.6 Live-test caps (call cap, single-active-call, minute cap, cost cap) — **completely unguarded by tests**

The only "coverage" is `receptionistLiveUatContract.unit.test.ts:26-36`:

```
expect(outboundSource).toContain('live_test_single_active_call');
expect(outboundSource).toContain('live_test_call_cap_reached');
expect(outboundSource).toContain('live_test_minute_cap_reached');
expect(outboundSource).toContain('live_test_cost_cap_reached');
```

Each of those four strings occurs in `outbound.ts` **twice**: once in the type-union cast at
`:1595` and once in the HTTP-status lookup arrays at `:1687-1688`. The lookup arrays are not
enforcement — they only pick 429 vs 402.

- **Change `outbound.ts:1625` from `const activeCallLimit = liveTest ? 1 : MAX_TENANT_ACTIVE_CALLS;`
  to `= MAX_TENANT_ACTIVE_CALLS;` → green.** The single-active-call guarantee is gone; all four
  greps still match.
- **Delete the entire live-test admission block `outbound.ts:1566-1596` → green.** `:1595` goes
  with it, but `:1687-1688` keep every string alive. The call cap, minute cap and cost cap
  disappear silently.
- `receptionistLiveCallUat.unit.test.ts` tests `evaluateLiveCallAdmission` correctly — but as a
  pure function. Because `LIVE_TEST_CALLS_AUTHORIZED` defaults `false`
  (`server/config/env.ts:243`), the route never calls it in any vitest run, so severing the
  route→function wire is invisible.

**These four caps are the guards standing between a UAT and an uncapped provider bill on a real
phone number, and they are protected by `grep`.**

### 3.7 Identity-substitution guards — **seventeen reasons with zero test references**

Enumerating every `reason`/`blocked` literal `/call` can emit and grepping every test file:

| Reason | Test references |
|---|---|
| `adhoc_call_not_authorized` (`:1447`) | **0** |
| `agent_required` (`:1980`) | **0** |
| `campaign_authority_incomplete` (`:1116`) | **0** |
| `campaign_not_running` (`:1368`) | **0** |
| `invalid_e164_destination` (`:1418`) | **0** |
| `live_test_attempt_replayed` / `_token_required` / `_configuration_invalid` | **0** each |
| `outbound_authority_unapproved` (`:1372`) | **0** |
| `provider_binding_mismatch` (`:2668`) | **0** |
| `provider_call_id_missing` (`:2645`) | **0** |
| `provider_ended_without_signed_analysis` | **0** |
| `synthetic_consent_attestation_required` (`:1122`) | **0** |
| `target_identity_changed` (`:1778`) | **0** |
| `target_identity_mismatch` (`:1460`) | **0** |
| `target_identity_unbound` (`:1451`) | **0** |
| `TENANT_MODE_DEMO_BLOCK` (`:1623`) | **0** |
| `campaign_authority_changed` | 1 (client parser literal only) |
| `quiet_hours` | 1 (client parser literal only) |
| `client_attempt_not_claimable`, `shared_suppression_gate`, `target_not_dialable` | 1 each (real) |
| `outbound_stopped` | 2 (1 real) |
| `voice_minutes_limit_reached` | 2 (1 real) |
| `concurrency_limit_reached` | 3 (1 real) |
| `opted_out` | 10 files (1 real for outbound) |

On the identity guards specifically — these are what stop an operator from POSTing a stored
`targetId` with somebody else's phone number:

- **Delete `outbound.ts:1449-1452` (`targetIdentityIsBound`) → green.** The identity→destination
  re-read still happens in `dncFence.ts:241-243`, so the dial still fails closed. But the *only*
  test of that deeper re-read is
  `receptionistDeliveryConsentIntegrity:311` ("deterministically re-reads identity after a
  concurrent phone update wins the row lock") — **in the suite that skips by default.** On
  `npm test`, deleting both the route guard and the fence guard is green, and a target whose
  patient changed phone number gets dialled at the old number.
- **Delete `outbound.ts:1453-1461` (`sameOptionalIdentity` mismatch check) → green.** Low blast
  radius (`dialIdentity = target ?? body` at `:1468` already prefers the stored target), but the
  guard is entirely unpinned.
- **Delete `outbound.ts:1445-1448` (`adhoc_call_not_authorized`) → green.** A `MANAGE`-permission
  user could POST `{phone: '+1…'}` with no target in production. The dial still fails closed
  (`dncFence.ts:184` throws `outbound_provider_intent_target_missing` → `409
  target_identity_changed`), but a `ReceptionistCallLog` and a reserved attempt are created per
  request, and no test observes any of it.

**Summary of §3:** of the seven advertised safety claims, **two are genuinely pinned** (kill
switch at depth; concurrency + cost cap), **three are pinned only through a single wire reason
that two independent layers both produce** (DNC, suppression, consent), **one is pinned by
nothing at all** (quiet hours at dispatch), and **one is pinned by string greps that survive
deleting the enforcement** (live-test single-active-call and cost caps).

---

## 4. Idempotency and concurrency

| Scenario | Implementation | Tested? |
|---|---|---|
| Duplicate launch with the same `clientAttemptToken` | Advisory lock + `IdempotencyKey(scope='receptionist.outbound-client-attempt')`, claimable once (`outbound.ts:1543-1562`) | **Yes** — `:1962` (cleared token → every late submission rejected, no call log, target untouched), `:1992` (dispatch claims first → `verify-clear` stays blocked with `call_not_terminal`, then clears with `durable_terminal_reconciliation`). Genuinely good. |
| Duplicate launch with **no** token | Nothing dedupes; the target claim `updateMany({status: 'PENDING' → 'CALLING'})` (`outbound.ts:1641-1655`) is the only serialisation | **No.** The UI always sends a token (`receptionist.ts:855-870`); the API does not require one except for live tests (`:1425`). Two token-less POSTs are serialised by `pg_advisory_xact_lock(receptionist-capacity:<tenant>)` at `:1564` and the conditional claim, so exactly one should win — **but no test asserts it**. There is no `Promise.all([inject(/call), inject(/call)])` anywhere in the suite. Every concurrency test uses the deterministic `providerBoundaryTestHook`, which serialises by construction. |
| Concurrent launches for **different** targets racing the last voice minute | `usedMinutes + activeCalls >= limitValue` (`outbound.ts:1636`) | **No.** The `+ activeCalls` reservation term — added specifically for this — is exercised by no test. |
| Concurrent launch vs. Studio pause | Shared `lockOutboundConfiguration` (`outbound.ts:167`) | **Yes** — `:1754`, `:991`. |
| Concurrent launch vs. DNC / consent write | `lockSuppressionFences` + `lockDncDestinationFence` | **Yes** for voice (`:569`, `:603`, `:635`); extensively for SMS (`campaignDispatchFence`, 16 tests). |
| Concurrent launch vs. kill switch | Four ordered re-checks | **Yes** — `:953`, `:1026`, `:1074`, `:1210`. |
| Provider-ID collision / reuse | `outbound.ts:2445-2467` | **Yes** — `:421`, `:1210`, `:1403`. |
| Webhook redelivery of the **same terminal event** | `pg_advisory_xact_lock(receptionist-call-lifecycle:…)` + first-terminal-outcome-wins + `voiceCallDedupeKey` (`webhooks.ts:1058-1140`) | **Partially.** `receptionistOutboundTargets:2351` and `receptionistSecurity:270` prove minute-metering and outcome immutability under redelivery. **But both use call logs with no `targetId`**, so the target-status branch's idempotency (`status: 'CALLING'` in the `updateMany` where-clause, `webhooks.ts:1179`) is never exercised. |
| `call_ended` then `call_analyzed` with **different** outcomes on a real target | `persistedOutcome` freezes the first terminal outcome (`webhooks.ts:1063-1068`), but the target branch uses the **raw** `outcomeRaw` from the current payload (`:1176`) | **No — and this is a latent divergence.** The call log keeps outcome #1 while the target can be moved by outcome #2, because the two reads use different variables. Only the `status: 'CALLING'` guard prevents a second move, and nothing tests it. |
| Out-of-order webhooks (`call_ended` before `call_started`) | Row is created on first event (`webhooks.ts:1082-1097`) | **No.** |
| `provider-sync` replay | Same lifecycle lock and dedupe key (`outbound.ts:2690-2760`) | **No.** Zero executing tests for the entire route. |

---

## 5. The gaps that matter most for a real clinic pilot, ranked

Ranked by (blast radius on a live pilot) × (probability the redesign silently breaks it).
Each names the specific test to write. **None of these overlaps the incident-reproduction
work in `receptionistOutboundCallLifecycle.integration.test.ts`** (stuck call, reconciliation,
active-call blocking).

**G1 — Quiet hours is not enforced by any test.** `outbound.ts:1515`, `:1863`.
*Test:* an integration test that creates a RUNNING campaign whose quiet window **contains
the current clinic-local time**, launches a target, and asserts `200 / {status:'skipped',
reason:'quiet_hours'}`, `providerFetch` not called, and the target still `PENDING` with
`attempts: 0`. Add the mirror at the in-transaction gate by moving the clinic timezone with
the boundary hook held. Add an overnight-wrap case (`21:00`→`08:00` evaluated at 23:30 and at
07:00 clinic-local) and a DST-transition case at dispatch, not just on the pure function.
*Why first:* the control is claimed loudest, is legally load-bearing, and both enforcement
points are freely deletable today.

**G2 — No test drives an outbound target through a terminal webhook to a terminal status.**
`webhooks.ts:1171-1186`. No test in the repo has ever seen a target reach `COMPLETED` or
`OPTED_OUT`.
*Test:* one parameterised integration test — launch a target through `/call` to `201 launched`,
then POST a signed `call_ended` with `custom_analysis_data.outcome` ∈
{`BOOKED`, `NOT_INTERESTED`, `NO_ANSWER`, `VOICEMAIL`, `OPTED_OUT`, `ESCALATED`, `FAILED`} and
assert the resulting `CallTargetStatus`, `lastOutcome`, `lastCallLogId` and `attempts` against
`targetStatusAfterOutcome`, at both `attempts <= maxRetryAttempts` and above it. Add the
redelivery case (same event twice → one transition) and the **divergent** case (`call_ended`
`NO_ANSWER` then `call_analyzed` `BOOKED`) to pin the `outcome` vs `outcomeRaw` split at
`webhooks.ts:1063` and `:1176`.
*Why:* this is the half of the lifecycle the redesign will rewrite, and there is nothing to
regress against.

**G3 — The provider request body is never checked against what the route assembles.**
`outbound.ts:1994-2032`.
*Test:* in the existing outbound integration harness, capture `providerFetch.mock.calls[0][1].body`
on a successful launch and assert `to_number === target.phone` (**not** the clinic line),
`override_agent_id/version === agent.providerAgentId/providerVersion`,
`metadata.{tenantId,outboundCampaignId,callLogId,targetId}` exact, and
`retell_llm_dynamic_variables.{first_name, script, booking_mode, appointment_type,
consent_text, disclosure}` matching the campaign for **both** booking modes.
*Why:* the requirement is per-patient appointment context in the call, and today nothing
proves even the *phone number* is the right one. This is also the test that will catch the
first per-patient variable the redesign adds and forgets to wire.

**G4 — `POST …/provider-sync` (~190 lines) has zero executing tests.** `outbound.ts:2623-2815`.
*Test:* a table-driven integration test over `getPhoneCall` snapshots asserting the outcome
map (`error`→`FAILED`; `not_connected`+voicemail→`VOICEMAIL`; `not_connected`→`NO_ANSWER`;
`ended`+`no_answer|busy|unanswered`→`NO_ANSWER`; `ended` otherwise→`ESCALATED` **plus** the
one-shot `provider_poll_review` staff task), the binding-mismatch quarantine
(`metadata.tenantId`/`outboundCampaignId`/`callLogId`/`agentId`/`agentVersion` each wrong in
turn → `409 provider_binding_mismatch`), `409 provider_call_id_missing`, minute-metering
idempotency across two syncs, and the target-status write at `:2738`.
*Why:* this is the only path that resolves a call when the webhook never arrives — the exact
production failure mode — and it is the one route in the module with no behavioural test at all.

**G5 — The consent/DNC integrity suite skips on every ordinary run.**
`receptionistDeliveryConsentIntegrity.integration.test.ts:25`, 13 tests / 57 assertions.
*Action (not a new test):* split the cases that need no disposable database out of the
`describeDisposable` block — that is 11 of 13; only the raw-`app_rls` forgery case at `:256`
and the trigger-behaviour probes truly need it — or provision `RLS_DISPOSABLE_DB` in CI. Then
add the missing discriminator: assert the **app** sentinel
(`outbound_provider_intent_suppressed`) and the **trigger** message
(`'…suppressed at the linearization point'`) separately, so removing either layer turns the
suite red (§3.3).

**G6 — Target selection and authorisation are UI-only.** `outbound.ts:1037-1092`, `:956-1030`,
`TargetList.tsx:100,154`.
*Test:* (a) an API test that `POST /targets` with a **suppressed** identity and with an
identity lacking compatible consent — pinning today's behaviour (accepted) so the redesign
makes a deliberate choice rather than inheriting it; (b) a jsdom test rendering `TargetList`
with mixed `voiceAuthorizationReady` candidates asserting the unauthorised ones are absent
from the picker and their Call buttons are disabled with the right title; (c) an integration
test of `/outbound-target-candidates` asserting `voiceAuthorizationReason` for each of the
four branches (`suppressed`, `compatible_immutable_consent`,
`consent_missing_or_incompatible`, `treatment_operations`).
*Why:* "select the patients with appointments tomorrow" is the requirement, and the
selection surface currently has no server-side authorisation and no behavioural test.

**G7 — The live-test caps are protected by string greps.** §3.6.
*Test:* an integration test that sets `LIVE_TEST_*` env in `beforeEach` (as
`receptionistLiveCallUat.unit.test.ts` already does) and drives `/call` — asserting `429
live_test_single_active_call` with one active call, `429 live_test_call_cap_reached` at
`maxCalls`, `402 live_test_minute_cap_reached`, `402 live_test_cost_cap_reached`, `409
live_test_attempt_replayed` on token reuse, and `409 live_test_attempt_token_required`
without a token. Then **delete the four `toContain` greps** from
`receptionistLiveUatContract.unit.test.ts:30-34`, which currently provide false assurance.

**G8 — Seventeen `/call` block reasons have no test.** §3.7.
*Test:* one compact table-driven integration test that constructs each precondition and
asserts `(statusCode, reason)`. Prioritise the identity family
(`target_identity_unbound`, `target_identity_mismatch`, `target_identity_changed`,
`adhoc_call_not_authorized`), then `campaign_not_running`, `outbound_authority_unapproved`,
`agent_required`, `invalid_e164_destination`, `TENANT_MODE_DEMO_BLOCK`. This also becomes the
regression net for the client's reason union (`src/lib/receptionist.ts:446-520`), which today
is a hand-maintained literal list with nothing pinning it to the server.

**G9 — Duplicate token-less launches for the same target are unserialised by any test.** §4.
*Test:* `Promise.all([inject(/call), inject(/call)])` for one target, asserting exactly one
`201 launched` and one `409 target_not_dialable`, exactly one `ReceptionistCallLog`, exactly
one `providerFetch` call, and `attempts: 1`. Same shape for two different targets racing the
final voice minute, to pin the `+ activeCalls` reservation term at `outbound.ts:1636`.
*Why:* a dialler will make this the normal case rather than the exceptional one.

**G10 — 905 of 1,388 lines of outbound UI have no test.** §1.2.
*Test:* jsdom coverage for `campaignPayload.ts` (the create/PATCH body builder — the exact
place the Zod-`.partial()` regression at `receptionistOutboundTargets:1656` reached
production from), `CampaignBuilder` (the missing-`agentId`-for-request-only defect from the
A6 audit), and `CampaignDetail`'s launch state machine (`launched` / `skipped` / `blocked` /
`cancelled` / `reconciliation_required` / `transport_ambiguous` → button-disabled state and
message), which is the code path an operator actually touches.

---

## 6. Notes for the redesign

- **The `CallOutcome` vocabulary cannot express the requirement.** `webhooks.ts:1019-1020`
  has no `CONFIRMED`/`CANCELLED`/`RESCHEDULED`, and `ReceptionistCallTarget`
  (`schema.prisma:3180-3207`) has no `appointmentId`. Whatever tests the new outcome vocabulary
  gets should be written against `targetStatusAfterOutcome` **and** its two call sites
  simultaneously — the pure-function test that exists today (`receptionistOutboundCompliance.unit.test.ts`)
  would keep passing through a total rewrite of both call sites.
- **`providerIntentBlockReason` collapsing app and trigger errors to one wire reason
  (`outbound.ts:405-428`) is a deliberate API design that is also a permanent coverage blind
  spot.** If the layers are meant to be independent, the tests must assert the layer, not the reason.
- **`quietWindowOutsideNow()` (`receptionistOutboundTargets:43`) is a fixture that makes the
  most important compliance control unreachable from the test suite.** Any new harness should
  take the quiet window as an explicit parameter with `inside`/`outside` cases, not default to
  "outside".
- **The `providerBoundaryTestHook` seam (`outbound.ts:62-69`) is excellent** — six named stages,
  production-fenced. It is why the provider-boundary coverage is as good as it is. Preserve
  an equivalent seam in the dialler.
