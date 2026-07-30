# CareCommand AI — Pilot Readiness & Superiority Backlog

> **Superseded planning snapshot.** The current release decision is maintained
> in [`docs/testing/RELEASE_READINESS_REPORT.md`](testing/RELEASE_READINESS_REPORT.md)
> and is **NO-GO for real PHI, production launch, or unattended autonomous
> receptionist operation**. The conditional language below is retained only as
> historical planning context for an attended synthetic-data pilot.

_Prepared by CTO + Sales Director (Kode Kinetics) after a full autonomous engineering + independent-expert review pass. Branch: `feat/security-observability-hardening` (uncommitted). Verification at time of writing: server + frontend typecheck clean, lint clean, **251/251 tests passing (43 files)**, 56 migrations applied and coherent._

---

## 1. Verdict: CONDITIONAL GO for an attended, low-volume pilot

The **core is genuinely strong and honest** — tenant isolation is uniform across ~900 data-access sites, auth/MFA/RBAC/entitlements/audit are real, migrations are forward-only, env-boot validation is rigorous, and the limitations docs are candid. The engagement closed the disqualifying security and money/safety defects. What remains is concentrated in **(a) fabricated demo surfaces** (being relabeled/hidden), **(b) a frontend-wiring gap** where real, working endpoints aren't reachable from the UI, and **(c) an operational envelope** that needs real provisioning (owner actions).

**Do NOT** run this as unattended enterprise validation, on real PHI, or on either shipped deploy config as-is, until the owner actions in §4 are done.

---

## 2. What was fixed and verified this pass (all green)

**Security / compliance**
- Portal token security: production magic-token outbox blocked at boot; single-use tokens made atomic (compare-and-set); audit failures now block regulated actions.
- **Device/RPM webhook fail-open → fail-closed** (was: unauthenticated cross-tenant clinical-reading + fake-alert injection).
- **AI receptionist `/fn` + Retell webhooks fail-closed**; SMS-injection defense; per-route rate limits; prompt-injection integrity clause.
- PHI-read auditing + read-RBAC enforcement (previously cosmetic) + `/audit-log` gated.
- Cross-module opt-out/consent enforcement centralized in `sendMessage`; E.164 validation.
- Deployment-profile boot gates (`pilot`/`enterprise` refuse unacknowledged mock providers; enterprise forbids mock payments); `/health/integrations` posture endpoint.

