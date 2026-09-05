# Bright Health LLC Pre-Pilot Certification

Last updated: 2026-09-05 (America/New_York)

## Executive verdict

**NO-GO for an unsupervised client pilot today. CONDITIONAL GO for an attended, non-production product demonstration.**

The core multi-clinic customer journeys, authorization boundaries, production build, complete automated regression, focused UI suites, local PILOT-volume query benchmark, and bounded Bright Health API burst pass. Intake, Connected Care, Telehealth, campaign scope, inventory, labs, CRM, portal, reviews, pilot-share revocation, and least-privilege AI paths were hardened and retested. A complete six-section Bright Health public intake was completed, submitted, reloaded and retried in visible Chrome. Connected Care now also has a coherent Bright Health Arlington sandbox story: configured signed provider intake, an assigned device, consent, active enrollment, normal and critical readings, one alert, and proven duplicate suppression. The product is materially more coherent and credible than at the start of this run.

The remaining blockers are not unit-test concerns. Read-only inspection of the live Retell number found its inbound side assigned to an agent for a different synthetic customer, while Render's outbound agent binding points to a constrained CareCommand demonstration agent. The deployed live-test envelope also does not match Bright Health and lacks a run ID, valid time window/expiry and positive caps. No call was placed against this unsafe configuration. The product correctly refuses to reactivate the paused Fairfax campaign. Live provider receipts and deployed Render capacity were not proven. CareCommand must not be represented as pilot-ready until the number is rebound through Studio to a Bright Health deployment and the external proofs pass on the exact deployed release.

On 2026-09-05, the authenticated production browser session was also proven to belong to Harley Street Medical Group rather than Bright Health LLC. The tenant account menu offered no workspace switch, and the separate Platform Operator console had no authenticated session. Secure tenant self-service password recovery has now been implemented and browser-tested in the local candidate, but it is not yet deployed and controlled-inbox email delivery is unproven. The platform support roster also still lacks a governed tenant-user assisted reset. This remaining deployment and fallback gap is recorded as BH-039, a P1 pilot-access and implementation blocker.

## Build and environment under test

| Item | Evidence |
|---|---|
| Repository | `kodekinetics79/carecommand-ai` local working copy |
| Branch | `feat/today-workspace-redesign` |
| Base HEAD | `409a56812282ac8a1ca013a18915ab97064afd29` |
| Repository-content fingerprint | `56ac8edb10ef4a165dee9fb24f8588fb0deeb2f6e6b2097e4fbee2cbb29f3c9a` (1,223 files) |
| New public-intake migration SHA-256 | `1f3231df404d42d2b58335036541f5fe9beec77df47dce0aec4174d407580bbc` |
| Build status | Committed release candidate; deployment verification recorded separately |
| Web application | Local Vite application, `http://127.0.0.1:12000` |
| API | Local API, `http://127.0.0.1:3001` |
| Database | Local PostgreSQL on port 55432; Bright Health synthetic database plus guarded disposable databases |
| Queue | Local Redis on port 56379 |
| Browser | Visible Google Chrome customer flows and read-only Retell/Render configuration inspection |
| Deployed site observed | `https://carecommand.kodekinetics.com`; repository routing sends same-origin `/v1`, `/health` and `/metrics` to the Vercel API function. The public `/health` and `/health/ready` returned 200, but release remained `unknown` and `/metrics` fell through to frontend HTML. Separately, the inspected Render backend service reported commit `7984ef308a2175aa3f4af4300b8f5bb2babf79ce`; no evidence proved that the public origin was reaching that service. This report does not claim either deployment contains the uncommitted fixes. |

The repository-content fingerprint and final commit SHA together identify the release. Deployment certification still requires runtime evidence from the same SHA.

The repository-content fingerprint hashes the sorted path/content set for tracked and non-ignored untracked files, excluding this self-referential certification report and `test-results/` evidence media. It therefore covers untracked source, tests, migrations and the operations packet that a normal diff-only hash would miss.

## Bright Health LLC tenant configuration

Tenant: `Bright Health LLC` (`d17a7531-1196-4cf5-aac3-de73a6138a64`)

| Area | Configuration exercised |
|---|---|
| Locations | Bright Health Arlington; Bright Health Fairfax |
| Receptionist profiles | Renamed through Studio to Bright Health Arlington and Bright Health Fairfax |
| Receptionist locations | Renamed through Studio and mapped to the matching scheduling branches |
| Owner | Existing synthetic tenant owner |
| Manager | Existing synthetic practice manager |
| Front desk | `bright.frontdesk@example.test`, Arlington + Fairfax, Arlington primary |
| Billing | `bright.billing@example.test`, Fairfax + Arlington, Fairfax primary |
| Providers/patients | Synthetic-only providers and patients; no PHI |
| Scheduling | Service catalogue, provider availability, clinic-specific schedules, and a real visible booking |
| Communications | Stored synthetic call activity, operator review, revision and audit attribution |
| Revenue | Clinic-scoped payment requests, eligibility workflow, failed-payment follow-up queue |
| Connected Care | Withings sandbox; `Bright RPM BP Monitor A-01` at Arlington; synthetic written RPM consent; active device-bound enrollment; two signed readings; one critical workflow alert; duplicate provider event suppressed |

Platform privileges were not granted to tenant users. RBAC, tenant boundaries, branch access, RLS, audit controls, and the platform/tenant separation remained in force.

## Scenario coverage

