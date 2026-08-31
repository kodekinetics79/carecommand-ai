# Outbound Calling — Reliability Review

**Date:** 2026-08-31
**Scope:** the outbound dial path end to end — intent creation, provider submission, provider acceptance, webhook delivery, terminal transition, operator recovery.
**Trigger:** a production outbound call to a real number that never connected (`call_status: not_connected`, `disconnection_reason: user_declined`, `duration_ms: 0`, identical start/end timestamps, no `to_number`) and left `ReceptionistCallLog.outcome = IN_PROGRESS` / `ReceptionistCallTarget.status = CALLING` permanently, with `provider-sync` refusing to reconcile.
**Status:** analysis only. No code changed.

---

## 0. Executive summary

The outbound path is unusually well defended at the **authorization** boundary and almost undefended at the **convergence** boundary. Every gate between "an operator clicked call" and "the provider accepted" is transactional, fenced, re-checked and audited. Past that point the system has exactly one way to learn what happened — an unsolicited signed webhook from Retell — and three ways to be told nothing at all. There is no timer, no poller, no sweeper and no operator lever that can close a call the provider never talks about again.

The incident is not a rare race. It is the ordinary behaviour of the system whenever a call does not produce a webhook, and there are at least four independent reasons a call may not produce one. Two of them (§1.4-A and §1.4-B) are latent configuration/parse bugs that make webhook loss the **default** for the default campaign shape, not the exception.

Concretely: **a leaked outbound row is permanent, and it consumes shared inbound answering capacity.** `MAX_TENANT_ACTIVE_CALLS` (25) is counted across both directions (`server/modules/receptionist/outbound.ts:1615`, `server/modules/receptionist/webhooks.ts:520`), and the only sweeper that closes stale rows deliberately skips any row with a provider intent (`server/modules/receptionist/webhooks.ts:481`). Twenty-five leaked outbound calls and the clinic's inbound AI receptionist stops answering patients — permanently, with no operator lever short of a platform-cleared kill switch.

### Findings by production risk

| ID | Risk | Finding | Where |
|---|---|---|---|
| **OR-01** | **P0** | Per-call webhook URL is built with `campaignId=` (empty) whenever the campaign has no linked `receptionistCampaignId` — the default booking mode. The webhook route parses that query with `z.string().uuid().optional()` and rejects it **400 before signature verification**. Every lifecycle event for those calls is permanently discarded. | `outbound.ts:1998`, `webhooks.ts:637` |
| **OR-02** | **P0** | No terminal-state convergence exists at all: no poller, no timer, no sweeper reaches an outbound row with a provider intent. A call with no webhook is `IN_PROGRESS` forever, and its target is `CALLING` forever. | `webhooks.ts:474-486`, absence in `server/workers/*` |
| **OR-03** | **P0** | Leaked outbound rows consume the **shared** tenant concurrency budget used by inbound patient calls. 25 leaks = the clinic's phone line stops being answered by the AI. | `outbound.ts:1615-1630`, `webhooks.ts:520-527` |
| **OR-04** | **P0** | `provider_binding_mismatch` quarantines reconciliation whenever the provider's record lacks the metadata we sent — which is exactly the state of a call that never started. The designed recovery is guaranteed to fail on the only class of call that needs it. | `outbound.ts:2656-2671` |
| **OR-05** | **P1** | Webhook target release keys off `custom_analysis_data.outcome`, not off the lifecycle event. A `call_ended` with no LLM analysis (normal for a call that never connected) leaves the call log at `outcome: IN_PROGRESS` **with `endedAt` set**, and leaves the target `CALLING` forever. | `webhooks.ts:1018`, `1040`, `1063-1067`, `1171-1182` |
| **OR-06** | **P1** | The only operator lever is a tenant-wide kill switch that only the platform control tower can clear, and it still cannot return a target to `PENDING`. Using it trades one stuck call for a stopped tenant. | `outbound.ts:514-720` |
| **OR-07** | **P1** | `ReceptionistOutboundProviderIntent` has no provider call id column and is append-only by trigger, so the durable intent cannot become the reconciliation key even after acceptance is known. | `prisma/schema.prisma:2555-2585`, migration `20260730250000…:290-415` |
| **OR-08** | **P1** | `live_test_single_active_call` is evaluated against never-closed prior attempt rows, so one leak wedges the entire live-UAT lane; the consumed attempt also counts permanently against `maxCalls`. | `outbound.ts:1584-1595`, `liveCallUat.ts:163-164` |
| **OR-09** | **P2** | `createPhoneCall` silently drops the per-call webhook when the URL is not publicly reachable (`providerReachableWebhookUrl` → `null`), with no error, no flag on the call log, and no operator-visible signal. | `retell.ts:245-259`, `285-300` |
| **OR-10** | **P2** | `DELETE /outbound-campaigns/:campaignId/targets/:id` has no status guard, and the restrict-mode FKs from `ReceptionistCallLog` make it fail with an unmapped Prisma error (500) for any target that has ever been dialled — so the obvious manual workaround is also unavailable. | `outbound.ts:1225-1239`, `schema.prisma:2404`, `3201` |
| **OR-11** | **P2** | `activeCalls > 0` / `>= MAX_TENANT_ACTIVE_CALLS` is a *count of unclosed rows*, not a count of live calls. It is a liveness proxy with no liveness evidence behind it. | `outbound.ts:1615`, `admissionPolicy.ts:40-43` |
| **OR-12** | **P3** | Provider-sync's `not_connected → NO_ANSWER` mapping discards `disconnection_reason`, so `user_declined` (a person actively rejecting the call) is indistinguishable from an unanswered ring and is retried identically. | `outbound.ts:2675-2683` |

---

## 1. Where this system can lose track of a call

The dial path has six commit points. Each one is analysed below for **lost**, **duplicated** and **delayed**.

### 1.0 The path, with its commit points

| # | Stage | Durable effect | Code |
|---|---|---|---|
| 1 | Reservation | `ReceptionistCallLog` created `IN_PROGRESS`; target claimed `PENDING → CALLING`, `attempts++` | `outbound.ts:1542-1683` |
| 2 | Provider intent | `ReceptionistOutboundProviderIntent` row (append-only), + audit + business event | `outbound.ts:1808-1893`, `dncFence.ts:166-278` |
| 3 | Provider submission | HTTP POST to Retell; **`call_id` returned synchronously** | `outbound.ts:1994`, `retell.ts:271-344` |
| 4 | Local binding | `ReceptionistCallLog.retellCallId = call_id` | `outbound.ts:2425-2474` |
| 5 | Lifecycle webhook | outcome, duration, `endedAt`, usage, target release | `webhooks.ts:631-1290` |
| 6 | Terminal transition | `targetStatusAfterOutcome` → `PENDING`/`COMPLETED`/`FAILED`/`OPTED_OUT` | `outbound.ts:135-146` |

