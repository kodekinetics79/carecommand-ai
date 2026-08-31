# Provider test strategy — post-mortem on 14 escaped Retell defects

**Date:** 2026-08-31 · **Branch:** `main` · **Author:** SDET post-mortem
**Merged fixes under review:** PRs #14, #15, #17–#28, #30, #32 (plus #29, #31 which are test-only)

---

## 0. Scope and method

Fourteen defects in the Retell voice-provider integration reached production over two
days. None was caught by the suite. The suite was green throughout.

The suite is not small, and the module is not thinly covered:

| Metric | Count |
|---|---|
| Server test files | 195 |
| Receptionist test files | 63 |
| Receptionist test cases (`it`/`test`/`it.each` sites) | 682 |
| Receptionist test lines | 20,223 |
| `vi.stubGlobal('fetch', …)` sites in Retell-facing suites | 54 |
| Retell response literals in tests (`is_published` occurrences) | 40 |

So this is not a coverage problem. 682 receptionist tests and 20k lines of test code
watched ten provider-contract defects go by. That is a *fidelity* problem, and the
rest of this document is about what fidelity means here and how to buy it cheaply.

Method: read the provider client (`server/lib/retell.ts`), the deploy and verify
services, the simulation, all six Retell-aware test files, and every fix commit from
`2a1fc24` to `0001059`; cross-check each defect against the code that was supposed to
catch it.

---

## 1. Verdict on the root cause

### 1.1 The tautology is real, was worse than stated, and is *not yet fixed*

The hypothesis is confirmed as to fact. `simulatedAgentSnapshot` did answer the
verification probe with the expectation, and `evaluateRetellAgentReadiness` did
compare `x !== x`. PRs #21 and #29 fixed **two** of those fields.

They did not fix the others. Here is the current state of
`server/lib/receptionist/retellSimulatedProvider.ts:329-370` against the nine
readiness gates in `server/lib/retell.ts:1096-1105`:

