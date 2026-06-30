# Competitive Intelligence → Product Decisions

Prepared by the competitive-intelligence + SaaS-monetization function. Benchmarks
leading clinic/EHR/practice-management/RCM/RPM/patient-engagement platforms and
converts findings into concrete decisions mapped to **our** modules. This is
analysis from public product knowledge as of the 2026 planning cycle; pricing and
feature specifics **must be re-verified before any sales/marketing claim**, and
clinical workflow assumptions are flagged for the validation pack
([CLINICAL_VALIDATION.md](CLINICAL_VALIDATION.md)).

> Rule: we do not copy. We extract the *job-to-be-done* a competitor wins on and
> implement it better, backend-first, with our isolation/audit guarantees intact.

---

## 1. The benchmark set (who we measure against, and why)

| Segment | Representative platforms | What they're known for |
|---|---|---|
| Enterprise EHR | Epic, Oracle Health (Cerner), athenahealth | Depth, interoperability, payer network, scheduling at scale |
| SMB practice mgmt / EHR | Tebra (Kareo+PatientPop), DrChrono, AdvancedMD, eClinicalWorks | All-in-one PM + billing for small clinics |
| Behavioral / solo-friendly | SimplePractice, Jane, Headway | Beautiful UX, fast onboarding, low friction |
| Patient access / intake | Phreesia, NexHealth, Solv, Klara, Luma Health | Digital intake, scheduling, reminders, two-way messaging |
| Front-office AI / voice | NexHealth, Hello Patient, Assort, newer voice-AI receptionists | Automated booking, call deflection |
| RCM / billing | Waystar, Availity, Inovalon, athenaCollector | Eligibility, claims, denials, patient pay |
| Patient financial | Cedar, PayZen, Waystar patient pay | Estimates, digital pay, plans, propensity |
| RPM / connected care | Tenovi, Optimize Health, Prevounce, Health Recovery Solutions | Device kits, readings, CPT-billable RPM |
| Interop / data | Health Gorilla, Particle, Redox | Records exchange, FHIR, network queries |
| Reviews / reputation | Birdeye, Podium, PatientPop | Review generation, reputation, local SEO |

---

## 2. Top selling points extracted → our decision

Legend: **BUILD-NOW** (close a competitive gap we can win) · **SOON** (next 1–2
quarters) · **DIFFERENTIATOR** (where we can be visibly better) · **VALIDATE**
(needs real-doctor confirmation) · **SKIP** (not worth it for our ICP now).

### Patient access & intake (Phreesia / NexHealth / Solv / Luma)
- **Selling point:** digital pre-visit intake, insurance card capture, e-sign
  consents, self-scheduling, reminders that reduce no-shows.
- **Our state:** intake packets + hashed-token public route + consent
  reconciliation exist; reminders/no-show signals exist; **self-scheduling is
  thin**.
- **Decisions:**
  - BUILD-NOW: patient self-scheduling against real provider availability
    (we have `ProviderProfile`/availability primitives + receptionist
    availability lib — wire a patient-facing booking contract).
  - DIFFERENTIATOR: **intake → eligibility → estimate → deposit** as one
    backend-orchestrated flow (most competitors silo these). We already have all
    four engines; the win is a single state machine + morning-briefing surfacing.
  - SOON: insurance card OCR (metadata-only today) behind a config-gated vendor.

### Front-office voice AI (NexHealth / voice-AI receptionists)
- **Selling point:** answers calls, books, reduces front-desk load; "never miss a
  patient call" demo moment.
- **Our state:** **live Retell receptionist + outbound calling** already exists —
  this is ahead of most incumbents.
- **Decisions:**
  - DIFFERENTIATOR (lead with this in demos): real-time conversational booking
    with backend-enforced availability + consent + idempotency.
  - SOON: call → structured outcome → revenue/clinical signal (close the loop into
    intelligence + morning briefing).
  - VALIDATE: after-hours triage scripts and escalation thresholds (clinical).

