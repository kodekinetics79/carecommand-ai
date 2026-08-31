# Outbound campaign design — the clinic calls the patient

Author: principal consultant seat (outbound patient communications). Date 2026-08-31. Branch `main`.
Audience: the engineering team who will build this. Every claim about current behaviour is cited `file:line`.

> **Status, 2026-08-31 (added after the design was written).** Phase 0 is **built, verified and merged**:
> PRs #34, #35, #36, #37 on `main`, with #33 as the regression guard. Its acceptance suite —
> `server/test/receptionistOutboundCallLifecycle.integration.test.ts` — was authored to fail and now
> passes 9/9 with no assertion weakened.
>
> The root cause found during that work is **not** the one this document predicted. It was ours, not the
> provider's: the per-call webhook URL carried a trailing `&campaignId=` on every
> `APPOINTMENT_REQUEST_ONLY` campaign (the default shape). The receiving handler parses its query string
> as its first statement, so an empty string answered **400 before signature verification** — and a 400 is
> permanent to a webhook sender. Every lifecycle event for every default-shape outbound call was dropped.
> Confirmed against production: with the parameter, 400; without it, 401.
>
> Everything below from **Phase 1** onward — the dialler, per-patient appointment context, confirm/cancel
> write-back — remains unbuilt. Read the phases as written; read the Phase 0 sections as history.