Stages 1–4 are transactional, fenced with per-tenant advisory locks, and re-verified at every boundary. **Stages 5 and 6 have no owner.** Nothing in this codebase drives them; they happen only if Retell chooses to call us.

---

### 1.1 Stage 1 — reservation

**Lost.** If the request dies between the target claim and the call-log insert, nothing is lost: both are in one transaction (`outbound.ts:1542-1683`), and `linkedAttempt.count !== 1` throws to roll it back (`outbound.ts:1670-1679`).

**Duplicated.** Guarded three ways: a client attempt token consumed under an advisory lock (`outbound.ts:1543-1563`), the tenant capacity lock (`outbound.ts:1564`), and the conditional target claim `status: DIALABLE_TARGET_STATUS` (`outbound.ts:1645-1657`) which admits exactly one winner. This is correct.

**Delayed.** No effect — everything after re-reads state.

**Residual risk: the attempts counter is spent before the provider is asked.** `attempts: { increment: 1 }` commits at `outbound.ts:1652`; the compensating `releaseReservedAttempt` (`outbound.ts:1700-1723`) decrements only on paths the handler itself reaches. If the **process** dies between stage 1 and stage 3, the attempt is burned with no call placed and no compensation, and with `maxRetryAttempts` defaulting to `1` (`schema.prisma:3160`) two such crashes exhaust the target's entire retry allowance without a single dial.

---

### 1.2 Stage 2 — provider intent

Assessed in full in §2. The relevant loss property here: **committing the intent is what makes the row un-sweepable.** `admitInboundReceptionist` closes stale `IN_PROGRESS` rows past a 4-hour lease, but its predicate excludes any row with an intent:

```
outboundProviderIntent: { is: null },      // webhooks.ts:481
```

with the comment "Only signed recovery or explicit operator reconciliation may close that uncertainty." Both of those escape hatches are broken (§1.4, §1.6), so the exclusion is unconditional in practice.

Two further properties of that sweeper make it irrelevant to outbound anyway:

- It runs **only inside the inbound admission transaction** (`webhooks.ts:447-540`), reached only from an inbound webhook or a destination-resolved event (`webhooks.ts:975`). A tenant that only dials out never executes it.
- It is not a scheduled job. `server/workers/queues.ts:144-148` schedules `receptionist-confirmation-dispatch` and `receptionist-agent-reverify` and nothing else touching call lifecycle.

---

### 1.3 Stages 3 and 4 — provider submission and local binding

This is the crash window the design worried most about, and it is genuinely well handled for the cases it anticipated.

**Rejected (`acceptance: 'rejected'`).** Only 400/401/403/404/422 (`retell.ts:317`). Call → `FAILED`, target → `targetStatusAfterOutcome` (`outbound.ts:2241-2258`). Correct and retryable.

**Unknown (`acceptance: 'unknown'`).** Timeouts, 409, 429, 5xx, and `retell_no_call_id`. Call → `ESCALATED`, target → `FAILED/RECONCILIATION_REQUIRED`, plus a critical signal and a `CRITICAL` staff task (`outbound.ts:2296-2312`). Fail-closed and correct — but note it lands the target in a **non-dialable** state that only a human can leave, and §5 shows there is no route for that human to use.

**Accepted, then the process dies before binding.** The intent is committed and the provider is running a call whose id we never stored. Recovery is `recoverOutboundProviderIntent` (`providerIntentRecovery.ts:44-290`), driven from `webhooks.ts:877-885`. This is elegant: the metadata carries an HMAC-signed intent tuple (`providerIntentCorrelation.ts:43-81`), the resolver takes only the opaque intent UUID under `SECURITY DEFINER`, and the nonce hash is compared with `timingSafeEqual`. **It works only if a webhook arrives.**

**Binding collision.** If the returned `call_id` is already bound to another local row, the call is `ESCALATED` and the target quarantined (`outbound.ts:2447-2467`). Correct.

**The gap:** `createPhoneCall` returns `ok` the instant Retell hands back a `call_id` (`retell.ts:339`). Retell's response at that point means *"I have registered a call"*, not *"a phone rang"*. Nothing in the system re-examines that call unless a webhook arrives. There is no `registered → ongoing` timeout, so **`call_status: registered` that never advances is invisible** — and `registered` is not in the `technicallyTerminal` set either (`outbound.ts:2674`), so even a manual poll of such a call would leave it `IN_PROGRESS`.

---

### 1.4 Stage 5 — webhook delivery: four independent ways to receive nothing

This is the heart of the incident.

#### A. The webhook URL is malformed for the default campaign shape — **OR-01, P0**

```ts
// server/modules/receptionist/outbound.ts:1998
webhookUrl: `${env.PUBLIC_API_URL}/v1/receptionist/webhooks/retell?clinicId=${campaign.clinicId}&campaignId=${campaign.receptionistCampaignId ?? ''}`,
```

`receptionistCampaignId` is nullable (`schema.prisma:3142`) and is required only for `DIRECT_BOOKING_IF_SLOT_AVAILABLE` (`outbound.ts:348`). The default booking mode is `APPOINTMENT_REQUEST_ONLY` (`schema.prisma:3155`). So for the default campaign the URL registered with Retell ends `&campaignId=`.

The receiving route's very first statement is:

```ts
// server/modules/receptionist/webhooks.ts:637
const query = z.object({ clinicId: uuid.optional(), campaignId: uuid.optional() }).parse(request.query);
```

Fastify's querystring parser yields `campaignId: ''`. `z.string().uuid().optional()` accepts `undefined`, not `''` — verified: it throws `invalid_format` on `campaignId`. The error plugin maps `ZodError` to **HTTP 400** (`server/plugins/errors.ts:46-54`). This happens **before** signature verification at `webhooks.ts:668`, before ingress resolution, before anything.

Consequences:

- Every `call_started`, `call_ended` and `call_analyzed` for a default-mode outbound call is rejected 400.
- A 400 is a *permanent* rejection to any sane webhook sender; Retell will not usefully retry it.
- There is no audit row, no `flagUnresolvedRetellIngress`, no signal. The event vanishes.
- The file already knows about this exact footgun — `outbound.ts:733-736` builds an `emptyToNull` preprocessor "instead of answering 400 'Invalid UUID' for a field the user never touched" — but the fix was applied to the campaign PATCH body and never to the webhook query.