### Revenue cycle & patient financial (Cedar / Waystar / Availity / PayZen)
- **Selling point:** real-time eligibility, patient-responsibility estimates,
  digital pay, payment plans, denial prevention, propensity-to-pay.
- **Our state:** eligibility (Stedi), responsibility estimates, deposits, Stripe
  links, rule-based denial-risk, revenue-protection alerts all exist; **claims
  submission + payment plans are not built** (intentionally — never auto-submit).
- **Decisions:**
  - BUILD-NOW: patient-responsibility **estimate → deposit → collect** packaged as
    a demo-ready flow with truthful provider gating (already mostly present).
  - SOON: payment plans (PayZen/Cedar pattern) — `PaymentRequest` can model
    installments; needs a plan schedule + Stripe subscription wiring.
  - DIFFERENTIATOR: **revenue-leak detection** (missed deposits, expired links,
    unverified eligibility before visit) surfaced proactively — we already emit
    `RevenueLeak`/`RevenueProtectionAlert`; competitors mostly report after the
    fact.
  - SKIP (for now): full clearinghouse claim submission — high regulatory surface;
    integrate Availity/Waystar later rather than build.

### RPM / connected care (Tenovi / Optimize / Prevounce)
- **Selling point:** cellular device kits, automatic readings, **CPT-billable**
  RPM (99453/99454/99457/99458), nurse review queues, alerts.
- **Our state:** device registry → enrollment → readings → **backend-decided
  severity** → alerts → RPM billing readiness all exist; signature-verified device
  webhooks.
- **Decisions:**
  - DIFFERENTIATOR: severity + escalation decided **in the backend** (not the app)
    with full audit — strong trust/compliance story.
  - BUILD-NOW: RPM **billing-readiness → exportable CPT evidence** (time logged,
    readings/16-day rule) — `RPMBillingReadiness` exists; add the time-accrual +
    export. **Never auto-bill.**
  - VALIDATE: per-condition thresholds and escalation SLAs (clinical — see
    validation pack).

### Reviews / reputation / growth (Birdeye / Podium / PatientPop)
- **Selling point:** automated review requests post-visit, reputation dashboards,
  reactivation campaigns.
- **Our state:** `ReviewRequest`, `ReputationCase`, CRM reactivation engine with
  consent/suppression + truthful delivery exist.
- **Decisions:**
  - SOON: post-visit review request triggered by appointment completion (wire the
    event we already emit).
  - DIFFERENTIATOR: consent-aware, suppression-aware campaigns that **never fake a
    send** (our CRM engine is already truthful — competitors have had TCPA/consent
    trouble; lead with compliance).

### UX / onboarding (SimplePractice / Jane)
- **Selling point:** clinicians self-onboard in minutes; the product "feels light."
- **Our state:** platform admin console + tenant provisioning + entitlements exist;
  **self-serve clinic onboarding + Stripe subscription billing is the GTM gap.**
- **Decisions:**
  - SOON: self-serve onboarding wizard → tenant provision → plan select → Stripe
    subscription → entitlement enforcement (we have every backend primitive).
  - UI/UX: mobile-first loading/empty/error states (flagged as a cross-cutting
    test gap) — fund this; it's what makes the SimplePractice "feel".

### Interoperability (Health Gorilla / Redox / FHIR)
- **Selling point:** pull external records, FHIR APIs, payer/network queries — table
  stakes for enterprise deals.
- **Our state:** none yet (greenfield).
- **Decisions:**
  - SOON→LATER: a **FHIR-shaped read API** over our domain (patients, appointments,
    observations from device readings) as the integration seam; defer inbound
    network queries until an enterprise deal demands it.
  - DIFFERENTIATOR potential: our event-driven core + idempotent webhooks make us a
    clean integration target.

---

## 3. Pricing & packaging patterns → monetization decisions

- **Per-provider/seat + module add-ons** is the dominant SMB model (Tebra, DrChrono,
  SimplePractice). We already model `SubscriptionPlan` + `SubscriptionAddon` +
  per-feature `TenantFeatureEntitlement` — **keep seat-based core + add-on modules**
  (RPM, voice AI, advanced RCM, reputation).