> **Status, 2026-08-31 (second update).** §6.1 and a first slice of §6.2 are **built**.
>
> * **§6.1, the extraction, is done and is the load-bearing part.** The launch path moved out of the
>   route to `server/lib/receptionist/outboundLaunch.ts` as a near-verbatim move with two mechanical
>   seams (`LaunchActor` for `request.auth.*`, `answer(n, x)` for `reply.code(n).send(x)`). The 79
>   existing outbound tests pass unmodified. `server/modules/receptionist/outbound.ts` fell from 3,004
>   lines to ~1,000 and the `/call` handler is now a 20-line adapter.
> * **The dialler is one queue, not three.** `receptionist-outbound-dial` fans a signed tick out to one
>   signed per-tenant pacing job (`server/lib/receptionist/outboundDialer.ts`), which selects PENDING
>   targets and calls `launchOutboundCall` per target. There is no `dial-task` queue and no
>   `ReceptionistCampaignRun`: without the run noun there is nothing to pace *per run*, and the target
>   claim inside the launch path is already atomic, so a separate claiming step in the pacer would have
>   fought it (`PENDING` is the only claimable status). §6.3's `SKIP LOCKED` claim belongs with the run
>   model, not before it.
> * **Pacing lives on the campaign**, as `dialerEnabled` / `dialerMaxConcurrentCalls` /
>   `dialerCallsPerMinute` / `dialerRetryGapMinutes` (migration
>   `20260831210000_receptionist_outbound_dialler`). `dialerEnabled` defaults false so this migration
>   did not turn every RUNNING campaign into an autodialler.
> * **A6-F07 is fixed.** The shared-suppression branch now writes the `OPTED_OUT` call log and
>   terminalises the target in the same place the DNC branch does. Left as it was, every pass would have
>   re-offered the same suppressed patient forever.
> * **§6.9(b) is done**: enabling `dialerEnabled` is refused `409 { status: 'setup_required', reason:
>   'dispatcher_not_running' }` when `QUEUES_ENABLED` or `RECEPTIONIST_OUTBOUND_DIAL_ENABLED` is off.
>   §6.9(a), standing the worker up on the production stack, is still a deployment decision and is NOT
>   done.
> * **Still unbuilt**: `ReceptionistCampaignRun` and calling windows (§3.2, §6.4's `windowStart/End`),
>   the disposition-aware retry table (§6.5 — only a flat minimum gap and `maxRetryAttempts` exist),
>   spend caps (§6.7), kill-switch queue draining (§6.8.1 — the pass re-reads the switch before every
>   target instead, so a stop takes effect on the next dial rather than by removing queued jobs), and
>   all of §7 onward.

**Product statement.** The patient never dials the clinic. The clinic dials the patient, states *their*
appointment — provider, date, time — and takes a confirm or a cancel. Reminders and confirmations first;
recall and reactivation later on the same machinery.

**One-sentence architectural verdict.** The safety spine that guards a single outbound call is genuinely
strong and should be preserved almost intact; everything that turns one call into a *campaign* — the run,
the appointment binding, the write-back, the timeout model, the dialler — does not exist, and two of the
existing structures (target uniqueness by phone, and target state derived from LLM analysis) must be torn
out rather than extended.

---

## 1. What exists today, verified

### 1.1 The parts worth keeping

| Capability | Where | Verdict |
|---|---|---|
| Outbound authority: OWNER/ADMIN approval + frozen authority fingerprint, re-checked at three boundaries | `server/modules/receptionist/outbound.ts:900-953` (approve), `:97-129` (fingerprint), `:1758-1782` + `:1815-1836` (re-check) | Keep. This is better than anything shipping in this market. |
| DNC / suppression fence held *across* the provider boundary, DB-trigger backed | `server/lib/receptionist/dncFence.ts:166` (`authorizeOutboundProviderIntentTx`), called at `outbound.ts:1872-1884` | Keep unchanged. |
| Durable provider intent — the commit marker that precedes the provider request | `prisma/schema.prisma:2555-2580`, issued at `outbound.ts:1798-1806` | Keep. It is also the key to outbound identity (§7). |
| Consent ladder: append-only voice consent events, exactly one patient/lead identity | `prisma/schema.prisma:2521-2553`, checked at `dncFence.ts:131` | Keep. |
| Quiet hours, fail-closed on misconfiguration, overnight-window aware | `outbound.ts:453-468` (`quietHoursConfigurationReason`), `:486-495` (`isWithinQuietHours`) | Keep the predicate; §6 changes *when* it is asked. |
| Per-call disclosure resolved from an approved locale pack at dial time | `outbound.ts:1979-1990`, `:2003-2006` | Keep. |
| "Human only" patients never reach the AI, enforced at the tool layer not the prompt | `server/lib/receptionist/liveTools.ts:1506-1527`, `server/lib/receptionist/humanOnly.ts:105-110` | Keep. |
| Repeat-caller escalation | `prisma/schema.prisma:2429` (`ReceptionistCallLog_repeat_caller_idx`) | Keep. |
| Emergency stop with provider cancellation and truthful reconciliation evidence | `outbound.ts:514-720` | Keep the mechanism; §6 adds the drain and §10 argues for an OWNER-clearable variant. |
| Targets must resolve to a real `Patient`/`Lead` row; the phone comes from the identity record, never the browser | `outbound.ts:1051-1069` | Keep, and defend it. See §8. |

### 1.2 The shape of the current system

- One outbound campaign = `ReceptionistOutboundCampaign` (`prisma/schema.prisma:3137-3178`), status
  `DRAFT|SCHEDULED|RUNNING|PAUSED|COMPLETED|FAILED` (`:3107-3115`).
- One target = `ReceptionistCallTarget` (`:3180-3207`), status `PENDING|CALLING|COMPLETED|FAILED|OPTED_OUT`
  (`:3116-3122`), `attempts` counter, `lastCallLogId`, `lastOutcome`.
- One call = `ReceptionistCallLog` (`:2338-2436`), outcome `IN_PROGRESS|BOOKED|NOT_INTERESTED|NO_ANSWER|
  VOICEMAIL|ESCALATED|OPTED_OUT|FAILED` (`:1893-1902`).
- One dial = `POST /v1/receptionist/outbound-campaigns/:id/call` (`outbound.ts:1345`), roughly 1,280 lines
  of gate, reservation, provider-intent commit, provider submission, and post-acceptance safety.
- Purposes `CARE_COORDINATION | APPOINTMENT_REMINDER | PATIENT_REACTIVATION` (`outbound.ts:51`); legal
  bases `EXPLICIT_CONSENT | TREATMENT_OPERATIONS` (`:52`).

---

## 2. What is missing or broken

These were established by production testing on 2026-08-29/30 and are each reproducible from the code.

### D1 — There is no dialler. One HTTP call = one phone call.

`RUNNABLE_CAMPAIGN_STATUS = 'RUNNING'` (`outbound.ts:49`) is consulted only inside the manual `/call`
route. `SCHEDULED` is settable at `outbound.ts:900-953` and read by nothing. No worker references
`ReceptionistCallTarget` — the five workers constructed at `server/workers/index.ts:60` are autopilot,
compliance, campaign, monitoring and eligibility-reconciliation, and none of them touch the outbound
domain. `maxRetryAttempts` (`prisma/schema.prisma:3160`) and `quietHoursStart/End` (`:3158-3159`) are
stored and consulted only by a human-initiated request. A 200-patient run is 200 operator clicks.

Already filed as P0 in this repo's own audit:
`docs/completion/modules/ai-receptionist-telephony/PILOT_PROGRAM_PHASE1_A6_OUTBOUND_2026-08-29.md` finding
A6-F03.

### D2 — The agent does not know the appointment.

The complete set of dynamic variables sent to the provider is `outbound.ts:1999-2020`: hours variables,
`clinic_name`, `agent_name`, `disclosure`, `live_test_disclosure`, `consent_text`, `human_handoff`,
`script`, `required_fields`, `first_name`, `booking_mode`, `appointment_type`. There is no provider name,
no date, no time, no appointment id, no location.

`ReceptionistCallTarget` has no appointment FK at all (`prisma/schema.prisma:3180-3207`). The only way to
put an appointment on the call today is to type it into `ReceptionistOutboundCampaign.script`
(`:3144`) — which is one string shared by every target, so **every patient in the campaign would hear the
same appointment.** That is exactly what the current demo does, and it is not a shortcut that can be
extended; it is the wrong shape.

### D3 — Confirm/cancel does not write back.

`handleAgentTool` (`liveTools.ts:1495-1641`) has no `confirm_appointment`. It *does* have
`cancel_appointment` (`:754-789`) and `reschedule_appointment` (`:791-838`), both well built. Neither is
reachable on an outbound call today, for two independent reasons:

1. `verifiedPatientForCall` (`liveTools.ts:629-643`) requires an `IdempotencyKey` row in scope
   `receptionist.voice-identity`, written only by `verify_patient_identity` (`:588-627`), which requires
   the answering party to state a matching date of birth.
2. `SAFE_WITHOUT_RECORDING_GRANT` (`webhooks.ts:1658`) does not include `cancel_appointment`, so the
   dispatcher refuses it unless `recordingConsentStatus === 'GRANTED'` (`:1659-1662`). Outbound calls are
   submitted with `dataStorageSetting: 'basic_attributes_only'` (`outbound.ts:2031`) — there is no
   recording, so there is nothing to grant, and the gate can never pass. **Every outbound cancel attempt
   would be refused with "I need your explicit agreement to the opening disclosure".**

And there is no state to write a *confirmation* into. `AppointmentStatus` (`prisma/schema.prisma:22-30`)
is `CONFIRMED|RISKY|ARRIVED|NO_SHOW|CANCELED|COMPLETED|WAITLIST`, and `Appointment.status` defaults to
`CONFIRMED` at creation (`:475`). "CONFIRMED" already means "the clinic booked it". A patient saying
"yes, I'll be there" has nowhere to land.

### D4 — A single unanswered call wedges the tenant. This is a state-machine hole.

Reproduced in production. The chain:

1. The dial reserves a `ReceptionistCallLog` with `outcome: 'IN_PROGRESS'`, `startedAt: now`, `endedAt`
   null (`outbound.ts:1530-1543`, created at `:1660`), and claims the target into `CALLING`
   (`:1641-1652`).
2. The provider accepts the request but the call never connects, so **no lifecycle webhook is ever sent.**
   `call_started`/`call_ended`/`call_analyzed` are the only registered events
   (`server/lib/retell.ts:131`).
3. Nothing has a deadline. The call row stays `IN_PROGRESS` with `endedAt = null` forever. The target
   stays `CALLING` forever.
4. The only existing lease sweep is inside `admitInboundReceptionist` (`webhooks.ts:472-488`) and it
   explicitly excludes rows that have a provider intent — `outboundProviderIntent: { is: null }`
   (`webhooks.ts:481`). **Every outbound campaign call has a provider intent, so it is structurally
   excluded.** The sweep also only runs when an *inbound* call arrives; on a clinic doing outbound only,
   it never runs at all. Two independent reasons the row is never healed.
5. The operator's manual escape, `POST .../call-logs/:id/provider-sync` (`outbound.ts:2623`), fetches the
   provider snapshot and then compares `snapshot.metadata.tenantId / outboundCampaignId / callLogId`
   against the local row (`:2656-2666`). For a call the provider never started, the provider retained no
   metadata — all three are `null` — so the comparison fails and the route returns
   `409 { status: 'quarantined', reason: 'provider_binding_mismatch' }` (`:2661-2671`). The operator's only
   recovery tool refuses to act, and calls it a security event.
6. Capacity is then held. In normal operation the ceiling is 25
   (`server/lib/receptionist/admissionPolicy.ts:39-43`, read at `outbound.ts:1625`), so one wedge is
   survivable. Under the attended live-test posture the ceiling is **1** (`outbound.ts:1625`), and
   `evaluateLiveCallAdmission` refuses on `usage.activeCalls > 0`
   (`server/lib/receptionist/liveCallUat.ts:163`). One unanswered call blocks every subsequent call for
   the tenant, permanently.
7. `POST .../launch-attempts/:token/verify-clear` correctly reports the wedge as
   `{ cleared: false, proof: 'call_not_terminal' }` (`outbound.ts:1327-1331`) — it can *see* the problem
   and has no power to fix it.

There is a second, quieter instance of the same hole even when webhooks *do* arrive. At
`webhooks.ts:1176` the target's next status is computed from `outcomeRaw` — the **LLM's**
`call_analysis.custom_analysis_data.outcome` (`:1018`). On a `call_ended` with no analysis block,
`outcomeRaw` is `''`, `targetStatusAfterOutcome('')` returns `null` (`outbound.ts:135-146`), and the
`if (target && nextStatus)` guard at `webhooks.ts:1177` skips the write. The call log terminalises; the
target stays `CALLING` forever.

**Root cause, stated precisely: there is no column anywhere in this system that says when a non-terminal
row stops being allowed to be non-terminal.** Liveness is delegated entirely to a third party that has no
contractual obligation to tell us anything.

### D5 — Targets must already be `Patient` or `Lead` rows; there is no list import.

`outbound.ts:1051-1069`: each target must name exactly one of `patientId`/`leadId`, the identity row must
exist and be undeleted, the phone is read *from the identity record*, and a browser-supplied phone that
disagrees is rejected (`:1062`). This is correct and I would not change it. It does mean the population
step must be a server-side query, not a file upload. See §8.

---

## 3. The domain model

### 3.1 How mature products model this

Luma Health, Artera/WELL, Relatient, Solutionreach and Weave all converge on four nouns, and the naming
differences hide no real disagreement:

- **Outreach plan / protocol** — a *rule*: "for appointments of type X, 24h before the start, call the
  patient." Durable, reusable, versioned. Not a list of people.
- **Enrolment / recipient** — the resolution of that rule against one real-world event: (this patient,
  this appointment, this plan, this wave). Created by a scheduled evaluation, not by an operator.
- **Touch / attempt** — one delivery on one channel at one moment. Has its own lifecycle and its own
  timeout. Several attempts per enrolment.
- **Response** — what the human did. Modelled *separately* from delivery, because "delivered" and
  "answered" and "confirmed" are three different facts and conflating them is the classic bug in this
  category (the SMS was delivered; the patient never read it; the appointment is still unconfirmed).

The current schema has campaign ≈ plan, target ≈ enrolment, call log ≈ attempt, and **no response
object at all**. That is the gap to close, plus one missing layer: the *wave*.

### 3.2 The wave is the missing noun — `ReceptionistCampaignRun`

A reminder campaign is not a list; it is a standing instruction that produces a new population every day.
"Call everyone with an appointment tomorrow" run on Monday and on Tuesday are two different bodies of
work that must be paced, paused, capped, reported and audited independently. Today there is nowhere to
put that. Consequences of not having it, all real: you cannot answer "how did last night's reminder run
go", you cannot cap spend per night, you cannot pause tonight without pausing the campaign, and a target
row is ambiguous between "not yet called tonight" and "never called at all".

```
model ReceptionistCampaignRun {
  id                    String   @id @default(uuid()) @db.Uuid
  tenantId              String   @db.Uuid
  outboundCampaignId    String   @db.Uuid
  // What this run is for. Immutable once created.
  windowStart           DateTime          // earliest dial time, UTC
  windowEnd             DateTime          // hard stop: no dial after this, ever
  // The frozen population query. A run must be reproducible and explainable a
  // year later without guessing what "tomorrow" meant when it ran.
  selectionKind         String            // 'appointment_window' | 'manual'
  selectionParams       Json              // { leadHoursMin, leadHoursMax, branchIds, serviceIds, statuses }
  selectionResolvedAt   DateTime?
  // Pacing and caps, snapshotted from the campaign at creation so an edit
  // mid-run cannot change what is already in flight.
  callsPerMinute        Int      @default(6)
  maxConcurrentCalls    Int      @default(4)
  maxAttemptsPerTask    Int      @default(2)
  maxCalls              Int?              // hard volume cap
  maxSpendNativeUnits   Int?              // hard cost cap
  spentNativeUnits      Int      @default(0)
  // Lifecycle. PLANNED -> RESOLVING -> RUNNING -> (PAUSED) -> COMPLETED | ABORTED
  status                String   @default("PLANNED")
  abortReason           String?
  authorityFingerprint  String            // campaign fingerprint frozen at run start
  createdAt             DateTime @default(now())
  ...
  @@unique([tenantId, outboundCampaignId, windowStart])   // one run per campaign per window
  @@index([tenantId, status, windowStart])
}
```

`authorityFingerprint` copies the value computed by `outboundAuthorityFingerprint`
(`outbound.ts:97-129`). A run that started under approved authority finishes under that authority or
aborts; it never silently adopts an edit. This mirrors what the manual path already does at
`outbound.ts:1827-1836`.

### 3.3 The task is the enrolment — reshape `ReceptionistCallTarget`

Keep the table (the migration cost of renaming is not worth it) and change its grain.

Add:
```
  runId               String?  @db.Uuid   // FK -> ReceptionistCampaignRun, null for legacy manual targets
  appointmentId       String?  @db.Uuid   // FK -> Appointment, tenant-scoped
  scheduledFor        DateTime?           // earliest permitted dial for THIS task
  nextAttemptAt       DateTime?           // when the dialler may next claim it
  leaseOwner          String?             // worker instance that holds the claim
  leaseExpiresAt      DateTime?           // NOT NULL whenever status = CALLING (CHECK)
  terminalReason      String?             // machine-readable, e.g. 'answered_confirmed', 'exhausted_no_answer'
  attemptsMax         Int      @default(2)  // snapshot from the run, not read live from the campaign
```

Drop `@@unique([tenantId, campaignId, phone])` (`prisma/schema.prisma:3206`) — see §10 — and replace with:
```
  @@unique([tenantId, runId, appointmentId])   // one reminder per appointment per run
  @@index([tenantId, runId, status, nextAttemptAt])   // the dialler's claim index
```

**Where appointment context lives, and when it is read.** It lives on the task as a foreign key, and it is
**resolved to text at dial time, never at enqueue time.** This is the single most important operational
rule in reminder systems and the most common production failure: an appointment moves between the nightly
enqueue and the 10:00 dial, and the patient is told a time that is no longer true. The dialler must
re-read the appointment inside the provider-intent transaction (alongside the existing checks at
`outbound.ts:1815-1870`) and abort the dial as `appointment_changed` if `startsAt`, `providerProfileId`,
`branchId` or `status` differ from what the task recorded. Cheap: it is one indexed read on
`@@unique([tenantId, id])` (`prisma/schema.prisma:507`).

### 3.4 The attempt already exists — give it a deadline

`ReceptionistCallLog` is already one row per dial: created at reservation (`outbound.ts:1659`), bound to
the target (`:1661-1671`), carrying the provider call id. Do not add a table. Add columns:

```
  deadlineAt          DateTime?   // when this row stops being allowed to be non-terminal
  outcomeSource       String?     // 'webhook_analyzed'|'webhook_ended'|'provider_poll'|'deadline_sweep'|'operator'
  dialDisposition     String?     // provider-derived transport result (§4.2)
  providerDisconnectReason String?
  terminalizedAt      DateTime?
```

and the constraint that makes D4 structurally impossible:

```sql
ALTER TABLE "ReceptionistCallLog" ADD CONSTRAINT receptionist_call_deadline_required
  CHECK ( ("outcome" = 'IN_PROGRESS' AND "endedAt" IS NULL) = ("deadlineAt" IS NOT NULL) );
```

**A non-terminal call row without a deadline cannot be inserted.** Not "should not" — cannot. Every
future code path, including ones nobody has written yet, inherits the guarantee from the database.

### 3.5 The response object — `AppointmentContactOutcome`

Append-only, house style (matching `ReceptionistVoiceConsentEvent` `prisma/schema.prisma:2521`,
`ReceptionistRecordingConsentEvent` `:2439`, `AppointmentNote` `:521`):

```
model AppointmentContactOutcome {
  id              String   @id @default(uuid()) @db.Uuid
  tenantId        String   @db.Uuid
  appointmentId   String   @db.Uuid
  callLogId       String?  @db.Uuid     // the exact call this came from
  targetId        String?  @db.Uuid
  channel         String                // 'voice'
  // CONFIRMED | CANCEL_REQUESTED | RESCHEDULE_REQUESTED | CALLBACK_REQUESTED
  // | WRONG_NUMBER | REFUSED | NO_RESPONSE | VOICEMAIL_LEFT
  response        String
  // How we know the answering party was the patient (§7).
  identityProof   String                // 'first_name_assertion' | 'dob_second_factor' | 'none'
  capturedVia     String                // 'speech' | 'dtmf' | 'staff'
  spokenAppointmentHash String          // digest of the exact appointment text read aloud
  occurredAt      DateTime @default(now())
  createdAt       DateTime @default(now())
  ...
  @@unique([tenantId, callLogId, response])   // one write per response per call; redelivery is a no-op
  @@index([tenantId, appointmentId, occurredAt])
}
```

`spokenAppointmentHash` is not decoration. When a patient later says "you told me Tuesday", this row is
what proves what the agent actually said, without retaining a transcript on a metadata-only call
(`outbound.ts:2031`).

Plus one denormalised column on `Appointment` so the front desk board and the no-show model can read it
without a join: `patientConfirmedAt DateTime?` and `patientConfirmedVia String?`.

**Do not add a new `AppointmentStatus` value.** The enum is load-bearing across the whole product:
`STATUS_TRANSITIONS` (`server/modules/appointments/routes.ts:25-29`), `BLOCKING_STATUSES`
(`server/lib/scheduling.ts:91`), the GiST double-book exclusion constraint
(`prisma/migrations/20260721180000_appointment_double_book_exclusion_and_patient_dob/migration.sql:28-38`),
`VOICE_MUTABLE_STATUSES` (`liveTools.ts:98`), `PATIENT_MUTABLE_STATUSES`
(`server/modules/portal/routes.ts:13`). Adding a value means auditing all of them. A nullable timestamp
means auditing none of them.

**For the negative case, use `RISKY`.** It is a legal source state in every gate constant listed above, it
blocks the slot in both the app layer (`server/lib/scheduling.ts:91`) and the DB constraint, and **nothing
in the codebase writes it today** — it is a reserved word waiting for exactly this. An appointment whose
reminder run exhausted without a confirmation *is* at risk. One caveat to handle: the confirmation outbox
suppresses on `appointment.status !== 'CONFIRMED'` (`server/lib/receptionist/confirmationOutbox.ts:177`),
so flipping to `RISKY` will suppress a still-queued booking confirmation. Those fire at booking time,
hours or days before a reminder, so in practice the outbox row is already terminal — but the reminder
writer must check and the test must pin it.

### 3.6 Reminder policy belongs on `SchedulingPolicy`

`SchedulingPolicy` (`prisma/schema.prisma:1033-1049`) is already the tenant's scheduling rulebook, already
read through one accessor (`getSchedulingPolicy`, `server/lib/scheduling.ts:33-45`) that every enforcement
site goes through. Add `reminderLeadHours Int @default(24)`, `reminderSecondAttemptGapHours Int @default(4)`,
`reminderCallWindowStart/End String`. Three files change (`schema.prisma`, `server/lib/scheduling.ts:10-45`,
`server/modules/scheduling/routes.ts:57-74`) and every consumer picks it up.

---

## 4. The call lifecycle state machine

Two machines. Keep them separate — conflating "the work item" with "the phone call" is why the current
system cannot express "this target has been tried twice and both calls failed differently".

### 4.1 Task machine (`ReceptionistCallTarget.status`)

```
                     ┌──────────────────────────────── suppression / DNC / patient opt-out
                     ▼
  PENDING ──claim──► CALLING ──attempt terminal, retryable, budget left──► PENDING
     │  │                │
     │  │                ├──attempt terminal, not retryable──► COMPLETED (terminalReason set)
     │  │                ├──attempts exhausted───────────────► FAILED    (terminalReason='exhausted_*')
     │  │                ├──DNC recorded in-call─────────────► OPTED_OUT
     │  │                └──lease expired, attempt UNKNOWN──► FAILED    (terminalReason='reconciliation_required')
     │  │
     │  └──run window closed / run aborted / appointment cancelled──► COMPLETED (terminalReason='moot')
     └──suppressed at claim time───────────────────────────────────► OPTED_OUT
```

Invariants:
- `status = CALLING` ⟺ `leaseExpiresAt IS NOT NULL AND leaseExpiresAt > now()`. Enforce with a CHECK on
  the null-ness; enforce the freshness in the sweeper.
- `PENDING` ⟹ `nextAttemptAt IS NOT NULL`. There is no such thing as a task waiting for nothing.
- Terminal statuses (`COMPLETED`, `FAILED`, `OPTED_OUT`) are absorbing. Only an operator action creates a
  new task; nothing reopens one. This preserves the existing property at `webhooks.ts:1168-1170`.
- **The task is moved by the attempt's `dialDisposition`, never by the LLM's analysis.** See §10.2.

### 4.2 Attempt machine (`ReceptionistCallLog`)

Three orthogonal facts, which the current single `outcome` enum conflates (§10.4):

- **transport state**: `RESERVED → SUBMITTED → RINGING → CONNECTED → terminal`
- **dial disposition** (provider-derived, one of): `ANSWERED_HUMAN`, `ANSWERED_MACHINE`, `NO_ANSWER`,
  `BUSY`, `REJECTED_BY_CARRIER`, `INVALID_NUMBER`, `FAILED_PROVIDER`, `CANCELED_BY_OPERATOR`,
  `NEVER_SUBMITTED`, `UNKNOWN`
- **conversation outcome** (only meaningful when disposition is `ANSWERED_HUMAN`): `CONFIRMED`,
  `CANCELLED`, `CALLBACK_REQUESTED`, `WRONG_PARTY`, `REFUSED`, `OPTED_OUT`, `ESCALATED`, `NONE`

Transport transitions, **each with its own deadline**:

| From | Event | To | `deadlineAt` set to |
|---|---|---|---|
| — | reservation row created (`outbound.ts:1659`) | `RESERVED` | now + 60s |
| `RESERVED` | provider accepted, call id stored | `SUBMITTED` | now + 120s (max ring + slack) |
| `RESERVED` | provider rejected (`createPhoneCall` `ok:false`, `acceptance:'rejected'`, `server/lib/retell.ts:323`) | terminal `NEVER_SUBMITTED` | null |
| `RESERVED` | provider acceptance **unknown** (`acceptance:'unknown'`, `retell.ts:341`) | `SUBMITTED_UNKNOWN` | now + 120s |
| `RESERVED` | deadline elapsed, no provider intent committed | terminal `NEVER_SUBMITTED` | null |
| `RESERVED` | deadline elapsed, provider intent **committed** | `SUBMITTED_UNKNOWN` | now + 60s (forces a poll) |
| `SUBMITTED` | `call_started` webhook | `RINGING` | now + 120s |
| `SUBMITTED`/`RINGING` | `call_ended` webhook | terminal, disposition from `disconnection_reason` | null |
| `RINGING` | first tool invocation or `call_started` with media | `CONNECTED` | now + maxCallDuration + 120s |
| `CONNECTED` | `call_ended`/`call_analyzed` | terminal | null |
| any non-terminal | **`deadlineAt < now()`** | poll the provider (§5.2); the poll decides | reset or null |
| any non-terminal | operator force-terminalise | terminal `CANCELED_BY_OPERATOR` or `UNKNOWN` | null |
| any non-terminal | tenant kill switch (`outbound.ts:514`) | terminal per existing logic | null |

**The terminal conditions the provider never tells you about** — and how each one is reached without a
webhook. Every row in this table is a real production disposition in this category:

| Real-world event | Provider signal, if any | How we terminalise |
|---|---|---|
| Patient does not pick up | often `call_ended`, `disconnection_reason` containing `no_answer` / `unanswered`; **sometimes nothing at all** | webhook if present; otherwise `deadlineAt` at SUBMITTED+120s → poll → `call_status: 'not_connected'` → `NO_ANSWER` |
| Line busy | `not_connected` with a busy reason; frequently silent | deadline → poll |
| Carrier rejects (blocked, spam-labelled, invalid) | `error`, or nothing | deadline → poll; `INVALID_NUMBER` also suppresses the destination for the task |
| Voicemail answers | `disconnection_reason` containing `voicemail`, sometimes only in `call_analyzed` | webhook; else poll. Currently mapped at `outbound.ts:2675-2685` |
| Patient answers and hangs up in 2 seconds | `call_ended`, duration < 5s, no analysis | webhook → `ANSWERED_HUMAN` + conversation `NONE`. Treat as a non-contact for retry purposes |
| **Provider accepted, then never started the call** (D4) | **nothing, ever** | deadline → poll → snapshot with `status: 'registered'`/`'not_connected'` **and empty metadata** → terminalise (§5.3) |
| Our process crashed between provider accept and storing the call id | nothing | `RESERVED` deadline elapsed with a committed provider intent → `SUBMITTED_UNKNOWN` → poll by *nonce*, not by call id (§5.4) |
| Provider outage — call may or may not be live | `acceptance: 'unknown'` (`retell.ts:341`) | already handled at `outbound.ts:2235-2260`: `ESCALATED`, critical signal, staff task. Keep, add the deadline so it cannot sit forever |

The design rule that makes D4 impossible is one sentence, and it is worth putting in the code as a
comment: **the provider is never the only thing that can end a call row.** Every non-terminal row carries
its own expiry, the DB refuses rows without one, and a single sweeper query
(`WHERE outcome = 'IN_PROGRESS' AND endedAt IS NULL AND deadlineAt < now()`) is the whole liveness
guarantee.

### 4.3 Second belt: capacity must not count expired rows

Today concurrency is `count(outcome = 'IN_PROGRESS' AND endedAt IS NULL)` (`outbound.ts:1615-1618`), which
is what turns a wedged row into a permanent capacity loss. Change it to
`count(... AND deadlineAt > now())`. The tenant then self-heals to full capacity the moment a row expires,
**even if the sweeper is down.** Correctness of the ledger still depends on the sweeper; availability of
the service does not. That separation is the difference between an outage and a delay.

---

## 5. Reconciliation

The provider is the source of truth for what happened on the wire. Webhooks are an optimisation. Design
for them never arriving; treat their arrival as a latency win.

### 5.1 Precedence lattice for terminal facts

One column, `outcomeSource`, and one rule set:

1. **Lifecycle** (`dialDisposition`, `durationSeconds`, `endedAt`) — first provider-derived terminal wins.
   `provider_poll` and `webhook_ended` are equally authoritative; whichever lands first is frozen. This
   preserves the existing immutability at `webhooks.ts:1061-1069`.
2. **Conversation outcome** — only `webhook_analyzed` and signed in-call tool results may set it, and a
   canonical database artefact always beats analysis. The existing rule at `webhooks.ts:1027-1039` — an
   analysis claiming `BOOKED` without a real `Appointment` row is demoted to `ESCALATED` — is exactly
   right and must be extended: an analysis claiming `CONFIRMED` without an `AppointmentContactOutcome` row
   is demoted to `ESCALATED` too. **The model's opinion is never evidence.**
3. `deadline_sweep` may only write `UNKNOWN`, and only when a poll was attempted and failed. It may never
   invent a disposition.
4. `operator` may write any terminal state, requires a reason string, is audited, and is the last resort.

This also fixes A6-F08: a poll that lands before `call_analyzed` currently freezes the row as `ESCALATED`
(`outbound.ts:2675-2685`) and loses the real outcome. With `outcomeSource` recorded, a later signed
`call_analyzed` is permitted to refine a poll-derived `ESCALATED` — and only that one value.

### 5.2 The sweeper

New worker, `receptionist-outbound-reconcile`, cron `* * * * *` (the same cadence as the confirmation
dispatcher, `server/workers/queues.ts:144`), fanning out per tenant through the established pattern
(`resolveActiveJobTenantIds()`, `server/lib/jobTenantResolver.ts:11-20`).

Per tenant, per pass, bounded batch (start at 200):

```
claim: SELECT id, retellCallId, deadlineAt FROM "ReceptionistCallLog"
       WHERE tenantId = $1 AND outcome = 'IN_PROGRESS' AND endedAt IS NULL
         AND deadlineAt < now()
       ORDER BY deadlineAt ASC
       LIMIT 200
       FOR UPDATE SKIP LOCKED;
```

`FOR UPDATE SKIP LOCKED` copies the eligibility reconciler (`server/lib/eligibilityExecution.ts:407`) and
is what lets you run more than one worker.

For each claimed row:
- **has `retellCallId`** → `getPhoneCall` (`server/lib/retell.ts:373`). Apply §5.3.
- **no `retellCallId`, no provider intent** → terminalise `NEVER_SUBMITTED`. Safe: nothing crossed the
  boundary.
- **no `retellCallId`, provider intent committed** → §5.4. Never auto-terminalise; never auto-retry.

Provider errors are not terminal facts. On `getPhoneCall` failure, push `deadlineAt` forward with
exponential backoff (60s · 2^n, capped at 1h — the same shape as `retryAt`,
`server/lib/receptionist/confirmationOutbox.ts:65-68`) and increment a poll-failure counter. After 5
consecutive failures, terminalise as `UNKNOWN` with `outcomeSource: 'deadline_sweep'`, raise an
`OperationalSignal` and a `StaffTask` — reusing the pattern already at `outbound.ts:2130-2178`.

### 5.3 Fix the binding check — a missing metadata is not a mismatch

This is the specific code change that unbreaks the operator's recovery path. `outbound.ts:2656-2671`
currently treats "the provider returned different metadata" and "the provider returned no metadata"
identically. They are completely different events:

- Metadata **present and disagreeing** → a real integrity event. Quarantine, exactly as today.
- Metadata **absent**, snapshot `callId === localCall.retellCallId`, and provider status in
  `registered | not_connected | error` → the provider never carried a conversation, so it retained no
  attributes. **The call id is a sufficient binding here**, because we minted it via `createPhoneCall`
  and wrote it into this row under the dispatch advisory lock (`outbound.ts:171-173`, applied at
  `:2426-2471`), and because a lifecycle-only terminalisation discloses nothing. Accept and terminalise.
- Metadata absent and status `ongoing` or `ended` → still quarantine. A call that carried media and lost
  its metadata is a real anomaly.

Two lines of predicate. It converts D4 from "permanently wedged" to "self-heals in 120 seconds".

### 5.4 Recovering a call whose id we never stored

`ReceptionistOutboundProviderIntent.correlationNonceHash` (`prisma/schema.prisma:2566`,
`@@unique([tenantId, correlationNonceHash])` at `:2578`) is already carried into provider metadata by
`providerIntentMetadataForRetell` (`outbound.ts:2026`) and is already used for signed recovery in
`recoverOutboundProviderIntent` (invoked at `webhooks.ts:878` and `:1359`). That machinery exists and is
**only reachable from the webhook**. Give it a second, worker-driven entrance: list the provider's recent
calls, match by nonce, and bind. If the provider offers no listing on this account, the fallback is the
existing behaviour — `ESCALATED`, critical signal, staff task — plus, now, an operator route that can
close it (§5.5). Never auto-retry an unknown: a duplicate call to a patient about a medical appointment
is worse than a missed one.

### 5.5 The operator escape hatch

`POST /v1/receptionist/outbound-campaigns/:campaignId/call-logs/:id/force-terminalize`, OWNER/ADMIN,
body `{ outcome: 'FAILED'|'UNKNOWN', reason: string(min 10) }`. Writes `outcomeSource: 'operator'`,
`terminalizedAt`, releases the target under the dispatch lock, emits `AuditEvent` and `BusinessEvent`, and
resolves the associated `OperationalSignal`. It is deliberately blunt.

A quarantine state with no human release is not a safety feature; it is an outage that has been given a
respectable name. Every mature product in this space has this button, and every one of them added it after
an incident.

### 5.6 Idempotency and at-least-once

Everything already in place, keep it:
- The lifecycle advisory lock `receptionist-call-lifecycle:{tenant}:{providerCallId}`
  (`webhooks.ts:1058`, `outbound.ts:2691`) serialises webhook, poll and sweeper. The sweeper takes the
  same lock. For rows with no provider id, key on `callLogId`.
- Usage metering dedupes on cumulative minutes (`voiceCallDedupeKey`, `outbound.ts:2722`,
  `webhooks.ts:1127`), so redelivery cannot inflate billing.
- Signed job envelopes with 15-minute max age and job-id↔payload binding
  (`server/lib/jobEnvelope.ts:39-51`, `:80-85`) — the new queue name must be added to `SecureQueueName`
  (`server/lib/jobEnvelope.ts:12`) or envelope validation rejects it.
- Dial idempotency: the dialler's provider submission is keyed by task id + attempt number. A worker that
  crashes mid-dial finds the reserved call row on restart and reconciles it; it never re-submits.

---

## 6. The dialler

### 6.1 Prerequisite: extract the launch path from the route

`POST /outbound-campaigns/:id/call` (`outbound.ts:1345-2621`) contains, in order: campaign status check,
authority approval check, assignment validation, agent readiness, kill switch, target ownership binding,
E164 canonicalisation, live-test authorisation, ad-hoc refusal, identity binding, dialability, shared
suppression, DNC, quiet hours, provider configuration, capacity+budget reservation under advisory lock,
pre-boundary re-check, provider-intent commit under the DNC fence, provider submission, post-acceptance
cancellation, and error-path circuit breaking. It is correct. It is also **a Fastify handler, and a worker
cannot call a Fastify handler.**

Extract it to `server/lib/receptionist/outboundLaunch.ts`:

```ts
export type LaunchActor =
  | { kind: 'user'; userId: string; requestId: string; ip?: string; userAgent?: string }
  | { kind: 'worker'; jobId: string; runId: string };

export async function launchOutboundCall(input: {
  tenantId: string; campaignId: string; targetId: string;
  actor: LaunchActor; clientAttemptToken?: string;
}): Promise<LaunchResult>;
```

The route becomes a thin adapter. **This is not optional and it is not a refactor for tidiness.** If the
worker re-implements the gates they will drift, and the first drift will be a call to a number on the
do-not-call list. Do this before anything else in Phase 1, with the existing 66 outbound tests
(`server/test/receptionistOutboundTargets.integration.test.ts`) green as the proof of no behaviour change.

The `audit(request, ...)` calls need an actor-agnostic seam. `auditOutboundMutation` already takes a
request; give it a `LaunchActor` overload writing `actorUserId: null` with a worker actor id, matching how
webhooks already do it (`enterTenantContext({ actorRole: 'WEBHOOK' })`, `webhooks.ts:907`).

### 6.2 Topology

New queue `receptionist-outbound-dial`, three job types:

1. `plan-runs` — cron `*/5 * * * *`, fans out per tenant. Creates `ReceptionistCampaignRun` rows for
   campaigns whose next window is due, resolves the population, materialises tasks. Idempotent through
   `@@unique([tenantId, outboundCampaignId, windowStart])`.
2. `pace-run` — one job per RUNNING run, self-rescheduling every `ceil(60/callsPerMinute)` seconds. This
   is where concurrency and pacing live. Claims up to `min(perTick, maxConcurrentCalls − inFlight)` tasks
   and enqueues one `dial-task` each.
3. `dial-task` — one job per attempt. Calls `launchOutboundCall`. **Concurrency on this worker is the
   real dial concurrency**; set it from config, default 4.

Why a pacer job rather than BullMQ rate limiting: the ceiling is not "jobs per second", it is
"simultaneous live conversations", which is a function of call *duration*, not arrival rate. Only a
component that can see in-flight state can hold that line.

**Prisma transaction hazard.** `dial-task` makes an HTTPS round trip to the provider inside its unit of
work. It must use `runInTenantContext` (AsyncLocalStorage only), **not** `runWithJobTenantContext`, which
opens a Prisma interactive transaction with a 5-second default timeout. This exact mistake already cost
this codebase a production incident — the write-up is at `server/workers/compliance.worker.ts:60-80`
(P2028, BullMQ retried three times into the same wall, agent attestations lapsed). Read it before writing
the worker.

### 6.3 Claiming

```
UPDATE "ReceptionistCallTarget" t SET
  status = 'CALLING', "leaseOwner" = $worker, "leaseExpiresAt" = now() + interval '5 minutes',
  attempts = attempts + 1
WHERE t.id IN (
  SELECT id FROM "ReceptionistCallTarget"
  WHERE "tenantId" = $1 AND "runId" = $2 AND status = 'PENDING'
    AND "nextAttemptAt" <= now() AND attempts < "attemptsMax"
  ORDER BY "nextAttemptAt" ASC
  LIMIT $n FOR UPDATE SKIP LOCKED
) RETURNING *;
```

`SKIP LOCKED` rather than the current `updateMany` + `count === 1` check (`outbound.ts:1641-1652`),
because the dialler needs N rows atomically and must not serialise behind another worker. Keep the
`updateMany` claim inside `launchOutboundCall` as the second, per-row fence — belt and braces, and it is
what makes a manual dial and a worker dial safe against each other.

A lease that expires (worker died mid-dial) is recovered by the same sweeper as §5.2: the attempt row's
deadline fires first, terminalises, and releases the task.

### 6.4 Pacing, windows and quiet hours

Three distinct time concepts, currently collapsed into one:

- **Calling window** (`run.windowStart/windowEnd`, and `SchedulingPolicy.reminderCallWindowStart/End`) —
  *when we intend to call*. Positive intent. E.g. 09:00–19:00 clinic-local.
- **Quiet hours** (`campaign.quietHoursStart/End`, `prisma/schema.prisma:3158-3159`) — *when we are
  forbidden to call*. A prohibition, evaluated fail-closed at `outbound.ts:453-468`. Keep exactly as is,
  including the re-check inside the provider-intent transaction (`outbound.ts:1856-1867`).
- **Task schedule** (`nextAttemptAt`) — *when this specific task may next be tried*.

The current code only has the prohibition, and it is only asked at dial time. It returns
`{ status: 'skipped', reason: 'quiet_hours' }` (`outbound.ts:1516-1517`) and leaves the target `PENDING` with
no future time — so a dialler naively polling would grind against the quiet window once a minute all
night. The dialler must, on a quiet-hours skip, set `nextAttemptAt` to the next window opening and stop
touching it. The clinic timezone is already available on `ReceptionistClinic.timezone`
(`outbound.ts:1359`), and `nowMinutesInTz` (`outbound.ts:471-483`) already does the arithmetic.

Hard stop at `windowEnd`: any task still `PENDING` when the window closes is terminalised
`COMPLETED / terminalReason: 'window_closed'`. **Never carry a reminder into the next day** — a reminder
that arrives after the appointment is worse than none.

### 6.5 Retry policy

Reminders are not marketing. Real-world numbers: two attempts capture ~95% of the reachable population;
attempt three annoys people and generates complaints. Recommended defaults:

| First-attempt disposition | Retry? | When |
|---|---|---|
| `ANSWERED_HUMAN` + any conversation outcome | No | terminal |
| `ANSWERED_MACHINE` (voicemail) | No on attempt 2; on attempt 1, retry once | +4h, different hour of day |
| `NO_ANSWER` | Yes, once | +4h, and never within 60 min of the previous attempt |
| `BUSY` | Yes, once | +20 min (carrier signal, cheap, high success) |
| `REJECTED_BY_CARRIER` / `INVALID_NUMBER` | No | terminal; file a staff task to correct the record |
| `FAILED_PROVIDER` | Yes, up to 2 | exponential 60s·2^n, capped 1h; does **not** consume a patient-facing attempt |
| `UNKNOWN` | **Never** | quarantine; operator only |

Two rules that must be enforced in code, not policy documents:
- **No dial after `appointment.startsAt`.** A reminder for an appointment that has begun is a support
  ticket. Check it inside the provider-intent transaction.
- **No second dial within 60 minutes.** Patients experience two calls in an hour as harassment, and it is
  the fastest route to a spam label on the clinic's number.

Separate the provider-failure retry budget from the patient-facing attempt budget. Today they share
`attempts` (`outbound.ts:132`), so three provider hiccups exhaust a patient's reminder. Note that
`releaseReservedAttempt` already decrements on a pre-boundary block (`outbound.ts:1720`) — extend that
principle to a named `providerRetries` counter.

Also, document `maxRetryAttempts` semantics. Trace: with default `1` (`prisma/schema.prisma:3160`),
`isTargetDialable` permits `attempts <= 1` (`outbound.ts:132`) and `targetStatusAfterOutcome` returns to
`PENDING` while `attempts <= 1` (`:143`), so a campaign dials **twice**. That is defensible for the name
"retry attempts" and indefensible as a field an operator sets in a UI labelled with a number. Rename the
run-level snapshot to `attemptsMax` with `attempts < attemptsMax` semantics.

### 6.6 DNC re-check at dial time

Already correct and must not be re-implemented. `launchOutboundCall` performs:
shared suppression at entry (`outbound.ts:1470-1478`), destination opt-out
(`isDestinationOptedOut`, `:1483`), re-check at the pre-provider boundary (`:1782-1786`), and the
authoritative fence inside the provider-intent transaction
(`authorizeOutboundProviderIntentTx`, `:1872-1884`, DB-trigger backed per
`prisma/schema.prisma:2552-2554`). The worker gets all of it for free by calling the extracted service.

One current defect to fix while you are there (A6-F07): the shared-suppression branch at
`outbound.ts:1470-1478` returns `skipped` **without writing a call log or moving the target**, so a
suppressed target stays `PENDING` and is re-claimed on every pass. Under a dialler that becomes an
infinite loop. Merge it with the opt-out branch at `:1481-1493` so suppression writes the `OPTED_OUT`
call log and terminalises the target in one transaction.

### 6.7 Volume and cost caps

`getPhoneCall` already returns `combinedCostNativeUnits` (`server/lib/retell.ts:429`) and the poll already
reads it (`outbound.ts:2797`) — and then throws it away. Accumulate it into
`ReceptionistCampaignRun.spentNativeUnits` at terminalisation, and check both `maxCalls` and
`maxSpendNativeUnits` in the pacer before each claim. On breach, `status = 'PAUSED'`,
`abortReason = 'spend_cap'`, `OperationalSignal`, and a visible banner. The existing
`evaluateLiveCallAdmission` cost logic (`server/lib/receptionist/liveCallUat.ts:169-172`) is the template;
it just needs to apply outside the UAT posture.

The voice-minute budget check already exists at `outbound.ts:1636-1639` and reserves a minute per
in-flight call. Keep it. Note it reads `periodUsageTotal` — per billing period, not lifetime — which is
the right call and was learned the hard way (comment at `:1630-1632`).

### 6.8 Interaction with the kill switch

`POST /outbound-control` (`outbound.ts:514`) sets `tenantAiUsage.killSwitch`, quarantines unbound intents,
and issues provider stops for bound calls. With a dialler it must additionally:

1. **Drain the queue.** Remove pending `dial-task` and `pace-run` jobs for the tenant and set every run to
   `PAUSED / abortReason: 'kill_switch'`. Without this, the queue keeps feeding dials that each individually
   block at `outbound.ts:1822` — safe, but it generates thousands of audit rows and looks like an attack.
2. **Release leases.** Every `CALLING` task with no in-flight attempt returns to `PENDING`.
3. The dialler checks the switch at claim time *and* relies on the existing check inside the provider-intent
   transaction (`outbound.ts:1822`). Both. The second is the one that is actually load-bearing.

And it must be clearable. Today the body schema is `z.literal(true)` (`outbound.ts:517`) — the tenant can
stop and cannot start. That is a defensible posture for a platform-imposed stop and an operational trap for
a tenant-imposed one. Record who imposed it; let OWNER clear a tenant-imposed stop with a reason and an
audit event; keep platform-imposed stops platform-only.

### 6.9 The deployment prerequisite — read this before estimating

**The worker process is not running on the production stack.** `vercel.json` defines serverless functions
and no cron; `docs/DEPLOY_VERCEL.md:3-5` states plainly that Vercel "does not host the always-on worker and
therefore is **not**, by itself, a complete pilot"; `docs/PILOT_READINESS_AND_BACKLOG.md:71` records that
"on the shipped Vercel config `QUEUES_ENABLED=false`, so autopilot/campaign/compliance ... silently never
run"; `railway.json:8` starts the API only. A worker service *is* defined at `render.yaml:60-81` and
`render.pilot.yaml:78-138` (the latter with `autoDeploy: false`, `:85`).

When queues are disabled, `disabledQueue()` (`server/workers/queues.ts:39-54`) returns a stub whose `add()`
resolves to `undefined` and enqueue returns `{ state: 'disabled' }` (`:101-103`). **A dialler shipped onto
today's production configuration would accept the operator's "start campaign" click and silently never
dial.** That is the worst possible failure mode for this feature — worse than an error — and it is a
deployment decision, not a code decision.

Mitigations, in order of preference: (a) stand up the always-on worker alongside the API — the blueprint
already exists; (b) failing that, make the "start run" endpoint refuse with an explicit
`{ status: 'setup_required', reason: 'dispatcher_not_running' }` when `QUEUES_ENABLED` is false or the
queue reports disabled, in the same spirit as the existing honest `setup_required` at `outbound.ts:1523`.
Do (b) regardless of (a).

Add the queue to the depth-sampling array at `server/workers/index.ts:96` or it is invisible to alerting,
and wrap the processor in `observed()` (`server/workers/observedJob.ts:17-37`) like every other worker.

---

## 7. Confirm / cancel / reschedule

### 7.1 The identity question, which is the whole design

Inbound and outbound are mirror images and it is worth being precise about the difference.

- **Inbound**: an unknown human calls a known number. The system knows nothing and must make the caller
  prove who they are. Hence `verify_patient_identity` (`liveTools.ts:588-627`): caller number plus date of
  birth, three attempts, 15-minute lockout.
- **Outbound**: the system dialled a number it holds on a specific patient record, under a
  `ReceptionistOutboundProviderIntent` that names `patientId`/`leadId` and the canonical destination
  (`prisma/schema.prisma:2560-2568`), authorised by a DB-trigger-backed fence
  (`dncFence.ts:166`). **The system knows exactly who it intended to reach.** What it does not know is who
  picked up: the patient, their spouse, their teenager, a wrong number, or an answering machine.

So on outbound the identity question inverts: not "who are you?" but "are you the person I dialled?"

**The tool must never take a patient id or an appointment id from the model.** It reads
`ReceptionistOutboundProviderIntent` by `callLogId` (`@@unique([tenantId, callLogId])`,
`prisma/schema.prisma:2576`) and the target's `appointmentId`. The model's only job is to report what the
human said. This is strictly stronger than the inbound path, where the model does supply an
`appointment_id` (validated against the verified patient at `liveTools.ts:757-760`).

### 7.2 Graduated identity proof

| Action | Proof required | Rationale |
|---|---|---|
| State the appointment (provider, date, time) | Answering party asserts the first name: "Is this Sarah?" → yes | Industry norm. First name only is not meaningful PHI; the appointment detail is, and it is not spoken until the assertion. If the answer is no or ambiguous, the agent gives a generic callback message and records `WRONG_NUMBER`. |
| **Confirm** | First-name assertion | Confirming discloses nothing new and the failure mode is a kept slot. Adding DOB friction here would cost more confirmations than it protects. |
| **Cancel** | First-name assertion **plus** date of birth via the existing `verify_patient_identity` | Cancellation is destructive and adversarially exploitable — a hostile ex-partner cancelling a clinic appointment is a real threat model, not a hypothetical. Cancels are ~10% of reminder responses, so the friction is paid by few. |
| Callback request / take a message | None | Discloses nothing. Already exists: `takeMessage` (`liveTools.ts:431`). |
| Reschedule | Not offered on the reminder call — see §8.2 | |

Voicemail: leave a generic message — clinic name, callback number, no appointment detail, no patient name
beyond the first name in the greeting. Record `VOICEMAIL_LEFT`. This is the conservative reading of
minimum necessary and it is what every deployment I have shipped settled on after legal review.

### 7.3 The tools

**New: `confirm_appointment`.** Arguments: `{ confirmed: boolean, identity_asserted: boolean }`. No ids.
Server side:

1. Load the provider intent by `callLogId`; load the target; load `appointmentId`.
2. Re-read the appointment. If `startsAt`/`status` changed since the task was resolved → return
   `{ confirmed: false, needs_human: true }` and a spoken line saying the front desk will call. **Never
   confirm an appointment you did not just read aloud correctly.**
3. Under `pg_advisory_xact_lock('receptionist-confirm:{tenant}:{appointmentId}')`:
   - insert `AppointmentContactOutcome { response: 'CONFIRMED', identityProof: 'first_name_assertion',
     capturedVia, spokenAppointmentHash, callLogId }` — the `@@unique([tenantId, callLogId, response])`
     makes redelivery a no-op;
   - set `Appointment.patientConfirmedAt = now()`, `patientConfirmedVia = 'voice'`;
   - append an `AppointmentNote` with `actorType: 'voice_agent'` and `callLogId`. Both the actor type and
     the column already exist (`prisma/schema.prisma:521-539`, `server/lib/appointmentNotes.ts:11`) and
     have had no writer since they were added — this is their intended use;
   - `AuditEvent` + `BusinessEvent` `appointment.patient_confirmed`.
4. **Status is not touched.** `CONFIRMED` already means "the clinic booked it".

**Reuse: `cancel_appointment`.** `liveTools.ts:754-789` is well built — optimistic concurrency, advisory
lock, deposit voiding without ever promising a refund (`:775-781`), audit and business event. Three
changes to make it reachable outbound:

1. `verifiedPatientForCall` (`:629-643`) must accept an outbound proof: for a call with a provider intent,
   the patient is the intent's `patientId`, and the second factor is still a DOB match written by
   `verify_patient_identity`. Concretely, add an outbound branch that resolves the patient from the intent
   instead of from `patientsByCanonicalPhone` — the phone-match assertion at `:642` is redundant when the
   destination is the one the fence authorised.
2. Add the outbound reminder tools to `SAFE_WITHOUT_RECORDING_GRANT` (`webhooks.ts:1658`), or better,
   make that gate conditional on the call actually being recorded. Outbound calls are launched
   `basic_attributes_only` (`outbound.ts:2031`); requiring a recording grant on a call with no recording is
   a category error that currently blocks 100% of outbound cancels.
3. Keep the two-step confirmation nonce (`prepare_appointment_change`, `liveTools.ts:708-753`). It is
   correct, it is cheap, and it is exactly what stops a mishearing from cancelling an appointment.

Write an `AppointmentContactOutcome { response: 'CANCEL_REQUESTED', identityProof: 'dob_second_factor' }`
alongside the status change, so cancellation attribution is queryable.

**Reuse: `record_do_not_call`** (`liveTools.ts:840`) — already in `SAFE_WITHOUT_RECORDING_GRANT`
(`webhooks.ts:1658`). Every outbound call must offer it; the prompt already says so
(`server/modules/receptionist/promptService.ts:1081`).

### 7.4 The negative outcomes

- **No answer / voicemail on the final attempt** → `Appointment.status = RISKY`, contact outcome
  `NO_RESPONSE`. Feeds the front-desk board and gives `noShowRisk` its first real signal (there is no
  writer today — `prisma/schema.prisma:480` is set only by seeds, per `server/scripts/product-audit.ts:65`).
- **Wrong number** → `AppointmentContactOutcome { response: 'WRONG_NUMBER' }`, suppress the destination for
  this patient, `StaffTask` to correct the record. Do **not** auto-write a DNC — the number may belong to
  someone who never asked to be suppressed globally; suppress the *pairing*, not the number.
- **Patient asks for a human** → `request_human_handoff` (`liveTools.ts:393`), existing path.

---

## 8. DTMF vs conversational

### 8.1 Recommendation

**Build conversational-first, present a DTMF option in the same breath, and route both to the same server
tool. Ship Phase 1 conversational-only, and do not promise the client DTMF until the provider capability is
verified on the real account.**

### 8.2 Reasoning from deployments

What is actually true in the field, and where the received wisdom is wrong:

- **Answer rates are identical.** Modality has no effect on whether someone picks up. Anything you have
  been told about "DTMF gets better answer rates" is confusing modality with caller ID reputation and time
  of day, which are the two variables that actually move connect rate.
- **Completion rates favour DTMF for the pure binary.** For "confirm or cancel", a keypad interaction
  finishes in about four seconds and completes more reliably than speech. Speech recognition on a reminder
  call fails in a specific and predictable set of environments: hearing aids, speakerphone in a moving car,
  a television in the room, strong regional accents, and — most commonly — the patient talking over the
  prompt because they have heard a hundred of these.
- **DTMF fails in its own specific ways**, and they are not marginal. A mobile handset held to the ear
  requires the patient to pull it away and find the keypad; on many devices the screen has locked. Older
  patients on landlines do fine; younger patients on mobiles are the ones who fumble it. The demographic
  intuition is exactly backwards from how it is usually stated.
- **Accessibility cuts both ways.** DTMF is superior for deaf-and-hard-of-hearing patients using amplified
  handsets and for anyone with a speech impairment; speech is superior for patients with limited dexterity,
  tremor, or low vision. Neither is accessible; offering both is.
- **Cost is not close.** A 25-second DTMF interaction with no LLM in the loop is a small fraction of a
  60–90 second conversational call at LLM voice rates. At 200 calls/night this is real money, and it is the
  strongest argument for DTMF as the *primary* path for the binary.
- **What actually reduces no-shows is none of the above.** It is (a) reaching the patient at all, (b)
  reaching them 24–48 hours out — early enough that the slot can be refilled, late enough to be
  memorable — and (c) making cancel exactly as easy as confirm. The measurable revenue effect of a reminder
  programme comes from *freed slots*, and a programme that makes confirming easy and cancelling hard
  produces fewer freed slots than one that treats them symmetrically. Modality is a second-order effect.

So the design is: the agent speaks the appointment, then says **"Press 1 to confirm, press 2 to cancel — or
just tell me."** Both paths land on the same `confirm_appointment` / `cancel_appointment` tool with
`capturedVia` recording which. This is where Artera/WELL, Relatient and Luma all converged, and they got
there from the same data.

### 8.3 The hard constraint in this codebase

**There is no path to receive DTMF from the patient today.** `press_digit` is a supported provider tool
type — enumerated at `server/modules/receptionist/promptService.ts:660-661` and validated at
`server/lib/receptionist/retellRequestContract.ts:42` and `:170-171` — but it is the *agent emitting* a
digit to navigate someone else's IVR. It is not capture. There is no inbound DTMF event handler anywhere in
`server/`.

Receiving keypad input requires one of:
1. A provider DTMF-capture capability wired to a new signed webhook event and added to
   `REQUIRED_RETELL_WEBHOOK_EVENTS` (`server/lib/retell.ts:131`) — **must be verified on the live account
   before it is promised**; or
2. A separate IVR leg (Twilio `<Gather>` or equivalent) for a DTMF-only variant, which is a second
   telephony integration with its own consent, disclosure, recording and reconciliation surface.

Given the standing position that the live agent currently has no tools, prompt or webhook deployed at all,
option 2 is not a Phase 1 conversation. **Phase 1 ships conversational-only** — buildable entirely on the
existing signed tool webhook (`webhooks.ts:1289`) with zero new provider surface — and DTMF is Phase 2,
gated on a capability spike.

The honest message to the client: DTMF is the right end state and we agree with the instinct; it is a
provider-capability question rather than a design question, and committing to it before the account is
verified would be committing to something we have not proven we can deliver. Conversational with an
explicit "you can also just say confirm or cancel" is not a downgrade — it is the same interaction, and it
degrades better when the patient is in a car.

---

## 9. What I would not build

**No predictive or power dialling. Ever.** Dialling more numbers than you can service is the single
regulatory landmine in this category — abandonment-rate rules (TCPA in the US, Ofcom's 3% / 2-second
connect rule in the UK) turn a throughput optimisation into a per-incident liability, and healthcare is the
worst possible domain for it. Progressive only: one live call per available slot, one task at a time. The
existing per-tenant concurrency ceiling (`admissionPolicy.ts:39-43`) already expresses the right idea.

**No reschedule on the reminder call, in Phase 1 or 2.** Reschedule needs availability search, service
resolution, provider matching, timezone-correct slot presentation and a second confirmation. It triples
call duration, it is precisely where the model will make its expensive mistake, and it turns a 25-second
reminder into a three-minute booking call at six times the cost — on every call, because you have to offer
it to everyone. Offer "I'll have the front desk call you back" via the existing `take_message`
(`liveTools.ts:431`) or a warm transfer. Revisit only when confirm/cancel has been boring for a month.

**No CSV or list import.** The rule that the phone number comes from the identity record and never the
browser (`outbound.ts:1051-1069`) is one of the best things in this module and I would defend it in front
of a regulator. A CSV upload is an unauthenticated dial list. Build "add from appointments in a date range"
instead — same outcome, and every row keeps its identity binding, consent evidence and suppression check.

**No answering-machine-detection tuning or voicemail transcription in v1.** AMD is a heuristic that is
wrong a few percent of the time, and its failure mode is hanging up on a real patient who paused before
saying hello. Use the provider's disconnection reason after the fact (already mapped at
`outbound.ts:2675-2685`), leave a fixed message, move on.