| Journey | Result | Customer evidence |
|---|---|---|
| Tenant owner navigation and Operational Briefing | PASS | Bright Health network workspace rendered with current role and scope |
| Platform-created Front Desk and Billing accounts | PASS | Accounts created through visible Control Plane |
| Front Desk least privilege | PASS | Work Queue available; Control Plane denied and absent from navigation |
| Billing least privilege | PASS | Revenue Operations available; Work Queue/Front Desk denied |
| Multi-clinic switch | PASS | Arlington/Fairfax breadcrumb, selector, request scope, and totals move together |
| Scheduling and provider availability | PASS | Consultation booked in Chrome for a synthetic patient at Fairfax |
| Double-book/race protection | PASS | Exact integration retest and final regression pass |
| Communications review | PASS | Synthetic call review saved and marked reviewed, revision 2, attributed to owner |
| Revenue failed-payment truth | PASS | Two network failures; one per clinic; both appear in the work queue |
| Insights truthfulness | PASS | Stored competitor data explicitly labeled non-live and unverified |
| Patient intake directory search and role controls | PASS locally | Cursor-aware server search reaches matches beyond the first 25 results; duplicate names are disambiguated by clinic and synthetic reference/contact details; write actions are removed for read-only roles; focused UI/API tests pass |
| Public patient intake completion and submission | PASS locally in Chrome | Bright Health six-section synthetic intake completed and submitted; reload and duplicate submit are idempotent; post-submit section writes are rejected by a packet-scoped RLS regression test |
| Connected Care enrollment safety | PASS locally | Configured/active provider and an assigned device are required for RPM; provider role is read-only; integration and UI tests pass |
| Telehealth multi-clinic scheduling | PASS locally | Canonical providers, clinic-local day bounds, cross-midnight behavior, branch scope, status and failure truthfulness pass |
| Campaign/advisory clinic scope | PASS locally | Stored campaign branch governs preview, launch, attribution evidence and advisory revenue; restricted-manager tests pass |
| Labs and inventory correctness | PASS locally | Forward-only review, idempotent retry, concurrent receipt/restock preservation, and cursor-complete accessible-scope totals pass |
| CRM/AI least privilege | PASS locally | Read-only roles cannot mutate; calls route through governed Receptionist Studio; raw AI routes restricted to Owner/Admin |
| Pilot share-link revocation | PASS locally | Revoked link returns 404; revocation is idempotent and audited exactly once |
| Reviews/advisory interaction truthfulness | PASS locally | Clinic-filter empty state distinguished from failure; advisor selection no longer sends a model request |
| Receptionist profile/location administration | PASS | Both customer-facing names updated through Studio |
| Receptionist publish and line verification | PASS in mock mode | Fairfax deployment published and line check returned VERIFIED |
| Exact post-publish inbound call | **SAFETY_BLOCKED** | Live Retell DID is bound inbound to a different synthetic customer's agent; no call was placed |
| Fairfax campaign reactivation | **BLOCKED** | Correctly refused until exact-deployment inbound call exists |
| Outbound live calls to authorized destinations | **NOT RUN** | No unnecessary live calls were placed without a ready live provider path |
| Connected Care operational demonstration | PASS locally through application APIs; Chrome replay pending | Arlington device reports from signed provider intake; two current readings, one critical alert, three sync receipts, active consent/enrollment, and an honestly incomplete billing-readiness state |
| Production/Render release verification | **NOT RUN** | Current fixes are uncommitted and undeployed |
| Post-change visible Chrome retest of newly hardened modules | **BLOCKED** | Login page loads locally and on the deployed site; entering the synthetic password still requires the user’s action-time confirmation |
| Mobile/responsive basics | PASS for key staff screens | Existing desktop/mobile evidence captured during this hardening run |
| Tenant Admin role journey | **NOT RUN after final changes** | Automated authorization coverage exists; visible Chrome replay pending |
| Practice Manager role journey | **NOT RUN after final changes** | Automated clinic-scope coverage exists; visible Chrome replay pending |
| Provider role journey | **NOT RUN after final changes** | Read-only Intake/Connected Care controls are tested; full visible journey pending |
| Scheduler-specific role | **NOT IMPLEMENTED** | No distinct Scheduler role exists; scheduling authority is carried by existing roles |
| Patient portal end-to-end journey | **PASS locally in focused UI/API tests; Chrome pending** | Magic-link navigation preserves the memory-only capability token; booking, reschedule/cancel and confirmation use the authoritative clinic timezone; ambiguous/nonexistent DST times fail safely. Authenticated visible replay remains under BH-027. |
| Audit export | **NOT RUN** | Route/permission evidence is insufficient for a customer-operated export claim |
| Bulk imports/exports | **NOT RUN / SCOPE UNDEFINED** | Pilot import utilities exist, but customer-facing bulk-operation coverage is not certified |
| Session expiry, stale tab and concurrent edit | **PARTIAL** | Auth/concurrency regression passes; final visible browser replay is pending |
| Holiday/after-hours and multi-location call transfer | **EXTERNAL_BLOCKED** | Requires corrected deployed voice binding and bounded live proof |
| Shared-provider overlap across clinics | **PASS in scheduling regression; Chrome pending** | Canonical provider/branch and double-book protections pass locally |
| Referral/clinic transfer workflow | **NOT IMPLEMENTED** | No governed referral workflow is wired |
| Data deletion/restore customer journey | **PARTIAL** | Local database restore and lifecycle controls pass; customer restore UI/managed restore not certified |
| Accessibility basics | **PARTIAL** | Static/UI checks and key responsive evidence exist; full keyboard/screen-reader audit not run |
| Browser network interruption/recovery | **NOT RUN after final changes** | Provider/queue failure tests exist; visible browser recovery remains unproven |

## Call ledger

No live outbound call was placed in this closing pass. That is a deliberate evidence statement, not a pass.

| Time | Destination | Scenario | Result | Duration/provider status | Application record |
|---|---|---|---|---|---|
| 2026-09-02 | Stored synthetic activity | Operator review of a synthetic scheduling call | PASS | Stored record; not a live provider call | Reviewed, revision 2, owner attribution |
| 2026-09-02 | Receptionist line | Publish and line verification | PASS, mock mode | VERIFIED; not an independent caller | New deployment evidence stored |
| 2026-09-02 | Live Retell DID | Read-only inbound/outbound binding inspection | **FAIL SAFE** | Inbound agent names a different synthetic customer; outbound points to constrained CareCommand demo agent | Screenshot and configuration trace; no call initiated |
| — | `***-***-5555` | Authorized outbound destination | NOT RUN | No call placed | None |
| — | `***-***-6009` | Authorized outbound destination | NOT RUN | No call placed | None |
| — | `***-***-5556` | Authorized outbound destination | NOT RUN | No call placed | None |

No other destination was used. The ambiguous four-digit number previously mentioned was not treated as authorization.

## Verification and performance evidence

### Release gates

