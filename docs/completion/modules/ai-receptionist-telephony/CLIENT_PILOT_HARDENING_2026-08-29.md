# AI Receptionist client-pilot hardening review

Date: 2026-08-29  
Scope: CareCommand AI Front Desk, Receptionist Studio, Retell agent `agent_bbc…1e5`, and the Retell number ending `8894`.  
Method: signed-in Chrome walkthrough, Retell configuration and historical-call inspection, repository trace, focused automated tests, clinic-operations SME review, architecture review, and current vendor-documentation comparison.

## Release verdict

**NO-GO for an independent client pilot today.** The backend has unusually strong safety and evidence controls, but the deployed voice runtime and staff-facing Front Desk are not one working product yet. A controlled internal attended UAT is appropriate only after the P0 deployment items below are green.

Do not describe the module as a live AI receptionist, autonomous scheduler, inbound answering service, or production-ready healthcare workflow until the exit gates in this document pass.

## What was directly observed in Chrome

| ID | Severity | Observation | Client impact | Evidence/status |
| --- | --- | --- | --- | --- |
| REC-P0-001 | P0 | The Retell number has **Inbound Call Agent = None (disabled)**. | A customer cannot call the advertised number and reach the receptionist. | Observed in Retell Phone Numbers. Open. |
| REC-P0-002 | P0 | The number's outbound binding is the keypad demo **V0**, while the agent has published V1 and draft V2. | CareCommand's verified/published version cannot be assumed to be the version that actually calls. | Observed in Retell Phone Numbers and agent versions. Open. |
| REC-P0-003 | P0 | The live agent is a fixed fictional appointment reminder. It says a hardcoded doctor/date/time and supports only confirm/cancel. | It cannot behave like a receptionist or safely test real booking, rescheduling, insurance, urgency, or handoff. | Observed agent prompt and completed-call transcript. Open. |
| REC-P0-004 | P0 | Retell exposes only `end_call` and `send_sms` on this agent. The CareCommand scheduling, identity, DNC, emergency, intake and handoff tools are absent. | Spoken promises cannot be backed by CareCommand transactions. | Observed Retell Functions panel. Open. |
| REC-P0-005 | P0 | Agent-level webhook URL is blank. | Call lifecycle, transcript/outcome, task and booking evidence cannot reliably reach CareCommand. | Observed Retell Webhook Settings. Open. |
| REC-P0-006 | P0 | CareCommand Front Desk read `/v1/conversations`; Retell activity writes `ReceptionistCallLog`. Studio showed seven calls while Front Desk showed zero. | Staff see contradictory metrics and miss calls requiring action. | Code trace plus supplied screenshots. Partially fixed in this pass: Calls tab/KPIs now read canonical receptionist call logs. |
| REC-P0-007 | P0 | Studio exported a query-string webhook URL while provider verification required the exact bare webhook URL. | Following CareCommand's own export caused `webhook_mismatch` and blocked launch. | Root cause fixed in this pass with a contract test. |
| REC-P1-008 | P1 | Existing Retell history contained 14 sessions: several zero-second `not_connected/user declined` attempts and only a small number of connected calls. One inspected connected call was a 34-second keypad demo, not a receptionist workflow. | “Calls handled” does not prove receptionist capability or operational success. | Observed Retell Call History. Open analytics/reconciliation work. |
| REC-P1-009 | P1 | A completed historical call had about 3.1s end-to-end latency and merely confirmed the fictional reminder; it invoked only `end_call`. | Connectivity exists, but the demonstrated workflow is below the pilot bar. | Observed call detail/transcript. Open. |
| REC-P1-010 | P1 | Inbound fallback number is empty; allowed inbound/outbound countries are unrestricted; caller verification/spam protection is not enabled; branded calling remains in review. | Overflow, abuse, answer rate and caller trust are not pilot-controlled. | Observed Retell Phone Numbers. Open. |
| REC-P1-011 | P1 | Location hours were hardcoded as one Mon–Fri window with weekends closed. | Multi-site, Saturday, split-shift and differing-day clinics were misconfigured. | Per-day editing implemented and tested in this pass; holidays/closures/on-call remain open. |
| REC-P1-012 | P1 | New Studio campaigns persisted placeholder content (`New offer`, generic consultation and script). | Drafts looked configured while containing unrealistic copy. | Replaced in this pass with required purpose, appointment type, scope and opening fields. |
| REC-P1-013 | P1 | Studio metrics are unscoped all-time totals; busy-operation panels do not automatically refresh; after-hours remains uncalculated. | A buyer cannot reconcile KPIs, current load, failures or SLA. | Open. |
| REC-P2-014 | P2 | Suggested-slot UI can never render because the adapter always sets it to null. | Dead UI implies capability that is not wired. | Open; remove or source from canonical scheduling. |
| REC-P0-015 | P0 | A saved campaign referenced a deleted receptionist location. Preview/export returned a generic 500 and the UI could not remove the hidden ID. | Operators could not diagnose or repair a broken campaign through the product. | Production data repaired with an audit event; local route now returns an actionable 409 and Retell export offers a route back to settings. |
| REC-P0-016 | P0 | `PREFERRED_LOCATION` carried hardcoded `Downtown Office`/`Uptown Office` options while the only mapped branch was Downtown Medical Centre. The intake compiler rejected the row and Retell export returned 500. | The spoken script and executable booking contract disagreed, and export was unusable. | Production options removed, attestation invalidated/revision advanced, export re-tested 200. UI no longer offers a second hand-maintained options list. |
| REC-P0-017 | P0 | The production SPA called `carecommand-ai.onrender.com` directly despite an existing same-origin Vercel API. Refresh cookies were therefore third-party and page reload signed the owner out. | Every reload interrupted operations and appeared as an authentication defect. | Production `VITE_API_URL` override removed and the existing artifact rebuilt. Same-origin login plus subsequent hard reload was verified successfully. |
| REC-P0-018 | P0 | The persisted clinic is Brightsmile/San Francisco demo data inside a Harley Street/London tenant; clinic timezone remained Los Angeles while the mapped location was London. | The prompt makes contradictory and potentially deceptive claims. | Open and launch-blocking. Do not convert these unknowns into guessed client facts. Replace via an explicit client configuration intake. |
| REC-P0-019 | P0 | Provider verification is wired and fails closed, but the supplied Retell agent has no CareCommand-verifiable environment tag/tool/webhook deployment. | CareCommand cannot attest that the version being called is the version it exported. | Agent ID linked through CareCommand; verification recorded `INVALID/not_found`. Call was not placed. |
| REC-P1-020 | P1 | Provider lists were empty on the cross-site Render path but loaded correctly after switching to the same-origin API. | A saved agent looked missing and the campaign appeared unlinked. | Resolved by REC-P0-017; Riley is now visible and selected. |