**No per-campaign free-text script for reminders.** `ReceptionistOutboundCampaign.script`
(`prisma/schema.prisma:3144`) is an operator-authored string injected into the prompt
(`outbound.ts:2009-2011`). For an offer campaign that is a product feature. For a reminder it is a
prompt-injection surface and a hallucination surface with no upside, because the content is entirely
determined by the appointment. Reminders get a server-owned template with typed slots and a fixed
disclosure; the operator chooses tone and the callback line, not sentences.

**No duplicate SMS/email machinery inside the outbound campaign.** `confirmationOutbox.ts` already exists,
already has lease/backoff/dead-letter/`delivery_unknown` semantics (`:132-172`), already runs every minute
(`server/workers/queues.ts:144`), and `NotificationEvent` already gives per-`(appointment, channel, source)`
idempotency for free (`prisma/schema.prisma:4209`). If a reminder run wants SMS fallback, it enqueues a
`NotificationEvent` with a new `source` string. Orchestrate; do not reimplement.

**No per-target scheduling UI.** The clinic's mental model is "call everyone with an appointment tomorrow".
Nobody wants a per-row date picker, and every product that shipped one removed it.

---

## 10. What I would tear out rather than extend

### 10.1 `@@unique([tenantId, campaignId, phone])` on `ReceptionistCallTarget`