- **Usage metering** (SMS, voice minutes, AI credits, devices) — Phreesia/voice
  vendors meter. We have `TenantUsageLimit`; **enforce metered caps at the backend**
  and surface upgrade prompts (entitlement guard already returns `feature_locked`).
- **Outcome/value framing** (Cedar/Waystar sell "$ recovered"): instrument
  **revenue recovered, no-shows prevented, RPM $ enabled** as first-class metrics —
  we already emit the underlying events; expose an ROI dashboard. Strong demo +
  renewal lever.
- **Platform-controlled billing rules** (tenant admins must not edit their own
  package): already enforced (platform vs tenant boundary). Keep it.
- DECISION: a **"Connected Care / RPM"** add-on and a **"Front-Office AI"** add-on
  are the two highest-margin, most-differentiated upsells given what we already
  have built.

---

## 4. Strongest demo moments to engineer (and we can win)

1. **"Never miss a call"** — live AI receptionist books a real appointment with
   eligibility + consent enforced (we have this; polish it).
2. **One-flow front desk** — patient self-intake → eligibility check → estimate →
   deposit link, all from one screen, backend-orchestrated.
3. **RPM critical reading** — a device reading crosses a threshold → backend decides
   `critical` → nurse alert + escalation, fully audited.
4. **Revenue-leak radar** — morning briefing shows "$X at risk: 3 unverified
   eligibilities, 2 expired deposit links" with one-tap actions.
5. **Compliance one-click** — HIPAA data-access export + audit trail + RLS proof in
   front of a security-minded buyer (we just shipped the export + RLS guard).

---

## 5. Competitor weaknesses we exploit (positioning)

- Incumbents bolt modules together; cross-module flows are stitched in the UI. **We
  orchestrate in the backend** (events, entitlements, audit) → fewer clicks, fewer
  leaks.
- Many growth/marketing tools have had **consent/TCPA** issues. **Our CRM is
  consent- and suppression-aware and never fabricates a send.**
- RPM point-solutions don't carry the clinic's full record; all-in-ones bolt RPM on.
  **We make severity a backend decision with audit** — a trust differentiator.
- Enterprise EHRs are heavy and slow to configure. **Our platform console +
  entitlements provision a tenant without code.**

## 6. Where we must NOT over-invest yet (focus discipline)

- Full clearinghouse claim **submission** (regulatory + integrations heavy) — partner
  instead.
- Inbound record-network queries (Health Gorilla/Particle scale) — defer to
  enterprise demand.
- Native mobile apps — ship mobile-web-first; our APIs are already mobile-ready.

---

## 7. Conversion summary (the backlog this produces)

| Priority | Item | Module(s) | Why now |
|---|---|---|---|
| BUILD-NOW | Patient self-scheduling on real availability | scheduling, receptionist | Closes the biggest access gap; we have availability primitives |
| BUILD-NOW | Unified intake→eligibility→estimate→deposit flow | intake, insurance, payments | All engines exist; orchestration is the win |
| BUILD-NOW | RPM time-accrual → CPT evidence export | connected-care | Monetizable; readiness model exists; never auto-bill |
| SOON | Self-serve onboarding + Stripe subscription + entitlement enforcement | platform, subscriptions | GTM unlock |
| SOON | Payment plans | payments | Cedar/PayZen parity |
| SOON | Post-visit review request automation | reputation | Growth loop; events already emitted |
| SOON | ROI/value dashboard ($ recovered, no-shows prevented) | intelligence, reporting | Renewal + demo lever |
| SOON | FHIR-shaped read API | interop (new) | Enterprise table stakes seam |
| DIFFERENTIATOR | Backend-orchestrated, audited cross-module flows | all | Our structural advantage |
| VALIDATE | RPM thresholds, triage scripts, escalation SLAs | clinical | Must be doctor-signed before reliance |

Each BUILD-NOW/SOON item must clear the project's evidence threshold (schema →
service → route protection → tenant/RBAC/feature guards → validation → audit →
tests → docs) before being called done.
