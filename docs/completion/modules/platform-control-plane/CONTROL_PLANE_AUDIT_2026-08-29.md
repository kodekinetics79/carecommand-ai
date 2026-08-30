# Platform Control Plane — audit ledger (2026-08-29)

Six SME teams audited the Control Tower and the multi-tenant substrate behind it:
provisioning & tenant detail, integration credential isolation, tenant isolation &
HIPAA/SOC 2, billing & metering, dead-control inventory, and a product consultant on
the platform/tenant split. Everything below is evidence from code, schema and
migrations. Claims the teams could not confirm are marked UNVERIFIED.

Status key: **FIXED** in commit 4e7f744 · **OPEN** · **BY DESIGN**

---

## 1. What is actually broken in the console

| # | Finding | Evidence | Status |
|---|---|---|---|
| C1 | "Create company" greys out with no explanation. Five required fields, none of them named. | `src/pages/PlatformConsole.tsx:1337` (old `canSubmit`) | FIXED |
| C2 | Slug contract disagreed in four places: console allowed 2-60 chars, route zod 2-80, the database function demands 3-40. A realistic company name produced a 51-char slug → 400 after submit. | `platformTenantProvisioning.ts:42`, `20260730133000_platform_database_plane/migration.sql:188` | FIXED |
| C3 | A failed or empty plan catalog rendered as a healthy single "Starter" option, which then failed provisioning with `plan_unavailable`. | `PlatformConsole.tsx:1348` + `.catch(() => [])` at `:1205,:1208,:187,:448` | FIXED (Tenants + Settings; other pickers OPEN) |
| C4 | Provisioning runs ~70 sequential statements inside one Prisma transaction with the 5s default budget. On managed Postgres this blows the budget and surfaces as an unmapped P2028 → bare 500. | `compliance/baseline.ts:49-89` (49 upserts) + `entitlements.ts:46-52` (15) | FIXED (30s budget + P2028 mapped) |
| C5 | Platform Settings: `defaultPlanKey` was unreachable — both create forms always sent an explicit `planKey`, so the `??` fallback could never fire. Operator sets "default plan", saves, gets Starter anyway. | `PlatformConsole.tsx:1300`, `PlatformPilot.tsx:51` | FIXED |
| C6 | `platformName` and `supportEmail` had no reader anywhere in the codebase. | exhaustive grep — only write sites and the GET echo | OPEN (kept; still unread) |
| C7 | The settings page had no `catch`: any 401/500 left an eternal spinner. This is most likely what "the settings page is dead" looked like. | `PlatformConsole.tsx:1058-1062` | FIXED |
| C8 | `ensureConfig` raced on first use — two concurrent GETs both `create({id:'singleton'})`. | `routes.ts:860-863` | FIXED (upsert) |
| C9 | Pilot Launchpad's Plan was a free-text box; a typo 400'd at the end of a long form. | `PlatformPilot.tsx:407` | FIXED (select) |
| C10 | Nine load paths have no `catch`, so an API failure renders as a reassuring empty state — including **"No pending subscription requests. You're all caught up."** | `PlatformConsole.tsx:1438,212,1553,1481,387,243` | OPEN |
| C11 | Developer note rendered under every tenant row: "billing/MRR available via platformAdmin.getBilling". | `PlatformConsole.tsx:1255` | OPEN |
| C12 | Two dead cards in "Quick actions" on the landing page — plain `<div>`s styled like the one working button. | `PlatformConsole.tsx:176-177` | OPEN |
| C13 | Audit tab fetches the **global** newest 200 events and filters client-side, though the endpoint accepts `tenantId`. On a busy platform a tenant's history reads as "no events". | `PlatformConsole.tsx:449,456` vs `routes.ts:364` | OPEN |
| C14 | Backend capability with no console surface: tenant rename (`routes.ts:410`), add-on attach/detach (`:463,:480`), support-session list/end (`:770,:774`), pilot share-link list/revoke, preset delete. | client methods exist, 0 call sites in `src/` | OPEN |
| C15 | `canManage` is never passed to `TenantsTab`/`TenantFeatureControls`, so a read-only operator gets enabled buttons and a 403 after the fact. | `PlatformConsole.tsx:1195,1417` | OPEN |
| C16 | Hardcoded `/15` feature denominator in two places. | `PlatformConsole.tsx:504,138` | OPEN |
| C17 | `/platform-legacy` is dead in production (static token disabled there). | `src/app/App.tsx:207` | OPEN (delete the route) |

## 2. Controls that persist perfectly to a column nothing reads

This is the dangerous class: the console reports success, shows green, and the product
behaves as if nothing happened.