| Readiness gate (`retell.ts:1269-1290`) | What the simulation answers | Line | Honest? |
|---|---|---|---|
| `version_mismatch` | `deployment.providerAgentVersion`, compared against `pinnedVersion: deployment.providerAgentVersion` (`agentVerification.ts:194`) | `:331` | **NO — `x !== x`** |
| `tag_unassigned` | `[input.versionTag]`, compared against `versionTag` | `:332` | **NO — `x !== x`** |
| `unpublished` | literal `true` | `:333` | **NO — cannot fail** |
| `webhook_mismatch` | `input.webhookUrl`, which is `expectedRetellAgentWebhookUrl()` (`retell.ts:1014`), compared against `expectedRetellAgentWebhookUrl()` (`agentVerification.ts:201`) | `:336` | **NO — `x !== x`** |
| `webhook_events_mismatch` | the three required events, hardcoded | `:337` | **NO — cannot fail** |
| `storage_policy_mismatch` | `'basic_attributes_only'`, the required constant | `:338` | **NO — cannot fail** |
| `signed_url_disabled` | literal `true` | `:339` | **NO — cannot fail** |
| `prompt_drift` | `hashPrompt(engineBody.generalPrompt)` from the remembered write body | `:356` | **YES** (fixed in #29) |
| `tools_drift` | `fingerprintTools(providerStoredTools)` where `providerStoredTools` derives from **`deployment.toolsJson`**, not from the remembered write body | `:305`, `:367-368` | **PARTIAL** |

**Seven of the nine gates that decide whether a clinic's phone line goes live are
still answered with the value they are checked against.** Only `prompt_drift` is
genuinely honest today.

Three further still-standing echoes worth naming:

- `:332 assignedTags: [input.versionTag]` is not merely tautological, it is
  **counterfactual**. Migration `prisma/migrations/20260831140000_receptionist_pinned_verification/migration.sql`
  states the live fact plainly: *"Retell also exposes no public tag-assignment write,
  so an agent CareCommand deploys comes back with `assigned_tags: []`."* The
  simulation has been inventing a tag the provider cannot assign. That single line is
  why defect 8 — a `CHECK` constraint demanding
  `providerAssignedTags @> ARRAY[providerVersionTag]` — could never fire in test and
  fired as a 500 on the first real verification. The migration comment says so
  itself: *"which is why this has never fired before: nothing had ever got far enough
  to write VERIFIED."*
- `:343 responseEngineGraphFingerprint` and `:346 bookToolFingerprint` are derived
  from `deployment.promptHash` / `deployment.toolFingerprint` / `deployment.toolsJson`
  — the expectations. `agentVerification.ts:262-263` uses exactly those two fields to
  decide `deploymentChanged`, i.e. "the provider was changed underneath us". That
  detector is tautological in mock mode.
- `:137` stores `general_tools` from the engine write body into the simulation's
  memory. **Nothing ever reads it.** `:305` reaches for `deployment.toolsJson`
  instead. The honest source is already being captured and then ignored.

### 1.2 Two gates are not evaluated at all

`evaluateRetellAgentReadiness` (`retell.ts:1269-1290`) never compares
`snapshot.beginMessageHash` or `snapshot.voiceId` / `snapshot.language` against
anything. Both the live probe (`retell.ts:850`) and the simulation (`:357`) compute
`beginMessageHash`; `providerSnapshotData` (`agentVerification.ts:81-103`) does not
persist it; nothing asserts on it. The begin message is **the first sentence a
patient hears**. It can drift at the provider today and every check stays green.

Same for the voice: `deploymentChanges()` (`retellDeploy.ts:141-146`) tracks a voice
change on our side, but no readiness gate re-reads it from the provider.

### 1.3 But the tautology is a symptom. The cause is *coincidental identity in fixtures*

Naming the mock as the root cause explains at most six of the fourteen defects and
would send the team to fix one file. The generative defect is broader and shows up
in four different places, only one of which is the mock:

> **Every fixture in this module makes two genuinely distinct things identical, so
> the code that distinguishes them was never executed.**

| # | Defect | The two things the fixture made identical | Where |
|---|---|---|---|
| 1 | Audit write 500s the call | "platform DB configured" vs "not configured" — `server/test/setupPlatformDatabase.ts:12` sets `PLATFORM_DATABASE_URL` unconditionally for **every** server test | test setup |
| 2 | Ingress resolves on `phone` | `inboundNumber` vs `phone` — the introducing migration backfilled one from the other, so *"the two are identical on every existing row and nothing could show the gap"* (`prisma/migrations/20260831130000_.../migration.sql:12-14`) | schema + seed |
| 3 | Empty tag metadata | "a tag we asked about" vs "a sibling tag" — every list-agents stub emitted `{ version, dynamic_variables }`, never `{}` | 4 HTTP stubs |
| 4/6/10 | Publish freezes / tag edit nulls the pin | "first deploy" vs "second deploy" — see §1.4 | simulation state |
| 5 | Engine version pinned | agent version vs engine version — **both are 0 on a first deploy** | deploy fixture |
| 7 | Permanent `tools_drift` | "what we authored" vs "what the provider stored" — the mock echoed, and so did every HTTP stub | mock + stubs |
| 8 | CHECK on assigned tags | "a tag we assigned" vs "a tag the provider assigned" | mock `:332` |
| 9 | `format: 'email'` stripped | authored schema vs stored schema; **and** the default prompt fixture configures no `EMAIL` field at all, so the failing type was never compiled | fixture + stubs |

Defects 1 and 2 are not provider-contract defects at all — they are the same
coincidental-identity failure in the test environment and in the database backfill.
That is the strongest evidence that the mock is a symptom: the identical failure mode
produced defects in three subsystems that share no code with `retellSimulatedProvider.ts`.

**Verdict: the tautological mock is the proximate cause of defects 7 and 8 and a
contributing cause of 3, 4, 5, 6, 9 and 10. It is not the root cause. The root cause
is that this module's fixtures are constructed by copying the expectation, and no
mechanism exists that would make a fixture disagree with us.**

### 1.4 Refuting "NO test in the repo deployed twice"

This claim is **false**, and the correction matters because it changes the fix.

Three tests deployed the same campaign twice, successfully, and were green
throughout the incident. All three predate PR #14:

| Test | Second deploy | Introduced by |
|---|---|---|
| `server/test/receptionistDeployIntegrity.integration.test.ts:345` → `:366` | after a pause | `1394987` (pre-#14) |
| `server/test/receptionistCampaignReadiness.integration.test.ts:421` → `:432` | "self-resets on every redeploy" | `b08a6b7` (pre-#14) |
| `server/test/receptionistReadinessContract.test.ts:142` → `:478` | "is invalidated by the next deploy" | `c0f09e5` (pre-#14) |

All three ran against the simulated provider. At `5205374^`, that simulation's
publish was:

```ts
function simulatedPublishAgent(_agentId: string, version: number) { … }
```

`_agentId` — publishing had **no effect on any state**. `updateLlm` never refused;
`updateAgent` always returned success; no version ever advanced. So the second
deploy was byte-for-byte indistinguishable from the first.

The accurate statement is:

> **No test had ever deployed twice against a provider model that has lifecycle
> state. Deploying twice against a stateless model is the same as deploying once.**

And the accurate statement is *still true today for the live-HTTP path.* Look at the
frozen-engine test added by PR #18
(`receptionistDeployIntegrity.integration.test.ts:453-496`) — the best second-deploy
HTTP test in the tree:

```ts
if (value.startsWith('/create-agent') || value.startsWith('/update-agent/')) {
  return new Response(JSON.stringify({ agent_id: agentId, version: 0 }), { status: 200 });
}
if (value.startsWith('/get-agent/')) {
  return new Response(JSON.stringify({ agent_id: agentId, version: 0, is_published: true }), { status: 200 });
}
```

`version: 0` on both deploys. Against the real provider the second deploy yields
agent version 1, and `publishRetellAgent` (`retell.ts:1530-1548`) then reads back
`get-agent?version=1` and refuses anything else. **Every HTTP stub in the tree is
stateless and pinned at version 0**, so no HTTP-stub test can tell a first deploy
from a second — which is exactly the seam defects 5, 6 and 10 lived in.

### 1.5 Assessing the #29 redeploy test

`receptionistDeployIntegrity.integration.test.ts:658-745` is a good test. It is the
first four-step deploy→verify→deploy→verify in the repo, it asserts the version
advance, the new engine, the SUPERSEDED predecessor, the read-back binding at version
1, and the pinned attestation. Keep it.

It is **not adequate**, for three reasons:

1. It runs `useMockProvider()` (`:671`). It therefore exercises the simulation's model
   of Retell, not `agentRequestBody`, not the `/publish-agent` + version read-back in
   `publishRetellAgent`, not `probeRetellEmptyTagDefaults`, not any HTTP parsing.
   Defects 3, 5, 9 and 10 all live on the code it skips.
2. It inherits the seven tautological gates from §1.1. The second verify passes for
   the same reason the first did.
3. It stops at two. `retellDeploy.ts:381` reads `priorAgentVersion` from
   `latest?.providerAgentVersion ?? priorEngine?.providerAgentVersion ?? 0` — a
   three-way fallback whose second and third branches are still unexercised.

### 1.6 Quantifying the stubs

There is **no shared description of the Retell API anywhere in this repo.** There are
twelve independent ones:

| # | Location | Endpoint(s) modelled | Diverges from the real API |
|---|---|---|---|
| 1 | `server/lib/receptionist/retellSimulatedProvider.ts:288-371` | the whole snapshot | 7/9 readiness gates echoed; `assignedTags` invented (real: `[]`) |
| 2 | `server/test/receptionistAgentProvider.unit.test.ts:29-45` `providerAgent()` | `get-agent` | `assigned_tags:['prod']` (legitimate for BYO, reused for deployed agents) |
| 3 | `server/test/receptionistAgentProvider.unit.test.ts:47-64` `listedProviderAgent()` | `v2/list-agents` | tag metadata always complete |
| 4 | `server/test/receptionistConfiguration.integration.test.ts:49` `listedRetellAgent()` | `v2/list-agents` | tag metadata always complete |
| 5 | `server/test/receptionistConfiguration.integration.test.ts:415-451` | `get-agent`, `get-retell-llm`, `get-phone-number` | echoes authored tools; `assigned_tags:['prod']` |
| 6 | `server/test/receptionistConfiguration.integration.test.ts:808-820` | `get-agent` | same |
| 7 | `server/test/receptionistConfiguration.integration.test.ts:843-855` | `get-agent` | same |
| 8 | `server/test/receptionistConfiguration.integration.test.ts:1053-1063` | `get-agent`, `get-retell-llm` | same |
| 9 | `server/test/receptionistDeployIntegrity.integration.test.ts:126-180` `stubLiveProvider` | full deploy + verify | `general_tools: options.tools()` fed `row.toolsJson` (`:274`, `:318`) — **echoes the expectation exactly as the mock did**; `assigned_tags:['prod']`; version pinned at 0; publish is a no-op |
| 10 | `server/test/receptionistDeployment.integration.test.ts:251-278` | full deploy + verify | `generalTools = row.toolsJson` (`:290`) — same echo; version pinned at 0 |
| 11 | `server/test/receptionistDeployment.integration.test.ts:414-424` | write sequence | version pinned at 0 |
| 12 | `server/test/receptionistDeployIntegrity.integration.test.ts:453-477` | second deploy | version pinned at 0 on both deploys |

**Every one of the twelve is wrong about at least one thing the real API does.**
The three that matter most:

- **8 of the 12 model a `get-agent` response, and all 8 hardcode
  `assigned_tags: ['prod']`** (rows 1, 2, 5, 6, 7, 8, 9, 10) for agents CareCommand
  deployed, where the provider returns `[]`.
- **All 4 `v2/list-agents` stubs that predate the incident** (rows 3, 4 and the inline
  ones inside rows 9 and 10) emit complete tag metadata; the provider returns
  `tags: { staging: {}, prod: {} }` (defect 3). The only two stubs that model the real
  shape were added by the fix itself (`a7b3e33`).
- **2 of 2 deploy-path stubs that answer `get-retell-llm` echo `row.toolsJson`
  verbatim.** The tautology the post-mortem attributes to the simulation is *equally
  present in the HTTP stubs*, and was never fixed there. Fixing
  `retellSimulatedProvider.ts` alone leaves `tools_drift` undetectable on the live
  code path.

Note the process shape: each of the fourteen fixes added another bespoke literal
(e.g. `a7b3e33` added two more list-agents shapes to `receptionistAgentProvider.unit.test.ts`).
The count is going **up**, and each new one is a fresh opportunity to be wrong.

---

## 2. The contract-testing gap

### 2.1 What exists, and what is missing

The repo already got the *request* half right.
`server/lib/receptionist/retellRequestContract.ts` is a hand-written mirror of what
Retell **accepts**, extracted so that the simulation and the deploy suites hold the
real payload against the real rules. Its header even records the lesson
(`:12-27`): *"A simulator that cannot say no is not a test double, it is a way of not
testing."* It was written after a live 400 on `general_tools/0/type`.

**The response half does not exist.** Nothing describes what Retell **stores and
returns** given what we wrote. That is precisely the surface all ten
provider-contract defects landed on:

- adds `speak_after_execution` on write (defect 7)
- drops empty collections — `required: []` inside `parameters` (defect 7)
- strips keywords outside the strict structured-output subset — `format`, `readOnly` (defect 9)
- returns `assigned_tags: []` for agents it did not tag (defect 8)
- returns `tags: { staging: {} }` for tags without version metadata (defect 3)
- freezes the engine on publish (defect 4)
- requires `response_engine.version == agent version` (defect 5)
- `/publish-agent-version/` freezes the entity; `/publish-agent/` does not (defect 10)

Every one of these is a *stored/returned* fact. None is expressible in
`retellRequestContract.ts`.

There is also a second-order problem: the one place that now encodes the strict
subset is a hand-written allowlist inside a test —
`server/test/receptionistIntakeContract.unit.test.ts`, `KEPT_BY_PROVIDER`. It is
correct today because someone read a live 400. Nothing keeps it correct, and its own
comment concedes the point: *"Adding to that list means confirming against the live
provider that the keyword survives a write, not assuming it will."* There is no
mechanism to do that confirming.

### 2.2 Proposed mechanism — three parts, no new infrastructure

Everything below uses tooling already in the repo: `vitest`, the TypeScript compiler
API (already used by `receptionistVendorNeutrality.lint.test.ts`), a JSON fixture
directory (already used by `retellVoices.mock.json`), and the `RUN_LIVE_VOICE_UAT`
opt-in pattern (already used by `tests/e2e/receptionist-live-uat.spec.ts` and
`package.json:test:e2e:live-voice`).

#### Part A — `retellStoredContract.ts`: the response-side twin

**New file:** `server/lib/receptionist/retellStoredContract.ts`

The mirror image of `retellRequestContract.ts`. One exported function:

```ts
/** What Retell STORES for a tool we authored. Confirmed against the live account. */
export function retellStoredTool(authored: Record<string, unknown>): Record<string, unknown>;
export function retellStoredTools(authored: unknown[]): unknown[];

/** The strict structured-output keyword subset the provider keeps on write. */
export const RETELL_STRICT_SCHEMA_KEYWORDS: ReadonlySet<string>;
```

It implements exactly three transformations, each with a dated live-account citation
in a comment, in the same register as `retellRequestContract.ts`:

1. add write-time defaults (`speak_after_execution: false` when absent);
2. drop empty collections (`required: []`, `properties: {}` → absent) at any depth;
3. strip any schema keyword outside `RETELL_STRICT_SCHEMA_KEYWORDS`.

Then:

- `retellSimulatedProvider.ts:309-312` calls it instead of its one-line
  `{ speak_after_execution: false, ...row }`;
- the shared test stub (Part B) calls it;
- `receptionistIntakeContract.unit.test.ts`'s `KEPT_BY_PROVIDER` is **deleted** and
  the test imports `RETELL_STRICT_SCHEMA_KEYWORDS` — one definition, two consumers,
  no drift.

Cost: ~90 lines + comments. Payoff: `format: 'email'` reintroduced anywhere fails
*every* deploy→verify integration test, not just one unit test with a bespoke list.

#### Part B — recorded fixtures and one stub factory

**New directory:** `server/lib/receptionist/fixtures/retell/`

Captured from a real sandbox account, one JSON file per interesting response, each
wrapping the raw body with provenance:

```
get-agent.deployed.json        { "_endpoint": "GET /get-agent/{id}?version=1",
                                 "_capturedAt": "2026-08-31", "_account": "sandbox",
                                 "body": { …, "assigned_tags": [], … } }
get-agent.byo.json             tag-routed hand-linked agent, assigned_tags: ["prod"]
get-agent.after-publish.json   the N+1 unpublished draft the entity read reports
v2-list-agents.json            tags: { staging: {}, prod: { version, dynamic_variables: {} } }
get-retell-llm.json            what the provider STORED
create-retell-llm.request.json what we SENT for the above  ← the pair is the contract
update-agent.published.json    the 400 body for a published-version write
update-retell-llm.published.json  "Cannot update published LLM"
get-phone-number.json
```

The paired `*.request.json` / stored-response files are the mechanism that makes
normalisation *visible*: a diff between them is the provider's write-time behaviour,
reviewable without reading code.

**New file:** `server/test/helpers/retellProviderStub.ts`

One factory replacing all 54 ad-hoc `vi.stubGlobal('fetch', …)` sites in the six
Retell-facing suites:

```ts
export function retellStub(options?: {
  onCreateAgent?: (n: number) => Partial<AgentBody>;   // per-call overrides
  tools?: 'stored' | ((authored: unknown[]) => unknown[]);
  binding?: () => { agentId: string | null; version: number | null } | 'unavailable';
}): { calls: RecordedCall[]; state: ProviderState };
```

Three properties the ad-hoc stubs lack:

1. **It is stateful.** `create-*` returns version 0; `update-*` returns
   `previous + 1`; `publish-agent` freezes the engine and marks the version
   published; `get-agent?version=N` answers only for versions that exist;
   `update-retell-llm` on a published engine returns the recorded 400.
2. **It normalises.** `get-retell-llm` answers `retellStoredTools(whatWasWritten)` —
   never the deployment row, never `options.tools()`.
3. **It is built from the fixtures**, so its base shape cannot silently disagree with
   the recorded account (`assigned_tags: []` by default; you opt into `['prod']` for a
   BYO scenario).

Migration is mechanical and can be done file by file; a stub that needs one field
different passes an override rather than re-describing the whole response.

#### Part C — an on-demand conformance suite against the live sandbox

**New file:** `server/test/receptionistRetellConformance.live.test.ts`
**New script:** `"test:retell:conformance": "RUN_RETELL_CONFORMANCE=true vitest run server/test/receptionistRetellConformance.live.test.ts"`

Gated exactly as the live-voice UAT is:

```ts
const RUN = process.env.RUN_RETELL_CONFORMANCE === 'true';
it.skipIf(!RUN)('…', …)
```

It performs one full cycle against a sandbox Retell account and asserts the eight
facts the fixtures encode — not our behaviour, *the provider's*:

| Assertion | Would have caught |
|---|---|
| `create-retell-llm` then `get-retell-llm` — stored tools equal `retellStoredTools(sent)` | 7, 9 |
| an agent we created reports `assigned_tags: []` | 8 |
| `v2/list-agents` tag metadata shape for a tag without a version | 3 |
| `update-retell-llm` on a published engine → 400 `Cannot update published LLM` | 4 |
| `update-agent` with `response_engine.version` set → 400 version-mismatch | 5 |
| `POST /publish-agent/{id}` then `PATCH /update-agent/{id}` → 200 | 10 |
| `POST /publish-agent-version/{id}` then `PATCH` → 422 | 10 |
| after `/publish-agent`, the entity read reports `version = N+1, is_published: false` | 10 |

Run it before any release that touches the deploy path, and on a weekly cron. It is
slow, it costs a few provider calls, and it must never be in `npm test`. When it
fails, it fails with the fixture that is now wrong — and updating the fixture is the
fix, which propagates to the simulation and to all 54 stubs at once.

**New script:** `server/scripts/captureRetellContract.ts` (`npm run retell:capture`)
runs the same cycle and *writes* the fixtures. Refuses unless
`RETELL_CONTRACT_CAPTURE=true` and the key is a sandbox key. This is what makes the
fixtures re-derivable instead of hand-maintained.

#### Part D — the lint that stops the simulation echoing expectations

**New file:** `server/test/receptionistProviderSimulationHonesty.lint.test.ts`

The repo already parses its own source with the TypeScript compiler API for exactly
this kind of ratchet (`receptionistVendorNeutrality.lint.test.ts` imports `typescript`
and walks string literals by field name). Reuse that.

The rule: find the object literal returned by `simulatedAgentSnapshot` in
`server/lib/receptionist/retellSimulatedProvider.ts`; for each property, walk the
initializer; **fail if it reads from the `deployment` parameter, from `input.webhookUrl`,
or is a literal equal to a constant that `evaluateRetellAgentReadiness` compares it
against** — unless the property name is in an explicit allowlist:

```ts
// A field may answer from the expectation ONLY when it is the STABLE IDENTITY of the
// published version rather than a claim about it. Each entry needs a written reason.
const IDENTITY_FIELDS = new Map([
  ['fingerprint', 'the identity of the published version; deriving it from the write cache would flip on a cold process'],
  ['agentId',     'the id we asked about'],
]);
```

Adding a field to that map is a code review with a sentence attached. Adding one
silently is a failing test. This is the mechanism that would have made the original
`promptHash: deployment.promptHash` unmergeable.

A companion assertion in the same file catches the *test-side* version of the same
sin: grep the six Retell-facing suites for a `get-retell-llm` handler whose
`general_tools` reads from `toolsJson` or `promptText`, and fail. That is exactly
`receptionistDeployIntegrity:274/318` and `receptionistDeployment:290`, both still
live today.

---

## 3. The "never ran twice" class

A systematic inventory of lifecycle operations across the whole test tree. Verdict is
"twice" only when a single test case invokes the operation twice against the **same
entity**.

### 3.1 Already covered twice (do not add work here)

| Operation | Evidence |
|---|---|
| Deploy | `receptionistDeployIntegrity.integration.test.ts:345`+`:366`, `:408`+`:420`, `:483`+`:490`, `:562` (concurrent), `:677`+`:699`; `receptionistCampaignReadiness.integration.test.ts:421`+`:432`; `receptionistReadinessContract.test.ts:142`+`:478` |
| Verify | `receptionistDeployment.integration.test.ts:291`+`:297`; `receptionistDeployIntegrity.integration.test.ts:276`+`:289`, `:319`+`:323`, `:685`+`:719` |
| Reverification worker pass | `receptionistReverification.integration.test.ts:118`, `:131`, `:132` (three passes) |
| Confirmation outbox drain | `receptionistConfirmationOutbox.integration.test.ts:156`+`:192`, `:320`+`:325`, `:334`+`:341`+`:345` |
| Inbound webhook replay | `receptionistInboundBootstrap.integration.test.ts:119`+`:120` (byte-identical `call_started`); full ordered sequence `:448`→`:451`→`:455`→`:460` |
| Booking replay / reconcile | `receptionistBooking.integration.test.ts:462`, `:602`+`:608`, `:633`+`:665`; `receptionistCanonicalLifecycle.integration.test.ts:65` |
| Stripe webhook replay | `payments.integration.test.ts:139`+`:150`, `:196`+`:198` (concurrent), and ~8 more pairs — the best-covered idempotent path in the repo |
| Campaign dispatch | `campaignDispatchFence.integration.test.ts:275`+`:280`, `:245`+`:246` |
| Campaign attribution re-run | `campaignAttribution.integration.test.ts:120`+`:146` |
| Autopilot action execute | `worker.integration.test.ts:160`+`:161` (`already_executed`) |
| Outbound call retry / verify-clear | `receptionistOutboundTargets.integration.test.ts:2062`+`:2085`, `:2021`+`:2033` |
| Pause / archive | `receptionistDeployment.integration.test.ts:608`/`:612`/`:616`/`:620` |

The "run it twice" discipline is genuinely well established in this codebase. That is
what makes §1.4's correction important: the deploy path *was* run twice, against a
model with no state. **Repetition without a stateful counterparty is not repetition.**

### 3.2 Never run twice — ranked by defect-class exposure

| Rank | Operation | Evidence of single invocation | Why it is exposed |
|---|---|---|---|
| 1 | **Deploy against an HTTP stub whose version advances** | every HTTP stub returns `version: 0` unconditionally (`receptionistDeployIntegrity:453-477`, `receptionistDeployment:414-424`, `:508-517`) | the exact seam of defects 5, 6, 10. `publishRetellAgent` (`retell.ts:1543-1546`) refuses a version the provider does not confirm — untested for any N>0 |
| 2 | **`POST /campaigns/:id/activate` on an already-ACTIVE campaign** | `receptionistCampaignReadiness:271,449,461,513,541,578`; `receptionistDeployment:576,602`; `receptionistDeployIntegrity:352` — all one-per-test | activation writes agent state; a double-activate is a plausible double-click |
| 3 | **`POST /crm/campaigns/:id/launch` on a launched campaign** | `campaignScopeDispatch:114,211,287`; `campaignScopeAuthority:178,240,298` — the `:148`/`:166` pair is two *different* campaigns | a re-launch is the money path; nothing tests the transition guard |
| 4 | **`runTenantComplianceJob` ticked twice** | `receptionistReverificationWorker.test.ts:50`, `:71`; `receptionistConfirmationWorker.test.ts:37` | BullMQ redelivers. The *body* is idempotent (§3.1); the *entrypoint* wrapper, including tenant-context acquisition, is not tested for redelivery |
| 5 | **`reconcileStrandedAutopilotDispatches` / `reconcileQueuedAutopilotDispatch`** | `autopilotRecovery.integration.test.ts:55`, `:129`, `:148`, `:177` — one pass, ever | a recovery pass that is not idempotent doubles the damage it exists to repair |
| 6 | **`createSafetyTask` with the same `(callId, kind)`** | every double call varies kind or callId: `frontDeskSafetyClosure:195`+`:196`, `frontDeskBoardCounts:129`+`:130`, `:223`–`:225` | a replayed safety webhook duplicates a clinical-safety task on the board |
| 7 | **`updatePhoneNumberInboundAgent` with the same number + agent** (`retell.ts:1577`) | no test invokes the WRITE twice; the four binding tests in `receptionistDeployConflicts.unit.test.ts:105,110,117,122` are all read-side (`phoneNumberBinding`) and all one-shot | a retried bind must be a no-op, not a rebind |
| 8 | **`POST /outbound-campaigns/:id/launch-attempts`** | `receptionistOutboundTargets:1968`, `:1998` | duplicate attempt-token registration untested |
| 9 | **`publishRetellAgent` at the adapter level** | `receptionistAgentProvider.unit.test.ts:1032`, `:1078` — separate tests, never the same agent twice | `/publish-agent-version/` is only asserted *absent* (`:1037`), never invoked |

### 3.3 One dead export found in passing

`reconcileStaleEligibilityExecutions` (`server/lib/eligibilityExecution.ts:343`) has
**zero callers** — no test, no worker, no route. Either wire it up or delete it; an
unreferenced reconciler is worse than none because the checklist reads as if
reconciliation happens.

---

## 4. Prioritised test strategy

Ordered by defects-prevented per hour. P0 is roughly two days of work and closes the
whole class.

### P0-1 — Make the simulation answer from what it was written (not from the expectation)

**Change:** `server/lib/receptionist/retellSimulatedProvider.ts`

Extend `rememberAgentVersion` (`:143-150`) to keep the whole agent write body — it
currently keeps only `llm_id` — and answer `:331-342` from it. Read `engineBody.tools`
(already stored at `:137`, never read) instead of `deployment.toolsJson` at `:305`.
Return `assignedTags: []` for deployed agents, matching the provider.

**Also change:** `server/lib/retell.ts:1269-1290` to compare `beginMessageHash` and
the provider-reported `voiceId`/`language`, with new failure codes
`begin_message_drift` and `voice_drift`; persist `providerBeginMessageHash` in
`agentVerification.ts:81-103`.

**Test:** `server/test/receptionistProviderSimulationHonesty.unit.test.ts` — for each
of the nine gates, deploy through the simulation, mutate one provider-side value, and
require the matching failure code. Nine assertions, one loop.

**Would have caught:** defects 7, 8. **Would now catch:** prompt drift, begin-message
drift, voice drift, tag drift, webhook drift, storage-policy drift, signed-URL drift
— seven gates that are currently unfalsifiable.

### P0-2 — `retellStoredContract.ts` + delete the duplicate keyword list

**New:** `server/lib/receptionist/retellStoredContract.ts` (§2.2 Part A).
**Change:** `retellSimulatedProvider.ts:309-312` to call it.
**Change:** `server/test/receptionistIntakeContract.unit.test.ts` to import
`RETELL_STRICT_SCHEMA_KEYWORDS` and delete its local `KEPT_BY_PROVIDER`.

**Would have caught:** defect 9 (`format: 'email'`) — end to end, in every
deploy→verify integration test, rather than in one unit test with a hand-written
list. Also defect 7's empty-collection half.

### P0-3 — The honesty lint

**New:** `server/test/receptionistProviderSimulationHonesty.lint.test.ts` (§2.2 Part D).

**Would have caught:** the original `promptHash: deployment.promptHash` at review
time, and the three echoes still standing today. This is the only item here that
prevents *recurrence* rather than repeating the last fix.

### P1-1 — One stateful, fixture-backed stub factory

**New:** `server/test/helpers/retellProviderStub.ts` (§2.2 Part B).
**New:** `server/lib/receptionist/fixtures/retell/*.json`.
**Change:** migrate the 54 stub sites in `receptionistAgentProvider.unit`,
`receptionistConfiguration.integration`, `receptionistDeployIntegrity.integration`,
`receptionistDeployment.integration`, `receptionistP0Reliability.unit`,
`receptionistSimulatedProviderFence.unit`.

**Would have caught:** defects 3 (fixture carries `tags: { staging: {} }` by
default), 7 and 9 (stub normalises instead of echoing), 8 (`assigned_tags: []` by
default).

### P1-2 — Deploy three times against the stateful HTTP stub

**New test in** `server/test/receptionistDeployIntegrity.integration.test.ts`:
deploy → verify → deploy → verify → deploy → verify against `retellProviderStub()`,
asserting agent versions 0, 1, 2; a fresh engine each time; `publishRetellAgent`
confirming each version by read-back; the phone binding following each version.

Three, not two: `retellDeploy.ts:381`'s `latest ?? priorEngine ?? 0` fallback needs a
third data point to be exercised.

**Would have caught:** defects 4, 5, 6, 10 — on the live code path, which the #29
test does not touch.

### P1-3 — Live conformance suite + capture script

**New:** `server/test/receptionistRetellConformance.live.test.ts`,
`server/scripts/captureRetellContract.ts`, two `package.json` scripts (§2.2 Part C).

**Would have caught:** all eight provider-fact defects, at the moment someone chose
to encode an assumption. More importantly it is the only proposal here that catches
the *next* provider change, which is the one we have no fix commit for yet.

### P2-1 — Close the six single-invocation lifecycle gaps

Cheap, mechanical, one assertion each:

| Test file | Add |
|---|---|
| `server/test/receptionistCampaignReadiness.integration.test.ts` | activate an already-ACTIVE campaign → 409, no state change |
| `server/test/campaignScopeDispatch.integration.test.ts` | launch an already-launched CRM campaign → refused |
| `server/test/receptionistReverificationWorker.test.ts` | tick `runTenantComplianceJob` twice → one effect |
| `server/test/autopilotRecovery.integration.test.ts` | second recovery pass → no further mutations |
| `server/test/frontDeskSafetyClosure.integration.test.ts` | `createSafetyTask` twice with the same `(callId, kind)` → one task |
| `server/test/receptionistAgentProvider.unit.test.ts` | `updatePhoneNumberInboundAgent` twice, same target → second is a no-op |

### P2-2 — Break the two remaining environment degeneracies

1. `server/test/setupPlatformDatabase.ts:12` sets `PLATFORM_DATABASE_URL` for every
   server test. Add **one** suite that runs without it and asserts the
   clinic-facing routes still serve — the generalisation of
   `receptionistIngressAuditResilience.integration.test.ts`, which mocks the module
   rather than removing the variable. **Would have caught defect 1.**
2. `prisma/synthetic/receptionistDemo.ts` and the test clinic factories should set
   `inboundNumber !== phone` by default, so the two columns are never
   coincidentally equal again. **Would have caught defect 2.**

Point 2 is the highest-leverage line in this document per character changed: one
seed value, and a class of "we read the wrong column" defects becomes visible.

### Summary — defect-by-defect coverage after P0+P1

| # | Defect | Caught by |
|---|---|---|
| 1 | audit write 500s the call | P2-2.1 |
| 2 | ingress on `phone` not `inboundNumber` | P2-2.2 |
| 3 | empty tag metadata | P1-1 (fixture default) |
| 4 | published engine frozen | P1-2 (stateful stub) |
| 5 | `response_engine.version` pinned | P1-2, P1-3 |
| 6 | tag edit nulls `currentDeploymentId` | P1-2 |
| 7 | permanent `tools_drift` | P0-1, P0-2 |
| 8 | CHECK on `providerAssignedTags` | P0-1 (`assignedTags: []`) |
| 9 | `format: 'email'` stripped | P0-2 |
| 10 | `/publish-agent-version/` freezes | P1-2, P1-3 |
| — | prompt / begin-message / voice / webhook / storage drift | P0-1 |
| — | *the next* provider change | P1-3 |

---

## 5. What is NOT worth testing

This is a small team. The following are things a thorough post-mortem would normally
demand and that I recommend **against**.

**Do not chase Retell's full response schema.** `retellRequestContract.ts` already
declines to guess at rules no live response has demonstrated (`:29-36`), and it is
right. Model only the behaviours we have a dated 400 or a captured response for.
An invented rule is the same defect as an invented tag, pointing the other way.

**Do not build a record-and-replay HTTP proxy (VCR/Polly/nock cassettes).** The
twelve stubs need *state* and *normalisation*, not traffic capture. Replayed cassettes
give you the same "version 0 forever" problem in a heavier package, and they rot
invisibly. Ten hand-curated JSON fixtures plus one stateful factory are smaller,
readable in review, and re-derivable by `npm run retell:capture`.

**Do not put the conformance suite in CI on every PR.** It costs provider calls,
needs a sandbox key in CI, and will flake on provider maintenance. Pre-release and
weekly is the right cadence. A flaky gate that people learn to re-run is worse than
no gate.

**Do not test the simulation's memory eviction.** `SIMULATED_MEMORY_LIMIT`
(`retellSimulatedProvider.ts:100`) and `boundMemory` are demo-profile-only, and the
cold-memory path already has the only assertion that matters — it answers `null`, not
"matches" (`receptionistAgentProvider.unit.test.ts:875`).

**Do not add a fourth and fifth deploy.** Three exercises the fallback chain. Beyond
that you are testing arithmetic.

**Do not write per-defect regression tests for the ten provider-contract defects.**
That is the trap this module is already in: fourteen fixes produced fourteen bespoke
literals and the count of independent provider descriptions went from ten to twelve.
Every per-defect test written in the last two days should be *reduced* once P0-1 and
P1-1 land — the honest simulation and the fixture-backed stub subsume most of them.
Deleting a test whose invariant is now enforced structurally is a net gain.

**Do not chase the frontend contract here.** `receptionistFixtureContract.unit.test.ts`
already parses the browser fixtures with the server's own schemas. That half is
solved; none of the fourteen defects was a UI-contract defect.

**Do not build a mutation-testing rig.** It would find the tautologies — and so does
one 60-line lint that runs in milliseconds. Buy the lint.

---

## 6. The one-sentence version

The suite tested that CareCommand is internally consistent, using fixtures
CareCommand wrote from its own expectations, against a provider model with no state —
so it could confirm every assumption and falsify none. The fix is not more tests; it
is three artefacts that can disagree with us: a stored-response contract, recorded
fixtures with a stateful stub, and a lint that refuses to let the simulation answer
with the expectation.
