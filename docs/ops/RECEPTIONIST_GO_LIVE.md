# Taking the AI Receptionist live on a number

What has to be true, in the order it has to become true, before a patient can
dial a clinic and reach the receptionist. Every claim here is grounded in the
code path named beside it; nothing is aspirational.

Written 2026-08-30 against the state of `main` after the ingress and audit
fixes. It exists because the module had a deploy path, a verification path and
a 21-item readiness gate, and no document that said what an operator does with
them in what order.

---

## 0. The ordering rule that costs the most to get wrong

**Set `PUBLIC_API_URL` to its final value before attesting the intake contract
or deploying.**

`expectedRetellToolUrl()` (`server/lib/retell.ts`) derives every per-clinic tool
URL from `PUBLIC_API_URL`, and that URL is part of the canonical booking
contract that gets fingerprinted (`normalizeBookAppointmentToolContract` →
`fingerprintJson`, `server/modules/receptionist/intakeContract.ts`). Change the
host afterwards and the fingerprint changes, which invalidates the attestation
and the deployment together — `intake_attested` and `deployment_current` both
stop passing, and the clinic has to re-attest and redeploy.

One canonical hostname, set everywhere, before anything is attested.

## 1. Environment

| Variable | Must be | Why |
|---|---|---|
| `PUBLIC_API_URL` | the canonical public HTTPS host, identical on **every** runtime that serves `/v1` | Source of the agent webhook URL and all tool URLs. Verification compares by strict equality. |
| `PLATFORM_DATABASE_URL` | set | `platformDb` throws outright when it is unset. Since the audit-write fix a call survives that, but the audit row is silently lost. |
| `RETELL_API_KEY` | a key with **Agent.Write** | Deploy creates an LLM, creates an agent, publishes a version and binds a number. Read-only keys pass `list-agents` and fail at step 1. |
| `RETELL_FROM_NUMBER` | the provider number | Outbound caller ID **only**. It has no say in who answers an inbound call. |
| `DEPLOYMENT_PROFILE` | `demo` for rehearsal, `pilot` for a real clinic | Under `demo` the guardrails in `server/config/env.ts` are not enforced and mock payments/insurance/AI are allowed unacknowledged. Voice is *not* mocked unless the key literally starts with `mock`. |

If more than one runtime serves `/v1` for the same domain, they must agree on
all of the above. They share one database, so a mismatch does not fail loudly —
it makes behaviour depend on which process caught the request.

## 2. What actually maps a caller to a clinic

`app_resolve_ingress_tenant('retell_destination_phone', <dialled number>)`
matches `COALESCE(NULLIF(btrim("inboundNumber"), ''), phone)` on **active**
clinics of **active** tenants, and returns a tenant only when exactly one clinic
matches.

- `inboundNumber` — the provider-owned DID the clinic answers on. This is what
  deploy binds and what verification re-reads.
- `phone` — the public number the agent *speaks*. Used as the destination only
  when no DID is assigned.

`inboundNumber` is owned by the deploy path and is not editable through the
clinic API, so it cannot drift away from the number actually bound.

Two consequences worth stating plainly:

- Set `inboundNumber` to the provider DID and leave `phone` as the clinic's real
  number. Setting `phone` to the DID works, but then the agent tells callers the
  provider number is the clinic's own.

  **For the first pilot we are doing exactly that on purpose**: the
  provider-owned number *is* the clinic's advertised number, so `phone` carries
  it and there is no second line to forward. That is the simplest correct
  configuration. It stops being correct the moment a clinic wants its own
  published number kept in front of patients — at which point set `phone` back
  to the real number and let deploy claim the DID.
- If a dialled number matches two active clinics, resolution returns **nothing**
  rather than guessing. That is deliberate. A caller reaching the wrong tenant is
  worse than a caller reaching a receptionist with no clinic facts.

A call that resolves to no tenant is still answered — with defaults. The agent
gets `is_open_now = "unknown"`, no clinic name, no hours, no fallback number and
no admission state. It sounds like a working receptionist and knows nothing, so
do not treat "the call connected" as evidence that mapping is correct. Check
`location_name`.