| Gate | Result |
|---|---|
| Prisma schema validation | PASS |
| Server TypeScript | PASS |
| ESLint | PASS |
| Production TypeScript/Vite build | PASS, 2,532 modules transformed |
| Diff whitespace check | PASS |
| Full disposable regression | **COMPOSITE PASS: 291/291 test files; 3,758 passed; 5 expected-failure cases; 10 skipped; 3,773 total.** The initial exact-tree run passed 286 files; all five files affected by the wrong Redis endpoint or the one stale health-contract expectation then passed in the corrected 11-file/100-test retest. |
| Focused password-recovery/security/queue retest | **PASS: 11/11 files; 100/100 tests; 48.20 seconds** |
| Demo readiness | **PASS: 14/14 tests** |
| Focused hardened-module UI regression | **PASS: 8 files; 111/111 tests** |
| Focused hardened-module database regression | **PASS: 6 files; 74/74 tests** |
| Public-intake capability/RLS regression | **PASS: 5/5 tests**, including complete-to-submitted, duplicate submit and immutable submitted sections |
| Public-intake browser replay | **PASS:** six sections submitted in visible Chrome; confirmation survives reload/retry |
| Dependency production audit | **PASS: 0 production vulnerabilities reported** |
| Impeccable static design detector | **PASS: no findings** |
| Connected Care provider activation UI regression | **PASS: 3/3 tests** |
| Connected Care disposable database regression | **PASS: 26/26 tests**, including the provider-management API → device → enrollment path |
| Bright Health signed-reading customer story | **PASS:** normal `1/0/0`, critical `1/1/0`, replay `0/0/1` for ingested/alerts/duplicates |
| Bright Health read-only API burst | **PASS: 500/500 HTTP 200**, 25 concurrent clients, 186.28 requests/second, p50 130.73 ms, p95 182.66 ms, p99 198.44 ms, max 217.75 ms |
| API benchmark remote-target guard | **PASS:** harness refuses every non-loopback target before issuing a request |
| Local database backup/restore lifecycle | **PASS:** 128 migrations; exact synthetic snapshot parity; 136 forced-RLS tables, 571 policies, non-superuser runtime role, 121 tenant-integrity foreign keys |
| Receptionist artifact retention automation | **PASS locally:** daily signed tenant-scoped job; legal-hold/provider-deletion lifecycle and worker wiring **11/11 focused tests** |
| Sealed-candidate local runtime smoke | **PASS:** `/health` 200; `/health/ready` 200 with database, Redis and ingress proxy `ok`; `/metrics` 200 Prometheus text with queue-depth and dependency gauges; security headers present |
| Guarded post-deploy release verification | **PASS locally: 11/11 focused deployment/release scenarios**; Vercel/Render release identity, HTTPS/canonical-host/GET-only guard, exact SHA, database/Redis/ingress readiness, unauthenticated and invalid-token metric denial, authenticated Prometheus content/series, and effective HSTS/frame assertions |
| Final repaired-module regression | **PASS: 9 files; 75/75 tests** across release identity/deployment verification, evidence-index safety, operational pagination, patient directory search, patient portal self-service/timezone behavior, and UI journeys |
| Evidence-index integrity | **PASS: 12/12 referenced artifacts** exist, are non-empty regular files within the repository, and are hashed; traversal, absolute-path, duplicate, missing, empty and symlink-escape cases are rejected |
| Live Retell/Render configuration audit | **FAIL SAFE:** inbound number points to another synthetic tenant's agent; Bright Health live-test tenant/run/window/caps are not ready; no call placed |

The complete regression used a fresh disposable Postgres database and the real local Redis queue. It covered queue draining, retries, tenant/RLS denials, webhook failure injection, booking atomicity, billing concurrency, auth/session boundaries, monitoring, intake, platform controls, and provider integration contracts.

### PILOT-volume local benchmark

Guarded disposable dataset: 2,000 patients, 4,042 appointments, 1,022 receptionist calls, 1,000 documents, 2,000 notifications, and 5,015 audit events. Host: Apple M2 Max, 12 logical CPUs, 64 GiB RAM, Node v24.15.0.

| Query class | Maximum of three local samples |
|---|---:|
| Patient search | 22.15 ms |
| Appointment calendar | 54.42 ms |
| Dashboard aggregate | 53.74 ms |
| Audit search | 62.92 ms |
| Receptionist events | 15.96 ms |
| Document list | 17.27 ms |
| Notification list | 26.91 ms |
| Bounded pagination | 26.43 ms |
| Platform overview | 4.35 ms |

All measurements passed the 750 ms local regression budget. The benchmark also confirmed that the platform database role could not select patient rows.

### Bright Health bounded local API burst

The guarded harness first verified the authenticated tenant as Bright Health LLC, then issued 500 read-only requests at concurrency 25 across authentication, dashboard, branch, patient, appointment, campaign, Connected Care, inventory, partner-report, telehealth and review endpoints. All 500 returned HTTP 200 in 2.684 seconds: 186.28 requests/second, p50 130.73 ms, p95 182.66 ms, p99 198.44 ms, maximum 217.75 ms, and zero failures. The slowest per-endpoint maximum was 217.75 ms. The harness is capped and rejects every non-loopback URL, so it cannot be pointed at Render accidentally.

These results are local database/API regression evidence only. They do not prove Render capacity, browser rendering latency, sustained concurrent users, write-path saturation, telephony throughput, provider rate limits, queue depth/recovery, or production failover.

## Defect and gap register

### Repaired and retested