## What genuinely works in the repository

- Signed Retell webhook verification and trusted destination-to-tenant mapping.
- Immutable agent/version readiness snapshots and deployment-drift checks.
- Atomic availability/booking protection and exact call-to-booking binding.
- Call-scoped identity checks, two-step cancel/reschedule confirmation and replay protection.
- DNC/opt-out fences, quiet-hour and capacity gates, emergency stop and provider-intent reconciliation.
- Emergency and human-handoff task creation before external transfer attempts.
- Recording/transcript access control, lifecycle/audit primitives and operator review/sign-off.

These are meaningful differentiators only after the same controls are attached to the actually published Retell version and demonstrated end to end.

## Must-have pilot journeys

1. New patient calls, changes location/time mid-sentence, asks about an accepted payer, and books only after explicit confirmation.
2. Two callers race for one slot; one commits and the other receives fresh alternatives.
3. Existing patient fails DOB once, then safely reschedules with read-after-write verification.
4. Caller requests cancellation where a deposit exists; cancellation is exact and refund is not promised.
5. Wrong party, shared family phone, proxy/minor and repeated identity failure disclose no PHI and create one handoff.
6. Emergency language interrupts the normal flow, gives the clinic-approved emergency instruction and creates exactly one critical alert.
7. Urgent dental symptoms follow a clinic-approved urgent/on-call pathway without diagnosis.
8. Spoken DNC persists before the call ends and prevents every later attempt.
9. Warm transfer distinguishes provider acceptance from a human connection and creates one callback task on failure.
10. Recording refusal continues through the allowed non-recorded workflow and stores the consent state.
11. After-hours/holiday/temporary closure uses the location timezone and a truthful callback SLA.
12. Voicemail, wrong number, busy/no-answer, noisy audio, barge-in, language switch, disconnect/retry and provider timeout all produce a non-fabricated disposition.
13. Busy load: ten inbound plus three outbound, including one emergency, one DNC and two same-slot callers, with no cross-call state or duplicate provider submission.

## Pilot exit gates

- Every test call creates exactly one Retell call ID and one CareCommand call-log record visible in Front Desk within 60 seconds.
- Zero PHI disclosure before accepted identity proof; zero phantom bookings/results; zero double bookings.
- Every successful book/reschedule/cancel exists in the canonical scheduler and is read back before the agent claims success.
- 100% of DNC and quiet-hour cases are suppressed; emergency stop prevents every new outbound attempt.
- 100% of safety-critical scenarios escalate correctly and stop the inappropriate workflow.
- Transfer success and transfer-failure fallback are both demonstrated with provider events and one durable task.
- Published agent ID/version/tag, number binding, webhook URL/events, storage/retention, transfer destination and tool schemas all match the CareCommand readiness snapshot.
- Pilot dashboard metrics reconcile to the call/event/appointment records; no hardcoded, browser-local, or unqualified all-time KPI is presented as current performance.

