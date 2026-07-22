# Incident And Integration Failure Runbook

Last updated: 2026-07-20

Use this for pilot war-room operations and client-run enterprise testing.

## Severity

| Severity | Definition | Response |
| --- | --- | --- |
| P0 | data exposure, cross-tenant access, duplicate charge, unsafe clinical alert routing, production outage | stop affected flow, page accountable owner, preserve evidence |
| P1 | major workflow broken, payments/eligibility/comms unavailable without safe fallback | war-room triage, communicate workaround, fix before next client cycle |
| P2 | degraded UX, confusing status, non-critical report or admin issue | backlog with owner and date |

## First Response

1. Assign incident commander, engineering owner, client communicator, and scribe.
2. Capture timestamp, environment, user/tenant, correlation ID, request ID, and
   screenshots without exposing PHI in public channels.
3. Freeze evidence: logs, audit events, webhook payload IDs, queue job IDs,
   deployment version, and database transaction IDs where available.
4. Decide whether to disable a feature flag, pause a worker, or pause a provider
   integration.
5. Communicate user-safe status and workaround.

## Integration Failure Tests

| Integration | Failure | Expected behavior |
| --- | --- | --- |
| Stripe | timeout, invalid signature, duplicate webhook, delayed webhook | no duplicate charge; status reconciles; invalid event rejected |
| Eligibility | 429, 500, timeout, inactive/uncertain response | retry or staff task; patient sees non-final language |
| Email/SMS/voice | provider outage, opt-out, invalid destination | no silent success; staff sees delivery status |
| Device/RPM | duplicate, out-of-order, corrupt, critical reading | idempotent reading handling; safe alert routing |
| AI gateway | unavailable or policy-blocked request | deterministic fallback/error; no PHI leak to unapproved provider |
| Redis/worker | Redis down, worker restart, queue backlog | API remains safe; queued jobs resume or fail visibly |

## Recovery Evidence

For each incident or drill, record:

- user-visible symptom
- affected tenants and workflows
- detection method
- mitigation
- permanent fix
- tests added or rerun
- audit/log evidence
- client-facing explanation

## Communication Rules

- Never say “HIPAA compliant” as an incident answer.
- Never expose raw PHI, tokens, webhook secrets, or stack traces to the client.
- State what is known, what is still under investigation, and the next update
  time.