| ID | Type/severity | Module | Reproduction and actual result | Expected result / impact | Remediation and retest |
|---|---|---|---|---|---|
| BH-001 | Defect / P1 | Work Queue/API scope | Open owner Work Queue; receptionist requests supplied a receptionist `clinicId`, which the API misused as a Branch authority header; calls/KPIs failed with “assigned clinic not active.” | Entity IDs must not cross authority namespaces; core front desk was unusable. | Only explicit `branchId` overrides the Branch header. Three header tests plus exact Chrome journey pass. Evidence: `test-results/bright-health-work-queue-fixed.png`. |
| BH-002 | Defect / P1 | Scheduling | Book a visible appointment; timeline displayed a raw provider UUID. | Staff must see the provider name. UUID display undermines trust and safe scheduling. | API returns `providerName`; adapter suppresses raw UUID fallback. Integration and Chrome retest pass. Evidence: `test-results/bright-health-scheduling-booked-fixed.png`. |
| BH-003 | Defect / P1 | Revenue | Open Revenue Operations with two failed payment requests; metric showed zero and the work queue was empty. | Failed cases must be counted and actionable. | Summary now counts failed requests without double-counting transactions; queue renders each case. Integration/UI/Chrome retest pass. |
| BH-004 | Security/scope / P1 | Billing RBAC | Create Billing user with two clinics; UI/server treated Billing as tenant-wide in several paths. | Billing is clinic-scoped and must obey assigned locations. | Added Billing to Control Plane, settings, admin safety, operations, staff-task, and authorization scope rules. Visible Control Plane and role journeys pass. |
| BH-005 | Defect / P1 | Revenue scope | Switch Billing from Fairfax to Arlington; data changed but the page selector still said Fairfax. | Every monetary total must identify its real clinic scope. | Selector now uses the shared clinic external store; both visible selectors and requests move together. Unit and exact Chrome retest pass. Evidence: `test-results/bright-health-billing-scope-fixed.png`. |
| BH-006 | Truthfulness / P2 | Insights | Open stored synthetic competitor intelligence; it appeared current without source caveat. | Stored records must not masquerade as live research. | Added non-live/unverified banner and recorded dates. UI tests and Chrome retest pass. |
| BH-007 | UI / P2 | Revenue | Failed-payment card used undeclared `border-amber-v/35`, so the semantic border rendered nothing. | Warning hierarchy must be visible. | Replaced with declared `/40`; color-utility contract passes. |
| BH-008 | Test tooling / P2 | Synthetic load harness | Run PILOT seed; suspended tenant entered production receptionist deploy and failed closed. | Inactive tenants should be seeded for denial testing but never deployed. | Seeder now leaves inactive-tenant campaigns in draft; PILOT benchmark and FUNCTIONAL demo readiness pass. |
| BH-015 | Defect/security / P1 | Patient Intake | Open the patient picker with more than 25 matching patients or sign in as a read-only Provider; the picker stopped at the first cursor page, duplicate names were insufficiently distinguished, and mutation controls remained visible. Root cause: incomplete cursor traversal, client-only assumptions and incomplete permission vocabulary. | Staff must search the complete accessible directory, distinguish duplicate synthetic patients safely, and read-only roles must not create, resend or review packets; otherwise the wrong patient can be selected and least privilege is misleading. | Added debounced cursor-aware server search, stale-request protection, clinic/reference/contact disambiguation, `intake:write`, truthful errors and write gating. UI tests prove the 26th match and 27-result pagination; API regression proves branch labels. Final regression passes. |
| BH-016 | Defect/safety / P1 | Connected Care | Enroll an RPM patient against an unready provider or without a device, or open consent/enrollment controls as Provider; the UI previously allowed an invalid path and exposed mutations. Root cause: readiness and role checks were not consistently carried to route/UI boundaries. | RPM evidence must be bound to a configured provider and real assigned device; Providers in the selected read-only role must not mutate enrollment or consent. | Server now requires configured active/webhook-ready providers and an RPM device; UI disables invalid enrollment and makes Provider read-only. Integration/UI/final full regression pass. |
| BH-017 | Defect/scope / P1 | Telehealth | Query a clinic-local day near midnight or resolve a provider across branches; prior behavior could use UTC day bounds, fallback identifiers, or optimistic status. Root cause: mixed time/provider representations. | Sessions must use canonical providers, correct clinic-local bounds, explicit branch scope, and truthful failure state or appointments can be routed/displayed incorrectly. | Added canonical provider resolution, multi-branch scope, local-day bounds including midnight, and explicit errors/status. Route tests and full regression pass. |
| BH-018 | Security/scope / P1 | Campaigns/Advisory | A restricted manager could preview a branch audience while dispatch/advisory evidence was derived tenant-wide. Root cause: the campaign did not retain one authoritative branch scope through every stage. | Preview, approval fingerprint, dispatch, attribution and advisory evidence must describe the same clinic; cross-clinic messaging/revenue leakage is unacceptable. | Persisted campaign branch scope and applied it to launch and advisory queries. Evidence-backed revenue and concurrent multi-clinic tests pass. |
| BH-019 | Security/privacy / P1 | AI endpoints | Call raw AI recommendations/usage/evaluations routes as a branch-scoped non-admin role; tenant-wide material could be reachable without a branch-safe contract. Root-cause hypothesis: role gate was broader than the response scope. | Sensitive AI aggregates must fail closed until branch-safe projections exist. | Raw AI administrative routes now require Owner/Admin. Authorization and final regression pass. |
| BH-020 | Defect/privacy / P2 | Pilot Status | Create a public pilot-status share, then attempt to withdraw it; no durable revoke journey existed. Root cause: share creation had no inverse operation. | A customer must be able to invalidate an accidentally or formerly shared readiness link immediately and audibly. | Added idempotent revoke; public URL returns 404 and exactly one audit event is created. Integration retest passes. |
| BH-021 | Data integrity / P1 | Inventory | Submit two receipts/restocks concurrently against the same item; read-modify-write could lose one increment. Root cause: stock mutation was not serialized. | Both receipts must be preserved; lost stock creates clinical and financial risk. | Added transaction-scoped advisory locking and receipt truth in UI. Concurrent +5/+7 from 10 resolves to 22; integration/full regression pass. |
| BH-022 | Data integrity / P1 | Partner/Lab reporting | Retry a report review or move backward after completion; state could regress or duplicate side effects. Root cause: transition and idempotency rules were incomplete. | Review is forward-only and a retried request must return the same outcome without duplicate evidence. | Enforced forward-only transitions and idempotent retry; labs permissions/errors were aligned. Integration/full regression pass. |
| BH-023 | Safety/RBAC / P1 | CRM calling | Trigger Call Now from CRM or use CRM mutations as a read-only role; the client could open `tel:` and bypass application consent, audit and call controls. | Calls must enter the governed receptionist workflow, and read-only roles must not mutate CRM records. | Call Now routes to Receptionist Studio with context; CRM actions are permission-gated. CRM UI and final regression pass. |
| BH-024 | Defect / P1 | Patient Portal | Display appointment/provider data when the canonical provider relation was absent; a raw UUID fallback could reach the patient. Root cause: identifier fallback was treated as display text. | Patients must see a validated provider name or an honest unavailable state, never an internal identifier. | Portal now resolves the canonical provider and suppresses UUID display. Full regression passes. |
| BH-025 | UX truthfulness / P2 | Reviews | Select a clinic with no reviews while the tenant has reviews elsewhere; the page showed a generic empty state indistinguishable from load failure/global emptiness. | The operator must know the current clinic filter is the reason for zero results. | Added clinic-aware empty state, clinic names and read-only response controls. UI tests and final build pass. |
| BH-026 | UX/cost / P3 | Advisory Room | Click an advisor tile only to inspect it; selection immediately sent a model request. Root cause: navigation and execution shared one click handler. | Selection should be free of side effects; only an explicit Ask action may consume AI capacity or create evidence. | Tile selection now changes context only; Ask is explicit. Final UI/build checks pass. |
| BH-028 | Defect/security / P1 | Public Intake client | Open a valid public intake link in a browser without a staff session; the client used the authenticated request helper, attempted staff refresh and displayed “Session expired.” Root cause: a public capability-token flow inherited staff authentication and clinic-scope behavior. | A patient link must work independently of staff sessions and must never attach staff authorization or clinic headers. Otherwise patient intake is unusable and security domains are mixed. | Added a credential-omitting public request path and moved all public intake calls to it. Two request-boundary tests, 17/17 focused UI/client tests and the exact Chrome journey pass. |
| BH-029 | Defect/security / P1 | Public Intake submit/RLS | Complete every required section and press Submit; status changed to `submitted`, which immediately invalidated the same `PUBLIC_INTAKE` RLS actor, causing the post-update read/audit to fail with 500. Existing gap-path tests missed it because `needs_review` did not self-revoke. | A completed packet must commit atomically, remain safely readable for confirmation/idempotent retry, and become immutable to the public token. Otherwise the best-completed patient journey fails and may leave ambiguous evidence. | Added migration `20260902123000_public_intake_submitted_context` to retain packet-scoped, unexpired read/retry authority for `submitted`; added central terminal-state mutation denial plus an explicit public 409. Visible Chrome submit/reload/retry passes; disposable RLS test proves retry and unchanged data after rejected edit; full 283-file regression passes. Evidence: `test-results/bright-health-public-intake-submitted.jpg`. |
| BH-013 | Product data / P2 | Connected Care | Open Connected Care as Bright Health; there were no current devices, readings, enrollments or alerts, so the module could not support a credible customer demonstration. | The buyer needs one coherent, explicitly synthetic workflow with current application evidence—not manufactured historical billing proof. | Through product APIs, configured Withings sandbox, registered an Arlington device, recorded written synthetic consent, enrolled a synthetic patient, ingested a normal and critical signed reading, and replayed the critical event. Result: 1 reporting device, 2 readings, 1 alert, 3 sync receipts, duplicate suppressed, RPM readiness honestly `MISSING_REQUIREMENTS`. **REPAIRED LOCALLY; authenticated Chrome replay pending under BH-027.** |
| BH-030 | Missing wiring / P1 | Device provider activation | Configure Withings through `/v1/devices/providers/:key/configure`, then enroll a patient. The setup route stored credentials but never set `webhookConfigured`; enrollment therefore remained permanently blocked with “Configure and verify this device provider.” | A complete signed setup must atomically advance the provider to webhook-ready while preserving encryption, tenancy, RBAC and audit boundaries. | Added the provider-specific signing secret to the configuration contract, derives/stores `webhookConfigured`, clears stale health verdicts, returns no secrets and audits the transition. Disposable integration proves incomplete setup is rejected, complete setup enables device-bound enrollment, encrypted storage omits plaintext, and the audit event exists. **PASS: 26/26 Connected Care tests.** |
| BH-031 | UX/RBAC / P2 | Device Integration | A tenant administrator had no UI to configure device providers, while read-only Provider users still saw “Register device,” which the API would refuse. | Management controls must be discoverable for authorized roles and absent for read-only roles; readiness language must distinguish local secret validation from real vendor reachability. | Added compact provider activation cards, secure dynamic setup fields, sandbox/production selection, retry/error/loading states and truthful “unverified” language; gated all mutations to Owner/Admin/Manager. Impeccable detector is clean and UI regression passes 3/3. |
| BH-033 | Test tooling/operations / P2 | Backup/restore lifecycle | Run the documented guarded lifecycle drill without environment JWT values; seeding and then the restored RLS verifier failed because separate child processes expected signing configuration. | A recovery drill must be self-contained and must never require an operator to copy deployed signing secrets into a disposable database exercise. | The guarded local-only verifier now injects fixed synthetic signing material into both child processes. The runbook documents the exact safe command. Full clean migrate → seed → dump → restore → RLS verification passes with 128 migrations and exact snapshot parity. |
| BH-034 | Missing wiring/privacy / P1 | Receptionist artifact retention | Configure recording/transcript retention and allow artifacts to expire; purge logic and legal-hold tests existed, but no worker schedule invoked the function. | Retention deadlines must execute automatically, tenant-scoped, hold-aware and auditable; otherwise recordings/transcripts can persist beyond policy. | Added a daily 03:20 signed per-tenant compliance job using a short-transaction RLS context. Worker schedule/context/envelope plus existing lifecycle semantics pass **11/11 focused tests**. Deployment/job receipt and real provider deletion confirmation remain external gates. |
| BH-035 | Defect/session / P1 | Patient Portal | From an authenticated portal dashboard, use the empty-state booking action; a document reload discarded the memory-only portal token and returned the patient to authentication. | Portal navigation must preserve the capability session without persisting it in unsafe browser storage; otherwise the primary self-service journey breaks. | Replaced the reload with SPA navigation and added focused UI coverage. The patient remains in the authenticated portal flow; final regression passes. Visible authenticated Chrome replay remains under BH-027. |
| BH-036 | Defect/scheduling / P1 | Patient Portal | View or change an appointment for a clinic outside the browser timezone or submit a local time during a DST gap/overlap; the client could format/convert against browser assumptions. | Every patient-visible and submitted appointment time must use the authoritative clinic timezone, and ambiguous/nonexistent local times must fail safely to prevent wrong-time care. | API now returns authoritative branch name/timezone; shared portal conversion/formatting rejects DST ambiguity/gaps and labels clinic/zone. Focused UI/time/API tests and final regression pass. |
| BH-037 | Defect/reporting / P1 | Inventory, Labs and Telehealth | Load more than one server page; operational pages requested only a capped first page but presented counts as if complete. | Buyer-facing operational totals must cover the complete accessible clinic scope or explicitly report unavailability; silently capped totals can hide work and supplies. | Added cursor-page contracts while retaining legacy arrays, all-page client traversal with a bounded safety cap, and truthful accessible-scope labels. Integration proves stable two-page traversal and legacy compatibility; final regression passes. |
| BH-038 | Evidence integrity / P2 | Certification package | The evidence index referenced a screenshot that did not exist, and no executable guard prevented missing, empty or escaping paths. | A make-or-break certification packet must be reproducible and must not claim absent evidence. | Removed the invalid reference and added a bounded evidence-index verifier that hashes 12 non-empty in-repository artifacts and rejects traversal, absolute paths, duplicates, missing/empty files and symlink escape. Nine unit cases and the real index pass. |

