# Phase 1 addendum — A6 Outbound campaigns (SDET audit + consultant verdict)

Re-run 2026-08-29 after the first attempt overflowed its output contract. Verdict: **BELOW_STANDARD**.

The safety spine is strong: OWNER approval with a frozen authority fingerprint (outbound.ts:923-980), fail-closed quiet hours, DNC fence at the provider boundary, canonical-booking-only truth, emergency stop with provider cancellation; 66/66 outbound tests pass. But a clinic cannot run a campaign without engineering: the Studio builder never sets agentId for request-only mode (Studio 1537,1812 vs outbound.ts:344) so UI-built campaigns fail approval; Pause 409s on direct-booking/custom campaigns (Zod partial keeps defaults, outbound.ts:783-802, reproduced on zod 4.4.3); no dispatcher touches receptionistCallTarget; targets have no appointment link (schema 2845-2872); no recall/waitlist purposes (outbound.ts:49); candidates capped at 50+50 with no search UI.

## Capability map

| Capability | Status | Evidence |
|---|---|---|
| Create outbound campaign (builder) | partial | outbound.ts:783-830 create; Studio CampaignFormFields 1774-1863 has no agent picker for request-only mode, so UI-built request-only campaigns can never be approved |
| Edit campaign after creation | missing | PATCH /outbound-campaigns/:id exists (outbound.ts:832) but Studio exposes no edit form; only Pause uses PATCH (Studio 2098) |
| Purpose / legal basis / policy version authority | works | outbound.ts:318-320 required for approve/direct booking; fingerprint 78-113; UI pre-selects values (known) |
| OWNER/ADMIN approval with frozen authority fingerprint | works | outbound.ts:923-980; tests receptionistOutboundTargets:1616,1652 pass |
| Pause running campaign | broken | Zod partial() injects defaults into PATCH {status:'PAUSED'} (outbound.ts:783-803) -> authorityChanged -> 409 outbound_authority_immutable for direct-booking or non-default retries/fields |
| Target candidate discovery | partial | outbound.ts:975-1057 take:50 patients + 50 leads; q param never sent by UI (Studio 2189); policy-missing 409 shown as generic failure (known) |
| Add / remove targets with identity binding and dedupe | works | outbound.ts:1065-1120, 1252-1266; tests :1776,1813 pass |
| Bulk / CSV / CRM-segment / appointment-driven target import | missing | Only single-select Add in TargetList (Studio 2197-2210); API accepts up to 500 rows (outbound.ts:1075) but no UI or importer uses it |
| Manual per-target launch with layered gates | works | outbound.ts:1377-2613 (status, authority, agent, stop, identity, DNC, quiet hours, capacity, provider intent); 66 tests pass |
| Automatic dialer / scheduler for RUNNING or SCHEDULED campaigns | missing | No worker references receptionistOutboundCampaign/receptionistCallTarget (server/workers/*); SCHEDULED only in enums outbound.ts:802,932 |
| Retry allowance | partial | isTargetDialable/targetStatusAfterOutcome outbound.ts:125-140 enforce allowance; no automatic re-dial after NO_ANSWER/VOICEMAIL/quiet-hours skip |
| Quiet hours (clinic tz, overnight, DST, fail-closed) | works | outbound.ts:381-427, 1530-1550; tests :440-478,1567 pass; client mirror validateOutboundQuietHours receptionist.ts:643 |
| DNC / consent fence at provider boundary | works | dncFence.ts:174-279 advisory fences + DB trigger; outbound.ts:1815-1900; tests :565-676,848 pass |
| Marking a suppressed target OPTED_OUT at dial | broken | outbound.ts:1497-1503 isSuppressed returns skipped with no log/target update; 1508-1523 opt-out branch unreachable (campaigns.ts:623 already covers it) |
| Tenant emergency stop with provider cancellation and reconciliation evidence | works | outbound.ts:446-720; Studio OutboundStopCard 1667-1725; tests :2097,1519 pass |
| Tenant-side clearing of emergency stop | missing | POST /outbound-control accepts only stopped:true (outbound.ts:452); UI says only platform control can clear (Studio 1690) |
| Provider lifecycle sync (poll) | partial | outbound.ts:2620-2780 maps any 'ended' without voicemail/no_answer reason to ESCALATED + COMPLETED target + staff task |
| Webhook outcome -> target state | partial | routes.ts:2470-2478 uses raw analysis outcome for target while call log normalized BOOKED->ESCALATED at :2389 |
| Transport-ambiguity and reconciliation launch blocks | works | receptionist.ts:378-384,570-640; routes.ts:1245; tests :313-417,1879-1909 pass |
| Attended live-test synthetic target | partial | outbound.ts:1126-1250 works; Studio 2010-2016 hardcodes acknowledgeSyntheticConsentEvidence:true and 'Jordan Test' without operator attestation |
| Booking-request reject | works | outbound.ts:2818-2860 REJECTED only, terminal guard; Studio ConfirmedButton requireReason 2368-2378 |
| Booking-request reconcile to canonical appointment | partial | routes.ts:1363-1497 strict identity/branch/provider proof works; UI requires pasted UUID, scheduler opens without prefill (Studio 2364,2410) |
| MISSING_INFO request completion path | missing | PATCH schema z.literal('REJECTED') outbound.ts:2822; no UI to edit collected fields or re-contact |
| Confirmation outbox enqueue/dispatch with lease, backoff, dead-letter, delivery_unknown | unverified | confirmationOutbox.ts:87-350; worker cron '* * * * *' queues.ts:143; 33 outbox/consent tests describe.skip without RLS_DISPOSABLE_DB |
| Confirmation delivered receipts (SMS/email) | missing | Only monitoring in-app inbox sets status 'delivered' (monitoring/routes.ts:295); no RECEIPT phase writer for receptionist.appointment_confirmation |

## Findings

| ID | Sev | Type | Title | File:line | Recommendation |
|---|---|---|---|---|---|
| A6-F01 | P0 | defect | Pause fails with 409 for running direct-booking / non-default campaigns (Zod partial() re-applies defaults on PATCH) | server/modules/receptionist/outbound.ts:802 | Build campaignUpdate without defaults (base schema without .default, defaults applied only in create) or strip undefined keys before diffing; add a test pausing a RUNNING DIRECT_BOOKING campaign via PATCH. |
| A6-F02 | P0 | gap | Studio builder never sets agentId for request-only campaigns, so approval always 409s agent_unlinked | src/pages/ReceptionistStudio.tsx:1812 | Add an agent selector (active, verified agents of the clinic) to CampaignFormFields for both modes, and surface agent readiness reason inline before approval. |
| A6-F03 | P1 | gap | No dispatcher: RUNNING/SCHEDULED campaigns never auto-dial, no retry or post-quiet-hours re-attempt | server/modules/receptionist/outbound.ts:932 | Add a worker that drains PENDING targets of RUNNING campaigns through the existing /call gates (respecting quiet hours, capacity, retry backoff) with per-campaign pacing and a start/stop time window. |
| A6-F04 | P1 | gap | Target import is one-at-a-time from a 50+50 capped dropdown; no search, CSV, CRM segment or appointment-based population | server/modules/receptionist/outbound.ts:1006 | Expose search + pagination in TargetList; add 'Add from appointments (date range)' and 'Add from CRM segment/CSV' flows that run through the same identity/consent checks. |
| A6-F05 | P1 | gap | APPOINTMENT_REMINDER calls carry no appointment context to the agent | server/modules/receptionist/outbound.ts:2003 | Link ReceptionistCallTarget to an Appointment (optional FK) and pass appointment_time/location/provider variables; let the agent's list_upcoming_appointments tool anchor on it. |
| A6-F06 | P1 | defect | Webhook writes raw analysis outcome to the target, marking it COMPLETED/BOOKED without a canonical booking | server/modules/receptionist/routes.ts:2474 | Pass the persisted/normalized outcome to targetStatusAfterOutcome and lastOutcome; add a test asserting target.lastOutcome ESCALATED when analysis says BOOKED without canonical appointment. |
| A6-F07 | P2 | defect | Suppressed targets are never marked OPTED_OUT at dial; the marking branch is unreachable dead code | server/modules/receptionist/outbound.ts:1497 | Merge the two gates: on suppression create the OPTED_OUT call log and set target status OPTED_OUT (or a new SUPPRESSED status) in one transaction; delete the dead branch. |
| A6-F08 | P2 | defect | Provider-sync before the analyzed webhook terminalizes the target as ESCALATED and loses the real outcome | server/modules/receptionist/outbound.ts:2664 | On poll, keep call IN_PROGRESS/ended-pending-analysis for a grace window, or let a later signed call_analyzed event override a poll-derived ESCALATED (track outcomeSource). |
| A6-F09 | P2 | gap | Confirmation 'Delivered' state is unreachable: no SMS/email delivery-receipt ingestion | server/lib/receptionist/confirmationOutbox.ts:47 | Add provider delivery-status webhook ingestion (Twilio/SendGrid style) keyed by providerMessageId writing RECEIPT attempts and status delivered/failed. |
| A6-F10 | P2 | gap | ConfirmationDeliveryQueue has no actions for dead_lettered / delivery_unknown rows | src/pages/ReceptionistStudio.tsx:2468 | Add per-row actions: 'Mark handled (reason)', 'Retry now' for dead_lettered with provider_setup_required, and link to the appointment; persist as delivery attempts/audit. |
| A6-F11 | P2 | ux | Booking-request reconciliation requires pasting an appointment UUID; scheduler opens with no prefill | src/pages/ReceptionistStudio.tsx:2410 | Open scheduler with prefilled patient/service/time/branch and a returnTo that auto-reconciles the created appointment to the request; offer an appointment picker filtered by patient. |
| A6-F12 | P2 | gap | MISSING_INFO requests have no completion path other than reject or manual appointment link | server/modules/receptionist/outbound.ts:2822 | Add PATCH of collected fields (audited) that recomputes missingFields and moves to PENDING_REVIEW, plus a 'call back' action that enqueues a target. |
| A6-F13 | P2 | security | Live-test attach auto-asserts synthetic consent attestation from the browser | src/pages/ReceptionistStudio.tsx:2013 | Add an explicit checkbox in the ConfirmedButton dialog bound to acknowledgeSyntheticConsentEvidence; keep default false. |
| A6-F14 | P2 | ux | Tenant cannot clear its own emergency stop; no escalation path shown | server/modules/receptionist/outbound.ts:452 | Allow OWNER to clear a tenant-initiated stop (not platform-imposed) with reason + audit, or show a 'request reactivation' action that files a platform task. |
| A6-F15 | P2 | hardcoded | Capacity, budget, pagination and agent-name fallbacks are hardcoded constants | server/modules/receptionist/outbound.ts:53 | Move limits to tenant settings/plan (TenantUsageLimit rows) and import the constant in routes.ts; paginate lists. |
| A6-F16 | P2 | i18n | Confirmation SMS is English-only and does not identify the clinic | server/lib/receptionist/confirmationOutbox.ts:336 | Include clinic name/location and use clinic language/locale for formatting; make templates configurable per clinic. |
| A6-F17 | P2 | ux | 'Approve and start' is shown to non-owner/admin roles and for COMPLETED/FAILED campaigns | src/pages/ReceptionistStudio.tsx:2077 | Pass user role into CampaignDetail, hide/disable for non OWNER/ADMIN with a tooltip, and label the action 'Re-approve and restart' for terminal statuses. |
| A6-F18 | P3 | ux | Request-only 'Default branch ID' is a free-text UUID input | src/pages/ReceptionistStudio.tsx:1843 | Reuse the mapped-locations Select used in direct-booking mode. |
| A6-F19 | P3 | ux | Booking-review-only roles get a permanent red 'safety status unavailable' alert | server/modules/receptionist/outbound.ts:433 | Allow read of stop status with call-artifacts:read, or hide the card when the user lacks manage permission. |
| A6-F20 | P3 | test-gap | Pause is only tested on default-shaped request-only campaigns, masking the PATCH default-reset bug | server/test/receptionistOutboundTargets.integration.test.ts:1007 | Add cases: pause RUNNING DIRECT_BOOKING campaign; pause with maxRetryAttempts 3; PATCH {name} on DRAFT must not alter bookingMode/requiredFields. |
| A6-F21 | P3 | harness | Confirmation outbox and delivery-consent suites skip entirely without RLS_DISPOSABLE_DB | server/test/receptionistConfirmationOutbox.integration.test.ts:139 | Provision a disposable RLS DB in CI or split non-destructive cases out of the gated describe. |
| A6-F22 | P3 | test-gap | No component/UI tests for OutboundPanel, CampaignBuilder, TargetList, BookingRequestQueue, ConfirmationDeliveryQueue | src/pages/ReceptionistStudio.tsx:1544 | Add jsdom tests covering builder payload shape, approve/pause flows, target add/call gating and queue actions with mocked receptionistApi. |
| A6-F23 | P3 | ux | Quiet hours required client-side at creation while server allows drafts without them | src/lib/receptionist.ts:646 | Use time inputs with clinic-timezone hint and defer the 'required' rule to approval, matching the server. |

## Consultant gaps

| ID | Pri | Effort | Gap | Proposal |
|---|---|---|---|---|
| A6-G01 | P0 | S | Studio builder never attaches an agent for request-only campaigns; approval always 409 agent_unlinked (Studio 1537,1812; outbound.ts:344-347). | Add an agent Select (active, provider-verified agents of the clinic) to CampaignFormFields for both modes; show agentReadinessReason inline and disable Approve until ready; add a jsdom test that the builder payload is approvable. |
| A6-G02 | P0 | S | PATCH schema campaignCreate.partial() re-applies defaults, so {status:'PAUSED'} flips authority fields and throws outbound_authority_immutable (outbound.ts:783-802,870-890). | Define a defaults-free base schema for update (or strip keys not present in the body before diffing); add tests: pause RUNNING DIRECT_BOOKING, pause with maxRetryAttempts 3, PATCH {name} leaves bookingMode/requiredFields untouched. |
| A6-G03 | P0 | L | No dispatcher: RUNNING/SCHEDULED campaigns never auto-dial; quiet-hours skips and NO_ANSWER leave targets PENDING with no retry (no worker references receptionistCallTarget; outbound.ts:1546). | Add outbound.worker in server/workers draining PENDING targets of RUNNING campaigns through the existing /call gate logic (extract launch into a service), with per-campaign calling window, pacing (calls/min), retry backoff, and audit; SCHEDULED starts at window open. |
| A6-G04 | P1 | M | Targets carry no appointmentId and calls pass no appointment variables (schema 2845-2872; outbound.ts:1998-2016), so APPOINTMENT_REMINDER cannot state the visit. | Add optional appointmentId FK on ReceptionistCallTarget; pass appointment_time/location/provider/service variables; let list_upcoming_appointments anchor on it; write confirmed/cancelled status back to Appointment and enqueue the confirmation outbox. |
| A6-G05 | P1 | M | Candidate discovery is take:50 patients + 50 leads with no search UI, CSV, CRM segment, appointment-date or recall-due population (outbound.ts:990-1006; Studio TargetList 2246-2294). | Add search + pagination to TargetList; add 'Add from appointments (date range)', 'Add from CRM segment', and CSV import flows that reuse POST targets (500 rows) and the same identity/consent checks; show per-row authorization reason. |
| A6-G06 | P1 | L | Purposes are only CARE_COORDINATION/APPOINTMENT_REMINDER/PATIENT_REACTIVATION (outbound.ts:49); no recall-due or waitlist-fill purpose, no slot-open trigger. | Add RECALL_DUE and WAITLIST_FILL purposes with legal-basis rules; add a scheduling hook that, on cancellation, enqueues WAITLIST-status appointments as targets of an approved waitlist campaign in priority order, with direct booking into the freed slot. |
| A6-G07 | P1 | S | Webhook uses raw analysis outcome for the target while the call log is normalized BOOKED->ESCALATED without a canonical appointment (routes.ts:2389 vs 2474-2478). | Pass persistedOutcome to targetStatusAfterOutcome and lastOutcome; add a test asserting target.lastOutcome ESCALATED when analysis says BOOKED without canonical booking. |
| A6-G08 | P1 | M | No edit UI after creation; request-only branch is a free-text UUID; quiet hours are free-text and required at save while server allows drafts (Studio 1843,1859,1873; outbound.ts:301-307). | Add an edit form on DRAFT/PAUSED (server PATCH exists at outbound.ts:832); reuse the mapped-location Select in both modes; use time inputs with clinic-timezone hint and enforce quiet hours at approval only. |
| A6-G09 | P2 | S | isSuppressed already includes opt-out (campaigns.ts:612), so the OPTED_OUT marking branch is dead; suppressed targets stay PENDING with no call-log evidence (outbound.ts:1497-1523). | Merge the gates: on suppression write an OPTED_OUT (or SUPPRESSED) call log and update the target in one transaction; delete the unreachable branch; add a test. |
| A6-G10 | P2 | M | Provider-sync of a just-ended call maps 'ended' to ESCALATED, terminalizes the target and opens a HIGH task before call_analyzed arrives (outbound.ts:2664-2672,2723-2740; routes.ts:2401). | Keep IN_PROGRESS with an ended-pending-analysis marker for a grace window, or record outcomeSource so a later signed call_analyzed overrides a poll-derived ESCALATED; add a poll-then-webhook race test. |
| A6-G11 | P2 | M | No delivery-receipt ingestion (RECEIPT phase never written) and ConfirmationDeliveryQueue is read-only for dead_lettered/delivery_unknown rows (confirmationOutbox.ts:47-56; Studio 2482-2513). | Add Twilio/SendGrid status webhooks keyed by providerMessageId writing RECEIPT attempts and delivered/failed; add row actions Mark handled (reason), Retry now after provider setup, link to appointment; persist as attempts/audit. |
| A6-G12 | P2 | M | Booking-request queue: reconcile needs a pasted appointment UUID, scheduler opens without prefill, MISSING_INFO has no edit or call-back path (Studio 2364,2410-2419; outbound.ts:2822). | Open scheduler with patient/service/time/branch prefilled and a returnTo that auto-reconciles the created appointment; add an appointment picker filtered by patient; allow audited PATCH of collected fields and a 'call back' action that enqueues a target. |
| A6-G13 | P2 | S | Live-test attach hardcodes acknowledgeSyntheticConsentEvidence:true, minting a granted consent event nobody attested (Studio 2013-2018; outbound.ts:1172-1195). | Bind both acknowledgements to explicit checkboxes in a ConfirmedButton dialog, default false; record the attesting user in the consent event metadata. |
| A6-G14 | P2 | S | Tenant emergency stop cannot be cleared by the tenant; only stopped:true accepted and UI says platform control must clear it with no channel (outbound.ts:452; Studio 1690). | Let OWNER clear a tenant-initiated stop (not platform-imposed) with reason and audit, keep platform-imposed stops platform-only, and add a 'Request reactivation' action that files a platform task. |
| A6-G15 | P2 | M | Hardcoded limits and copy: MAX_TENANT_ACTIVE_CALLS=3, DEFAULT_VOICE_MINUTES_LIMIT=500, agent fallback 'Riley', en-US unbranded confirmation SMS (outbound.ts:53-54,2004; confirmationOutbox.ts:40,336). | Move concurrency/budget to TenantUsageLimit/plan rows; include clinic name and location in confirmations; format with clinic locale/timezone; make templates configurable per clinic. |
| A6-G16 | P2 | S | Approve button has no role check (Studio 2112-2122); FRONT_DESK sees a permanent red safety alert because stop status requires receptionist:manage (outbound.ts:433). | Pass role into CampaignDetail, hide/disable Approve for non OWNER/ADMIN with a tooltip, label 'Re-approve and restart' for terminal statuses; allow read of stop status with call-artifacts:read or hide the card. |
| A6-G17 | P3 | M | No per-campaign outcome funnel; list endpoint only returns _count of targets and callLogs (outbound.ts:806-811). | Add GET /outbound-campaigns/:id/metrics (targets by status, outcomes, bookings with canonical appointments, minutes, cost) and a summary strip in CampaignDetail. |
| A6-G18 | P3 | M | Harness gaps: outbox/consent suites skip without RLS_DISPOSABLE_DB (33 tests), no jsdom tests for OutboundPanel components, no create-approve-call-webhook-reconcile journey test. | Provision a disposable RLS DB in CI; add jsdom tests for builder payload, approve/pause, target add/call gating, queue actions; add one integration journey test across the full outbound path. |

## Edge moves

- Sell 'auditable outreach': OWNER approval with a frozen authority fingerprint and policy version per campaign is stronger governance than any incumbent offers; surface it in the UI as a signed approval record.
- Fail-closed compliance at the provider boundary (DNC fence with DB trigger, quiet hours that refuse to dial on bad config) is a real differentiator for TCPA-sensitive multi-location groups; publish it as a guarantee.
- Canonical-booking-only truth (LLM claims never count as bookings) beats AI receptionists that over-report; expose a 'verified bookings' metric per campaign once G07/G17 land.
- Once a dispatcher exists, run voice-first recall with SMS fallback through the same outbox: call, then text a booking link on no-answer, sharing one suppression and consent model.
- Voice waitlist fill with direct booking into the freed slot (G06) leapfrogs Luma/NexHealth text-only waitlists.
- Purpose + policy-version consent evidence enables explicit-consent markets (UK/EU) where US incumbents are weak.
- Emergency stop with provider cancellation and reconciliation evidence is unique; add a tenant self-clear (G14) and market it as a one-click safety brake.

## Pilot blockers

- Studio cannot create an approvable request-only campaign (agent never set) so no clinic user can start outreach (G01).
- Pause returns 409 for direct-booking or custom campaigns; only the kill switch stops a live campaign (G02).
- No automatic dialer: every call is a staff click, no retries after no-answer or quiet hours (G03).
- Reminder calls carry no appointment context and cannot confirm or change the real visit (G04).
- Target candidates capped at 50 patients + 50 leads with no search or import (G05).
- Production checklist shows agent deployment and live-test authorization unset; launches return setup_required.
- Webhook marks targets BOOKED on LLM-claimed bookings without a canonical appointment (G07).
- Confirmation SMS omits clinic identification and is English-only (G15).
- Tenant cannot clear its own emergency stop and no escalation channel is shown (G14).
- Booking-request reconciliation requires pasting an appointment UUID (G12).
- Confirmation outbox state machine is untested in the default run (33 tests skipped) (G18).

## Coverage gaps

- No test pauses a RUNNING DIRECT_BOOKING outbound campaign via PATCH /outbound-campaigns/:id (A6-F01)
- No test that a webhook analysis outcome BOOKED without canonical booking leaves the target non-terminal (A6-F06)
- No test asserting a suppressed target is marked OPTED_OUT at dial; the branch is dead code (A6-F07)
- No test for provider-sync racing an analyzed webhook (poll-first then call_analyzed) (A6-F08)
- No test for target-candidate search/pagination beyond the 50-row take
- No jsdom tests for OutboundPanel/CampaignBuilder/TargetList/BookingRequestQueue/ConfirmationDeliveryQueue
- Confirmation outbox and delivery-consent integrity suites (33 tests) run only with RLS_DISPOSABLE_DB
- No test that the Studio builder payload for request-only mode is accepted by POST /outbound-campaigns and approvable
- No end-to-end journey test create -> approve -> target -> call -> webhook -> request -> reconcile -> confirmation
- No test that MANAGER role is refused Approve in UI (server 403 covered at test :1616)
- Known (confirmed): builder posts '' for optional UUIDs/policyVersion -> 400 (Studio 1537,1877-1886; outbound.ts:786-791)
- Known (confirmed): campaigns cannot be edited after creation from the UI
- Known (confirmed): target-candidates 409 for missing policy shown as generic load failure (Studio 2190; outbound.ts:983)
- Known (confirmed): purpose/legal basis silently pre-selected in EMPTY_CAMPAIGN (Studio 1540)
- Known (confirmed): RetellStatusCard copy points at server env vars (Studio 1745)
