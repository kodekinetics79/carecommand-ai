# Integration Mode Register

Last updated: 2026-07-20

Every enterprise validation cycle must mark each integration as `live`,
`sandbox`, `mock`, or `not configured`. Do not mix provider modes in buyer-facing
claims.

| Integration | Local default | Enterprise validation requirement |
| --- | --- | --- |
| Stripe payments | `PAYMENT_PROVIDER=mock` unless Stripe keys are set | sandbox or live account approved by client; prove success, failure, duplicate webhook, refund/dispute/reconciliation where in scope |
| Eligibility | `INSURANCE_PROVIDER=mock`; Stedi sandbox supported | sandbox/live payer connection with active, inactive, uncertain, timeout, and credential-failure cases |
| Email | not configured unless provider env is set | prove delivery, bounce/failure, opt-out, and no PHI leakage in subject/body |
| SMS/WhatsApp | not configured unless Twilio/WhatsApp env is set | prove opt-in, opt-out, delivery failure, and rate limits |
| Voice/AI receptionist | not configured unless Retell env is set | prove call routing, transcript handling, PHI policy, and failure fallback |
| AI gateway | `AI_PROVIDER=mock` | approved provider or accepted mock mode; prove PHI policy and human-approval gate |
| Translation | `auto`; MyMemory fallback can work without key | confirm client-approved provider and language scope |
| Device/RPM | sandbox/demo unless vendor env is set | prove matched, unmatched, duplicate, corrupt, out-of-order, normal, warning, and critical readings |
| Redis/queues | local Docker Redis | always-on Redis and worker process with backlog/alert evidence |
| Observability | structured logs/metrics seam | client environment must prove protected metrics, alert route, and error reporter |

## Deployment Profile Gates (enforced at boot)

This register's contract is now machine-enforced by `server/config/env.ts`:

- `DEPLOYMENT_PROFILE` — `demo` (default) | `pilot` | `enterprise`. Deployment
  posture, deliberately independent of `NODE_ENV` (the local E2E harness runs
  `NODE_ENV=production` under the `demo` profile and keeps booting).
- `ALLOWED_MOCK_INTEGRATIONS` — comma-separated explicit acknowledgements,
  e.g. `ai,insurance`. Valid tokens: `payments`, `insurance`, `ai`. Unknown
  tokens fail boot in every profile (a typo must never silently acknowledge
  nothing).

Boot behavior:

| Profile | Mock integration (payments/insurance/ai) | Result |
| --- | --- | --- |
| `demo` | any | boots (demo posture is allowed to be mock) |
| `pilot` / `enterprise` | not listed in `ALLOWED_MOCK_INTEGRATIONS` | **boot fails** naming the integration, the profile, and the fix |
| `pilot` | listed in `ALLOWED_MOCK_INTEGRATIONS` | boots — the mock is an explicit, recorded exclusion |
| `enterprise` | payments mock, even if acknowledged | **boot fails** — payments are the money path; mock is never valid enterprise evidence |

The effective posture is queryable by an authorized monitor at `GET /health/integrations`
(`{ profile, integrations: { payments, insurance, ai, email, sms, voice },
acknowledgedMockIntegrations }` — provider ids and configured/not_configured
flags only, never credentials). Production callers use the same monitoring bearer
token as `/metrics`; unauthenticated callers receive no inventory. Use it as the first evidence artifact of every
validation cycle: it makes "which mode was this run in?" a fact, not a claim.

Proof: `server/test/envSchema.test.ts` (gate semantics) and
`server/test/observabilityPillars.test.ts` (endpoint shape).

## Evidence Fields

For each integration, record:

- mode
- credential owner
- test data set
- webhook/event IDs
- success evidence
- failure evidence
- idempotency/replay evidence
- reconciliation evidence
- client acceptance or exclusion