**This is the single highest-value fix in this document.** It converts webhook loss from the norm to the exception.

*Fix:* coerce `''` → `undefined` in the webhook query schema (`z.preprocess(v => (v === '' ? undefined : v), uuid.optional())`), **and** omit the parameter at the source rather than emitting an empty one (`outbound.ts:1998`). Both, not either: the receiver must be tolerant because URLs already registered on live agents cannot be retroactively rewritten. Additionally, the query parse must move *after* signature verification, so that a malformed selector on an authenticated body is a flagged ingress review rather than a silent 400.

#### B. The webhook URL is silently dropped when unreachable — **OR-09, P2**

```ts
// server/lib/retell.ts:285-297
const providerWebhookUrl = providerReachableWebhookUrl(input.webhookUrl);
…
...(providerWebhookUrl ? { webhook_url: providerWebhookUrl, webhook_events: [...] } : {}),
```

`providerReachableWebhookUrl` (`retell.ts:245-259`) returns `null` for non-https, loopback, `.local`, and RFC1918 hosts. When it does, the call is placed **with no per-call webhook at all** and falls back to whatever the agent carries. `createPhoneCall` returns `ok: true` regardless; the call log records nothing about it.

`env.ts:458-462` enforces a public HTTPS `PUBLIC_API_URL` for the production `DEPLOYMENT_PROFILE`, which contains the blast radius — but the containment lives in a different subsystem, and a URL that is well-formed and public yet points at a stale host (the Render/Vercel split recorded in the deploy notes) passes this check and still delivers nowhere.

*Fix:* make the per-call webhook a hard precondition of an outbound dial. If `providerReachableWebhookUrl` returns `null`, refuse the dial with `reason: 'provider_callback_unreachable'` rather than placing a call we cannot hear the end of. Stamp the resolved webhook URL's host on the call log (or the submission receipt of §3.2) so an operator can see which endpoint a stuck call was expecting.

#### C. The provider never emits an event, because the call never started — **the incident**

`not_connected` with `duration_ms: 0` and identical timestamps is a call Retell registered and then abandoned. `call_started` never fires because the call never started. Whether `call_ended` fires for this class is provider-dependent and, per the incident report, it did not.

The design's answer to this is `POST …/provider-sync`. §1.6 and §4 explain why it cannot answer.

#### D. The event arrives but carries no analysis — **OR-05, P1**

Even a *delivered* `call_ended` does not reliably close the loop, because outcome derivation is sourced entirely from the LLM's post-call analysis:

```ts
const outcomeRaw = String(custom.outcome ?? '').toUpperCase();   // webhooks.ts:1018
const outcome: CallOutcome = validOutcomes.includes(...) ? ... : 'IN_PROGRESS';   // webhooks.ts:1040
```

A call that never connected produces no `custom_analysis_data`. So `outcomeRaw === ''` and `outcome === 'IN_PROGRESS'`. Then:

```ts
const persistedOutcome = canonicalBooking ? 'BOOKED'
  : current && current.outcome !== 'IN_PROGRESS' ? current.outcome
  : outcome;                                                     // webhooks.ts:1063-1067
…
endedAt: ended ? (current.endedAt ?? new Date()) : undefined,    // webhooks.ts:1078
```

The row is written **`outcome: IN_PROGRESS` with `endedAt` set** — a state that is not terminal by the system's own definition (`verify-clear` at `outbound.ts:1327` requires `outcome !== 'IN_PROGRESS' && endedAt !== null`), yet no longer counts toward `activeCalls` (which requires `endedAt: null`). A permanent half-state.

And the target release is keyed off the same empty string:

```ts
const nextStatus = target ? targetStatusAfterOutcome(outcomeRaw, ...) : null;   // webhooks.ts:1176
if (target && nextStatus) { …update… }
```

`targetStatusAfterOutcome('')` returns `null` (`outbound.ts:135-146` — `''` matches none of the three branches), so the target is **never released** and stays `CALLING` forever.

Note the asymmetry: `disconnection_reason` *is* consumed on this path, but only to derive `transferOutcome` (`webhooks.ts:54-57`, `1051`). The webhook has the provider's own reason for the call ending in hand and does not use it to decide the outcome — while `provider-sync` (`outbound.ts:2675-2683`) does exactly that. The two convergence paths disagree about what evidence counts.

*Fix:* derive outcome from the lifecycle event first and from analysis only as a refinement. `call_ended` is itself terminal evidence. Map `disconnection_reason` in the webhook with the same table `provider-sync` uses, defaulting an analysis-free `call_ended` to `NO_ANSWER`/`FAILED` rather than `IN_PROGRESS`. Release the target from `persistedOutcome`, never from `outcomeRaw`.

---

### 1.5 Stage 5, duplicated and delayed

Credit where due — redelivery is handled correctly.

- **Duplicated.** A per-call advisory lock `receptionist-call-lifecycle:{tenantId}:{callId}` serialises lifecycle writes (`webhooks.ts:1058`); the first terminal outcome is immutable (`webhooks.ts:1063-1067`); billing charges only the positive minute delta under `voiceCallDedupeKey` (`webhooks.ts:1114-1140`); the target update is conditioned on `status: 'CALLING'` (`webhooks.ts:1178`). Replay is a no-op.
- **Delayed.** A late terminal event still reconciles: `enforceAdmission: !endedEvent` (`webhooks.ts:981`) lets a terminal event through a kill switch, and terminal events skip the callback rate limiter entirely (`webhooks.ts:953`). Correct.

The one delay hazard: `provider-sync` and a late `call_analyzed` can race, and they take **different** locks — `provider-sync` locks on `localCall.retellCallId` (`outbound.ts:2704`), the webhook on `providerCallId` (`webhooks.ts:1058`). Same key value, same lock; that is fine. But `provider-sync` will have already set `endedAt` and moved the target, and the webhook's `current.outcome !== 'IN_PROGRESS'` guard then freezes the poll's guess in place even when the webhook carries better evidence. Poll-derived outcomes should be marked provisional (§3.5).

---

### 1.6 Stage 6 — terminal transition, and the states with no exit

`targetStatusAfterOutcome` (`outbound.ts:135-146`) is the only function that returns a target to `PENDING`, and `PENDING` is the only dialable status (`outbound.ts:50`, `131-134`). Enumerating the exits:

