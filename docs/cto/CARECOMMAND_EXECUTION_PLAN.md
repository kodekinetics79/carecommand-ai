# CareCommand CTO execution plan

Status date: 2026-11-21

Authoritative starting commit: `659564f1a803482f5942282f3edf6249a8363a54`

Delivery model: one active bounded milestone, evidence-gated advancement

## Product invariant

Every patient contact must end in all of the following:

1. a reconciled communication state;
2. an evidence-backed business outcome;
3. an authoritative appointment or an actionable human work item; and
4. a tenant-safe audit trail.

CareCommand owns workflow, policy, consent, communication orchestration, work,
and outcome evidence. An EHR/PMS remains authoritative for scheduling when a
tenant is configured for external scheduling authority.

## Architecture decision

Keep the existing React/Fastify/PostgreSQL/Prisma application as a modular
monolith with separately deployed workers. Preserve RLS, audit, scheduling,
idempotency, provider adapters, and queue foundations. Do not rewrite the
product or split it into microservices before the core workflow is accepted.

Provider-specific infrastructure remains replaceable:

- Retell: first voice adapter, not the product system of record.
- Redis/BullMQ: durable asynchronous execution and reconciliation.
- EHR/PMS/HIS: authoritative external scheduling adapter when connected.
- Meta/Twilio/Infobip or regional providers: channel transport.
- Payment and payer services: authoritative external outcomes, reconciled into
  CareCommand-owned workflow state.

## Non-hardcoded product standard

Production must not contain hardcoded or fallback patients, clinics,
appointments, providers, services, availability, phone numbers, agent IDs,
scripts, escalation destinations, prices, payer results, or dashboard metrics.

Allowed production constants are limited to enums, validation limits, feature
definitions, error codes, and reviewable default templates. Synthetic data is
permitted only in environment-locked development, CI, staging, and explicitly
labelled UAT tenants.

Every production surface must render truthful loading, empty, not configured,
degraded, stale, permission denied, and source-backed success states.

## Milestone plan

| Order | Milestone | Business outcome | Gate evidence |
| --- | --- | --- | --- |
| CC-00 | Baseline and product truth | Exact deployed code, schema, provider posture, and production failures are known; demo fallbacks are excluded | Full SHA/deployment ID, schema and environment inventory, production health, hardcoded-artifact scan, authoritative control ledger |
| CC-01 | Database trust and canonical spine | Patient, appointment, communication, access case, consent, integration, and work records have one source of truth | Clean/upgrade migrations, RLS CRUD proof, tenant FK proof, state-transition and idempotency tests |
| CC-02 | Canonical scheduling | Staff, portal, and voice tools use the same transaction for availability, booking, confirmation, cancellation, and rescheduling | Headed-browser journeys, persisted outcome, concurrency race, audit, second-tenant denial |
| CC-03 | Telephony control and number binding | CareCommand configures the live voice provider, binds a tenant-owned number, publishes the agent, and reports real provider health | CareCommand UI, provider confirmation, persisted binding, signed webhook, kill switch, audit correlation |
| CC-04 | Outbound appointment conversion | A CareCommand-launched call creates or changes a canonical appointment and reconciles the dashboard | Call, target, patient, campaign, appointment, provider trace, audit, and dashboard all linked |
| CC-05 | Inbound access and unified work queue | Inbound callers complete permitted scheduling work; every unresolved case becomes owned staff work | Destination resolution, identity proof, safe scheduling, transfer/callback evidence, SLA and resolution history |
| CC-06 | Omnichannel continuity | Voice, WhatsApp, SMS, email, and portal continue one access case without conflicting records | Delivery/reply evidence, consent, opt-out, secure links, idempotent callbacks, coherent timeline |
| CC-07 | Patient readiness and revenue | Booked patients complete intake, insurance, eligibility, deposits, and payment steps or enter an exception queue | Document safety, payer provenance, payment reconciliation, appointment-readiness truth |
| CC-08 | Multi-location pilot certification | A second clinic can be configured and operated without source-code changes | Tenant onboarding, scoped roles, integration readiness, restore/rollback, security/accessibility/performance evidence |
| CC-09 | UAE country pack | The accepted product runs in UAE with Arabic/English, RTL, regional data, local channels, and one HIS round trip | Regional data flow, Arabic/English golden journeys, local telephony/WhatsApp, HIS reconciliation, customer/legal acceptance |
| CC-10 | Growth, revenue recovery, and Saudi pack | Proven access workflows expand into governed recovery campaigns; Saudi follows through a qualified country-pack path | Reconciled conversion/revenue metrics, campaign controls, Saudi data/PDPL/Arabic/NPHIES partner evidence |

No milestone advances because code exists or tests are numerous. Acceptance
requires the real interface, the real backend, persisted state, negative and
recovery cases, and evidence bound to the exact deployed candidate.

## Frozen scope

Until CC-08 is accepted, no new feature work is permitted for:

- clinical workspace, labs, or telehealth;
- RPM, devices, or connected-care expansion;
- competitor radar;
- inventory;
- generic AI advisory or autopilot;
- native mobile expansion;
- CRM work outside appointment conversion;
- full EHR/EMR or claims-clearinghouse functionality;
- dashboards without a reconciled KPI dictionary; or
- additional country packs beyond UAE.

Existing code remains unless it creates a security, release, or active-module
blocker. Frozen routes may be hidden from production navigation as part of the
truthful-product-shell work.

## Module gate

Each milestone records:

- baseline and candidate full SHA;
- deployed environment and deployment ID;
- migration and schema identity;
- deterministic synthetic seed version and scenario IDs;
- critical browser journeys and roles;
- API, provider, database, audit, and observability evidence;
- security, tenancy, concurrency, accessibility, and recovery results;
- findings with stable IDs and owners; and
- one outcome: `ACCEPTED`, `CONDITIONAL ACCEPTANCE`, `REMEDIATION REQUIRED`,
  or `BLOCKED`.

No patient traffic is permitted until database isolation, provider contracts,
observability, restore, rollback, and the limited-pilot approval gate pass.