`prisma/schema.prisma:3206`. Wrong grain, and it is not a constraint that can be relaxed later without a
data migration, so fix it before there is data.

Three things it makes impossible, all of which a reminder campaign hits on day one:
- A recurring campaign can dial a given number **once, ever**. Tomorrow's run cannot re-target the same
  patient.
- Two patients in one household — spouses, a parent and child, a care home — share a phone. Only one can
  ever be a target.
- One patient with two appointments in the same run gets one reminder, silently, for whichever appointment
  was inserted first.

Replace with `@@unique([tenantId, runId, appointmentId])`. Dedupe by *destination within a run* at
population time instead (a warning, not a constraint, so the operator can see it), and add a global
"maximum calls to one destination per day" guard in the dialler.

### 10.2 Target state derived from LLM analysis

`webhooks.ts:1176` computes the target's next status from `outcomeRaw` — the model's
`custom_analysis_data.outcome`. This is wrong on two independent axes:
- **Liveness**: when there is no analysis block, `outcomeRaw` is `''`, `targetStatusAfterOutcome` returns
  `null` (`outbound.ts:135-146`), and the target is silently left in `CALLING` forever (§2, D4).
- **Correctness**: the same file already establishes, correctly, that the model's claim of `BOOKED` is not
  evidence and is demoted without a canonical `Appointment` (`webhooks.ts:1027-1039`). It then turns around
  and lets that same unverified string decide the target's terminal state, which is how a target reaches
  `COMPLETED` on a call that achieved nothing.