| Target state | Reached by | Exit to `PENDING`? |
|---|---|---|
| `CALLING` | claim at `outbound.ts:1652` | Only via a webhook/poll carrying a retryable outcome, or `releaseReservedAttempt` inside the same request |
| `FAILED` + `RECONCILIATION_REQUIRED` | acceptance-unknown, binding failure, kill switch, quarantined recovery | **None.** No code path anywhere sets `PENDING` from `FAILED` |
| `FAILED` + `OUTBOUND_STOPPED` | `applyConfirmedProviderStopTx` (`outbound.ts:183-273`) | **None** |
| `COMPLETED` | `BOOKED`/`NOT_INTERESTED`/`ESCALATED` | None (correct) |

So every fail-closed branch in the system terminates in a state whose documented resolution is "staff reconciliation" — and **no route exists for staff to perform it**. The `CRITICAL` staff tasks created at `outbound.ts:2298-2312`, `2166-2176` and `733-745` describe work the product cannot do.

The incident's own path is the narrowest version: `CALLING` with a live call log, where the *only* transition is a webhook that will never come or a poll that is refused.

---

## 2. The provider-intent durability design: what it covers, what it does not

### 2.1 What it actually does

`ReceptionistOutboundProviderIntent` (`schema.prisma:2555-2585`) plus `authorizeOutboundProviderIntentTx` (`dncFence.ts:166-278`) plus the `receptionist_outbound_provider_intent_guard` trigger (migration `20260730250000_receptionist_delivery_consent_integrity/migration.sql:290-415`) implement a **linearization point for consent**. The intent row is the durable proof that, at one instant which the database can order against every competing suppression write, this tenant was permitted to dial this exact destination for this exact person under this exact policy.

Mechanically:

1. `FOR UPDATE` on the call log and target rows (`dncFence.ts:187-207`) pins the tuple.
2. Exactly-one-of `patientId`/`leadId` (`dncFence.ts:210-212`).
3. Destination canonicalised and required to agree across target, call log and the Patient/Lead row (`dncFence.ts:213-218`, `241-243`).
4. Suppression advisory fences taken in a fixed sorted order before the identity row lock, to avoid inversion against concurrent revocation (`dncFence.ts:220-228`, `52-69`).
5. Full suppression re-check under those fences (`dncFence.ts:244-251`).
6. Immutable voice-consent evidence for `EXPLICIT_CONSENT` / `PATIENT_REACTIVATION` (`dncFence.ts:253-262`).
7. The database trigger repeats **all** of it independently, and refuses `UPDATE`/`DELETE` outright.

Plus the correlation envelope (`providerIntentCorrelation.ts`): an HMAC over a length-prefixed tuple, keyed on `JWT_SECRET` so it survives Retell key rotation, with a random nonce whose hash is stored and compared with `timingSafeEqual`. That envelope is what lets an unsolicited webhook bootstrap a tenant context safely (`providerIntentRecovery.ts:49-63`).

This is a good design for the problem it names.

### 2.2 The one durability problem it does solve

**Crash between provider acceptance and local binding.** The provider is running a call; our process died before writing `retellCallId`. `recoverOutboundProviderIntent` (`providerIntentRecovery.ts:44-290`) reconstructs the binding from the next webhook's signed metadata, checks for id collision and replay, verifies the deployment attestation, trips the deployment circuit on mismatch, and quarantines with `stopRequired` when the recovered call is no longer safe to continue.

### 2.3 What it does not cover — and why it did not save us

**(a) The intent stores no provider call id — OR-07.** Look at the columns (`schema.prisma:2556-2578`): call log, campaign, target, patient/lead, consent event, destination, nonce hash, purpose, policy version, timestamps. There is **no `providerCallId`**. The only home for the provider's identifier is `ReceptionistCallLog.retellCallId`.

That is a consequential omission, because the intent is the *append-only, trigger-protected, independently-verifiable* record — and `ReceptionistCallLog` is an ordinary mutable row. The strongest join key the provider will ever give us (§3.1) is stored on the weakest record.

Worse, it cannot simply be added: the guard trigger raises `'ReceptionistOutboundProviderIntent is append-only'` on any `UPDATE` (migration `…:301-304`), and the call id does not exist until after the intent commits. A provider call id can never be written into this table by construction. It needs a sibling record (§3.2).

**(b) It is authorization evidence, not lifecycle evidence.** The intent answers "were we allowed to dial?" It never answers "did the call happen, and how did it end?" The design correctly refuses to let anything but signed evidence close the loop — but then never builds a second source of signed evidence, so "refuses to guess" collapses into "never converges."

**(c) It is recoverable only by an inbound webhook.** `recoverOutboundProviderIntent` is called from exactly one place (`webhooks.ts:877-885`; the tool webhook at `1358` is the in-call variant). It is a *reactive* recovery mechanism for a *push* channel. When the push channel is the thing that failed, the recovery mechanism is unreachable. There is no code path that starts from an intent row and goes and asks the provider.

**(d) Its presence actively blocks the only sweeper.** `webhooks.ts:481` excludes intent-bearing rows from lease expiry. The intent was intended as a *stronger* durability guarantee; because the promised follow-through never shipped, it functions as an *exemption from cleanup*. A call with an intent is strictly harder to recover than a call without one.

**In the incident specifically:** the intent committed (stage 2 ✅), Retell accepted and returned a `call_id` (stage 3 ✅), the binding wrote `retellCallId` (stage 4 ✅). The intent's entire job was done correctly, and none of it was relevant — because the failure was at stage 5, which the intent design does not address, and its side effect at `webhooks.ts:481` removed the only automatic cleanup that might otherwise have applied.

---

## 3. Reconciliation design: how convergence should work

The requirement: **the provider is authoritative but unreliable, and its records are incomplete for calls that never start.** A design that requires complete provider records cannot converge. A design that guesses cannot be trusted. The resolution is to separate *what happened on the call* (needs provider evidence, may remain unknown forever) from *whether this attempt is still in flight* (must always converge, and can be decided locally once enough time has passed).

### 3.1 The join key

`call_id` is returned synchronously from `POST /v2/create-phone-call` (`retell.ts:339`) even when everything else about the call is absent. Three properties make it the right key:

1. **We minted the request it answers.** Possession is evidence of ownership — the id came back on our own authenticated HTTP response to our own submission.
2. **It is globally unique in our schema.** `ReceptionistCallLog.retellCallId String? @unique` (`schema.prisma:2343`) is unique across all tenants, so if our row holds it, no other tenant's row can. Cross-tenant misattribution is a database invariant, not a policy check.
3. **`getPhoneCall` already validates it.** `retell.ts:405-406` refuses any response whose `call_id` differs from the one requested. Fetching by id already proves the response describes the call we asked about.

Everything else Retell returns — metadata, agent id, agent version, `to_number` — is optional and demonstrably absent for calls that never start. It must be treated as **corroborating evidence, not a precondition**.

