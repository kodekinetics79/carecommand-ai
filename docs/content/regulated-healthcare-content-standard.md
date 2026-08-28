# Regulated Healthcare Content Standard

Status: product content standard; not legal advice or a compliance certification
Applies to: CareCommand AI staff UI, patient-facing messages, voice prompts, help text, empty/error states, reports, and sales-enablement copy

## Purpose

CareCommand must describe what the system and its external providers actually did. Content must not turn an operational signal into a clinical conclusion, a provider acknowledgment into delivery, a benefit response into guaranteed coverage, a proposed time into an appointment, or a readiness score into certification.

Jurisdiction-specific call, recording, consent, privacy, payment, insurance, telehealth, accessibility, and clinical language requires documented approval by the clinic and qualified counsel before activation. Product copy supports that review; it does not replace it.

## Core voice

- Use short, direct sentences and familiar words.
- Name the actor and the state: “The messaging provider accepted the request,” not “Confirmation sent.”
- Tell the user what happens next and who must act.
- State uncertainty beside the affected value, not in a distant footer.
- Do not use urgency, fear, or revenue pressure to override patient choice.
- Do not expose secrets, full member IDs, unnecessary clinical details, or sensitive data in errors.

## Required semantic distinctions

| Topic | Use | Do not use unless proven |
| --- | --- | --- |
| Appointment | “Requested,” “suggested time,” “held,” or “confirmed appointment” according to the canonical appointment record | “Booked” or “confirmed” for a lead, request, or suggested slot |
| Message | “Queued,” “provider accepted,” “delivered,” “failed,” or “delivery unknown” | “Sent” when only queued or provider-accepted |
| Call | “Provider accepted call request,” “connected,” “completed,” “stop confirmed,” or “status unknown” | “Called,” “stopped,” or “canceled” without provider evidence |
| Eligibility | “Payer response as of [time]” and the response status | “Covered,” “approved,” or “verified coverage” as a payment guarantee |
| Benefits | “Reported copay/deductible/coinsurance” | “Patient owes” or “final cost” before adjudication |
| Estimate | “Estimated patient responsibility” and “recommended collection amount” | “Amount due” unless an authoritative balance exists |
| Prior authorization | “Not started,” “submitted,” “payer approved,” “payer denied,” or “needs review” | “Covered” or “claim approved” |
| Payment | “Link created,” “link delivery status,” “provider reports paid,” “reconciled,” or “failed” | “Collected” based only on a manual click or link creation |
| AI | “AI-generated draft/summary” and “requires staff/clinician review” | “Diagnosis,” “clinical decision,” “doctor-reviewed,” or “safe” from model output alone |
| Monitoring | “Operational alert,” “outside configured threshold,” or “needs clinical review” | “Patient at risk,” “critical condition,” or diagnostic language without clinician determination |
| Billing | “Workflow prerequisites recorded” or “billing review candidate” | “Billable,” “coding compliant,” or “claim ready” without payer/coding review |
| Compliance | “Readiness,” “alignment evidence,” “control self-assessment,” and “gap” | “HIPAA compliant,” “SOC 2 certified,” “GDPR compliant,” or legal conclusions |

## Status copy pattern

Every asynchronous external action must expose these facts when applicable:

1. Current state.
2. Evidence time and source.
3. Whether the state is final or may change.
4. Safe next action.
5. A warning against retrying when provider acceptance is uncertain.

Example: “Delivery unknown. The provider may have accepted this message, but CareCommand did not receive a final receipt. Do not resend until staff reviews the provider record.”

## Voice and messaging requirements

- Identify the assistant as AI and name the clinic before collecting information.
- Use the clinic-and-counsel-approved disclosure verbatim. A prompt is not proof that disclosure was spoken or consent was obtained.
- Record an explicit response where required. Silence, prior unrelated consent, or continued conversation is not affirmative consent.
- Honor opt-out or do-not-contact requests immediately, confirm the preference without pressure, and end outbound promotion.
- Never imply that a transfer, callback, message, confirmation, cancellation, or reschedule succeeded unless the corresponding tool returns success.
- In an emergency, direct the caller to local emergency services immediately. Do not diagnose, triage, or promise that clinic staff will respond.
- Collect only the minimum information needed for the stated task. Never collect full payment-card data or Social Security numbers by voice or free text.
- Recording and transcription activation must remain disabled until jurisdiction, routing, disclosure, retention, access, and deletion requirements are approved and configured.

## Insurance, revenue, and payment requirements

- Show the provider mode: sandbox, mock, or production-connected.
- Show when the payer response was checked and warn that benefits can change and are not a payment guarantee.
- Label copay, deductible, coinsurance, allowed amount, and patient responsibility as payer-reported or estimated.
- Prior authorization approval does not guarantee payment; eligibility does not prove authorization.
- Payment-link creation is not delivery; delivery is not payment; provider-reported payment is not settlement or bank reconciliation.
- Manual payment status changes must be described as staff-recorded unless backed by provider evidence.
- Never promise refunds, coverage, reimbursement, claim acceptance, or a final patient balance.

## Clinical, lab, telehealth, and monitoring requirements

- AI output is administrative support unless a licensed clinician performs and records the clinical act.
- Lab results must be described as received and awaiting clinician review; never “normal,” “safe,” or “ready for action” solely from workflow status.
- Telehealth confirmation means a canonical appointment exists; it does not prove intake, consent, payment, technical readiness, or clinician availability.
- Device readings and thresholds support review; they are not diagnoses or emergency monitoring.
- “Acknowledge” means a staff member saw an alert. “Resolve” means the workflow item is closed; neither proves clinical follow-up.
- RPM readiness is an operational evidence checklist. It does not determine coding, medical necessity, payer coverage, claim eligibility, or reimbursement.

## Accessibility and health literacy

- Target plain language suitable for a general audience; explain unavoidable insurance and compliance terms in place.
- Do not communicate state by color alone. Pair color with text and, where useful, an icon.
- Buttons must name the action and object: “Open scheduling to review” beats “Continue.”
- Errors must say what failed, whether anything may have completed, and a safe recovery step.
- Empty states must distinguish “none exist,” “filters returned none,” “still loading,” and “could not load.”
- Patient messages must support approved language and interpreter workflows. Do not claim that machine translation is clinically validated.

## Approval and release gate

Before a clinic activates regulated communication, the release owner must record:

- clinic owner approval of scripts, offers, escalation paths, hours, and callback expectations;
- qualified-counsel approval for every applicable jurisdiction and channel;
- privacy/security approval for data collection, recording, transcription, storage, retention, access, and deletion;
- clinical leadership approval for escalation and emergency language;
- revenue-cycle approval for eligibility, estimate, prior-authorization, collection, refund, and billing language;
- accessibility and language-access review;
- test evidence covering refusal, withdrawal, opt-out, ambiguity, provider timeout, duplicate action, and human handoff.

Any missing approval is an external activation blocker, not a copy defect to hide.