### Open blockers and gaps

| ID | Type/severity | Exact evidence | Customer impact | Required remediation / retest status |
|---|---|---|---|---|
| BH-032 | External configuration/safety / P1 | In visible Chrome, the live Retell DID's inbound agent prompt named **Brightsmile Dental Group**, its London location and dental campaign. Render's `RETELL_AGENT_ID` instead matched the constrained outbound demonstration agent. The enabled live-test envelope did not match the Bright Health tenant; its execution ID, valid window/expiry and positive caps were absent. Evidence: `test-results/bright-health-retell-inbound-wrong-tenant-2026-09-02.png`. | A Bright Health caller could hear another tenant's identity and workflow. This is a tenant-misrouting, privacy and brand-safety blocker. | Do not call. Deploy the exact hardened release; set a short-lived Bright Health test envelope; deploy/publish the Bright Health agent from Receptionist Studio so it atomically rebinds the exact DID; verify Retell reads back the same agent/version/number; then place one bounded inbound test. **OPEN / SAFETY_BLOCKED.** |
| BH-009 | External proof / P1 | Newly published Fairfax deployment is VERIFIED in mock mode, but no post-publish inbound caller reached it; campaign is paused and activation is disabled. | Voice is a core purchase driver. A buyer can reasonably walk away if the exact deployed line cannot be proven. | On the deployed live provider: call the receptionist DID from an authorized staff phone, confirm disclosure/consent, complete one booking journey, verify call log/version/audit/cost, then activate. **OPEN / EXTERNAL_BLOCKED.** |
| BH-010 | External proof / P1 | No live outbound calls or provider receipts in this closing run. | Success, no-answer, voicemail, retry, opt-out, escalation, recording/transcript, and cost behavior remain unproven. | Run the bounded call matrix only to the three authorized full numbers, then attach provider and application receipts. **OPEN / EXTERNAL_BLOCKED.** |
| BH-011 | Release/observability / P1 | Fixes are uncommitted and not deployed. The public origin routes its API through Vercel, while a separate Render backend/worker service also exists. The current public `/health` returns release `unknown`, and `/metrics` returns frontend HTML; no evidence proved the public origin reaches Render. | Local evidence cannot certify the customer-facing deployment, and confusing two runtimes can attach the wrong SHA to incidents or leave the worker unverified. | Release identity now resolves explicit `RELEASE`, Render `RENDER_GIT_COMMIT`, or Vercel `VERCEL_GIT_COMMIT_SHA`. The guarded verifier proves public-origin exact SHA/readiness, metric denial without/with a wrong token, authenticated Prometheus content and effective baseline headers. Commit and CI one SHA; deploy the Vercel web/API and the required Render worker/API from that SHA; run the public verifier; separately prove Render worker heartbeat/job drain and migrations; then rerun customer journeys. **OPEN / DEPLOYMENT_BLOCKED.** |
| BH-012 | Performance / P2 | Local PILOT-volume database queries pass (slowest 62.92 ms). A tenant-verified, read-only Bright Health burst also passed 500/500 at concurrency 25, 186.28 requests/second, p95 182.66 ms and p99 198.44 ms. No deployed browser/API concurrency, write saturation, provider saturation, queue-depth or recovery evidence exists. | Local request handling is credible at the tested burst, but deployed capacity and recovery at pilot load remain unknown. | Retain the guarded local harness, then run an approved staged deployed test with p50/p95/p99 thresholds, queue telemetry, rate-limit evidence and recovery. **LOCAL EVIDENCE PASS / DEPLOYMENT_BLOCKED.** |
| BH-014 | Configuration / P1 | SMS and email confirmation channels display unconfigured provider requirements. Reminders are part of the requested pilot workflow. | Staff cannot rely on confirmations/reminders in a pilot, and a silent scope ambiguity could present unavailable delivery as operational. | Configure and verify approved providers, delivery receipts, consent, opt-out and failure queues, or explicitly remove live messaging from the signed pilot scope and customer script. **OPEN / EXTERNAL_BLOCKED.** |
| BH-027 | Verification / P2 | Newly hardened module pages have automated and build evidence, but their post-change customer journeys have not yet been replayed in visible Chrome because entering the synthetic password needs action-time confirmation. | Automated proof alone does not satisfy the stated customer-operation acceptance bar. | After explicit confirmation, log in locally, replay Intake, Connected Care, Labs, Inventory, Telehealth, Campaigns and Reviews, and attach screenshots. **OPEN / USER_CONFIRMATION_BLOCKED.** |
| BH-039 | Access recovery/implementation / P1 | On 2026-09-05, the authenticated production session resolved to Harley Street Medical Group under an Owner account. Its account menu offered no tenant switch, its Control Plane listed only that tenant's five clinics, and a separate `/platform/login` tab had no operator session. Tenant self-service recovery is now implemented locally: optional workspace disambiguation, provider-accepted pending→active email token, fragment-only browser handling, 30-minute default TTL, single-use confirmation, session revocation, MFA preservation, cooldown, neutral responses/timing, and deactivation/suspension invalidation. Focused recovery/security/UI verification passes. The deployed environment and controlled inbox have not been proven, and Platform Operator assisted recovery is still absent. | A customer or implementation team must be able to recover an existing tenant administrator through a governed, audited, time-bounded process without database surgery or access to another tenant. Until the local path is deployed and email delivery is proven, Bright Health still cannot enter its own workspace. | Deploy the exact tested release, configure `PUBLIC_APP_URL` plus a verified transactional email provider, prove the controlled-inbox link in Chrome, and close the remaining Platform Admin assisted-recovery fallback. Then recover the Bright Health owner and replay login, MFA, logout, expired/reused credential denial and role journeys. **LOCAL FIX PASS / DEPLOYMENT + EXTERNAL DELIVERY BLOCKED.** |

