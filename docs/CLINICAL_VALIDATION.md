# Clinical & Operational Validation Pack

Prepared by the healthcare-workflow + clinic-operations + revenue-cycle + RPM
consultants for structured review with **real doctors, nurses, front-desk, billing
managers, and clinic owners**. The engineering board cannot self-certify clinical
correctness; the items here are **assumptions encoded in the backend today** plus
the **questions that must be answered by practicing clinicians** before any
assumption is relied upon in production.

> Status convention used throughout: **[ASSUMPTION — needs clinical validation]**
> marks something the code currently does that a clinician must confirm.
> **[DECISION — do not finalize]** marks a choice we must not lock without
> customer/clinician sign-off.

How to use: run the role interviews below with 3–5 representatives per role across
at least two specialties (e.g., primary care + one specialty such as cardiology or
endocrinology for RPM). Capture answers against each assumption and convert to
schema/threshold/workflow changes through the normal evidence-threshold pipeline.

---

## 1. Physician (MD/DO) interview guide

Goal: reduce clicks, fit real visit flow, keep the doctor out of administrative work.

1. Walk us through a typical visit start-to-finish. Where does software help vs. get
   in the way today?
2. At the point of care, what are the **top 3 things you must see in under 5 seconds**
   (e.g., reason for visit, last readings, meds, allergies, balance/eligibility)?
3. Morning briefing: if the system could surface a short list before clinic, what
   belongs on it — and what would be noise? *(We build `MorningBriefingSignal` from
   operational data — validate the signal set.)*
4. Follow-up tasks: how do you currently track "circle back with this patient"? Who
   owns it after the visit?
5. RPM/remote readings: which conditions do you actually want to monitor remotely,
   and **at what numeric thresholds do you want to be alerted** vs. let the nurse
   handle? *(Drives `MonitoringRule`/`evaluateSeverity`.)*
6. Alerts: what would make you trust (or ignore) an automated severity label? What's
   the cost of a false "critical"?
7. AI assistance: where is AI welcome (drafting, summarizing, surfacing) and where is
   it unacceptable without your explicit approval? *(We default to human approval +
   PHI off.)*
8. What makes you abandon a product in week one?

**Assumptions to confirm:**
- [ASSUMPTION] Severity bands (normal/warning/critical) and the specific
  glucose/BP/etc. thresholds in `server/lib/monitoring.ts` are clinically
  appropriate and conservative enough. **Must be condition- and patient-specific —
  current global defaults are placeholders.**
- [ASSUMPTION] Morning-briefing signals (no-show risk, unverified eligibility,
  overdue follow-ups, revenue at risk) are the right priorities for a physician's
  pre-clinic glance.
- [DECISION — do not finalize] Whether the physician or the nurse is the default
  owner/first-responder for each alert type.

---

## 2. Nurse / Medical Assistant interview guide

Goal: support triage, follow-up, readings review, tasks, escalations.

1. Describe your daily task queue. How do you prioritize across patients?
2. For remote readings: what should auto-resolve, what needs your review, and what
   must escalate to the provider immediately?
3. How do you want to acknowledge/snooze/resolve an alert? What audit do you need on
   who did what?
4. Patient outreach (recalls, reminders, results): what channels and what consent
   rules must we respect?
5. What information must travel with an escalation so the provider doesn't have to
   dig?

**Assumptions to confirm:**
- [ASSUMPTION] The alert lifecycle (open → acknowledged → resolved) and the
  nurse-review queue model match real triage behavior.
- [ASSUMPTION] Escalation thresholds and the "who gets paged" rules.
- [DECISION — do not finalize] SLA timers for acknowledging critical readings.

---

## 3. Front-desk / patient-access interview guide

Goal: intake, scheduling, insurance, reminders, documents, communication.

1. Walk through booking a new vs. returning patient. Where do you lose time?
2. Self-scheduling: would you let patients self-book, and with what guardrails
   (visit types, provider rules, buffers, pre-visit requirements)?
3. Intake: which forms/consents are mandatory before a visit? What's acceptable to
   collect on the patient's phone vs. in office?
4. Insurance: at what point do you verify eligibility, and what do you do when it
   fails or is uncertain?
5. Reminders/no-shows: what cadence actually reduces no-shows without annoying
   patients? What are your consent constraints?
6. Deposits/payments: do you collect anything up front today? What would make that
   comfortable for staff and patients?

**Assumptions to confirm:**
- [ASSUMPTION] The intake → consent reconciliation → eligibility → estimate →
  deposit ordering matches the desk's real sequence.