### 3.2 A submission receipt

Add an append-only `ReceptionistOutboundProviderSubmission` sibling to the intent, written immediately after `createPhoneCall` returns, in the same transaction as the binding at `outbound.ts:2425-2474`:

```
id, tenantId, providerIntentId (FK, unique), callLogId, outboundCampaignId, targetId,
providerCallId (unique, nullable), submittedAt, acceptance ('accepted'|'rejected'|'unknown'),
providerAgentId, providerAgentVersion, callbackHost,
lastPolledAt, pollAttempts, convergedAt, convergenceSource ('webhook'|'poll'|'lease'|'operator')
```

Why a second table rather than columns on the call log:

- The intent is append-only by trigger and cannot carry the id (§2.3a).
- Poll bookkeeping (`lastPolledAt`, `pollAttempts`) is mutable and does not belong on an evidentiary record.
- It gives the reconciler an **index to scan**: "every submission with `convergedAt IS NULL`". Today no such worklist exists, which is precisely why nothing can be driven.
- `providerCallId` unique on this table makes "this id belongs to this tenant's submission" a constraint, not a query.

The `acceptance: 'unknown'` case (timeout with no id) is exactly the row a reconciler should poll by intent id later, if Retell ever exposes such a lookup; today it is at least an explicit worklist entry rather than an invisible orphan.

### 3.3 What to poll, and when

A scheduled worker — `receptionist-outbound-reconcile`, alongside the existing schedules in `server/workers/queues.ts:144-148` — claims submissions where `convergedAt IS NULL` and drives them to convergence.

| Age since `submittedAt` | Action | Rationale |
|---|---|---|
| 0–60s | nothing | The webhook is the cheap path; do not race it |
| 60s | poll #1 | A real call is `ongoing` by now, or it never started |
| then 2m, 5m, 15m, 45m (capped, jittered) | poll | Bounded exponential backoff; a 40-minute call polls ~5 times |
| provider says `ended`/`error`/`not_connected` | converge | Provider terminal is terminal (§3.4) |
| provider says `registered` and age > 5 min | converge `FAILED` / `provider_never_started` | `registered` that never advances is a call that did not happen |
| provider says `ongoing` | keep polling; extend the local lease | Genuine long call |
| provider 404 / `retell_error_404` and age > 15 min | converge `FAILED` / `provider_call_unknown` | The provider has no record of a call we submitted |
| provider unreachable | do not converge; increment `pollAttempts` | Never convert our outage into a call outcome |
| age > lease (4h) with no successful poll ever | converge `FAILED` / `unreconciled_lease_expired`, raise a signal | Bounded uncertainty beats unbounded |

Polling is cheap and privacy-safe by construction: `getPhoneCall` (`retell.ts:373-434`) already returns no transcript, no recording, no caller number and no free-text analysis. The docstring calls it "the privacy-safe polling fallback for an attended synthetic UAT" — it is fit for general use and should be promoted from a UAT affordance to the reconciliation substrate.

The `registered`-never-advances rule matters especially: `technicallyTerminal` (`outbound.ts:2674`) excludes `registered`, so today even a successful poll of such a call leaves it `IN_PROGRESS`.

### 3.4 Idempotency

Every convergence write must be safe under arbitrary interleaving of poll, webhook redelivery and operator action.

1. **Lock.** Reuse the existing per-call key `receptionist-call-lifecycle:{tenantId}:{providerCallId}` (`webhooks.ts:1058`, `outbound.ts:2704`) — both paths already agree on it. For a submission with no provider id, key on the intent id instead.
2. **Guard.** Convergence transitions `IN_PROGRESS → terminal` only. Re-read inside the lock and no-op if `convergedAt IS NOT NULL` or the call is already terminal.
3. **Evidence precedence**, strongest wins, ties resolved by arrival order: canonical booking (an actual `Appointment` row) > signed `call_analyzed` > signed `call_ended` > provider poll > lease expiry. Store `convergenceSource` so the precedence is auditable and a later stronger source can legitimately overwrite a weaker one (§3.5).
4. **Billing.** Keep the existing delta-only rule with `voiceCallDedupeKey(providerCallId, cumulativeMinutes)` (`webhooks.ts:1114-1140`, `outbound.ts:2710-2736`); it is already correct and correctly shared between the two paths.
5. **Target release** exactly once, conditioned on `lastCallLogId` **and** `status: 'CALLING'`, as `provider-sync` already does at `outbound.ts:2740-2751`.

### 3.5 Making a terminal state unambiguous

Today "terminal" is inferred from a two-column conjunction that four code paths compute slightly differently, and one of them can produce `outcome: IN_PROGRESS` with `endedAt` set (§1.4-D). Three changes remove the ambiguity:

**(a) Never leave a lifecycle-terminal row at `IN_PROGRESS`.** If `endedAt` is being set, the outcome must leave `IN_PROGRESS`. `NO_ANSWER` for a call that never connected is honest; `IN_PROGRESS` on a call that ended is not. Consider a database `CHECK ("outcome" <> 'IN_PROGRESS' OR "endedAt" IS NULL)` to make the half-state unrepresentable.

**(b) Distinguish "the call is over" from "we know how it went."** These are different facts and the schema conflates them. Add `outcomeConfidence: 'provider_analyzed' | 'provider_lifecycle' | 'provider_poll' | 'inferred_lease'` (or read it off `convergenceSource`). The call log becomes terminal on lifecycle evidence; the *business outcome* stays explicitly unknown, routed to the review queue that `provider-sync` already builds at `outbound.ts:2755-2780`. This preserves the product's real principle — never fabricate a business outcome — while dropping the operational fiction that the call might still be running.

**(c) Make retryability a first-class decision, not a side effect of an outcome string.** `targetStatusAfterOutcome` currently returns `null` for unrecognised outcomes and silently leaves the target wedged. It should be total: every terminal outcome maps to a target status, and an unmappable outcome maps to `FAILED` with an explicit `lastOutcome`, never to "do nothing."

---

## 4. The quarantine rule

### 4.1 What it does and why it fired

