# CTO decision memo — Platform Control Plane (2026-08-29)

Inputs: six SME audits (ledger: `CONTROL_PLANE_AUDIT_2026-08-29.md`), the owner's nine
questions, and commit 4e7f744. Acting decisions — the owner can reverse any of them.

**Standing principle for this module: one plane owns each thing.** Where both planes have
a legitimate interest, the platform sets a **ceiling or a floor** and the tenant moves
inside it. Two planes writing the same field is the bug behind half of what follows.

**Second principle: fail amber, not green.** This codebase is unusually disciplined about
saying what is not wired (`setup_required`, "record only; not enforced", a 403 rather than
an empty roster). Every serious defect found is a place where that discipline lapsed and
something reported success it had not achieved. New work does not get to add another.

---

## Answers to the nine questions

### 1. "Unable to add a new company" — FIXED, and it was four things

The endpoint was never broken. What was broken: the button greyed out without naming a
single unmet requirement; the slug contract disagreed across four layers (console 2-60,
route 2-80, database 3-40) so a realistic company name failed *after* submit; a failed
plan catalog rendered as a healthy "Starter" that then failed provisioning; and the
transaction ran ~70 statements against Prisma's 5s default, surfacing a timeout as a bare
500. All four are fixed and covered by 10 new integration tests — the path had **zero**
automated coverage before today.

### 2. Tenant detail — the standard field set

The drawer is thinner than the backend. `Tenant` already carries 16 company fields, and the
API already returns `createdAt`, `trialEndsAt`, add-ons and a deep link that the UI drops
on the floor. **Decision — six sections, and nothing on screen that isn't real:**

| Section | Fields | State |
|---|---|---|
| Identity | legal name, trading name, slug, timezone, country, locations, created | mostly exists; surface it |
| Commercial | plan, status, trial ends, **contract start / renewal date**, **CSM owner**, MRR, add-ons | renewal/CSM/add-on UI missing |
| Operational health | calls answered 7d, distinct logins 7d, unresolved booking requests, last activity | new — three numbers, no ML |
| Usage vs entitlement | voice minutes this period, seats, locations — each with limit and source | needs the metering spine (§8) |
| Security & compliance | MFA, lockout, session length, IP allowlist, **BAA signed + date**, data region | BAA/region are schema gaps |
| Access & evidence | open support sessions (and **end** them), per-tenant audit trail, break-glass history | endpoints exist, no UI |

Renewal date is the single field that most prevents silent churn. NPI, tax ID, BAA status,
contract dates and CSM owner do not exist in the schema at all — they are a small additive
migration, not a console gap.

### 3. "Platform settings page is dead" — half right, and the half that was wrong mattered

It saved to Postgres and wrote an audit event. But of four fields, one worked, two had **no
reader anywhere in the codebase**, and the "default plan" could never apply because both
create forms always sent an explicit plan. So the operator saw "Settings saved." and got
Starter anyway. And on any load failure the page spun forever — which is what "dead" looked
like from outside.

**Decision: a settings field must have a read site or it does not exist.** The page now
carries only fields provisioning consumes — default plan, trial length, timezone, country,
first branch name, included voice minutes, and a security floor — and both create forms
seed from it. `platformName`/`supportEmail` are kept on probation: give them read sites
(console header, login page, outbound email footer) in the next cycle or delete them.

### 4. Presets plus manual entry — done, and the rule is "fill, never lock"

Presets (US/UK × pilot/production) are served from the API, not hardcoded in the console.
Applying one fills every field; each stays editable; `presetKey` records the starting point
and flips to `custom` the moment an operator edits anything. Same rule now applies to the
Pilot Launchpad's plan field, which was free text.

### 5. Retell in two places — which wins, and how tenants stay apart

**The honest finding first: today, neither.** The platform Integrations vault encrypts
credentials that **no runtime sender ever reads** — every provider call resolves
`process.env`. An operator rotating a leaked Twilio token gets `connected · via db` and
`test ok` while every message still goes out on the old key. And "Retell · test ok" means
"two env vars are non-empty" — there is no live ping for voice at all.

**Decisions:**

1. **Make the vault authoritative or delete it.** Resolution becomes
   `PlatformIntegration → env fallback`, in one shared resolver used by every sender. A
   green badge must mean the product will use that credential. **P0.**
2. **Voice, SMS, email, eligibility and SaaS payments are platform-owned. The tenant never
   sees or supplies those keys** — remove them from tenant-facing surfaces. What the tenant
   owns is their *resources* inside our account: their number, their agent, their sender
   name, their consent state.
3. **Tenant-owned integrations stay tenant-side**: RPM devices (already the reference
   implementation — per-tenant `encryptedConfig`, per-tenant webhook HMAC), and later their
   PMS/EHR. Insurance currently *stores* a per-tenant credential and never reads it: either
   read it or drop the field.
4. **Retell tenant separation is already correct and must not be regressed** — signature
   first, tenant from signed content, `?clinicId=` demoted to a cross-checked hint. Two
   gaps to close: prove number ownership before binding a clinic phone (today it is
   first-come-wins), and stop using one API key as both credential and webhook secret.