Delete the LLM path. The task moves on the attempt's `dialDisposition`, which is provider-derived. The
conversation outcome enriches the record and is never the trigger. Already filed as A6-F06.

### 10.3 The 1,280-line `/call` route, as a *route*

`outbound.ts:1345-2621`. The logic is not the problem — the layering is. A dialler physically cannot call a
Fastify handler, so leaving it here guarantees a second implementation of the gates, and gate drift in this
module means an unlawful call. Extract to `outboundLaunch.ts` (§6.1) with the existing tests as the
regression proof. This is a prerequisite, not a nice-to-have.

### 10.4 `ReceptionistCallOutcome` as one enum

`prisma/schema.prisma:1893-1902`: `IN_PROGRESS | BOOKED | NOT_INTERESTED | NO_ANSWER | VOICEMAIL |
ESCALATED | OPTED_OUT | FAILED`. Three orthogonal axes in one column — transport state (`IN_PROGRESS`),
dial disposition (`NO_ANSWER`, `VOICEMAIL`, `FAILED`) and conversation result (`BOOKED`,
`NOT_INTERESTED`, `OPTED_OUT`). Consequences visible in the code today:

- `ESCALATED` currently means at least four different things: the provider ended a call with no signed
  analysis (`outbound.ts:2683-2686`), provider acceptance was unknown (`:2250`), a stop could not be
  confirmed (`:2210`), and the kill switch quarantined an unbound intent (`:552`). No query can
  distinguish them.
