# Regulated Content Inventory

This inventory maps high-risk content surfaces to their truthful meaning and approval owner. It is a product/content control, not a legal determination.

| Surface | User | Canonical meaning | Required qualifier | Approval before activation |
| --- | --- | --- | --- | --- |
| AI Front Desk inbox | Staff | Stored conversations and reply workflow | A draft is not sent; a proposed slot is not booked | Clinic operations, privacy |
| Advisory Room | Staff/owner | Operational planning output from a configured model or deterministic rules | Show answer source; rule scores and impact estimates are unvalidated planning heuristics, not clinical, financial, or outcome predictions | Product, clinic operations, privacy for model activation |
| Receptionist Studio prompts | Staff/caller | Configuration used to generate provider prompts/tools | Provider deployment and jurisdiction approval remain separate | Clinic, counsel, privacy, clinical safety |
| Recording/transcription disclosure | Caller | Approved disclosure plus captured caller decision | Prompt text alone is not consent evidence | Counsel per jurisdiction, clinic, privacy |
| Human handoff | Caller/staff | Handoff request/task/transfer result | Never promise a callback or transfer without a successful result | Clinic operations |
| DNC/opt-out | Caller/staff | Durable suppression state | Apply immediately; no persuasion | Counsel, clinic, privacy |
| Appointment suggestion | Staff/patient | Candidate time or scheduling context | Only a canonical appointment is confirmed | Clinic operations |
| Insurance directory | Staff/patient | Payers the clinic says it accepts | Acceptance is not eligibility or payment assurance | Clinic RCM |
| Eligibility result | Staff | Payer/provider response at a point in time | Not a guarantee of coverage or payment | Clinic RCM, payer-contract review |
| Benefits values | Staff/patient | Payer-reported or estimated values | Final responsibility depends on adjudication | Clinic RCM |
| Prior authorization | Staff | Workflow status or payer decision | Approval does not guarantee payment | Clinic RCM, clinical operations |
| Responsibility estimate | Staff/patient | Estimate from recorded benefits/rules | Not a bill or final amount due | Clinic RCM, patient financial policy |
| Payment request/link | Staff/patient | Link creation, delivery, and provider payment evidence | Each is a distinct state | Clinic finance, payment-provider review |
| Revenue dashboards | Staff | Aggregates from stored operational/payment data | Definitions and time window must be visible | Finance/RCM |
| Compliance Readiness Center | Owner/compliance/auditor | Internal control self-assessment and evidence metadata | Not certification or legal compliance opinion | Security/privacy/compliance owner |
| Evidence Vault | Compliance staff | External link/hash metadata and version chain | CareCommand does not custody the evidence file | Compliance owner, security |
| Labs | Clinical staff | Order/report workflow state | Result receipt is not clinician interpretation | Clinical leadership |
| Telehealth | Staff | Appointment and workflow status | Does not prove consent, intake, payment, or technical readiness | Clinical operations, privacy |
| Remote monitoring | Clinical staff | Device readings and operational alerts | Not diagnosis or emergency dispatch | Clinical leadership, device program owner |
| RPM billing readiness | Clinical/RCM staff | Recorded prerequisite checklist | Not coding, medical necessity, claim, or payment approval | RCM/coding, clinical leadership |
| Campaign outreach | Staff/recipient | Audience, consent/suppression, dispatch, and outcomes | Launch authorization is distinct from delivery | Clinic, counsel, privacy, marketing compliance |

## Implemented wording pass

- Insurance acceptance, eligibility, benefit, and estimate copy distinguishes payer response from coverage/payment guarantees.
- AI Front Desk copy distinguishes stored replies and suggested times from provider delivery and confirmed appointments.
- Advisory Room copy exposes answer provenance and labels rule scores, assessments, and impact figures as planning heuristics.
- Compliance Center copy states that scores are internal readiness indicators and evidence records are metadata/version-chain records, not certification.
- Lab, telehealth, monitoring, and RPM copy separates workflow state from clinician judgment and billing eligibility.
- Receptionist prompt copy reports appointment mutation and confirmation-delivery results only from tool evidence.

## External content still required

The repository cannot supply these clinic-specific decisions:

- approved clinic identity, hours, services, locations, prices, refund/cancellation policy, and escalation contacts;
- jurisdiction-by-jurisdiction AI, recording, transcription, SMS, email, and outbound-call disclosures;
- language-access and interpreter policy;
- patient financial responsibility and estimate disclaimer;
- payer-specific eligibility and prior-authorization operating procedures;
- emergency, symptom, refill, result, complaint, minor/guardian, proxy, and accessibility escalation scripts;
- retention/deletion schedule and approved transcript/recording access roles.

Keep these items marked “approval required” until the accountable clinic owner and qualified reviewer sign off. Do not replace them with generic generated language.

## Activation blockers found in this review

- Recording/transcription: the product-controlled prompt asks for permission, and local persistence is consent-gated, but repository content does not prove that the telephony provider avoids recording or transcript processing before the caller's decision. Keep recording and transcription disabled until provider-side behavior, data custody, deletion, and jurisdictional wording are verified.
- Test calls: a “sandbox” label is not evidence that a configured telephony provider will avoid a real call. Test controls must state when an external call can occur and remain restricted to authorized non-production destinations.
- Public intake communication choices: clinic identity is available, but clinic-specific sender details, frequency, help/stop routing, language variants, and jurisdiction/channel terms still require approval before patient activation.
- RPM: the UI now carries emergency and sole-reliance warnings; each clinic still needs an approved escalation protocol, response hours, staffing coverage, device limitations, and patient instructions.