- [ASSUMPTION] No-show risk signals are actionable, not just informational.
- [DECISION — do not finalize] Default reminder cadence and channels per visit type.

---

## 4. Billing / revenue-cycle manager interview guide

Goal: eligibility, estimates, deposits, claims readiness, denials, RPM billing,
revenue protection.

1. Where does revenue actually leak today (missed deposits, unverified eligibility,
   no-shows, uncaptured charges, denials)?
2. Patient-responsibility estimates: how accurate must they be to be useful, and
   what data do you trust them from?
3. Deposits/payment plans: what policies (amount, who's exempt, refunds) are
   realistic?
4. Denials: which front-end checks would prevent the most denials for your payers?
5. RPM billing: how do you currently substantiate CPT 99453/99454/99457/99458 (time,
   16-day reading rule)? What evidence do you need exported?
6. What must NEVER be auto-submitted on your behalf?

**Assumptions to confirm:**
- [ASSUMPTION] Rule-based denial-risk heuristics in `insuranceIntelligence`
  meaningfully predict denials for the customer's payer mix.
- [ASSUMPTION] `RPMBillingReadiness` captures the right evidence for CPT
  substantiation. **Time-accrual is not yet implemented — confirm requirements.**
- [DECISION — do not finalize] Deposit amounts/exemptions; never auto-submit claims.

---

## 5. Clinic owner / administrator interview guide

Goal: visibility into revenue, workload, risk, retention, staff performance.

1. What 5 numbers do you check weekly to know the practice is healthy?
2. How do you measure missed revenue opportunities and patient retention today?
3. Multi-location: how do you think about staff access, scheduling, and reporting
   across branches?
4. What would make you switch from your current system — and what would make
   switching too risky?
5. What does "ROI proven" look like for you at renewal?

**Assumptions to confirm:**
- [ASSUMPTION] Branch/location scoping and per-branch reporting match how
  multi-site clinics actually operate. *(We have branch scope + `UserClinicAccess`;
  multi-branch-per-user access is still thin.)*
- [ASSUMPTION] The "$ recovered / no-shows prevented / RPM enabled" metrics are the
  ones owners will renew on.

---

## 6. Patient-workflow validation guide

1. Would you self-schedule, self-intake, and pay a deposit from your phone? What
   stops you?
2. What communication (channel, frequency) is welcome vs. spam?
3. For remote monitoring: what's the minimum-friction way to submit readings, and
   what feedback do you expect?
4. Right-of-access: if you requested all your data, what format/contents do you
   expect? *(We now expose a HIPAA data-access export — validate contents.)*

---

## 7. Specialty-specific workflow assumptions (high-risk)

| Specialty | Assumption encoded / implied | Must validate |
|---|---|---|
| Primary care | General visit + recall + RPM thresholds | Threshold defaults; recall cadence |
| Cardiology | BP/weight RPM, escalation on trend | Per-patient thresholds, trend windows |
| Endocrinology | Glucose RPM bands (see `monitoring.ts`) | Hypo/hyper bands, time-in-range needs |
| Behavioral health | Consent sensitivity, 42 CFR Part 2 | Stricter consent/segmentation of PHI |
| Multi-site groups | Branch scope + cross-branch reporting | Access model, scheduling across sites |

**42 CFR Part 2 / behavioral-health PHI segmentation is a [DECISION — do not
finalize] without legal + clinical review** — our current model treats PHI
uniformly.

---

## 8. High-risk assumptions requiring real human validation (consolidated)

1. **RPM severity thresholds** (`monitoring.ts`) — clinical safety. *Highest risk.*
2. **Alert escalation rules + ownership** (who responds, how fast).
3. **Denial-risk heuristics** — financial accuracy per payer.
4. **Deposit/financial policies** — patient-experience + compliance.
5. **Reminder cadence/consent** — TCPA / patient experience.
6. **Behavioral-health / Part 2 PHI handling** — legal segmentation.
7. **Self-scheduling guardrails** — provider acceptance.

## 9. Decisions that must NOT be finalized without clinic feedback

- Any clinical threshold or escalation timing.
- Default deposit amounts/exemptions and refund policy.
- Which AI outputs may act without human approval (current default: none act
  without approval; keep until validated otherwise).
- PHI segmentation for sensitive specialties.
- Claim auto-submission (current decision: **never** — do not change without billing
  + legal sign-off).

---

Until these interviews are completed and logged, every item above remains marked
**needs clinical validation** and must not be presented to customers as clinically
endorsed. Engineering will keep thresholds and policies **config-driven** (not
hard-coded) so clinician feedback can be applied without redeploys where possible.