```ts
// server/modules/receptionist/outbound.ts:2656-2671
const metadataTenant = typeof snapshot.metadata.tenantId === 'string' ? snapshot.metadata.tenantId : null;
const metadataCampaign = typeof snapshot.metadata.outboundCampaignId === 'string' ? … : null;
const metadataCallLog = typeof snapshot.metadata.callLogId === 'string' ? … : null;
const expectedAgentId = localCall.outboundCampaign?.agent?.providerAgentId ?? null;
const expectedAgentVersion = localCall.outboundCampaign?.agent?.providerVersion ?? null;
if (metadataTenant !== request.auth.tenantId
  || metadataCampaign !== params.campaignId
  || metadataCallLog !== localCall.id
  || (expectedAgentId && snapshot.agentId !== expectedAgentId)
  || (expectedAgentVersion !== null && snapshot.agentVersion !== expectedAgentVersion)) {
  … return reply.code(409).send({ status: 'quarantined', reason: 'provider_binding_mismatch' });
}
```

The safety property is right and must be preserved: **never attribute a stranger's call to this tenant.** Provider metadata is a legitimate cross-check.

The flaw is that it treats **absence as contradiction**. All five clauses fail identically whether the provider says "this call belongs to someone else" or "I have no record of that." For a call that never started, Retell retained no metadata and no agent binding — so `metadataTenant`, `metadataCampaign`, `metadataCallLog` are all `null` and `snapshot.agentId` is `null`, and every clause trips at once. The rule is guaranteed to fire on precisely the population it was built to rescue.

There is a second, unnoticed failure mode with the same shape: `expectedAgentVersion !== null && snapshot.agentVersion !== expectedAgentVersion` will quarantine a **perfectly ordinary, correctly attributed** call if the agent was re-verified to a new provider version after the call was placed — because it compares the provider's record of *that call* against the campaign's agent binding *now*, not against the version we actually submitted. The correct comparand is the version recorded on the submission receipt (§3.2), not today's campaign configuration.

### 4.2 The ownership argument

The call id was returned synchronously on our own authenticated request. `getPhoneCall` refuses any response whose `call_id` differs from the one asked for (`retell.ts:405-406`). `retellCallId` is globally unique in our schema (`schema.prisma:2343`). Therefore:

> **Fetching provider call X by id, from a local row that holds X, is already proof that X is ours.** Provider metadata can *strengthen* that proof. It cannot be required to establish it, because the provider is free to discard it.

The current rule inverts this: it treats our own submission receipt as insufficient and the provider's optional bookkeeping as mandatory.

### 4.3 Proposed rule: three-valued matching with evidence-scoped effects

Evaluate each signal as **`match` / `mismatch` / `absent`** rather than boolean, then let the *combination* decide:

| Signal | `match` | `mismatch` | `absent` |
|---|---|---|---|
| `snapshot.callId === localCall.retellCallId` | required | **hard quarantine** | impossible (`retell.ts:405`) |
| `metadata.tenantId` | corroborates | **hard quarantine** | permitted |
| `metadata.callLogId` | corroborates | **hard quarantine** | permitted |
| `metadata.outboundCampaignId` | corroborates | **hard quarantine** | permitted |
| `agentId` / `agentVersion` vs the **submission receipt** | corroborates | soft quarantine (deployment circuit) | permitted |

Decision:

1. **Any `mismatch` on tenant / callLogId / campaignId → quarantine, unchanged.** This is a stranger's call, or evidence of provider-side confusion. `409 provider_binding_mismatch`, audit as today. The safety property is fully preserved: a populated field that names someone else still blocks.
2. **Agent id/version `mismatch` → quarantine as `provider_deployment_mismatch`**, and trip the deployment circuit the way `providerIntentRecovery.ts:158-182` already does. Different failure, different name, different remediation — today it is misreported as a binding mismatch.
3. **All present signals `match`, some `absent` → reconcile in `degraded_attribution` mode.** Permitted effects:
   - ✅ set `endedAt`, set a terminal `outcome`, release the target per §3.4
   - ✅ record billable minutes (the provider's own duration, ≥ existing)
   - ❌ **no** business outcome above `NO_ANSWER`/`FAILED` — never `BOOKED`, never `NOT_INTERESTED`, never consent, never an appointment request
   - ❌ no transcript, recording or analysis ingestion (`provider-sync` already returns none)
   - 📋 stamp `attributionEvidence: 'call_id_only'` on the audit row and on the call log's `convergenceSource`
4. **`durationMs === 0` with `status: not_connected` → converge as never-connected**, which is a *stronger* safety position than IN_PROGRESS: it proves no conversation occurred, so no patient-facing outcome could exist to misattribute.

The asymmetry is deliberate and defensible: **absent metadata restricts what we may conclude; it does not prevent us from closing the attempt.** Closing an attempt on `call_id` evidence alone risks nothing — the worst case is that we mark our own call terminal a little early, which the lease would have done anyway. Asserting a *booking* on that evidence would risk everything, and remains forbidden.

Point 4 also removes the incident's specific trap entirely: `not_connected` + `duration_ms: 0` is self-evidently a call that never reached a human, and needs no metadata to be safely closed.

### 4.4 Rejected alternative

"Let the operator override the quarantine with a confirmation checkbox." Rejected: it converts a safety invariant into a UI habit, and the operator has strictly less information than the server does. The server can compare the id it minted; a human comparing masked ids in a browser cannot do better and will click through.

---

## 5. Operator recovery: the minimum safe lever

### 5.1 What an operator has today

| Lever | Effect | Why it fails here |
|---|---|---|
| `POST …/provider-sync` | poll + converge | 409 quarantined (§4) |
| `POST /outbound-control` | tenant kill switch + stop every active call | Only the platform control tower can clear it (`outbound.ts:515-517`); `stopPhoneCall` on an already-ended call returns non-2xx → `ok: false` (`retell.ts:1305-1307`) → the call converges `ESCALATED` and the target `FAILED/RECONCILIATION_REQUIRED`, still not dialable. Stops the tenant to unstick one call, and still does not restore the target |
| `DELETE …/targets/:id` | delete and re-add the target | No status guard (`outbound.ts:1225`), but `ReceptionistCallLog_target_ownership_fkey` and `ReceptionistCallTarget_last_call_ownership_fkey` are `onDelete: Restrict` (`schema.prisma:2404`, `3201`), so a dialled target cannot be deleted and the Prisma FK error is unmapped → 500 (**OR-10**) |
| `…/launch-attempts/:token/verify-clear` | clear the client attempt fence | Returns `cleared: false, proof: 'call_not_terminal'` (`outbound.ts:1327-1336`) — it *reports* the stuck state, it cannot fix it |
| Direct SQL | — | Not a product feature; bypasses RLS, audit and the consent invariants |

So: **zero safe levers.** The `CRITICAL` staff tasks the system creates for exactly this situation (`outbound.ts:2298-2312`, `2166-2176`, `733-745`) describe work with no corresponding endpoint.

### 5.2 The lever to build

**`POST /v1/receptionist/outbound-campaigns/:campaignId/call-logs/:id/reconcile`**

Deliberately narrow: it closes one attempt and optionally makes one target dialable again. It does not stop the tenant, does not touch the kill switch, does not affect any other call.

**Preconditions (all enforced server-side, none operator-assertable):**
- The call log is tenant-scoped and belongs to `:campaignId`.
- It is non-terminal: `outcome = IN_PROGRESS` or (`outcome = ESCALATED` and `lastOutcome = RECONCILIATION_REQUIRED`).
- **A provider poll was attempted first, in this request.** If `retellCallId` is present, call `getPhoneCall`. If the provider says the call is `ongoing`, **refuse** (`409 provider_call_still_active`) — an operator must never close a live call.
- If the poll succeeds, use its result under the §4.3 rules and ignore the operator's requested disposition. The manual disposition applies only when the provider cannot answer (404, or no `retellCallId` at all).
- Age gate: the call must be older than a floor (5 minutes) so the lever cannot race a normal dial.

**Request body:** `{ disposition: 'not_connected' | 'failed', retryTarget: boolean, reason: string (min 20 chars) }`. No free choice of business outcome — `BOOKED`, `NOT_INTERESTED` and `OPTED_OUT` are not offerable, because a human who was not on the call cannot attest to them.

**Effects, in one transaction under `receptionist-call-lifecycle:{tenantId}:{providerCallId|callLogId}`:**
1. Call log → `NO_ANSWER` (not_connected) or `FAILED`, `endedAt = now()`, `outcomeConfidence = 'operator_reconciled'`.
2. Target → `targetStatusAfterOutcome(outcome, attempts, maxRetryAttempts)` if `retryTarget`, else `FAILED` + `lastOutcome = 'OPERATOR_RECONCILED'`.
3. Submission receipt (§3.2) → `convergedAt`, `convergenceSource = 'operator'`.
4. Resolve the related `operationalSignal` rows and complete the related `staffTask` rows — reusing the pattern already written in `applyConfirmedProviderStopTx` (`outbound.ts:239-273`).
5. **No** attempts decrement. The attempt was really spent; the number must stay honest.

**Who may use it.** Not `receptionist:manage` — that is the same permission that dials, and one credential should not both place a call and erase the evidence of it. Two acceptable answers:
- `requireRoles('OWNER', 'ADMIN')` **plus** `receptionist:manage`, matching the composition already used for the two most dangerous outbound routes (`outbound.ts:900`, `1093`); or
- a new `receptionist:call-reconcile` permission in `RECEPTIONIST_PERMISSIONS` (`accessControl.ts:10-16`), grantable to a senior operator without granting dial rights.

I recommend the second. Reconciliation is a distinct capability with a distinct blast radius, and the tenant `RoleDefinition.permissions` override already supports scoping it.

**What it must record.** An `AuditEvent` and a `BusinessEvent`, both mandatory and both *inside* the state transaction (unlike the best-effort observability elsewhere in this file) — because an operator-asserted state change with no record is the one case where the audit trail *is* the evidence:

```
action:   'receptionist.call.operatorReconciled'
resource: 'receptionistCallLog', resourceId: <callLogId>
metadata: {
  campaignId, targetId, providerCallIdMasked,
  priorOutcome, newOutcome, priorTargetStatus, newTargetStatus,
  retryTargetRequested, attemptsRetained,
  providerPollAttempted, providerPollResult,      // 'ended'|'not_connected'|'unavailable'|'no_provider_id'
  providerStatus, providerDisconnectionReason, providerDurationMs,
  attributionEvidence,                             // 'metadata_verified' | 'call_id_only' | 'none'
  reason, actorUserId, occurredAt
}
```

Masked provider id only (`maskProviderId`, `liveCallUat.ts:90-94`), consistent with the rest of the module.

**And a worklist.** `GET …/call-logs?state=unreconciled` (or a Front Desk lane) listing every non-terminal outbound call older than the lease with its age, provider status and last poll result. Today an operator has no way to discover a stuck call except by noticing that dialling has stopped working.

### 5.3 Sequencing

The manual lever is a floor, not the fix. Once the reconciler of §3.3 exists, this endpoint should be needed only for calls where the provider itself has no answer — which is the correct residual scope for a human.

---

## 6. Concurrency and single-active-call

### 6.1 What the two primitives actually measure

```ts
const activeCalls = await tx.receptionistCallLog.count({
  where: { tenantId, outcome: 'IN_PROGRESS', endedAt: null },
});                                                          // outbound.ts:1615-1618
const activeCallLimit = liveTest ? 1 : MAX_TENANT_ACTIVE_CALLS;
if (activeCalls >= activeCallLimit) { … 'concurrency_limit_reached' }   // outbound.ts:1625-1630
```

and for live UAT:

```ts
activeCalls: priorCalls.filter(call => !call.endedAt && call.outcome === 'IN_PROGRESS').length,  // outbound.ts:1593
…
if (usage.activeCalls > 0) return { allowed: false, reason: 'live_test_single_active_call' };    // liveCallUat.ts:163
```

Both count **rows we have not closed**, and call that "calls in flight." Those are the same number only if every row is eventually closed. §1 establishes that they are not. So the limiter measures *unclosed bookkeeping*, and every leak is a permanent, irreversible reduction in the tenant's calling capacity. Leaks are monotonic: nothing ever decrements this.

Three consequences:

- **`live_test_single_active_call` is a one-shot fuse — OR-08.** With a limit of 1, the *first* leak ends the lane. Worse, the UAT admission also counts `attemptsUsed: priorAttempts.length` (`outbound.ts:1591`), so a stuck attempt permanently consumes budget against `LIVE_TEST_MAX_CALLS` even after the concurrency issue is resolved. There is no way to release either.
- **Leaks cross the inbound/outbound boundary — OR-03.** `MAX_TENANT_ACTIVE_CALLS = 25` (`admissionPolicy.ts:40-43`) is enforced against the same undirectioned count on the inbound path (`webhooks.ts:520-527`). 25 leaked outbound rows and every inbound patient hits `concurrency_limit_reached`. That path at least transfers to a human rather than hanging up (`admissionPolicy.ts:96-104` — a genuinely good decision, made after a prior incident where callers were disconnected) — but the AI receptionist the clinic is paying for has silently stopped working, with no alert.
- **The self-healing that does exist is unreachable for outbound.** The lease sweeper (`webhooks.ts:472-503`) is the right idea, in the wrong place (inside inbound admission), with a predicate that excludes exactly the rows that leak (`webhooks.ts:481`).

### 6.2 Is `activeCalls > 0` the right primitive?

**For an attended live-UAT gate: yes, but it needs a release.** "One authorised test call to one authorised number at a time" is a sound rule for calling a real human during a supervised test. What is wrong is not the limit but that it is computed from unbounded state with no expiry. Two changes make it correct: apply the lease (an attempt older than `max_call_minutes + margin` cannot still be active), and let the §5 reconcile lever release an attempt.

**For a real dialler: no.** Three reasons.

1. **It is a liveness question answered with a bookkeeping proxy.** A concurrency limiter must count calls the provider believes are live. Ours counts rows we forgot to close.
2. **It is unbounded in time.** Every real dialler bounds in-flight state by a lease. Ours has one (4 hours) that outbound never reaches.
3. **It conflates two budgets.** Inbound answering capacity is a patient-safety resource — refusing it means a patient does not reach their clinic. Outbound dial capacity is a cost/pacing resource. They should not be able to starve each other, and today outbound starves inbound.

### 6.3 What a real dialler needs

**(a) Lease every in-flight call.** Add `activeLeaseExpiresAt` to `ReceptionistCallLog`, set at reservation (`now + expected_max_call_duration + margin`, using the same `maxCallDurationMs` bound the live-UAT path already sends to Retell at `outbound.ts:2028`), extended by every `ongoing` poll or `call_started`. Count as active only `endedAt IS NULL AND activeLeaseExpiresAt > now()`. This single change makes the limiter self-healing without deciding any call's outcome: an expired lease frees *capacity*, while the reconciler of §3 separately decides the *outcome*. Keeping those two decisions apart is what lets capacity recover fast (minutes) while outcome attribution stays conservative (evidence-driven).

**(b) Separate the budgets.** Distinct inbound and outbound ceilings, with outbound the lower and inbound never reducible by outbound leakage. The comment at `admissionPolicy.ts:36-39` already anticipates the mechanism ("the real fix is a per-tenant `TenantUsageLimit` row"); that row should carry both numbers.

**(c) Pace, don't just cap.** A concurrency cap is the wrong shape for outbound. A dialler needs *rate* (calls started per minute), because 25 simultaneous dials from one clinic number is a carrier-reputation and patient-experience problem long before it is a capacity problem. The infrastructure exists — `server/lib/receptionist/providerRateLimit.ts` and `retellRateStore.ts` — and is not applied to the dial path.

**(d) Make the ceiling observable.** `concurrency_limit_reached` currently produces a 429 and an audit row. It should also raise an `operationalSignal` when the limiter blocks while the *leased* active count is zero — that condition is definitionally a leak, and it is the cheapest possible detector for every failure in §1.

**(e) Reconcile before refusing.** Before returning `concurrency_limit_reached`, sweep this tenant's expired leases inline (as inbound admission already does at `webhooks.ts:472-503`). A tenant should never be told "too many calls in flight" on the strength of rows the system could have closed a moment earlier.

---

## 7. Recommended sequence

| Order | Change | Finding | Effort | Effect |
|---|---|---|---|---|
| 1 | Coerce `''` → `undefined` in the webhook query schema; stop emitting `campaignId=`; move the query parse after signature verification | OR-01 | S | Restores webhook delivery for the default campaign shape — the largest single reduction in leak rate |
| 2 | Three-valued quarantine (§4.3); `not_connected` + `duration_ms: 0` converges | OR-04, OR-12 | S | Makes the existing recovery endpoint work on the population it was built for; unsticks the current incident |
| 3 | Derive webhook outcome from lifecycle + `disconnection_reason`, not from LLM analysis; make `targetStatusAfterOutcome` total | OR-05 | S | Closes the delivered-but-analysis-free leak, and the `IN_PROGRESS`-with-`endedAt` half-state |
| 4 | `activeLeaseExpiresAt` + lease-aware active count + inline sweep before refusing | OR-03, OR-11 | M | Capacity becomes self-healing; inbound stops being starved by outbound |
| 5 | Submission receipt table + `receptionist-outbound-reconcile` worker (§3.2, §3.3) | OR-02, OR-07 | L | Convergence stops depending on the provider choosing to call us |
| 6 | `POST …/reconcile` operator lever + `receptionist:call-reconcile` permission + unreconciled worklist | OR-06 | M | The `CRITICAL` staff tasks the system already creates become actionable |
| 7 | Refuse to dial when the per-call webhook URL is unreachable; record `callbackHost` | OR-09 | S | Removes a silent whole-class outage |
| 8 | Separate inbound/outbound ceilings; apply rate pacing to the dial path | OR-11 | M | Correct dialler shape |
| 9 | Status guard + FK-error mapping on target DELETE | OR-10 | S | Removes a 500 |

Items 1–3 are small, independent, and together address the incident and most of the leak surface. Items 4–6 are the structural fix.

---

## 8. Tests this review implies

The existing suites (`receptionistOutboundTargets.integration.test.ts`, `receptionistP0Reliability.unit.test.ts`, `receptionistProviderIntentCorrelation.unit.test.ts`) cover the authorization boundary thoroughly and the convergence boundary not at all. Missing:

1. Outbound webhook URL built for a campaign with `receptionistCampaignId = null`, replayed against the real route with a valid signature → must be accepted, not 400. *(OR-01 regression)*
2. `call_ended` with no `custom_analysis_data` → call terminal with a non-`IN_PROGRESS` outcome; target released. *(OR-05)*
3. `getPhoneCall` returning `not_connected`, `duration_ms: 0`, empty `metadata`, `agent_id: null` → `provider-sync` converges, target returns to `PENDING`. *(OR-04, the incident)*
4. `getPhoneCall` returning populated metadata naming a **different** tenant → still `409 provider_binding_mismatch`. *(the safety property must survive the fix)*
5. `getPhoneCall` returning `agent_version` different from the submitted version → `provider_deployment_mismatch`, not `provider_binding_mismatch`. *(§4.1)*
6. `status: registered` polled past the 5-minute floor → converges. *(§3.3)*
7. Reconciler idempotency: poll converges, then `call_analyzed` redelivers → one usage event, no outcome downgrade, no double target release.
8. Lease expiry frees concurrency for an outbound row **that has a provider intent**. *(OR-02, the `webhooks.ts:481` exclusion)*
9. 25 leaked outbound rows must not block an inbound patient call. *(OR-03)*
10. Operator reconcile refuses while the provider reports `ongoing`; succeeds on 404; writes audit + business event inside the state transaction. *(§5.2)*

Per the standing testing note in this repo, all of these need isolated tenants — the shared dev DB accumulates rows and every assertion above is a count or state assertion.
