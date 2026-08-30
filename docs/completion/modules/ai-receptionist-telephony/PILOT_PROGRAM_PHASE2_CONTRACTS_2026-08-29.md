# Phase 2 contract freeze — CTO decisions after the design review gate (2026-08-29)

Applies to designs C2–C6. Where a design contradicts this memo, this memo wins. Reviewers' ids are cited so the build agents can look up the detail.

## 1. Cycle order, migrations, waves
- Migration folder stamps (Prisma applies by folder name): C2 `20260830110000_receptionist_knowledge_hours_locale`, C3 `20260830120000_receptionist_inbound_reception`, C4 `20260830130000_front_desk_loop`, C5 `20260830140000_receptionist_agent_deployment`, C6 `20260830150000_outbound_automation`. (C4-R08)
- Build waves with exclusive file ownership per agent:
  - **Wave A** (after C1): (1) `C4-pre` task contract — `server/lib/receptionist/frontDeskTask.ts` (metadata Zod schema, kind union, `createSafetyTask(ctx, kind, args)` signature re-exported from liveTools) — lands FIRST as a tiny package; then in parallel (2) C2 backend, (3) C2 frontend.
  - **Wave B**: C3 backend (owns liveTools.ts, webhooks.ts, promptService.ts, intakeContract.ts, scheduling.ts/availability.ts, C3 migration) ∥ C4 backend (owns operations tasks routes, staff routes, activity.ts, appointments notes route, C4 migration, `frontDeskTask.ts` follow-ups; must NOT edit liveTools.ts/webhooks.ts — C3 inserts the one-line `stampCallerIdentity(...)` / `markTransferOutcome(...)` calls C4 exports) ∥ C4 frontend (FrontDesk page, ActivityPanel, StaffWorkflow card, Sidebar/links).
  - **Wave C**: C5 backend (retell.ts, retellMock.ts, retellDeploy.ts, agentVerification.ts, remediation.ts, placeholders.ts, campaignReadiness.ts, worker job, agents.ts/campaigns.ts routes) ∥ C5 frontend ∥ C6 backend (outbound.ts, dispatcher worker, population sources) ∥ C6 frontend (outbound/* components).
  - **Wave D**: C7 harness — seeds/demo, e2e, a11y pass, docs/runbook/limitations, pilot scorecard — then full SDET audit.
- Each wave ends with: CTO review of reports/diffs → SDET verification (full receptionist server suites + web suites + lint + typecheck + build, plus a targeted audit agent) → fix loop → merge/commit.

## 2. Locale packs and caller-facing messages (C2-R05, CX contract, C2↔C3)
- `ReceptionistLocalePack.strings = { emergencyNumber: string; timeStyle: '12h'|'24h'; dateStyle: 'weekday-month-day'|'weekday-day-month'; messages: Record<string,string> }` with C3's dotted key namespace (`disclosure.*`, `dnc.*`, `voicemail.script`, `summary.line`, `not_interested.line`, `emergency.instruction`, `after_hours.line`, `human_fallback.line`, `tool.*`, `consent.*`, `receptionist.degraded.*`).
- One placeholder syntax: `{{var}}` (Retell-compatible). Per-key allowlist of variables; unknown placeholder = validation error. Renderer output must contain no `{{` except the runtime dynamic variables in §3.
- Platform defaults live in code at `server/lib/receptionist/localePacks/defaults.ts` (C2 owns the file; C3 appends its keys with en-US and en-GB text). en-US v1 `disclosure.recording` is byte-equal to `RECORDING_DISCLOSURE_EVIDENCE_TEMPLATE` (consent-hash continuity). C3 ships platform-default **v2** with `disclosure.ai_acknowledgment` + `disclosure.recording`; the validator must NOT require the template to end with `?`.
- No `ReceptionistTenantPolicy.messageOverrides`; an override is a new DRAFT pack version approved through C2's flow. Approval stays one click for OWNER/ADMIN (show the evidence hash; no checkbox ceremony). Drop the PL/pgSQL immutability trigger; app-level 409 `PACK_IMMUTABLE`. Keep `retire` as a status change only (no separate route needed if PATCH status covers it).
- Consent ladder wording (CX-R02): any on-topic continuation after the disclosure = `record_call_consent(ai=ACKNOWLEDGED, recording=NOT_STATED)` silently, proceed; "no"/"don't record" = recording REFUSED, service continues with `restrictCallToBasicAttributes`; DECLINED only on explicit objection to talking to an AI → transfer/callback. Written into prompt (C3) and pack keys (C2/C3).

## 3. Runtime dynamic variables (C2-R06)
- Single exported `RUNTIME_DYNAMIC_VARIABLES` in `promptService.ts` (name + default) consumed by `buildRetellConfig` defaults, C3 `call_inbound`, outbound dial, and the prompt-snapshot allowlist test. Names: `is_open_now`, `hours_today`, `next_opening`, `closure_reason`, `emergency_number`, `known_first_name`, `human_fallback_number`, `admission_state`, `location_name`, `location_address`, `location_phone`. `locations_json` is dropped. `buildHoursDynamicVariables` (C2) is the single producer of the hours vars; C3 spreads it.

## 4. Services — one source of truth (CX-R06)
- `ServiceCatalogItem` is canonical. C2's migration adds `spokenDescription String?`, `bookableByVoice Boolean @default(false)`, `voiceDurationMinutes Int?`, `priceFrom Decimal?` to it. `KnowledgeDocument.services` is REMOVED; the Knowledge tab edits these columns via a small services sub-panel (or the existing ServiceCatalogPanel gains the fields — frontend decides; one place). Prompt `# Services` renders from the catalog; C3's tool enum uses `bookableByVoice` rows; readiness fails when no bookable service exists.

## 5. Transfer outcome (C2-R07, C4-R conflicts)
- C2: add `disconnection_reason` to the `/webhooks/retell` Zod call object; map `call_transfer` → `connected`, otherwise `unknown` (do not invent a failed class); write `ReceptionistCallLog.transferOutcome`; expose on the call row. C2 must NOT touch StaffTask.
- C4 exports `markTransferOutcome(tx, { tenantId, callLogId, outcome })` updating task metadata (`transferStatus`, `transferUpdatedAt`; `connected` → `COMPLETED` with outcomeCode `transferred`). C3's `webhooks.ts` is the single call site (inserted in Wave B).
- `transferReadiness` gains reason `loops_to_agent` when the fallback equals `clinic.phone`, a forwarded location phone, or any inbound line number (CX-R04); C5 readiness check `transfer_target_distinct`.

## 6. Readiness and attestation (C2-R08, CX-R05)
- `evaluateCampaignReadiness` (C5) is the ONLY activation gate and route; Studio badges read from it. C2 ships pure `clinicActivationBlockers(tx, {tenantId, clinicId, agent}): Blocker[]` (country missing, hours missing, pack unapproved, language unsupported, transfer loops) and wires them into today's `assertCampaignAgent` path as 409 until C5 lands; C3 ships `inboundReadinessChecks()` the same way. C5 replaces both call sites with readiness rows.
- C2 keeps only `attestedLocalePackId/attestedLocalePackHash` on `ReceptionistCampaign`; prompt/hours/knowledge hashes are stored on C5's `ReceptionistAgentDeployment`. C2 still exports the pure `promptHash/hoursHash/knowledgeHash` functions.
- C5 readiness adds `test_call_completed` (an inbound call log on the line from a staff number) and a "Go live" card with ordered steps: deploy → verify → forward public number to the DID → test call → activate; deploy sets the Retell number's default agent and readiness verifies it (CX-R07); runbook mandates carrier no-answer fallback to the desk.
- `storeTranscriptsAfterConsent` tenant setting: C5 readiness derives the expected `data_storage_setting` from `ReceptionistTenantPolicy`; if C3 does not ship the policy table, the setting is read-only "off" and documented.

## 7. Catalog ownership (C2-R09)
- C2 owns `server/lib/receptionist/catalog.ts` and `GET /v1/receptionist/catalog` (fieldTypes, timezones grouped + recommended, countries, languages, tones, campaignTypes, localePacks status, limits). C2 does NOT touch `server/lib/retell.ts`. C5 adds `listRetellVoices(): RetellProviderResult<…>` in retell.ts and contributes the `voices` + `providerMode` sections to the catalog module. Frontend deletes the client constants and reads the catalog (out-of-list values still render).

## 8. StaffTask contract (C4-R05, C3↔C4)
- `server/lib/receptionist/frontDeskTask.ts` (C4-pre) owns ONE metadata schema: `kind` union = `message | human_handoff | emergency | missed_call | call_denied | ai_declined | tool_failure | identity_locked | booking_review`; fields `callerName`, `verifiedPhone`, `requestedCallbackPhone`, `messages[]` (append), `reasonCategory`, `callbackWindow`, `transferStatus`, `transferUpdatedAt`, `toolName`, `denialReason`, `appointmentRequestId`, `appointmentId`, `callId`, `requiresAcknowledgement`, `source`. C3 imports `createSafetyTask(ctx, kind, args)` typed on that union. Drop `cancellation_note`; C3's `cancelAppointment` writes `Appointment.cancellationReason` (≤240, sanitised) + `cancelledVia='voice_agent'` — those two columns move into C3's migration; audit keeps `hasReason` only.
- `ToolContext.selection` (C3's name) carries `branchId, locationId, clinicId, callLogId, direction, verifiedPatientId, branchTimezone`; C4 replaces every `ctx.admitted` with `ctx.selection`.
- `/v1/tasks` list: branch filter `OR branchId null`; cursor pagination; `handoffReferences` kept as a one-cycle alias.

## 9. Permissions and read gate
- C2 introduces `receptionist:read` in `server/lib/permissions.ts` + `accessControl.ts` and a `receptionistRead` preHandler = `requireAnyPermission('receptionist:manage','receptionist:read')`; FRONT_DESK and AUDITOR get `receptionist:read`. All GET routes in C2–C6 use it; mutations stay `writeRoles`. C4 opens Studio read-only and the Front Desk page on it.

## 10. Urgent vs emergency (CX-R01)
- `KnowledgeDocument.urgentCare = { whatCountsAsUrgent: string; sameDayPolicy: string; onCallNumber: string | null }` (C2). Prompt splits life-threatening (emergency number, `report_emergency`) from clinically urgent (offer soonest slot / on-call number / handoff). C3 `report_emergency.reason_category` enum gains `urgent_clinical` (task kind `emergency` with `reasonCategory`), and the front desk lane shows it distinctly.

## 11. Returning callers (CX-R03)
- C3 inbound task list: when `known_first_name` is set (single phone match) collect DOB via `DATE_OF_BIRTH` and call `verify_patient_identity` before `book_appointment`; match links the patient, mismatch books as new with `metadata.possibleDuplicateOfPatientId` and a `booking_review` task.

## 12. Test/fixture fallout to include in the same PR (C2-R01..R04, C4-R07)
- `server/test/helpers/receptionistFixtures.ts` (`createClinicFixture` with country/timezone/defaultLanguage) and migrate every direct `db.receptionistClinic.create` (13 suites), `prisma/seedSynthetic.ts`, `outbound.verify.ts`; update `receptionistConfiguration.integration.test.ts` createClinic helper + location payloads; server derives `defaultLanguage` from the country's default when omitted (only country + timezone hard-required).
- `server/test/fixtures/receptionistPromptConfigs.ts` `promptFixture()`; `PromptConfig.knowledge` and `.hours` nullable, `.localePack` required; rewrite the six PromptConfig builders; move `911` assertions in receptionistSafety/ContentChallenge/ConversationSafety/PilotScenarioCoverage to pack strings.
- RLS harness per-table overrides for `ReceptionistLocalePack` (`country='US'`, `language='en-US'`, `source='platform_default'`); do not touch `TENANT_DELETE_PROTECTED_TABLES`; `AppointmentNote` goes into `TENANT_APPEND_ONLY_TABLES` with `REVOKE ALL` before GRANT.
- C4: Lead already has `@@unique([tenantId,id])` — no ALTER; relation named `noteEntries` (scalar `notes` stays); `GET /appointment-requests` scoped by `callLog.clinicId` only; `/book` consumes C3's `bookingSequence`; update lists gain receptionistLifecycle (list projection), receptionistOperatorReview, staffTaskHandoff; Sidebar/StaffWorkflow web tests are new files.
- `complianceDisclosure` nullable: coalesce to `''` in outbound dynamic variables, `liveCallUatDisclosure`, `toPromptConfig`, consent hash, provisionDemo, e2e.
- C2 `AfterHoursCard` ships as an exported component + jsdom test only; C4's `FrontDesk.tsx` mounts it.
- C4 KPIs read the stamped `outsideHours` column (null = unavailable); `isOpenAt` only for rows predating C2.

## 13. Accepted scope cuts (pilot)
- C2: drop attestedPrompt/Hours/Knowledge columns; drop `/locale-packs/:id/preview` (client-side preview); partial-day closures keep columns, Zod rejects non-null times; per-location hours override = API + engine only, UI inherit-only; `CLINIC_IN_USE` confirm flow dropped (keep `expectedUpdatedAt`); `import-services` dropped (services are catalog rows now).
- C3: drop `messageOverrides`, per-clinic `maxConcurrentCalls` (tenant-level only), `voiceAlias`.
- C4: drop staff SMS/email alert outbox (in-app banner + sidebar badge + 20s poll only; say so on the Go-live card); drop `leadId` FK, free-text `q` search, `patient.nextAppointmentAt` in list projection, Scheduling-detail notes mount, callback-window clipping to hours (store window, `dueAt = start`), separate `/contact` route (unmasked number in task detail for permitted roles, audited).
- C5: drop prompt line-diff viewer (chips only), `takeOver`, deployments history beyond latest, web-call (design only).

## 14. Non-negotiables restated
No hardcoded tenant-facing values; every failure spoken + visible; tests with every route/tool/panel; seeds cover it; prompt snapshot tests; deploy attestation includes the prompt hash; commit per package on `feat/receptionist-pilot-program-20260829`; never push main.