## Competitive position

Vendor-published capabilities are not independent proof. They define the buyer's current comparison set.

| Buyer expectation | Market examples | CareCommand position today |
| --- | --- | --- |
| Live EHR scheduling and healthcare escalation | [PolyAI healthcare](https://poly.ai/industries/healthcare), [Hyro Epic](https://www.hyro.ai/integration/epic/), [Syllable Epic](https://syllable.ai/integrations/epic-ehr) | Backend transaction controls are promising; the deployed voice agent has none of the tools attached. Below market until live write-back is proven. |
| Fast SMB setup plus human fallback | [Smith.ai AI Receptionist](https://smith.ai/ai-receptionist), [Goodcall](https://www.goodcall.com/) | More rigorous governance, but materially harder/manual setup and no configured inbound/fallback on the test number. Below market on operational readiness. |
| Telephony primitives, versioning, transfer, voicemail and evaluation | [Retell transfer](https://docs.retellai.com/build/single-multi-prompt/transfer-call), [Retell voicemail](https://docs.retellai.com/build/handle-voicemail), [Vapi outbound](https://docs.vapi.ai/calls/outbound-calling) | Supplier capability exists, but the current number is bound to an obsolete demo and CareCommand does not deploy/promote it. Infrastructure is not product completion. |
| Auditable, policy-backed patient promises | Market offerings vary | Potential CareCommand advantage: exact version verification, server authorization, DNC fences, booking atomicity and reconciliation. Beyond many SMB tools in control design, but unproven in the live runtime. |

Safe sales language: **“CareCommand is undergoing attended pilot acceptance. Its controls are designed so every patient promise can be tied to a verified system action and auditable evidence.”** Do not claim HIPAA certification, full autonomy, EHR integration, market leadership or production readiness without the matching contractual and live evidence.

## Changes completed in this hardening pass

1. Canonicalized the exported Retell event webhook to the exact bare URL the deployment verifier requires.
2. Wired Front Desk voice KPIs, Calls tab and review queue to `/v1/receptionist/call-logs` and corrected the full-log destination to Studio Activity.
3. Removed browser-local “calls today” claims; voice cards now state their actual latest-100 scope.
4. Replaced fake campaign defaults with required, user-supplied purpose/service/scope/opening fields.
5. Replaced cloned weekday hours with editable per-day location hours and added regression coverage.
6. Repaired two malformed production campaign references, invalidated stale attestation, and recorded both interventions in the audit ledger.
7. Restored Retell export end to end; its booking contract now emits the one live mapped location ID instead of stale display-name choices.
8. Removed the production cross-site API override and verified login survives a real Chrome hard reload on the same-origin API.
9. Linked the supplied Retell agent through CareCommand and exercised the real verification button; it correctly persisted an invalid provider result instead of pretending readiness.
10. Added explicit recovery for invalid campaign/intake exports, clipboard-failure feedback, disabled-control reasons, correct cancel-copy for new locations, and post-save agent editor synchronization.

## Live intervention ledger

| Time/order | Action | Result |
| --- | --- | --- |
| 1 | Mapped the receptionist location to the active Downtown Medical Centre scheduling branch and Europe/London. | Location save succeeded; branch is now executable. |
| 2 | Removed the deleted eligible-location UUID under restricted tenant context and wrote an audit event. | Prompt generation recovered. |
| 3 | Removed stale location-name options from the typed preferred-location field, advanced the schema revision, cleared prior attestation, and wrote an audit event. | Retell export recovered and returned an executable UUID-bound booking schema. |
| 4 | Rebuilt the production frontend without the Render API override. | Same-origin authentication and reload persistence passed. |
| 5 | Linked `agent_bbc…1e5` with the requested provider tag and ran CareCommand verification. | Fails closed as `INVALID/not_found`; no outbound call was attempted. |

The last result is an intentional launch stop, not an incomplete test: the published Retell version is still a fictional keypad reminder and does not contain the exported CareCommand webhook or booking/safety tools. Dialling it would demonstrate connectivity while falsely claiming the AI Receptionist is working.

## Next implementation order

1. Bind the Retell number to one published immutable UAT version; enable the inbound agent; configure the canonical signed webhook and events; attach all exported CareCommand tools; configure fallback/transfer and restricted countries.
2. Add CareCommand deploy/promote/rollback ownership or a guided exact configuration-diff workflow. Preview must execute the exact published version.
3. Finish unified Front Desk detail/actions for voice calls, add live refresh, owners/due times/SLA and after-hours classification from holidays/closures/on-call data.
4. Add provider/service/resource scheduling, payer knowledge provenance, dental urgency policy, proxy/guardian flow, multilingual fallback and truthful voicemail/retry policies.
5. Run the controlled call matrix only against the three owner-authorized numbers, then issue the client evidence packet with masked destinations, provider/local call IDs, tool results, appointment/task IDs and pass/fail.