5. **Twilio is the real isolation problem.** One account, one FROM number, no inbound
   route, and account-level STOP handling that is platform-global: **clinic A's opt-out can
   suppress clinic B**. Decision: one number per clinic, and Twilio subaccounts before the
   third clinic. Until then, SMS stays limited to one pilot clinic.
6. **Stripe: do not onboard a second paying clinic without Connect.** Every clinic's patient
   money currently settles into our balance with no payout path in code.

### 6. How the multi-tenant platform is hardened

Better than expected, and the core should not be touched: three database principals with
`NOBYPASSRLS`, 131 tables under forced RLS generated from the catalog (deny-by-default for
future tables), **per-table behavioural proof running in CI**, no raw-SQL escape hatch,
roles re-read from the database rather than trusted from the JWT, HMAC-verified webhooks
resolved to a tenant before any context is entered, append-only audit enforced by trigger,
and a database-enforced break-glass for staff rosters.

The gaps are not in the isolation core. In order: the pilot-import routes read and write
tenant PHI as `source:'platform'`, bypassing the break-glass built for exactly that (**H1**);
a MANAGER can self-escalate to full admin through role overrides (**H2**); full request URLs
including one-time patient tokens are logged at `info` (**H3**); two advisory endpoints
returning 25 named patients have no permission check and no audit (**H4**); and the
production RLS cutover is **unverified** (**H5**) — until `rls:verify` runs against prod,
all of the above is proven in CI only.

**Decision: H1-H5 are P0, ahead of any new console feature.** H1 is ~20 lines — require a
live support session in the pilot-routes preHandler, the same 403 the roster already
returns.

### 7. HIPAA and SOC 2 readiness

Split honestly: **~35% engineering, ~65% policy and contracts.** No amount of code closes
the second half.

**Pilot-safe with one friendly clinic and real PHI (3-5 focused days of engineering):**
finish the prod RLS cutover and capture the evidence; close H2, H3, H4; require a support
session on the PHI pivot; schedule the retention purge job that is already written and
tested but has no caller; turn on `requireMfa` and `failedLoginLockout` for the pilot tenant
(both implemented, both default off); set `DEPLOYMENT_PROFILE=pilot`, which forces
production mode, a real platform DB URL, HTTPS origins, protected metrics and kills the
static token by construction; validate `sslmode` and pass Redis TLS through.

**Before a single real patient record — non-negotiable, no code substitutes:** signed BAAs
with Neon, Vercel/Render, Retell, Twilio, Stripe, Stedi and the email provider; Neon PITR
on with **one proven restore**; a breach-notification procedure; a pilot agreement stating
attended operation and audited vendor access; and rotation of every secret shared in chat.
Two cheap wins that remove a subprocessor from PHI scope: stop putting the patient's full
name in the Stripe line-item description, and fix the **hardcoded DOB `19850101`** currently
sent in every Stedi 270.

**Documented pilot limitations we accept:** no field-level PHI encryption, no automatic idle
logoff (compensate with a 15-minute session and a workstation-lock policy — §312(a)(2)(iii)
is *addressable*), soft-delete-only erasure, unaudited portal reads, no pen test yet.

**SOC 2:** scope Security + Availability + Confidentiality; skip Processing Integrity, which
would drag the receptionist's booking-accuracy claims into scope. CC7/CC8 evidence is
already produced automatically by CI (SBOM, audit signatures, per-PR migration + RLS +
behavioural proof). Buy a compliance platform for CC1-CC4 rather than hand-rolling policy.
Realistic: Type 1 in 2-3 months after the engineering list, Type II six months later.

### 8. Billing, metering and the revenue model

**Recommendation: per-location platform fee + included AI-receptionist minutes + metered
overage + feature add-ons.** Reasons: voice minutes are the only COGS-bearing unit that is
already metered *and* enforced; per-location is already modelled (`multi_location` limits
plus an `extra_location` add-on); and **per-seat is anti-aligned** — an AI receptionist's
pitch is fewer front-desk seats, so per-seat means product success shrinks its own invoice.
Outcome-based pricing (per booked appointment) is the better *story* and the data exists —
ship it as a P2 upsell lever, not as the base, because attribution disputes are brutal at
this size.

Tier price ≥ (included minutes × all-in cost per minute + fixed infra per tenant) ÷
(1 − target margin); overage at 2-3× cost, not at cost. **Four inputs are missing and none
are in the repo:** contracted Retell per-minute, Twilio per-SMS and per-inbound-minute, and
fixed infra per tenant. Give me those and the tier table computes.

**The P0 is not a feature, it is a live defect.** The voice meter is a **lifetime** counter
with no reset: the first pilot clinic hard-stops at 500 lifetime minutes with a 402 on
inbound patient calls, mid-month-two, silently. Fix: one append-only `UsageEvent` table with
`periodKey` and a `dedupeKey` (webhook redelivery is routine here), written inside the two
transactions that already increment minutes, and both admission gates switched to read the
**current-period** aggregate. Then set `monthlyPrice` so the console stops reporting $0 MRR
for the entire book of business, and cap or meter `overageAllowed`, which today removes the
voice cap entirely while nothing prices it.

