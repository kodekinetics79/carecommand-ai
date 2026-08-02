# CareCommand AI App Content Design System

Status: pilot working standard
Owner: Product Content Design
Applies to: shared navigation, account access, operator workflows, general operational modules, UI states, and non-clinical product guidance
Regulated companion standards: [regulated-healthcare-content-standard.md](./regulated-healthcare-content-standard.md) and [regulated-content-inventory.md](./regulated-content-inventory.md)

This standard governs product language; it does not certify legal, clinical, security, privacy, accessibility, or regulatory compliance. Final regulated language needs the named approvals in this document and the regulated companion standard.

## Product promise

CareCommand AI helps clinic teams review records, coordinate operational work, and use configured provider integrations from one workspace. The interface must distinguish what the app stores, calculates, suggests, submits, and can actually confirm.

Do not describe configuration as execution, a local record as provider delivery, a score as a professional assessment, or a draft as an approved action.

## Voice

Use a calm, precise, operational voice:

- Start with the user’s task: “Review appointments,” “Create draft,” “Try again.”
- Prefer plain verbs: review, create, record, submit, pause, cancel, retry.
- State scope and evidence: “Loaded reviews,” “latest recorded health check,” “stored risk score.”
- Explain the next safe step when something is unavailable.
- Use sentence case for headings, buttons, tabs, and status labels.
- Use “patient” in clinic workflows, “caller” in call workflows, “lead” before conversion, “clinic” or “workspace” for tenant-facing UI, and “tenant” only in operator tools.
- Use US English for the current pilot: authorization, utilization, program, center, canceled.

Avoid promotional or internal language in task UI: magic, boost, guaranteed, seamless, rails, RLS, TTL, env vars, canonical UUID, attested, full audit trail, and safe by design.

## Evidence ladder

UI claims must use the strongest label the available evidence supports—never a stronger one.

| Evidence | Allowed language | Do not say |
| --- | --- | --- |
| A local form value exists | Draft, entered, selected | Approved, verified |
| A local record exists | Recorded, saved, on file | Sent, delivered, paid |
| Server configuration is detected | Configured, credentials saved | Connected, healthy, ready |
| A provider test succeeded | Latest check succeeded; verified at time shown | Guaranteed, always available |
| Provider accepted a request | Provider accepted/submitted | Delivered, completed |
| Provider supplied a delivery receipt | Delivered at [time] | Delivered when only queued/accepted |
| A stored model/rule score exists | Stored score, rule-ranked, estimated | Diagnosis, certainty, outcome |
| A checklist is complete | Checklist completion | Production ready, compliant, certified |

When evidence is unknown, show “Unknown” or “Not verified.” Do not replace unknown data with a reassuring default.

## Canonical information architecture

Use the same label in sidebar, breadcrumb, page title, command search, and help content.

| Area | Canonical label | Purpose |
| --- | --- | --- |
| Home | Command Center | Workspace overview and prioritized work |
| Advice | Advisory Room | Operational guidance; not professional advice |
| Opportunities | Opportunity Center | Ranked operational opportunities |
| People | Patients | Patient records and access-controlled workflows |
| Calendar | Scheduling | Appointments and provider availability |
| Intake | Patient Intake | Pre-visit information and staff review |
| Front desk | AI Receptionist | Conversation and follow-up operations |
| Setup | Receptionist Studio | Receptionist configuration and deployment evidence |
| Work | Staff Tasks | Staff queues, assignments, and status |
| Growth | CRM | Leads, engagement, and consent-aware follow-up |
| Campaigns | Campaigner | Draft and approved campaign workflows |
| Automation | Autopilot | Configured playbooks, approvals, and recorded activity |
| Reputation | Reviews | Reviews, recorded responses, and request status |
| Market | ClinicRadar | Stored reputation and competitor signals |
| Governance | Control Plane | Access, controls, provider status, and audit records |
| Connections | Integrations | Provider configuration and recorded health |
| Account | Settings | Workspace preferences, access, and configuration |

Regulated modules retain the names defined in the regulated content inventory.

## Page structure

Every operational page should answer, in order:

1. What is this page for?
2. What scope and data state am I seeing?
3. What needs attention?
4. What can I safely do next?
5. What evidence confirms the result?

Page titles name the object or task. Subtitles explain the actual workflow, not a marketing promise. Badges show one current state and must not combine unrelated facts into opaque strings such as “Live DB · 3 Active.”

## State content

### Loading

- Use “Loading appointments…” or “Checking provider status…”
- Apply `role="status"`, `aria-live="polite"`, and `aria-busy="true"` where appropriate.
- Do not show zero as if it were loaded data.

### Empty

An empty state is not an error. Name the scope and next step:

- First use: “No integrations available. Provider records appear after they are added.”
- Filtered: “No matching integrations. Clear the search or choose another category.”
- Valid zero: “No review requests are recorded yet.”

### Error

- Lead with impact: “Scheduling data is unavailable.”
- Add the safe next step: “Try again,” “Review provider logs,” or “Contact an administrator.”
- Put technical detail after the plain-language summary.
- Use `role="alert"` for blocking failures.
- Never silently substitute demo or fallback data.

### Success

Name exactly what changed and what did not:

- “Response recorded in CareCommand. External delivery is not confirmed here.”
- “Campaign draft created. No audience was contacted.”
- “Provider accepted the request. Delivery is not yet confirmed.”

### Partial or ambiguous result

Use an amber, persistent state. Tell the user whether retrying could duplicate an action. If provider acceptance is unknown, say “Do not retry until reconciled.”

## Actions and forms