No unresolved P0 was found in the tested local build. BH-009, BH-010, BH-011, BH-014, BH-032, and BH-039 are unresolved P1 acceptance blockers for the requested pilot. BH-039 must close before the final Bright Health role journeys can begin; BH-032 must close before BH-009 can begin. BH-034 is repaired locally but remains deployment-evidence blocked.

## Missing and unwired feature register

| ID | Severity | Capability | Observed state | Pilot decision / workaround | Retest status |
|---|---|---|---|---|---|
| MU-001 | P1 if included | Referral and inter-clinic transfer workflow | No governed referral workflow is implemented; review UI explicitly reports referrals unavailable. | Exclude from signed pilot scope or implement identity, consent, assignment, status and audit lifecycle before promising it. | NOT IMPLEMENTED |
| MU-002 | P1 if included | Video-room delivery | CareCommand schedules and tracks video appointments but does not provide the clinical video room. | Name the approved external video system in onboarding and test the handoff; do not describe CareCommand as the video provider. | EXTERNAL WORKFLOW UNCONFIGURED |
| MU-003 | P2 | Lab/document upload | Partner-report tracking and clinician review exist; upload is not available on the page. | Use the clinic-approved external document workflow and scope the pilot to tracking/review only. | NOT IMPLEMENTED IN PRODUCT |
| MU-004 | P2 | Inventory purchasing | Stock receipt and threshold tracking exist; purchasing/vendor ordering is not configured. | Use the customer’s approved purchasing system; demonstrate only receipt and attention tracking. | NOT IMPLEMENTED IN PRODUCT |
| MU-005 | P1 for pilot access | Staff and tenant-admin account recovery | Secure self-service recovery is implemented and focused-tested locally, but the deployed email provider/controlled-inbox journey is unproven and the Platform Operator support roster still has no governed assisted reset/activation action. | Deploy and configure the self-service path, attach inbox/browser/audit evidence, then implement the BH-039 assisted-recovery fallback. | LOCAL FIX PASS / EXTERNAL_BLOCKED |
| MU-006 | P2 | Per-tenant patient-portal module controls | Portal navigation/actions are largely fixed rather than derived from a clinic feature allowlist. | Remove configurability promises for the pilot or implement server-enforced feature controls before claiming selective exposure. | GAP OPEN |
| MU-007 | P1 | Live SMS/email reminders | Product workflow exists, but approved delivery providers/receipts are absent. | Governed by BH-014; exclude from signed scope until provider proof is attached. | EXTERNAL_BLOCKED |

## Security, privacy, and tenancy findings