| # | Finding | Evidence | Status |
|---|---|---|---|
| V1 | **The integration credential vault is inert.** `PlatformIntegration` is referenced only inside `platform/routes.ts`. Every runtime sender reads `process.env` directly. An operator rotating a leaked Twilio token sees `connected · via db` and `test ok` while every SMS still goes out on the old key. | writers `routes.ts:964-985`; consumers `lib/retell.ts:18`, `lib/commsProvider.ts:64-66,82-83`, `lib/deposits.ts:40`, `revenue-protection.ts:735,763,967,982` | OPEN — P0 |
| V2 | "Test connection" does no network call for voice/email/insurance/payment-webhook — `status` is initialised `'ok'`. **"Retell · test ok" means "two env vars are non-empty."** | `routes.ts:1005,1017` | OPEN |
| V3 | `modelTier` and `aiCreditsLimit` persist to columns with no reader. `aiCreditsUsed`, `campaignGenerations`, `reportGenerations` have no writer — three permanently-zero cards. | `routes.ts:684-688` vs grep | OPEN |
| V4 | 6 of 7 usage counters are frozen: `used` is seeded once at row creation and only `voice_minutes` is ever incremented. `seats: 3/25` was true the day the row was created. Device Usage is structurally 0. | `routes.ts:652-655` | OPEN |
| V5 | MRR/ARR are structurally $0: the catalog migration deliberately never writes `monthlyPrice`, and `ensureBilling` copies it once, lazily, then `change-plan` never updates it. | `routes.ts:606`, `20260828120000…/migration.sql:29-33` | OPEN |
| V6 | Announcements have zero consumers outside the platform routes; `audience` isn't settable in the form. | grep across `server/` + `src/` | OPEN |
| V7 | "Retry failed jobs" covers 1 of 5 queues under a generic "Failed background jobs" label. | `routes.ts:810-836` vs `workers/queues.ts` | OPEN |
| V8 | `ipAllowlist` is stored and never enforced (honestly labelled in the UI), and has no editor. `passwordExpiryDays` is enforced but has no control. | `PlatformConsole.tsx:1012` | OPEN |

## 3. Live defects that will bite a paying pilot

| # | Finding | Evidence | Status |
|---|---|---|---|
| L1 | **The voice meter never resets.** `TenantUsageLimit.used` and `TenantAiUsage.receptionistMinutes` are lifetime counters — only `{increment}` exists, no period key, no reset job. The first pilot clinic hard-stops at 500 *lifetime* minutes with a 402 on inbound patient calls, mid-month-two, silently. | `receptionist/webhooks.ts:615-631,324-345`; no `BillingPeriod`/`UsageEvent` model in 4,049 lines of schema | OPEN — P0 |
| L2 | **An expired trial keeps working forever.** `ENTITLED_STATUSES` includes TRIAL/ACTIVE/PAST_DUE, entitlements recompute only on platform mutations, and no job ever expires a trial or rolls a period. | `subscriptions/catalog.ts:75`; `workers/index.ts:60-66` | OPEN |
| L3 | **`overageAllowed` is uncapped and unbilled.** It removes the voice cap entirely while nothing meters or prices the overage. | `webhooks.ts:341`, `outbound.ts:1653` | OPEN |
| L4 | A platform entitlement override was silently wiped by any plan change, add-on edit, suspend or reactivate — while the console claimed the opposite. | `entitlements.ts:46-52` vs `PlatformConsole.tsx:1428` | FIXED |
| L5 | `limitValue` is theatre: locations sold as "up to 2 / up to 5" with an `extra_location` add-on, and nothing enforces it at `POST /v1/branches`. No seat enforcement either. | `branches/routes.ts:37-44` | OPEN |
| L6 | `TenantSecurityPolicy` is written by both planes with last-writer-wins. A tenant admin can overwrite an MFA mandate the platform set. | `platform/routes.ts:734` and `compliance/center.ts:519` | PARTLY FIXED (floor applied at provisioning; runtime `max(floor, tenant)` still OPEN) |

## 4. Multi-tenant isolation — as built

The isolation core is genuinely strong and should not be regressed:

- **Three database principals.** `app_rls` (NOBYPASSRLS, owns nothing) for tenant/PHI,
  `app_platform` (NOINHERIT, no grant on Patient/Appointment/clinical/call/payment) for
  the console, and a separate migration owner. `20260730133000:64-75`.
- **131 tables ENABLE + FORCE RLS**, policies generated by a catalog-driven loop over
  every table carrying `tenantId`, deny-by-default for future tables.
  `20260730120000_complete_rls_isolation:317-345,10-12`.