- Button labels describe the immediate effect: “Create draft,” not “Launch”; “Open scheduling,” not “Book” when only navigating.
- Destructive or externally visible actions need confirmation that names scope and consequences.
- Labels must remain visible; placeholders provide examples only.
- Add help before high-risk fields, not after failure.
- Disable an unavailable workflow with a reason in nearby text. Never leave a working-looking control that changes only local UI state.
- Busy labels use the same verb: Create → Creating…, Record → Recording…, Verify → Verifying….
- Success and failure messages belong next to the action and use live-region semantics.

## Status vocabulary

Use these integration states consistently:

- Not configured — required configuration is missing.
- Configuration detected — configuration exists; connectivity is not proven.
- Sandbox check succeeded — latest sandbox check succeeded at the displayed time.
- Production verification pending — production activation or check is incomplete.
- Healthy — latest defined health check passed; future requests are not guaranteed.
- Degraded — a defined health check reported a problem.
- Unknown — no current evidence supports another state.

For records, use Draft, Pending review, Approved, Scheduled, Submitted, Provider accepted, Delivered, Failed, Suppressed, Canceled, and Reconciliation required only when the backend state supports that label.

## AI and automation language

- Label generated content “Suggested” or “Draft” and require review where applicable.
- Identify the source of scores and estimates. Show method, period, and scope when available.
- Do not claim that AI “learns,” “decides,” “prevents,” “recovers,” or works “24/7” unless current executable evidence proves the claim and product/legal owners approve it.
- Never use “AI confidence” when the number is inferred from severity or hardcoded.
- A design diagram is “How this playbook is configured,” not an execution trace.
- A stored outcome value is “associated value,” not “recovered revenue,” unless attribution evidence proves recovery.

## Claim safety

The following require evidence review and named approval before publication:

- secure, encrypted, immutable, tamper-proof, audit-ready, compliant;
- HIPAA compliant, SOC 2 compliant/certified, GDPR compliant;
- prevents denials, recovers revenue, reduces no-shows, improves outcomes;
- autonomous, human-free, always on, 24/7;
- sent, delivered, paid, booked, canceled at provider;
- no PHI, no violations, all controls operational, production ready.

Preferred patterns:

- “Role-based access and recorded account activity” instead of “secure and audit-ready.”
- “Designed for summary setup data; do not enter patient information” instead of “No PHI is exposed.”
- “The checks shown returned no alerts” instead of “Security posture is clean.”
- “Checklist completion” instead of “go-live readiness.”

## Accessibility and localization

- Do not rely on color alone; pair icons with visible state text.
- Icon-only controls need action-specific accessible names.
- Dialogs need a name, initial focus, keyboard containment, Escape behavior where safe, and focus return.
- Do not advertise arrow-key or Enter behavior until implemented.
- Avoid symbols as the only relationship cue; localize dates, times, numbers, and currencies.
- Show the clinic timezone for appointment, outreach, and quiet-hours decisions.
- “Remember me” should state what is retained, for example “Remember email on this device.”
- User-authored text must not be used as an accessible label without a stable action prefix.

## Pilot content gates

Before a pilot walkthrough:

- Remove or clearly label all synthetic metrics and examples.
- Show tenant/workspace, branch, timezone, provider mode, and data-state context.
- Verify loading, valid-empty, partial, error, permission-denied, unknown, and success states.
- Ensure navigation-only buttons say Open or Review, not Run, Launch, Send, or Book.
- Confirm provider-facing actions use durable evidence and show reconciliation states.
- Freeze approved receptionist, outreach, insurance, payment, privacy, and emergency wording.
- Complete keyboard, screen-reader, zoom, mobile, and contrast testing.

## Current implementation inventory

This content pass changed the following general surfaces:

- Global IA: aligned Advisory Room, Scheduling, and Staff Tasks labels; removed the misleading Autopilot live dot.
- Command search: removed fabricated counts and unsupported keyboard instructions; added dialog and input labels.
- Login: removed 24/7, recovery, denial-prevention, secure, and audit-ready claims.
- Integrations and Settings: separated configured, recorded healthy, mock, sandbox, and production states.
- Scheduling and Reviews: replaced “Live DB” jargon with task/data states and removed fixed trend/referral metrics.
- ClinicRadar: removed fabricated value, confidence, dates, health scores, and guardrail-success claims.
- Autopilot: removed the UI-only pause/resume control and recast configuration values as stored or estimated.
- Advisory Room: exposes model-versus-rule provenance and labels confidence and impact values as unvalidated planning heuristics.
- Inventory: removed controls that falsely increased stock while claiming to place an order.
- Platform login and pilot status: removed absolute audit/security/readiness claims and added checklist limitations.
- Control Plane: reframed readiness as selected configuration checks with an explicit non-certification disclaimer.

The regulated content inventory documents the separate changes to receptionist, insurance, revenue/payment, compliance, intake, monitoring, labs, telehealth, and campaign consent language.

## Required external approvals

Agent review is not approval. Obtain, record, version, and date:

- Product and pilot operations owner approval for taxonomy, workflows, and demo claims.
- Healthcare/privacy counsel approval for PHI-facing notices, retention, transcripts, and patient communications.
- Telemarketing and recording counsel approval by jurisdiction for consent, DNC, quiet hours, AI/prerecorded voice, recording, and opt-out wording.
- Clinical safety/medical director approval for emergency, monitoring, lab, triage, and sole-reliance language.
- Security/privacy owner approval for any security, encryption, audit, retention, or data-exclusion claim.
- Payer/RCM and legal approval for eligibility, benefits, authorization, estimates, and payment language.
- Reputation/marketing counsel approval for review, referral, offer, and testimonial workflows.
- WCAG 2.2 AA specialist review and testing with representative assistive technology.
- Pilot clinic brand and operations approval for clinic identity, escalation, hours, timezone, and handoff language.

Record approvals outside source copy with approver, role, artifact version/hash, jurisdiction/scope, decision, date, and expiry/review date.