- There is no way to express the single most common reminder result: "we connected, and the patient
  confirmed." `BOOKED` is wrong, `NOT_INTERESTED` is wrong, `ESCALATED` is a lie.

Split into `dialDisposition` + `conversationOutcome`, keep `outcome` as a derived compatibility column for
the duration of the migration, and delete it once the reads move.

### 10.5 The capacity query as written

`outbound.ts:1615-1618`. Counting non-terminal rows with no expiry means one stuck row is a permanent
capacity loss, and under the live-test posture (`:1625`, `liveCallUat.ts:163`) one stuck row is a permanent
tenant outage. Add `AND deadlineAt > now()` (§4.3).

### 10.6 `outbound-control` as a one-way door

`outbound.ts:517`: `z.literal(true)`. Correct for a platform-imposed stop; an operational trap for a
tenant-imposed one, and with a dialler in the picture a tenant will trip it — that is what it is for. Record
the imposer; let OWNER clear a tenant-imposed stop with a reason and an audit event.

### 10.7 The stale-call lease sweep, in its current location

`webhooks.ts:472-488`. It is inside `admitInboundReceptionist`, so it only runs when an inbound call
arrives — a clinic doing outbound only never runs it — and it explicitly excludes every row with a provider
intent (`:481`), i.e. every outbound campaign call. Both exclusions were defensible when written and are
exactly wrong for a dialler. Move it into the reconciliation worker (§5.2), keep the "never
auto-terminalise a committed-but-unbound intent" rule (§5.4), and let the deadline column drive it.