**Money integrity (finance)**
- Revenue double-count fixed; AR over-count fixed; **cents preserved** (no more whole-dollar rounding); segregation-of-duties on manual "collect" (FRONT_DESK can't fabricate revenue); **`charge.refunded` / `charge.dispute.created` handled**; actual settled amount reconciled; invented Stedi coverage fallbacks removed; outstanding-balance reconciliation; RevenuePulse "Live DB" fabrication relabeled.

**Patient safety (RPM)**
- Diastolic BP now scored (hypertensive crisis alerts); weight (CHF delta) + ECG (arrhythmia) bands; **missed-reading + device-offline detector jobs** (watch for absence of data); reading dedup.

**Correctness**
- **DB exclusion constraint** stops provider double-booking across all four booking paths; reschedule conflict check; "Live DB Customer" name bug fixed; patient `dateOfBirth` field added.

**AI-honesty**
- "Send AI Reply" now actually delivers (or truthfully records non-delivery — no more inflated "AI recovered"); Advisory routed through the PHI-guarded governed gateway with honest "rule-based estimate" labeling; fabricated charts relabeled; `openai`/`claude` providers wired with graceful errors.

**RLS architecture**
- Caught and defused a migration that would have taken production down at the intended `app_rls` cutover; PHI-table RLS deferred with a documented corrective migration; application-level tenant isolation is the enforced, tested interim control. See [KNOWN_LIMITATIONS_REGISTER](KNOWN_LIMITATIONS_REGISTER.md).

---

## 3. Truthful capability matrix (for buyer-facing claims)

| Area | Status | Notes |
|---|---|---|
| Auth / MFA / RBAC / entitlements | **Real** | Enforced server-side; read-RBAC now blocks |
| Tenant isolation | **Real (app-level)** | Uniform; DB-RLS on PHI deferred (documented) |
| Audit trail | **Real** | Append-only DB trigger; PHI reads now audited |
| AI receptionist (inbound + live booking) | **Real** | Signature-verified, conflict-safe, opt-out-aware |
| SMS / comms delivery | **Real when Twilio configured** | Truthful; never fakes "sent"; consent-gated |
| Payments (take a Stripe payment) | **Real when Stripe configured** | Now cents-correct, refund/dispute-aware, SoD-gated |
| Insurance eligibility | **Real via Stedi when configured** | No longer fabricates missing fields; else honest `setup_required` |
| Scheduling / self-book | **Real** | DB-level double-book prevention; **timezone still UTC-assumed** |
| RPM abnormal-reading alerting | **Real** | Now incl. diastolic/weight/ECG + absence-of-data detection |
| Autopilot execution | **Not real** | Execute is a no-op; approvals seed-only — scope OUT or relabel |
| Advisory | **Rule-based** | Honestly labeled; free-text via governed gateway |
| Telehealth video | **Not built** | No video/join link — scope OUT of pilot |
| Campaigner (legacy page) | **Mockup** | Hide for pilot; real engine is `/v1/crm` |
| Patient portal login | **Blocked in prod** | Magic-link never delivered — see §4 |

---

## 4. Owner actions (only you can do these — I can't provision infra/credentials)

1. **Stand up ONE always-on stack** (always-on API + worker, Neon pooled URL, persistent Redis, `DEPLOYMENT_PROFILE=pilot`). On the shipped Vercel config `QUEUES_ENABLED=false`, so autopilot/campaign/compliance **and the new RPM safety detectors** silently never run. Verify via `/health/integrations` + `/metrics` queue depth.
2. **Run one backup + restore drill** (Neon PITR or dumps) and capture evidence — the backup job is a placeholder today.
3. **Provide integration credentials** for whatever the client must see live: Stripe, Stedi, Retell, **Twilio (also unblocks patient portal login + magic-link delivery)**.
4. **Rotate secrets** the readiness doc admits were shared in chat; confirm DB encryption-at-rest + BAAs before real PHI.
5. **Wire Sentry + Prometheus receiver** (alerts are authored, not provisioned).

---

## 5. Ranked superiority backlog (from 5 SME + 3 UAT expert reviews)

### P0 — pilot-blocking (fix or honestly scope-out before a buyer touches it)
- **Portal magic-link delivery** — wire `sendMessage` into portal auth (needs Twilio/email). Without it, no patient can log in. _(S, code; credential = owner)_
- **Frontend wiring gap** — the schedule/patient screens don't call existing endpoints: no check-in/cancel/reschedule/no-show buttons, no provider selector on booking, no patient-edit form, no intake-origination button. Backend is done; this is a focused UI sprint. _(M–L)_
- **Telehealth** — build real video/join-link OR remove the surface + its fabricated data. Recommend scope-out. _(L or S)_
- **Autopilot** — execution is a no-op; either implement bounded real actions + a runtime approval creator, or relabel as "preview/governed-manual." Recommend relabel for pilot. _(L or S)_
- **Campaigner mockup** — rewire "Launch" to the real `/v1/crm` engine or hide the page. _(M or S)_
- **CRM inbound STOP handling** — no webhook captures SMS STOP though templates say "Reply STOP" (TCPA/A2P exposure). _(M)_
- **Portal pay-link 404** — wrong prefix (`/public/checkout` vs `/v1/payments/public/checkout`) + no checkout page. _(S–M)_

### P1 — competitive parity / material gaps
- **Timezone correctness** — clinic time is UTC-assumed while `Branch.timezone` exists; real clinics get slots off by hours. Thread IANA zone through slot math + the exclusion range. _(M)_
- **Scheduling**: recurring/series appts, appointment types w/ durations+buffers, working-hours/time-off management UI, waitlist model + auto-fill, reminders/confirmations + no-show prediction. _(M–L each)_
- **Finance**: patient AR aging (30/60/90), receipts/invoices, payment plans/partial payments, double-entry GL, payout/settlement reconciliation vs Stripe (refund/dispute matching may need providerReference broadening). _(M–L)_
- **RPM**: alert escalation + on-call routing (dead `escalationMinutes`/`assignedRole` fields), CMS code capture (99453/54/57/58) vs one READY flag, device provisioning/shipment lifecycle. _(M–L)_
- **CRM**: campaign→booking→revenue attribution (dead columns), per-lead consent truth + lead ownership/assignment/SLA, source attribution, lost-reason, review-request automation, deliverability throttling, nurture cadences. _(M–L)_
- **Patient experience**: self-reschedule/cancel, in-portal fillable intake, document/image capture + e-signature, appointment reminders, language preference. _(M–L)_
- **Reliability**: autopilot approve→execute reconciler (crash-safe); queue campaign dispatch + pilot import (currently inline sync); per-tenant rate/pool quotas; N+1 hotspots (receptionist `/overview`, monitoring `/patients-at-risk`, connected-care `/rpm-readiness` write-on-GET). _(S–M)_

### P2 — polish / roadmap
- Deposit-evaluate role inconsistency (FRONT_DESK 403 on a shown button); WhatsApp routing (`whatsapp:` prefix) bug; hardcoded UI panels (Revenue/Labs/Inventory/Scheduling "AI" tiles) relabel; A/B testing; dedup/merge; activity timelines; bulk import/export; PRODUCTION_READINESS.md permission-editor claim contradicts code (truth-up); circuit breakers on outbound providers.

---

## 6. Recommended pilot framing (Sales)

Sell the **strengths honestly**: enterprise-grade security/isolation/audit, a real AI receptionist that books conflict-safe and honors opt-outs, cents-correct/refund-aware payments, and RPM that now catches both bad readings and the dangerous *absence* of readings. Scope the pilot to those flows. Explicitly exclude Telehealth video, Autopilot auto-execution, and the legacy Campaigner from the demo, and label eligibility/advisory outputs as estimates. Do not show any dashboard figure that isn't computed from real data.
