# Connected Care — Sandbox & Demo Runbook

How to get every device + insurance provider into a **sandbox** state and run a
believable, fully-backed client demo. Provider credentials are **per-tenant and
encrypted in the DB** (configured at **Integration Setup → `/integration-setup`**),
**not** read from `.env` — only Stedi's *production* key and the AI keys live in env.

> No API keys are ever sent to the frontend or logged. Keys are read on the
> backend only.

---

## TL;DR — make it test-ready in 2 commands

```bash
npm run db:seed        # guarded synthetic data; requires the documented test-only confirmation variables
npm run demo:sandbox   # flip every provider to Sandbox + stream live readings
```

`demo:sandbox` (for `DEV_TENANT_ID`):
- Stedi → **SANDBOX** (no key needed).
- Dexcom / Withings / Validic / Terra / Tenovi → **SANDBOX** (with an encrypted
  demo webhook secret); manual → **ACTIVE**.
- Enrolls demo patients with one external ref per provider.
- Streams readings through the **real** adapter → severity pipeline, producing
  engine-decided alerts and sync-log entries.

It prints a ready-to-run **signed** curl so you can push more readings live.

---

## What's genuinely demo-ready right now (no vendor accounts)

| Surface | State | Demo action |
|---|---|---|
| **Insurance eligibility (Stedi)** | Sandbox, live | Run a check on `/insurance-eligibility` (see member-ID patterns below) |
| **Manual device provider** | Active | Unsigned webhook ingest → reading + alert |
| **Branded device providers** | Sandbox (our simulator) | Signed webhook ingest → reading + alert |
| **Remote Monitoring / Alerts / RPM** | Populated by the pipeline | Acknowledge/assign/resolve; record review minutes; provider signoff |
| **AI gateway** | `mock` provider | Generate recommendations, view usage/cost, health-check |

### Insurance eligibility sandbox — member-ID patterns
The Stedi sandbox is deterministic so every status is reproducible:

| Member ID | Result |
|---|---|
| anything normal (`AET-110293`) | **ACTIVE** (copay/deductible/coinsurance populated) |
| ends in `00` (`AET-1100`) | **INACTIVE** |
| ends in `99` (`AET-1199`) | **NEEDS_REVIEW** |
| starts with `ERR` (`ERR-0001`) | **ERROR** |

### Push a live reading during the demo
```bash
# Manual (no signature required)
curl -X POST http://localhost:3001/v1/connected-care/$DEV_TENANT_ID/providers/manual/webhook \
  -H 'content-type: application/json' \
  -d '{"readings":[{"patientExternalRef":"MANUAL-001","readingType":"glucose","value":"330","numericValue":330,"unit":"mg/dL"}]}'

# Branded provider (HMAC-SHA256 of the raw body with the demo secret)
SIG=$(node -e "console.log(require('crypto').createHmac('sha256','demo-sandbox-secret').update(process.argv[1]).digest('hex'))" "$BODY")
curl -X POST http://localhost:3001/v1/connected-care/$DEV_TENANT_ID/providers/dexcom/webhook \
  -H "x-cc-signature: $SIG" -H 'content-type: application/json' -d "$BODY"
```
A wrong/absent signature is **rejected (401)** and logged in Provider Sync Logs.

---

## Per-provider sandbox reference

Each device provider's **sandbox base URL + auth fields** for when you move
beyond the simulator to real vendor sandboxes. Enter these in **Integration
Setup** (encrypted at rest). Verify exact endpoints in each vendor's current docs.

| Provider | Category | Config fields (Integration Setup) | Vendor sandbox base (verify in docs) | Get sandbox access |
|---|---|---|---|---|
| **Dexcom** | DIRECT_API | `clientId`, `clientSecret` | `https://sandbox-api.dexcom.com` (OAuth) | developer.dexcom.com |
| **Withings** | DIRECT_API | `clientId`, `clientSecret` | `https://wbsapi.withings.net` (OAuth) | developer.withings.com |
| **Validic** | AGGREGATOR | `apiKey`, `orgId` | `https://api.validic.com` | validic.com |
| **Terra** | AGGREGATOR | `apiKey`, `devId` | `https://api.tryterra.co` | tryterra.co |
| **Tenovi** | RPM_VENDOR | `apiKey` | Tenovi RPM Hub API | tenovi.com |
| **manual** | MANUAL | — (always available) | n/a | n/a |

| Insurance | Config fields | Sandbox / prod base | Notes |
|---|---|---|---|
| **Stedi** | `apiKey` (prod only) | `https://healthcare.us.stedi.com` | Sandbox needs **no** key; set `STEDI_API_KEY` to go live |
| **Optum** | `clientId`, `clientSecret` | developer.optum.com | Stays `NOT_CONFIGURED` until creds entered |
| **Availity** | `clientId`, `clientSecret` | developer.availity.com | Stays `NOT_CONFIGURED` until creds entered |

> **Webhook signing:** real vendors sign webhooks differently (Dexcom/Withings
> use OAuth + notification callbacks; Validic/Terra/Tenovi send signed events).
> Our receiver verifies an **HMAC-SHA256** of the raw body against the per-tenant
> `webhookSecret` (from the provider's encrypted config) via the `x-cc-signature`
> header. Map each vendor's signature header to this when wiring a live sandbox.

---

## Going from sandbox → production
1. Get the vendor's **production** credentials.
2. In Integration Setup, set the provider **mode = production** and enter the keys.
3. Run **Health check**. Status flips `SANDBOX → ACTIVE` once required config is present.
4. For Stedi production eligibility, also set `STEDI_API_KEY` in the backend env.

## Governance recap
- Tenant-isolated, RBAC-enforced, audited, rate-limited on eligibility + webhooks.
- AI: PHI blocked unless `AI_ENABLE_PHI=true`; daily spend capped by
  `AI_COST_BUDGET_DAILY_USD`; every call logged to `AIUsageLog`.
- RPM billing readiness **never auto-submits** a claim — provider signoff required.