---

## 11. Phased delivery

Success criterion for Phase 1, stated as an acceptance test, because "useful to one clinic" needs a number:
**200 appointments tomorrow; one operator click at 09:00; zero further clicks; every task terminal by
19:00; zero dials outside the calling window; zero dials to a suppressed destination; every appointment
either confirmed, cancelled, or marked `RISKY` with a visible reason; and the whole run reconciled with no
row stuck non-terminal for more than five minutes past its deadline.**

### Phase 0 — Stop the bleeding (≈1 week, ships value with no dialler)

1. `deadlineAt` column + CHECK constraint on `ReceptionistCallLog` (§3.4).
2. Reconciliation worker with the deadline sweep and provider poll (§5.2).
3. Fix the binding check so a metadata-less never-started call terminalises instead of quarantining
   (§5.3, `outbound.ts:2656-2671`).
4. Capacity query counts only unexpired rows (§4.3, `outbound.ts:1615-1618`).
5. `force-terminalize` operator route (§5.5).
6. Target state moves on disposition, not analysis (§10.2, `webhooks.ts:1176`).
7. Extract `launchOutboundCall` (§6.1) with the 66 existing outbound tests green.

After Phase 0 the demo stops wedging and the existing manual flow becomes operable. That alone is worth
shipping.

### Phase 1 — The useful clinic (≈3 weeks)