**Platform-only:** price book, plan definitions, included quantities, overage rates,
credits, and all provider COGS. **Tenant-visible, read-only:** their own usage, invoices,
receipts, entitlement matrix. Plan changes stay a *request* the platform approves.

### 9. What belongs where

| Domain | Owner | Why |
|---|---|---|
| Platform operators | PLATFORM | Your staff roster is not tenant data |
| Tenant lifecycle: provision, suspend, offboard | PLATFORM | Suspension is a commercial lever; tenant requests, platform executes |
| Plan & pricing | PLATFORM | Tenant asks via subscription request; no self-serve upgrade until billing is real |
| Feature entitlements | **CEILING** | Split the two booleans now conflated: `entitled` (platform, from plan) vs `enabled` (tenant preference). Not paying ≠ chose to switch it off |
| Usage limits | **CEILING** | Platform sets the hard cap; tenant sets a soft alert under it |
| Provider credentials | **BY ACCOUNT OWNER** | Our vendor accounts: platform-only, key never visible. Their accounts (devices, PMS): tenant-only |
| AI model tier & guardrail prompt | **CEILING** | Platform owns the layer that stops the agent giving medical advice; tenant writes greeting, FAQs, escalation |
| Clinical/business config: hours, providers, services, templates | TENANT | We should not know their Tuesday hours. Platform may seed at onboarding, then hand over permanently |
| Branding | **CEILING** | Logo/colours tenant; custom domain and de-branding are paid entitlements |
| Data export | TENANT | Self-serve export is a sales asset; gating it behind a ticket reads as lock-in |
| Data deletion | PLATFORM | Irreversible and regulated; tenant requests, platform executes after a delay, legal holds win |
| Support access / impersonation | **PLATFORM-INITIATED, TENANT-CONSENTED** | Time-boxed, reason-required, visible to the tenant afterwards |
| Security policy (MFA, session, IP, lockout) | **FLOOR — the most important one** | Platform sets a minimum; the tenant may only tighten. Today both planes write one row, last-writer-wins |
| Audit visibility | BOTH, ASYMMETRIC | Tenant sees its own events **plus every platform action taken on its account**. Nobody deletes |

---

## What the owner did not ask, and should have

1. **Tenant mode: `demo` / `pilot` / `production`.** Non-negotiable for a voice product —
   one flag above every live-dial path. It does not exist.
2. **Impersonation with consent.** "Open Control Center" only opens a drawer. There is no
   way to see the product as the clinic sees it, which means every support conversation is
   conducted blind.
3. **Entitlement overrides need `expiresAt` and `reason`,** or pilot comps quietly become
   permanent free features.
4. **Onboarding measured on value, not rows.** The readiness score counts imported CSV rows
   and will read 100% before a single call has been answered. Score it on *time to first
   answered call*.
5. **No path from a created company to a working phone number.** This is the hard stop in
   the 30-minute onboarding test — steps 3, 4, 6, 7, 8 and 10 of that flow do not exist, so
   the honest current time-to-first-call is a multi-day operator project.
6. **Production reports `release: "unknown"`.** You cannot tell what is deployed.
7. **Nine load paths render API failure as a reassuring empty state** — including "No
   pending subscription requests. You're all caught up." That is a correctness lie.

## Anti-spaceship filter — not now, and what triggers each

SSO/SAML/SCIM (first 50-seat prospect) · region pinning (first EU/UK contract redline) ·
invoice engine, proration, dunning (>10 paying tenants) · flag targeting rules (>20 tenants)
· automated status page (after the first hand-written incident email) · ML health scoring
(after 20 tenants) · self-serve trial→paid (>5 inbound/week) · four-eyes approval (>3
operators) · white-label/reseller (when a DSO asks in writing).

## Build order

**P0 — this week.** Security: H1 support-session gate on the PHI pivot, H2 role-escalation
guard, H3 URL redaction in logs, H4 permission gates on advisory, H5 prod RLS cutover +
captured evidence. Money: period-scoped `UsageEvent` and both admission gates reading the
current period (stops the 500-lifetime-minute hard stop), `monthlyPrice` set, overage capped.
Truth: make the credential vault authoritative with env fallback.

**P1 — next two weeks.** Tenant mode flag; consented impersonation; override expiry+reason;
contract/renewal/CSM/BAA fields; tenant health signals; per-tenant audit fetch; support
session list/end, add-on attach/detach and tenant rename UI (all backend-complete already);
`canManage` propagation; kill the reassuring-empty-state lies; security floor resolved as
`max(floor, tenant)` at read time.

**P2 — the month after.** Twilio subaccounts + per-clinic numbers; Stripe Connect; number
provisioning inside the console; agent config generated from clinic setup; onboarding
checklist rewritten against first-answered-call; offboarding export bundle; SMS/email
metering; seat and location enforcement.
