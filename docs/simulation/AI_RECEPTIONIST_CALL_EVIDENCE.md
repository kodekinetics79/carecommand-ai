# AI Receptionist and Voice Evidence

Live-call authorization status: **AUTHORIZATION_BLOCKED**. `LIVE_TEST_CALLS_AUTHORIZED=true` was not present and provider credentials were unavailable. Calls placed: 0. Duration: 0 minutes. Provider cost: USD 0. No phone number or raw transcript is stored here.

Protocol-faithful integration evidence covered signed webhook freshness/replay, tenant destination mismatch quarantine, missing-provider fail-closed behavior, Redis rate-store outage, DNC/provider-intent ordering, immutable consent, revocation ordering, identity boundaries, and usage-event delta idempotency. The focused voice/autopilot run reported 77 passed, 13 skipped, and one recovery performance timeout; the stronger disposable consent/DNC race lane passed 13/13.

Autopilot remediation now performs a real allowlisted staff-task action atomically and rejects stale generations. Worker regression passed 4/4 and route/recovery tests passed 11/11 with a 30-second timeout.

Remaining: provider transcript/audio ordering for emergency language, exact negative identity-tool replay deduplication, recovery throughput, tenant retry, and queue namespace isolation. Independent review also found that an outbound Retell call-ID collision can skip durable binding yet continue a successful launch path, leaving provider intent untracked. Therefore the simulated control lane is **REJECTED for release**, while the live-call lane remains **AUTHORIZATION_BLOCKED**.