- **Per-table behavioural proof in CI** — all 131 tables asserted for same-tenant visible,
  cross-tenant zero, no-context zero, across read, list, search, aggregate, export and
  every write verb. `server/test/rlsBehavioralCoverage.integration.test.ts:34-58`,
  `.github/workflows/ci.yml:90-100`.
- **No raw-SQL escape hatch** — zero `$queryRawUnsafe`/`$executeRawUnsafe` in app code.
- **Role is re-read from the database**, never trusted from the JWT. `plugins/auth.ts:58,78`.
- **Every webhook verifies an HMAC over the raw body first**, then maps to exactly one
  tenant through a SECURITY DEFINER resolver; ambiguous matches fail closed. No public
  route derives tenant authority from untrusted input.
- **AuditEvent is append-only three ways** — trigger binding all roles, privilege revoke,
  and no UPDATE/DELETE policy.
- **Break-glass is DB-enforced**: the staff roster requires a live, unended,
  reason-matching `SupportAccessSession`, checked inside the database function itself.

Holes found, ranked:

| # | Hole | Evidence |
|---|---|---|
| H1 | **CRITICAL.** The pilot-import routes enter a *tenant* context with `source:'platform'` and read/write patient, appointment and insurance rows. The RLS platform branch admits *any active PlatformUser* to *any* tenant table. The strict `source='support'` branch — reason-mandatory, expiring, DB-validated — was built for exactly this and is dead code. | `platform/pilot.routes.ts:139-155,370-390,405-413`; `20260730130000:76-82` |
| H2 | **HIGH.** A MANAGER can self-escalate to full tenant admin: role CRUD is gated on `settings:write` (which MANAGER holds), role names are free-form, an override *replaces* defaults, and there is no "you may only grant what you hold" check. | `settings/routes.ts:585,614`; `lib/permissions.ts:122,172,201-207` |
| H3 | **HIGH.** Full request URLs are logged at `info` — including `?search=Jane%20Doe` and the single-use intake / checkout / pilot-share tokens. The OTel span scrubber does exactly this job for traces; the log serializer has no equivalent. | `config/logger.ts:13-27`, `app.ts:67`, `lib/spanRedaction.ts:31,37` |
| H4 | **HIGH.** `GET /v1/advisory/brief` and `POST /v1/advisory/ask` have **no permission check** — any authenticated role gets 25 named patients with churn risk, lifetime value and outstanding balance, and it writes no audit event. | `advisory/routes.ts:25,30`; `advisory/service.ts:75-79` |
| H5 | **HIGH, UNVERIFIED.** Production RLS posture is unknown — the cutover was in flight and the API was deliberately refusing to boot. Every claim above is proven in CI and unproven in production until `rls:verify` runs against prod. | `docs/ops/PROD_RLS_CUTOVER.md:3` |
| H6 | MEDIUM-HIGH. A hardcoded platform-owner token is live whenever `NODE_ENV !== 'production'` — the gate is `NODE_ENV`, not `DEPLOYMENT_PROFILE`. | `lib/platform.ts:17-22`, `platformAuth.ts:138` |
| H7 | MEDIUM. `purgeDueReceptionistArtifacts` is written and tested with **no production caller** — retention deadlines are stored and ignored. | `lib/receptionist/privacyLifecycle.ts:166`; `workers/queues.ts:139-143` |
| H8 | MEDIUM. `app_rls` retains SELECT on the cross-tenant `PlatformAuditEvent`, which is excluded from the RLS loop. | `20260730120000:30,46` |
| H9 | MEDIUM. `REDIS_URL` parsing discards the scheme and never sets `tls` — a `rediss://` URL connects in plaintext. `DATABASE_URL` never validates `sslmode`. | `workers/queues.ts:27-35`; `config/env.ts:76` |
| H10 | MEDIUM. `render.yaml` runs raw `prisma migrate deploy` in its build, bypassing the ack-gated, principal-checked `deploy-migrations.sh`. | `render.yaml:44` vs `scripts/deploy-migrations.sh:4-40` |
| H11 | LOW-MEDIUM. No tenant-side visibility of platform actions: a clinic owner cannot see that vendor staff opened a support session, viewed their roster or changed their MFA policy. | no platform action writes tenant `AuditEvent` |

## 5. Provider isolation — the honest picture

**There is no per-tenant provider account anywhere in this system.** Tenant A can never
use tenant B's Twilio/Stripe/Retell account because no tenant has one. Every tenant
transacts on a single platform-owned account per provider, read from `process.env`.