1. `ReceptionistCampaignRun` + task reshape (`runId`, `appointmentId`, `nextAttemptAt`, lease columns);
   drop the phone uniqueness (§3.2, §3.3, §10.1).
2. Population: "appointments starting in [now+leadHoursMin, now+leadHoursMax] at branch B with status
   CONFIRMED/RISKY", resolved server-side, each row identity-bound and consent-checked exactly as
   `POST /targets` does today (`outbound.ts:1051-1069`).
3. Appointment dynamic variables — `provider_name`, `appointment_date`, `appointment_time`,
   `appointment_location`, `patient_first_name` — resolved **inside the provider-intent transaction**, with
   an `appointment_changed` abort (§3.3), added at `outbound.ts:1999-2020`.
4. Server-owned reminder prompt template replacing free-text `script` for `APPOINTMENT_REMINDER` (§9).
5. `confirm_appointment` tool + `AppointmentContactOutcome` + `Appointment.patientConfirmedAt` +
   `AppointmentNote(actorType: 'voice_agent')` (§7.3).
6. Dialler: `plan-runs` / `pace-run` / `dial-task`, pacing, concurrency, calling window vs quiet hours,
   retry ladder, `nextAttemptAt` after a quiet-hours skip (§6).
7. Kill-switch drain (§6.8) and the `dispatcher_not_running` refusal (§6.9).
8. Front-desk "Reminder results" board: run summary, per-task state, per-appointment outcome, and a
   one-click "call this one again".

### Phase 2 — Cancel, and the money (≈2 weeks)

1. `cancel_appointment` reachable outbound: outbound identity proof, recording-grant gate fix,
   DOB second factor (§7.3).
2. `RISKY` on exhausted-without-confirmation; first real writer for `noShowRisk` (§7.4).
3. Wrong-number handling and destination-pairing suppression (§7.4).
4. Cost and volume caps with accumulated spend (§6.7).
5. Freed-slot hook: a cancel emits `appointment.cancelled` (already at `liveTools.ts:782`) — subscribe the
   waitlist to it.
6. **DTMF spike**, then implement if the provider capability verifies on the live account (§8.3).

### Phase 3 — Breadth (≈3 weeks)

1. Reschedule on the reminder call, using `prepare_appointment_change` (`liveTools.ts:708`) unchanged.
2. Recall and reactivation purposes on the same run/task machinery.
3. Multi-channel wave: call → SMS fallback via `NotificationEvent` with a new `source`
   (`confirmationOutbox.ts`, §9).
4. Attribution: confirmed-vs-attended, cancellation lead time, slots refilled, cost per prevented no-show.

---

## 12. Decisions needed before Phase 1 starts

1. **Is an always-on worker being deployed?** (§6.9) If not, Phase 1 delivers nothing and the honest answer
   to the client is that the dialler cannot exist yet. This is the single blocking question.
2. **Is the Retell agent actually deployed with the prompt, tools and webhook?** The tool contract
   (`promptService.ts:686-934`) and the deployment machinery
   (`server/modules/receptionist/deployment.ts`) exist; whether the live account reflects them must be
   verified before any of §7 is testable end to end.
3. **DTMF capability on the live provider account** (§8.3) — a one-day spike, and it determines what we can
   promise the client.
4. **Reminder lead time and calling window defaults** — proposed 24h lead, 09:00–19:00 clinic-local, two
   attempts, 4h apart. These belong on `SchedulingPolicy` (§3.6) so they are tenant-editable, but the
   defaults are a clinical/operational decision, not an engineering one.
5. **Confirm identity threshold** — §7.2 proposes first-name assertion for confirm, DOB for cancel. This is
   a compliance decision the practice's own policy may override; make it a tenant setting if they push
   back, defaulting to the stricter option.