- Tenant users were not given platform privileges.
- Owner/admin, Front Desk, and Billing routes were checked through visible role-specific sessions.
- Front Desk could not open Control Plane; Billing could not open Work Queue.
- Billing and Front Desk clinic selection remained limited to assigned branches.
- Campaign preview, dispatch, attribution and advisory revenue now share one persisted clinic scope.
- Raw AI administrative aggregates fail closed for non-Owner/Admin roles until branch-safe projections exist.
- Pilot-status share links can be revoked idempotently and become inaccessible immediately.
- Public intake requests omit staff credentials and clinic-scope headers. After submission, the same unexpired packet capability can only confirm/retry submission; section mutation is rejected and cancelled/expired/approved packets remain denied.
- CRM calls no longer bypass application governance through a direct phone link.
- The final suite exercised RLS, cross-tenant denials, auth refresh/replay/logout boundaries, webhook signatures, platform MFA, payment/inventory concurrency, forward-only workflows, and audit behavior.
- The PILOT benchmark verified the platform role could not query patient rows.
- The sealed local candidate exposes real Prometheus metrics and reports database, Redis and ingress proxy ready; the local development release label remains `unknown` by design because no deployment SHA exists yet.
- Expired receptionist artifacts now have a daily signed, tenant-scoped purge path that honors legal holds and records provider deletion outcomes; local worker/lifecycle tests pass, while deployment and real provider receipts remain pending.
- A complete local backup/restore lifecycle passed with exact record parity and restored RLS/integrity verification. Managed Render backup availability, RPO/RTO and restore evidence remain external.
- Synthetic data only was used. No PHI was created or transmitted.
- The product clearly labels mock/test eligibility and card-payment modes on Revenue Operations.
- HIPAA readiness is not certified by this report. Deployment controls, BAAs, provider contracts, key custody, retention, backups, incident response, access reviews, and production audit export still require operational evidence.

## Multi-clinic findings

Strengths:

- Shared staff can be assigned to multiple locations with a primary clinic.
- Global and module scope stay synchronized after the Revenue fix.
- Scheduling displays branch, provider name, clinic-local time and timezone.
- Owner can view consolidated revenue; clinic roles cannot select a fictional network-wide view.
- Receptionist locations map explicitly to scheduling branches.
- Telehealth day boundaries follow the clinic timezone and canonical provider/branch relationships.
- Campaign evidence, dispatch and revenue stay inside a restricted manager's clinic.
- Inventory concurrency and lab/partner review transitions preserve evidence under retry.

Concerns:

- Client-facing clinic/receptionist configuration can change the deployed voice prompt and correctly triggers a re-publish/test-call gate; onboarding must plan for that operational dependency.
- Live multi-location routing, transfers, after-hours/holiday differences and cross-location call handoff still need deployed voice proof.
- The Connected Care story is intentionally sandbox-only. No live Withings adapter reachability or production vendor contract was proven.

## UI/UX and patient-experience findings

The Impeccable-led redesign materially improved hierarchy, visible role/scope context, Operational Briefing, navigation, modern card treatment, responsive behavior, and honest empty/loading/error states. The strongest quality is not decorative glass treatment; it is that money, clinic, test/live mode, and verification states are now explicit.

Remaining experience risks are operational: SMS/email channels are unconfigured, Connected Care vendor reachability is unverified, and the live call experience is unproven. Those will outweigh visual polish in a buyer’s evaluation.

## Current competitive benchmark

Competitor statements below are vendor claims from official sources, checked on 2026-09-02. They are not independently verified performance claims.