| Provider | Account | Creds read from | Tenant routing | Risk |
|---|---|---|---|---|
| Twilio SMS | one platform account, **one FROM number** | `env` only | none at the provider | **HIGH** — shared sender; **a patient replying STOP hits Twilio's account-level opt-out, which is platform-global, so clinic A's STOP can suppress clinic B**, and the app's tenant-scoped ledger cannot agree with it. There is no inbound SMS route at all. |
| Stripe | one platform account, **no Connect** | `env` only | `metadata[tenantId]` written, never read | **HIGH** — every clinic's patient payments settle into the platform balance with no payout path in code |
| Retell voice | one API key, one FROM number, one webhook secret | `env` only | **strong, DB-side** — HMAC first, then tenant from signed content; `?clinicId=` is demoted to a hint and cross-checked | MEDIUM-HIGH — first-inbound resolution trusts a self-declared `ReceptionistClinic.phone` with no ownership proof (first-come-wins land-grab of call metadata); one key is both API credential and webhook HMAC secret for all tenants |
| Stedi eligibility | one API key, **one hardcoded provider identity** (`'CareCommand Clinic'`, npi `1999999984`) — and a **hardcoded DOB `19850101`** in the 270 | `env` only; per-tenant `encryptedConfig` is written and never read | MEDIUM |
| Devices (RPM) | **per tenant** | `DeviceProvider.encryptedConfig`, decrypted at the webhook | per-tenant HMAC verifier | **LOW — this is the reference implementation to copy** |

## 6. Billing and metering — as built

- **Live:** plan/add-on catalog, entitlement resolution, and entitlement **enforcement at
  the API** (23 server-side gates, module-wide hooks plus non-JWT paths; the UI padlock is
  a mirror, not the gate). Voice minutes are metered transactionally at two write sites and
  enforced with a 402. AI tokens and estimated cost are logged per request with a daily
  per-tenant spend cap.
- **Absent:** a price book (`monthlyPrice` is never written), SaaS subscription billing
  (no Stripe customer/subscription/invoice anywhere), invoices, dunning, proration, tax,
  trial/period lifecycle, per-period aggregation, SMS/email metering, seat and location
  enforcement, and any record of provider COGS.
- The memory note "only subscription requests + entitlements exist" is **half stale**:
  entitlement enforcement and the voice meter are real. "No checkout/invoices/dunning"
  still holds.

## 7. Fixed in this session (2026-08-29)

| Commit | What it closed |
|---|---|
| `4e7f744` | C1-C5, C7-C9, L4 - provisioning contract, transaction budget, platform settings that provisioning reads, presets, entitlement-override durability |
| `d65aa01` | C10-C13, C15, C16 - failed lists no longer render as reassuring empty states, per-tenant audit fetch, dead quick-action cards, dev note, hardcoded /15, read-only role respected |
| `f48121c` | H2, H3, H4 - role-escalation guard, URL redaction in logs (plus Fastify's 404 handler, which leaked the same URLs), permission gates + audit on the advisory PHI endpoints |
| `5349c92` | H1 - break-glass required before platform staff read or write clinic data |

### A defect found while fixing H1

`pilotRoutes` never established the platform database request scope that `platformRoutes`
sets up (`routes.ts:247`), so every platform-plane read inside the pilot plugin ran without
its actor GUCs and was **silently denied by RLS** rather than erroring. Fixed in `5349c92`;
it is what made the support-session lookup - and the plugin's own platform audit writes -
work at all. Worth a lint or a plugin-level assertion: a platform-plane query outside the
scope should fail loudly, not return nothing.

## 8. Known-failing tests (pre-existing, deliberately left failing)

`server/test/pilotImport.test.ts` - two cases:

1. **Preset save is not idempotent.** The replayed save creates a second row instead of
   returning the stored response.
2. **A retried commit records a second durable intent** (`pilot.import.committed.requested`).

Cause: commit `2bdffe6` (a revert of PR #4) removed idempotency handling from
`pilot.routes.ts`. The console still sends an `Idempotency-Key` header that **nothing
reads** - grep finds no idempotency handling in that file at all. So a double-clicked
import is not protected by the mechanism the client believes is protecting it (data-key
upserts limit the damage, but that is luck, not design).

Both tests assert the correct behaviour of a capability that was reverted away. They are
left failing rather than weakened to match the regression. Restoring idempotency on these
routes is P1.

Separately, the shared dev database has accumulated 72 `PilotImportPreset` rows with
`isDefault = true`, which makes any "the default preset" assertion ambiguous - a test
isolation problem worth fixing when that suite is next touched.
