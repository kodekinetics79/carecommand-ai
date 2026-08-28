# Attended Retell Live Voice UAT

This run proves one CareCommand-originated Retell call through the real local application, installed Google Chrome, PostgreSQL, the restricted application API, and the durable receptionist call/audit path. It uses one explicitly authorized destination attached to a clearly synthetic lead at runtime. It is **not** a production campaign, patient test, compliance certification, or permission to call any other number.

## What the application now enforces

- The live-test path is available only in the `demo` deployment profile.
- Exactly one synthetic tenant and one E.164 recipient must be supplied in the local process environment.
- The browser cannot supply or change the destination.
- The authorized destination is attached to a synthetic lead through a server-held endpoint and returned masked.
- One active live-test call is allowed at a time.
- Call count, per-call duration, aggregate minutes, expiration, time window, and conservative provider-cost limits are enforced before Retell invocation.
- Real provider calls use the exact verified Retell agent ID and version stored for the tenant.
- A loopback/local callback URL is omitted rather than sent to Retell; the UI can poll Retell's Get Call endpoint until a signed public webhook is available.
- Provider and destination identifiers are masked in browser/evidence surfaces.
- A technically ended call without signed analyzed-webhook evidence is routed to staff review rather than represented as a successful business outcome.

## Retell dashboard preflight

In the Retell dashboard:

1. Confirm the intended agent is published and note its agent ID and exact published version.
2. Open **Phone Numbers** and confirm a Retell-managed or imported number is available for outbound use.
3. Bind the intended agent as the number's outbound agent, or use the explicit agent override already verified by CareCommand.
4. Create a restricted API key that can create and read calls.
5. Confirm the account has billing/credit sufficient for one short test call.

CareCommand uses Retell directly. Twilio credentials are required only when the selected Retell number is backed by a custom Twilio/SIP configuration.

## Local environment

Set these only in the Terminal session that starts the UAT. Do not paste real values into chat, source files, tracked `.env` files, screenshots, or test reports.

```bash
cd /Users/zackkhan/carecommand-ai

export DEPLOYMENT_PROFILE=demo
export RETELL_API_KEY='<restricted Retell API key>'
export RETELL_FROM_NUMBER='<Retell outbound number in E.164>'
export LIVE_TEST_RETELL_AGENT_ID='<published Retell agent id>'
export LIVE_TEST_RETELL_AGENT_VERSION='<published integer version>'

export LIVE_TEST_CALLS_AUTHORIZED=true
export LIVE_TEST_EXECUTION_ID="voice-uat-$(date -u +%Y%m%dT%H%M%SZ)"
export LIVE_TEST_TENANT_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
export AUTHORIZED_TEST_PHONE_E164='<one user-authorized E.164 destination>'
export LIVE_TEST_RECIPIENT_ALLOWLIST="$AUTHORIZED_TEST_PHONE_E164"
export LIVE_TEST_EXPIRES_AT="$(date -u -v+2H +%Y-%m-%dT%H:%M:%SZ)"
export LIVE_TEST_TIMEZONE='America/New_York'
export LIVE_TEST_WINDOW_START='09:00'
export LIVE_TEST_WINDOW_END='20:00'
export LIVE_TEST_MAX_CALLS=1
export LIVE_TEST_MAX_CALL_MINUTES=5
export LIVE_TEST_MAX_TOTAL_MINUTES=5
export LIVE_TEST_MAX_PROVIDER_COST_USD=3
export LIVE_TEST_ESTIMATED_COST_PER_MINUTE_USD=0.25

# The disposable browser harness still needs the repository's normal local
# database/Redis/JWT variables. Keep those in the existing ignored local setup.
export E2E_USE_INSTALLED_CHROME=true
export E2E_HEADLESS=false
```

The macOS `date -v` syntax above creates a two-hour authorization. On another operating system, set an equivalent future ISO-8601 UTC timestamp no more than 24 hours ahead.

## Run

```bash
npm run test:e2e:live-voice
```

The harness:

1. creates a disposable database and applies the authoritative migrations;
2. starts the real built frontend and API;
3. launches installed Google Chrome visibly;
4. seeds one synthetic tenant, clinic, Owner, and provider-verified agent reference;
5. creates and approves a care-coordination campaign through the authenticated CareCommand API;
6. attaches the one environment-authorized destination as a synthetic lead through the CareCommand UI;
7. launches exactly one call from the target row;
8. polls Retell through the CareCommand provider-sync endpoint when no public webhook is available;
9. verifies the durable call, provider intent, audit, usage, masking, reload behavior, and Pixel 7 responsive state.

When the phone rings, answer, confirm that the authorized CareCommand test call arrived, and end the call after the agent responds. The harness fails if the call never obtains a real provider ID, never connects, produces a duplicate provider intent, leaks the raw destination in Chrome, or lacks the expected audit/usage evidence.

## Public webhook (recommended after connectivity proof)

A public HTTPS callback is not required for the first attended dial because CareCommand can poll Retell for privacy-safe lifecycle metadata. For complete real-time evidence, configure `PUBLIC_API_URL` to an approved HTTPS endpoint and validate Retell's signature against the exact raw request body before activating tenant context.

Never expose an unauthenticated local development server directly to the internet.

## Cleanup

The disposable database is dropped by the test wrapper. When the run finishes, clear the process-scoped authorization and secrets:

```bash
unset RETELL_API_KEY RETELL_FROM_NUMBER LIVE_TEST_RETELL_AGENT_ID LIVE_TEST_RETELL_AGENT_VERSION
unset LIVE_TEST_CALLS_AUTHORIZED LIVE_TEST_EXECUTION_ID LIVE_TEST_TENANT_ID AUTHORIZED_TEST_PHONE_E164 LIVE_TEST_RECIPIENT_ALLOWLIST
unset LIVE_TEST_EXPIRES_AT LIVE_TEST_TIMEZONE LIVE_TEST_WINDOW_START LIVE_TEST_WINDOW_END
unset LIVE_TEST_MAX_CALLS LIVE_TEST_MAX_CALL_MINUTES LIVE_TEST_MAX_TOTAL_MINUTES
unset LIVE_TEST_MAX_PROVIDER_COST_USD LIVE_TEST_ESTIMATED_COST_PER_MINUTE_USD
unset RUN_LIVE_VOICE_UAT E2E_USE_INSTALLED_CHROME E2E_HEADLESS
```

Confirm no call remains active in Retell and no future test call is scheduled.