## 3. Clear the readiness gate

`GET /v1/receptionist/campaigns/:id/readiness` is the single source of truth.
Twenty-one checks; `server/lib/receptionist/remediation.ts` carries the operator
wording for each.

**Clinic Profile** — `clinic_country_set`, `clinic_hours_set`,
`locale_pack_approved`, `closing_disclosure_present`, `disclosure_composed`,
`emergency_path_reachable`, `transfer_target_distinct`.

The country selects the locale pack, the emergency number and the spoken date
format. Hours are not cosmetic: without them every after-hours answer is
invented. The human fallback number must be a number a person answers and must
differ from the AI line, or a transfer returns the caller to the agent.

**Agent & Campaign** — `agent_language_supported`, `agent_linked`,
`placeholders_absent`, `confirmation_channels`, `data_storage_setting`.

`placeholders_absent` fails while any pre-filled example value survives. Do not
deploy past it; those strings are spoken.

**Booking** — `location_mapped`, `services_bookable`, `provider_availability`,
`provider_resolvable`, `intake_attested`.

`provider_resolvable` is the one that surprises people: a branch with **more
than one** active provider and no rule for choosing between them makes the agent
take a message instead of booking. One active provider per mapped branch, or map
the campaign to a branch that has one.

**Provider** — `agent_verified`, `deployment_current`, `number_bound`. These are
what deploy and verification set. Do not chase them by hand.

**Last** — `test_call_completed`. Section 6.

## 4. Deploy

`POST /v1/receptionist/campaigns/:id/deploy` (`retellDeploy.ts`). In order:

1. create/update the response engine
2. create/update the agent with the assembled prompt and the tool set
3. **publish** that exact version
4. bind the clinic's inbound number to that published version, writing
   `expectedRetellAgentWebhookUrl()` as the number's inbound webhook

Step 4 uses `clinicInboundNumber(campaign.clinic)`, claimed and
uniqueness-checked in the first transaction. If the agent publishes but the bind
fails, the deploy says so and `number_bound` does not pass — it does not pretend.

An unpublished agent cannot take calls. A published agent with no number bound
cannot either: the `call_inbound` handler returns dynamic variables, it does not
return an `override_agent_id`, so the number must carry the binding itself.

## 5. Verify

`POST /v1/receptionist/agents/:id/verify-provider` reads the live agent back
from the provider — tools, webhook URL, published version, number binding — and
compares it to what we believe we deployed. `GET
/v1/receptionist/voice-line-status` reports the result.

Verification is the only evidence that configuration reached the provider. The
module's original failure was a full green checklist over a provider account
that had never received a single one of our tools.

## 6. The test call

Dial the number from a staff phone. `test_call_completed` clears from the call
appearing in Activity.

Check, in this order:

1. the agent greets with the **clinic's** name, not a default
2. it answers "are you open now" from real hours
3. `check_availability` returns times that exist
4. `book_appointment` produces an appointment visible on Front Desk
5. asking for a person reaches the human fallback number

If 1 or 2 is wrong, ingress mapping is wrong (section 2) — stop and fix that
before reading anything into 3–5.

### Outbound test calls are a different thing entirely

CareCommand dialling *you* is hard-gated off. `LIVE_TEST_CALLS_AUTHORIZED`
defaults false and `LIVE_TEST_MAX_CALLS` / `LIVE_TEST_MAX_TOTAL_MINUTES` default
to `0` (`server/config/env.ts`). Enabling it needs an authorization flag, an
execution id, a tenant id, a recipient allowlist, an expiry, a time window and a
cost cap — deliberately, because an outbound dialler that misfires calls
patients. Inbound needs none of that. Test inbound.

## 7. Known limitations

- Under `DEPLOYMENT_PROFILE=demo` the pilot guardrails do not run. Flip to
  `pilot` for a real clinic and read the boot failures as a to-do list.
- Call storage is metadata-only unless the tenant opts in; transcripts are not
  retained by default.
- `RETELL_AGENT_ID` is read by nothing. If it is set in an environment, it is
  vestigial and misleading — remove it.