| Vendor | Current official claim | CareCommand observed position |
|---|---|---|
| NexHealth | Reminder sequences can vary by appointment type/confirmation status and shared templates can warn about multi-location impact ([official help](https://help.nexhealth.com/en/articles/10046646-how-do-i-set-up-appointment-reminders)). | CareCommand has broad scheduling/communications concepts and stronger evidence-state language, but live reminder delivery and multi-location template behavior are not proven. |
| Tebra | Practice-level online scheduling supports multiple service locations/providers and may include telehealth; patient confirmations/reminders are part of online booking ([official help](https://helpme.tebra.com/Platform/Practice_Settings/Calendar_Settings/Enable_or_Disable_Practice_Online_Scheduling), [booking help](https://helpme.tebra.com/Practice_Growth/Practice_Portal/Online_Booking_with_Practice_Growth)). | CareCommand’s internal scheduling and branch scope are credible; patient self-service, marketplace visibility, and external scheduling integration are less mature in this proof. |
| Phreesia | Its official investor material presents integrated scheduling, intake, eligibility, payments, reminders, consent, messaging, analytics, and real-time PM/EHR integration ([official investor presentation](https://ir.phreesia.com/files/doc_financials/2025/q2/PHR-Q2-FY25-IR-Presentation.pdf)). | CareCommand’s single operational workspace is compelling, but test-mode integrations and missing deployed delivery proof leave it behind on enterprise integration credibility. |
| Hyro | The vendor claims healthcare voice/chat agents for scheduling, routing, FAQs and Epic-connected patient access, with explainability/control/compliance positioning ([official platform](https://www.hyro.ai/), [provider solution](https://www.hyro.ai/providers/)). | CareCommand shows unusually explicit deployment, consent, safe-tool and audit gates. It cannot claim competitive call quality or reliability until the live inbound/outbound matrix passes. |

CareCommand’s best differentiation is an evidence-aware clinic operating layer: one place for scheduling, front-desk work, communications review, revenue follow-up, clinic scope, and explicit test/live/readiness state. The competitive weakness is execution proof around live integrations, onboarding completeness, and deployed reliability.

## Must-have before pilot

1. Commit the current working tree and establish one immutable release SHA.
2. Run clean CI and deploy that exact SHA to Render.
3. Replace the stale Retell inbound binding by deploying the Bright Health agent from Studio; verify exact DID, tenant, agent/version and webhook readback before any call.
4. Create a short-lived live-test envelope for the Bright Health tenant with one run ID, one approved destination per execution, valid window/expiry and positive call/minute/cost caps.
5. Verify migrations, runtime SHA, health, security headers, cookies/CSRF, queue/worker, and rollback on Render.
6. Complete one exact-deployment inbound call and only then consider reactivating Fairfax.
7. Execute the bounded live outbound matrix to only the three authorized full numbers.
8. Configure/verify SMS and email channels or remove those promises from pilot scope; run staged deployed concurrency/load and recovery evidence.
9. Complete the pending authenticated local Chrome replay, then rerun the strongest owner, role, clinic-switch and hardened-module journeys on the deployed release.
10. Assign real owners and execute the prepared Bright Health operations packet: support/escalation, emergency stop, incident response, retention, managed backup/restore, access review and success-metric sign-off.

Can defer after a tightly scoped pilot: broad visual refinement beyond the established design system, secondary modules not in the signed pilot scope, advanced benchmarking, and deeper growth/marketing automation.

## Sales and implementation verdict

A credible multi-clinic buyer would be **impressed by the breadth, visible scope controls, scheduling workflow, evidence-aware AI receptionist setup, Connected Care duplicate/alert evidence, and unified operational workspace**. They would be **seriously concerned by the wrong-customer live inbound binding, unconfigured delivery channels, and absence of deployed capacity evidence**. A buyer would reasonably walk away if the current voice number were demonstrated. If voice is excluded and this is presented honestly as an attended local workflow demonstration with dated external-certification gates, the product is credible enough to continue the sales process.

## Top ten remediation priorities

1. Keep the live DID out of demonstrations until the wrong-customer inbound binding is removed and verified.
2. Commit/CI/deploy one immutable SHA and verify runtime release/metrics.
3. Deploy Bright Health from Studio and verify DID/agent/version/webhook readback plus the short-lived safety envelope.
4. Complete the post-change visible Chrome replay with the synthetic tenant.
5. Exact live inbound call proof and campaign activation.
6. Deployed owner/Front Desk/Billing and hardened-module Chrome retest.
7. Bounded authorized outbound call matrix and call ledger.
8. SMS/email provider configuration and delivery/consent evidence.
9. Deployed performance/queue/recovery, observability, alerting and rollback proof.
10. Assign the operations-packet owners; execute managed backup/restore, access review and incident/emergency-stop drills; record sign-off and limitations.

## Client demonstration script

Use only these flows until the remaining blockers are closed:

1. Sign in as the Bright Health owner and open Operational Briefing. Explain network context and evidence status.
2. Open Work Queue and show actionable calls/tasks/KPIs without discussing live-call capacity.
3. Open Schedule, choose Fairfax, inspect provider availability, and book a synthetic consultation.
4. Show the appointment with provider name, clinic and clinic-local time.
5. Switch to Communications, open the stored synthetic call, show summary/actions/review revision/audit attribution.
6. Sign in as Front Desk, show that Work Queue is available and Control Plane is denied.
7. Switch Front Desk between Arlington and Fairfax and show clinic-local counts.
8. Sign in as Billing, show that Revenue Operations is available and Work Queue is denied.
9. Switch Billing between Fairfax and Arlington; show the breadcrumb, local selector and failed-payment queue changing together.
10. Return as owner and show Control Plane clinic assignments and least-privilege role setup.
11. Open Receptionist Studio and show Bright Health clinic/location mappings, disclosure wording, readiness checklist and mock verification. Explicitly say the live post-publish call is still pending.
12. End with Security Posture/Audit evidence and the pilot acceptance checklist.

After BH-027 closes, demonstrate Connected Care only as a signed **sandbox** workflow: provider setup, device enrollment, normal reading, alert, duplicate suppression, and honest billing gaps. Do not claim live Withings reachability, live SMS/email, production capacity, or a certified live call until the corresponding evidence above is green.

## Changes made during the closing hardening pass

- Hardened cursor-complete Intake search/disambiguation and permissions, public intake credential separation and submitted-packet RLS lifecycle, Connected Care provider/device readiness and provider activation, Telehealth local-time/provider scope, campaign/advisory branch authority, raw AI least privilege, CRM call governance, pilot-link revocation, patient-portal session/timezone/DST behavior, reviews empty states, and Advisory Room execution intent.
- Populated Bright Health Arlington through application APIs with a signed synthetic Connected Care story; retained a truthful `MISSING_REQUIREMENTS` billing state instead of fabricating 16 historical days or clinical time.
- Serialized concurrent inventory receipts, enforced forward-only/idempotent partner-report review, and made Inventory, Labs and Telehealth traverse all accessible cursor pages before presenting totals.
- Added host-correct release identity for explicit `RELEASE`, Render `RENDER_GIT_COMMIT`, and Vercel `VERCEL_GIT_COMMIT_SHA`; the public same-origin API is a Vercel function, while Render remains a separately verified service boundary. Vercel documents `VERCEL_GIT_COMMIT_SHA` as available at build and runtime when system variables are exposed ([official system variables](https://vercel.com/docs/environment-variables/system-environment-variables)).
- Added a canonical-host, HTTPS-only, GET-only deployed-release verifier for the exact SHA, database/Redis/ingress readiness, denial without/with an invalid monitoring token, authenticated Prometheus output, API-exposed queue-depth/dependency series and effective HSTS/frame protections. The 11 deployment/release scenarios pass locally; worker processing remains a separate deployment gate.
- Added a tenant-verified, read-only, loopback-only API burst harness and passed 500/500 Bright Health requests at concurrency 25; it refuses remote targets by construction.
- Repaired and documented the guarded local backup/restore lifecycle so it needs no deployed signing secret; clean 128-migration restore, record parity, RLS role/policies and tenant-integrity verification pass.
- Wired the previously orphaned receptionist retention purge into a daily signed tenant-scoped worker and added focused schedule/context/envelope regression coverage.
- Added a Bright Health-specific pilot operations packet with active stop conditions, launch gates, emergency-stop sequence, unassigned accountable roles, retention/backup/access controls, success scorecard and formal sign-off table.
- Added a machine-verifiable Bright Health release-candidate manifest that seals 1,223 tracked and non-ignored untracked repository files, including migrations and tests, while excluding only the self-referential manifest/report and evidence media. The exact final fingerprint is recorded above.
- Added a machine-verifiable evidence-index guard; all 12 listed artifacts are present, non-empty, in-repository regular files with computed hashes.
- Updated older end-to-end fixtures to use evidence-backed campaign revenue and configured synthetic RPM providers/devices. This repaired test drift without weakening production safeguards.
- Added secure tenant self-service recovery with optional workspace disambiguation, neutral responses and timing, provider-accepted pending-to-active tokens, fragment-only browser transport, a 30-minute default expiry, cooldown and concurrency protection, one-time use, global session revocation, MFA preservation, and reset invalidation on user deactivation or tenant suspension. The visible browser journey and focused backend/frontend/security regressions pass locally.
- Retested the five Redis/config-affected files from the aggregate run with the correct local Redis endpoint after updating the single stale health-contract expectation. The combined exact-tree result is 291/291 files passing, with 3,758 passing tests, 5 expected-failure cases and 10 skips; the targeted 11-file retest passed 100/100 tests.

## Evidence index

- `test-results/bright-health-work-queue-fixed.png`
- `test-results/bright-health-scheduling-booked-fixed.png`
- `test-results/bright-health-call-review-complete.png`
- `test-results/bright-health-frontdesk-billing-provisioned.png`
- `test-results/bright-health-billing-scope-fixed.png`
- `test-results/bright-health-control-plane-security.png`
- `test-results/bright-health-staff-desktop.png`
- `test-results/bright-health-staff-mobile-scope-accepted.png`
- `test-results/bright-health-public-intake-submitted.jpg`
- `test-results/bright-health-retell-inbound-wrong-tenant-2026-09-02.png`
- `docs/testing/BRIGHT_HEALTH_PILOT_OPERATIONS_PACKET_2026-09-02.md`
- `docs/testing/bright-health-release-candidate.json`

## Certification boundary

This report certifies the observed local working tree and synthetic customer operation described above. It does not certify the current Vercel public web/API deployment, the separate Render API/worker deployment, live Retell behavior, telecommunications compliance, payment/eligibility providers, HIPAA compliance, or production capacity. Those remain explicit acceptance gates, not assumptions.
