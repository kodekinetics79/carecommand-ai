# CareCommand AI Authoritative Module Registry

Generated from commit `e3dad8d574b6050072000b442c2276caf19d0792` (`rc/pilot-convergence-2026-07-30`) by inspecting the React router/navigation, Fastify registrations and route handlers, Prisma schema, workers/schedulers, feature catalog, integration configuration, tests, migrations, and release evidence. This is an ownership registry, not a claim that every discovered feature satisfies the production Definition of Done.

## Registry rules

- `Primary owner` is exclusive. A route, endpoint, model, job, feature flag, or integration may be consumed by other modules but has exactly one primary module below.
- `COMPLETE` is used only where executable evidence and an independent decision already exist. A rendered page, compiled handler, model, or passing broad crawl is not completion evidence by itself.
- `IN DISCOVERY` means the surface is real but feature-level Definition-of-Done evidence has not yet been reconciled.
- `EXTERNAL BLOCKED` is limited to an otherwise internally complete capability that needs credentials, contracts, legal determinations, organizational approval, or a managed external environment.
- Pods are dedicated ownership constructs. Embedded consultants advise implementation; independent reviewers must not author the feature they review.
- Detailed sequential features and evidence gaps are in `docs/completion/modules/<module>/FEATURE_INVENTORY.md`; current feature states are mirrored in `MASTER_COMPLETION_LEDGER.md`.

## Dependency waves

```text
Wave 0: M01 foundation, M02 identity, M23 database/RLS, M24 release engineering
   |
Wave 1: M03 platform, M04 organization, M05 workforce, M06 patient master, M20 entitlements
   |
Wave 2: M07 scheduling, M08 clinical, M09 receptionist, M10 portal, M11 CRM/comms,
        M12 insurance, M13 revenue/payments, M14 connected care, M15 AI/autopilot
   |
Wave 3: M16 command analytics, M17 reputation, M18 integrations/operations,
        M19 compliance/lifecycle, M21 observability/workers, M22 localization/accessibility
```

Wave ordering constrains shared contracts, not all work: discovery and isolated tests may proceed in parallel. Prisma/migration/RLS changes belong solely to the Database, Prisma and RLS Council; shared auth, router, CI, environment, and design-system changes require their central owner.

## Dedicated module-to-team assignment

| ID | Module / business purpose | Dedicated delivery pod | Embedded Consultant SME | Independent Consultant SME | Wave | Current verdict |
|---|---|---|---|---|---:|---|
| M01 | Shared Application Foundation — common API/runtime, shell, validation, errors, pagination, security primitives | Foundation Pod: platform lead, backend, frontend shell, QA, security, reliability | Enterprise SaaS application architect | Independent application-architecture reviewer | 0 | IN DISCOVERY |
| M02 | Authentication, Identity and Sessions — staff login, MFA, reset, tokens, CSRF, revocation | Identity Pod: IAM lead, backend, frontend, database, QA, privacy | IAM/zero-trust/MFA/session-security consultant | Independent identity penetration-test consultant | 0 | IN DISCOVERY; core staff authentication independently accepted |
| M03 | Platform Administration, Onboarding and Pilot Operations — operator plane, tenant provisioning, import/share | Platform Pod: SaaS control-plane lead, backend, frontend, data, QA, FinOps | Enterprise multi-tenant SaaS and customer-onboarding consultant | Independent control-plane security reviewer | 1 | IN DISCOVERY; platform isolation/auth controls independently accepted |
| M04 | Tenant, Clinic, Location and Service Catalog — organizational master data and clinic topology | Organization Pod: clinic-operations lead, backend, frontend, data-integrity, QA | Multi-site medical-practice operations consultant | Independent tenant-lifecycle/data-integrity reviewer | 1 | IN DISCOVERY |
| M05 | Workforce, Providers, Staff, Roles and Permissions — team master, access and productivity | Workforce Pod: workforce lead, IAM engineer, backend, frontend, QA, UX | Medical-practice workforce and RBAC consultant | Independent least-privilege/workflow reviewer | 1 | IN DISCOVERY |
| M06 | Patient Master, Consent and Intake — patient identity, intake packets, documents and subject access | Patient Data Pod: patient-identity lead, backend, frontend, privacy, QA | HIM/patient-registration/consent consultant | Independent patient-identity and privacy reviewer | 1 | IN DISCOVERY; intake authorization/acknowledgement controls accepted |
| M07 | Scheduling and Appointments — policies, availability, booking, changes and deposits contract | Scheduling Pod: scheduling lead, backend, frontend, concurrency, QA | Medical front-desk and scheduling-operations consultant | Independent scheduling/concurrency reviewer | 2 | IN DISCOVERY; collision and canonical booking controls accepted |
| M08 | Clinical Workspace, Labs and Telehealth — provider workspace and explicitly limited clinical surfaces | Clinical Pod: clinical informatics lead, physician/nurse SME, backend, frontend, QA, safety | Practicing physician and clinical-informatics consultant | Independent clinical-safety reviewer | 2 | IN DISCOVERY |
| M09 | AI Receptionist and Telephony — inbound/outbound voice, consent, identity, tools and handoff | Receptionist Pod: telephony lead, receptionist SME, backend, frontend, QA, safety | Medical receptionist/call-center/Retell consultant | Independent telephony privacy and clinical-safety reviewer | 2 | IN DISCOVERY; protected autonomous core accepted, live provider activation external |
| M10 | Patient Portal — separate identity, self-service scheduling, intake, insurance and payments | Portal Pod: patient-experience lead, backend, frontend, accessibility, privacy, QA | Patient-experience and digital-accessibility consultant | Independent portal privacy/accessibility reviewer | 2 | IN DISCOVERY |
| M11 | CRM, Campaigns, Messaging and Patient Acquisition — pipeline, consent, outreach and delivery | Growth Pod: CRM lead, comms engineer, backend, frontend, QA, privacy | Healthcare CRM/outreach/comms compliance consultant | Independent consent/delivery reviewer | 2 | IN DISCOVERY; live communications external |
| M12 | Insurance, Eligibility and Prior Authorization — coverage, payer and benefits workflow | Insurance Pod: RCM eligibility lead, backend, frontend, integration, QA | Payer eligibility/prior-authorization consultant | Independent payer-workflow/data-integrity reviewer | 2 | IN DISCOVERY; live payer activation external |
| M13 | Revenue Cycle, Billing, Deposits and Payments — estimates, money state and reconciliation | Revenue Pod: healthcare finance lead, backend, frontend, accounting-control, QA | Healthcare RCM/Stripe/reconciliation consultant | Independent payment-security/accounting reviewer | 2 | IN DISCOVERY; money concurrency accepted, live rails external |
| M14 | Connected Care, RPM, Devices and Monitoring — enrollment, readings, alerts and billing evidence | Connected Care Pod: RPM lead, device integration, clinical, backend, frontend, QA | RPM clinical and device-integration consultant | Independent RPM safety/evidence reviewer | 2 | IN DISCOVERY; fixed-period evidence core independently accepted, vendors external |
| M15 | AI Advisory, Recommendations, Guardrails and Autopilot — governed decision support and approved actions | AI Governance Pod: AI platform lead, backend, frontend, safety, evaluation, QA | Healthcare AI governance/prompt-safety consultant | Independent AI safety/model-risk reviewer | 2 | IN DISCOVERY |
| M16 | Command Center, Operations, Opportunities and Analytics — cross-domain operational intelligence | Command Analytics Pod: operations analytics lead, backend, frontend, data, QA | Medical-practice COO/analytics consultant | Independent analytics-truthfulness reviewer | 3 | IN DISCOVERY |
| M17 | Reputation, Reviews and Competitive Intelligence — reviews, response, cases and market radar | Reputation Pod: patient-experience/reputation lead, backend, frontend, QA | Healthcare reputation and competitive-intelligence consultant | Independent consumer-protection/analytics reviewer | 3 | IN DISCOVERY |
| M18 | Inventory, Partner Reports and Tenant Integrations — operational inventory and integration registry | Integration Operations Pod: integration lead, backend, frontend, QA, reliability | Healthcare integration/vendor-operations consultant | Independent API/webhook/reliability reviewer | 3 | IN DISCOVERY |
| M19 | Audit, Privacy, Compliance and Data Lifecycle — evidence, risks, incidents, retention and access review | Compliance Pod: privacy/security lead, backend, data, QA, governance | HIPAA/GDPR/SOC 2 technical-controls consultant | Independent privacy/audit-evidence reviewer | 3 | IN DISCOVERY; mandatory audit durability accepted, organizational evidence external |
| M20 | Subscription, Usage, Entitlements and Feature Flags — commercial plans and server-enforced access | Entitlements Pod: SaaS billing lead, backend, frontend, data, QA | SaaS subscription/FinOps/customer-success consultant | Independent entitlement/billing-control reviewer | 1 | IN DISCOVERY |
| M21 | Monitoring, Logging, Health, Workers and Queues — service telemetry and durable background execution | Reliability Pod: SRE lead, worker engineer, observability, security, QA | SRE/incident-response/observability consultant | Independent production-reliability reviewer | 3 | IN DISCOVERY; managed alert delivery external |
| M22 | Localization, Preferences and Accessibility — language, formatting and accessible application behavior | Experience Pod: UX lead, frontend, i18n, accessibility, QA | WCAG/assistive-technology/localization consultant | Independent accessibility auditor | 3 | IN DISCOVERY; formal WCAG audit external |
| M23 | Database, Prisma and Row-Level Security — schema lifecycle and tenant enforcement | Database Council Pod: PostgreSQL security architect, Prisma engineer, DBA, QA | PostgreSQL/RLS/data-integrity consultant | Independent database security reviewer | 0 | COMPLETE for current local 69-migration/119-table baseline |
| M24 | Infrastructure, Deployment, CI/CD, Backup and Release — reproducibility, rollback and recovery | Release Engineering Pod: release lead, SRE, cloud security, QA, DR | Cloud SRE/backup/DR/release consultant | Independent production-acceptance reviewer | 0 | IN DISCOVERY; managed production evidence external |

## Exclusive frontend route ownership

Aliases and child routes inherit the owner shown. The wildcard redirect and authenticated/public layout guards belong to M01.

| Module | React routes owned |
|---|---|
| M01 | `*` redirect; protected/public layout boundary |
| M02 | `/login` |
| M03 | `/pilot/:token`, `/platform/login`, `/platform`, `/platform-legacy` |
| M04 | No standalone route; organization editor is consumed by M03/M05/M09 surfaces |
| M05 | `/staff`, `/doctor-workspace`, `/control-plane`, `/admin` |
| M06 | `/patients`, `/patients/:id`, `/patient-intake`, `/intake/:token` |
| M07 | `/scheduling` |
| M08 | `/labs`, `/telehealth` |
| M09 | `/ai-receptionist`, `/receptionist-studio` |
| M10 | `/client/login`, `/client`, `/client/appointments`, `/client/requests`, `/client/intake`, `/client/insurance`, `/client/payments`, `/client/profile`, `/client/preferences` |
| M11 | `/crm`, `/campaigner`, `/reactivation` |
| M12 | `/insurance`, `/insurance-eligibility` |
| M13 | `/revenue`, `/revenue-protection` |
| M14 | `/monitoring`, `/devices`, `/enrollments`, `/rpm-readiness`, `/sync-logs`, `/integration-setup` |
| M15 | `/advisory`, `/autopilot` |
| M16 | `/`, `/opportunities`, `/clinic-radar`, `/benchmarking` |
| M17 | `/reviews` |
| M18 | `/inventory`, `/integrations` |
| M19 | `/compliance`, `/compliance/:section` |
| M20 | `/subscription` |
| M21 | No application page; service/worker operational surfaces |
| M22 | `/settings` |
| M23 | No application page; database control plane |
| M24 | No application page; release/operations artifacts |

The sidebar exposes 32 unique staff destinations. Additional protected aliases, public token routes, platform routes, and patient portal child routes are declared in `src/app/App.tsx` and are all assigned above.

## Exclusive API and background ownership

| Module | API namespaces / endpoint groups | Workers, webhooks, scheduled tasks |
|---|---|---|
| M01 | Development-only `/docs/json`; Fastify error, auth-context, CORS, helmet, rate-limit and common pagination/error contracts | None |
| M02 | `/v1/auth/**`; `/v1/security/**` exported by `securityRoutes` | None |
| M03 | `/v1/onboarding/**`; `/v1/platform/auth/**`; `/v1/platform/**`; public `/v1/pilot/share/:token` | Platform provider retry endpoint is request-driven, not a scheduler |
| M04 | `/v1/branches/**` | None |
| M05 | `/v1/providers/**`; `/v1/staff/**`; `/v1/admin/**`; `/v1/control-plane/**` | None |
| M06 | `/v1/patients/**`; staff/public `/v1/intake/**` | Intake delivery is synchronous/provider-seam based |
| M07 | `/v1/appointments/**`; `/v1/scheduling/**`; `/v1/services/**` | None |
| M08 | `/v1/telehealth/sessions`; no Labs API exists | None |
| M09 | authenticated and public-webhook `/v1/receptionist/**` | Retell event/function webhooks and request-driven outbound calls |
| M10 | `/v1/portal/auth/**`; `/v1/portal/**`; `/v1/portal-admin/**` | Portal token delivery seam; no queue |
| M11 | authenticated/public-webhook `/v1/crm/**` | `campaign-scheduler`; `dispatch-scheduled` every five minutes; tenant-envelope jobs; delivery webhook |
| M12 | `/v1/insurance/**` | Stedi/payer request-response adapter; no scheduler |
| M13 | authenticated/public `/v1/payments/**`; authenticated and Stripe-webhook `/v1/revenue-protection/**` | Stripe webhook reconciliation |
| M14 | `/v1/devices/**`; `/v1/monitoring/**`; authenticated/provider-webhook `/v1/connected-care/**` | `monitoring-safety`; `missed-reading-scan` and `device-offline-scan` every 15 minutes; device webhooks |
| M15 | `/v1/advisory/**`; `/v1/autopilot/**`; `/v1/ai/**`; `/v1/settings/guardrails/**` | `autopilot-execution` / `execute-approved-action` |
| M16 | `/v1/dashboard/summary`; `/v1/briefing`; `/v1/signals`; `/v1/recommendations`; `/v1/opportunities`; `/v1/revenue-leaks`; `/v1/revenue-snapshots`; `/v1/tasks`; `/v1/conversations` | None |
| M17 | `/v1/competitors/radar`; `/v1/reputation`; `/v1/reviews/**` | None |
| M18 | `/v1/inventory/**`; `/v1/partner-reports/**`; `/v1/integrations/**` from operations routes | Integration test/run endpoints; no scheduler |
| M19 | `/v1/compliance/**` | `compliance-maintenance`: readiness, evidence expiry, truthful backup placeholder, access-review, vendor-review and security-scan-placeholder schedules |
| M20 | `/v1/subscriptions/**` | None |
| M21 | `/health`, `/health/live`, `/health/ready`, `/health/integrations`, `/health/slo`, `/metrics`; worker metrics port | Queue registration/runtime, signed tenant envelopes, retry/backoff, trace propagation and queue-depth sampling |
| M22 | `/v1/i18n/**`; `/v1/settings/notification-templates/**`; `/v1/settings/preferences/**`; `/v1/settings/roles/**` catalog/editor UI contract | Translation providers are synchronous |
| M23 | `rls:verify`, `test:rls:behavior`, drift and database-lifecycle verification commands | Migration/RLS verification harnesses |
| M24 | Build/check/test/e2e/simulation/release commands; no customer API | Deployment, clean-clone, backup/restore and rollback operational lanes |

`server/modules/operations/routes.ts` and `server/modules/settings/routes.ts` are physically shared files; the endpoint groups above are the authoritative logical ownership boundaries. Any edit to either file requires Architecture Council coordination.

## Exclusive Prisma model ownership (127/127)

Every `model` in `prisma/schema.prisma` appears exactly once here.

| Module | Models owned |
|---|---|
| M01 | `IdempotencyKey` |
| M02 | `User`, `PasswordResetToken` |
| M03 | `PlatformUser`, `PlatformAuditEvent`, `PlatformConfig`, `PlatformAnnouncement`, `SupportAccessSession`, `PilotImportPreset`, `PilotStatusShare`, `PlatformIntegration` |
| M04 | `Tenant`, `Branch`, `ServiceCatalogItem` |
| M05 | `RoleDefinition`, `UserClinicAccess`, `ProviderProfile`, `StaffProfile`, `StaffTask` |
| M06 | `Patient`, `ConsentEvent`, `PatientIntakePacket`, `PatientIntakeSection`, `PatientIntakeDocument`, `PatientConsentRecord` |
| M07 | `Appointment`, `ProviderAvailability`, `SchedulingPolicy`, `ProviderTimeOff`, `AppointmentRequest` |
| M08 | None; the current limited clinical/telehealth surfaces read shared patient/appointment/provider contracts and have no dedicated encounter/order/lab models |
| M09 | `ReceptionistClinic`, `ReceptionistLocation`, `ReceptionistAgent`, `ReceptionistCampaign`, `ReceptionistIntakeField`, `ReceptionistAppointmentRequest`, `ReceptionistCallLog`, `ReceptionistRecordingConsentEvent`, `ReceptionistArtifactLifecycleEvent`, `ReceptionistCallLegalHold`, `ReceptionistOptOut`, `ReceptionistOutboundCampaign`, `ReceptionistCallTarget` |
| M10 | `PatientPortalAccount`, `PatientPortalToken`, `PortalAccessRequest` |
| M11 | `Lead`, `Campaign`, `AutomationRule`, `CommunicationConsent`, `CampaignSuppression`, `CampaignDelivery`, `NotificationTemplate`, `NotificationEvent`, `Conversation` |
| M12 | `InsurancePayer`, `PatientInsurancePolicy`, `EligibilityVerification`, `BenefitSnapshot`, `PriorAuthorization`, `InsuranceProvider` |
| M13 | `PatientResponsibilityEstimate`, `PaymentProviderConnection`, `PaymentRequest`, `PaymentTransaction`, `DepositRule`, `DepositRequirement`, `RevenueProtectionAlert`, `RevenueLeak` |
| M14 | `Device`, `DeviceEvent`, `MonitoringRule`, `DeviceReading`, `ReadingAlert`, `MorningBriefingSignal`, `DeviceProvider`, `PatientDeviceEnrollment`, `DeviceProviderSyncLog`, `PatientConsent`, `RPMBillingReadiness` |
| M15 | `AutopilotPlaybook`, `AutopilotApproval`, `AIRecommendation`, `AiGuardrail`, `AIUsageLog`, `AIEvaluation` |
| M16 | `RevenueSnapshot`, `Opportunity`, `BusinessEvent`, `OperationalSignal` |
| M17 | `Review`, `Competitor`, `CompetitorReviewInsight`, `ReputationCase`, `ReviewRequest` |
| M18 | `InventoryItem`, `PartnerReport`, `Integration`, `IntegrationRunLog` |
| M19 | `AuditEvent`, `ComplianceFramework`, `ComplianceControl`, `ComplianceEvidence`, `ComplianceControlEvidence`, `ComplianceEvidenceVersion`, `CompliancePolicy`, `ComplianceRisk`, `ComplianceTask`, `ComplianceException`, `VendorRisk`, `SecurityIncident`, `AccessReview`, `DataRetentionPolicy`, `BackupVerification`, `SecurityScanResult`, `TenantSecurityPolicy` |
| M20 | `SubscriptionPlan`, `SubscriptionPlanFeature`, `SubscriptionAddon`, `TenantSubscription`, `TenantSubscriptionAddon`, `TenantFeatureEntitlement`, `TenantSubscriptionRequest`, `TenantBilling`, `TenantUsageLimit`, `TenantAiUsage` |
| M21 | None; runtime telemetry is intentionally outside application data or written through the domain-owned AuditEvent/IntegrationRunLog contracts |
| M22 | `CustomerPreference` |
| M23 | None; owns schema/migrations/policies for, but not business semantics of, all models |
| M24 | None |

## Exclusive feature-flag ownership

M20 owns the catalog and resolver for all 15 server-enforced subscription features: `appointments`, `patient_crm`, `basic_reports`, `payments_deposits`, `revenue_protection`, `campaign_automation`, `ai_receptionist`, `device_integration`, `insurance_eligibility`, `advanced_reports`, `multi_location`, `compliance_readiness`, `staff_kpis`, `api_access`, and `custom_integrations`. Domain modules own correct behavior when enabled/disabled; M20 owns key definition, plan/add-on mapping, override, and resolution semantics.

Deployment/runtime controls are owned as follows: M24 owns `DEPLOYMENT_PROFILE` and release posture; M21 owns `QUEUES_ENABLED`, OTEL/metrics/Sentry controls; M23 owns `RLS_ENFORCE_RUNTIME_ROLE`; M15 owns AI provider/PHI/budget/human-approval controls; M09 owns Retell configuration and receptionist kill/capacity policy; M12 owns insurance provider mode; M13 owns payment provider mode; M22 owns translation provider mode; M02 owns auth/MFA/session controls.

## Exclusive external integration ownership

| Integration | Primary module | Consumers / dependency note |
|---|---|---|
| PostgreSQL/Prisma/RLS | M23 | All persistent modules |
| Redis/BullMQ | M21 | M11, M14, M15, M19 |
| Retell | M09 | M07 scheduling, M06 patient, M19 audit/privacy |
| Twilio, WhatsApp, HTTP email/SMTP | M11 | M06 intake and M10 portal consume delivery seams |
| Stripe and alternative payment provider configuration | M13 | M07 deposits, M10 portal, M19 audit |
| Stedi/Availity/pVerify/Optum eligibility | M12 | M13 revenue cycle, M10 portal |
| Dexcom/Withings/Validic/Terra/Tenovi/manual device adapters | M14 | M06 patient, M08 clinical, M19 audit |
| Ollama/OpenAI/Claude model providers | M15 | M16 advisory/analytics consumer |
| DeepL/Google/MyMemory translation | M22 | Staff, platform and portal UIs |
| OpenTelemetry/OTLP, Prometheus and Sentry seam | M21 | API and worker processes |
| Vercel/Railway deployment targets | M24 | Entire release artifact |

## Roles and data classification

Staff roles are `OWNER`, `ADMIN`, `MANAGER`, `BILLING`, `PROVIDER`, `FRONT_DESK`, `ANALYST`, `COMPLIANCE_OFFICER`, and `AUDITOR`; M05 owns their business permission matrix. M02 owns authentication enforcement, M23 owns tenant isolation, and each domain owns object/branch authorization. M03 PlatformUser and M10 patient identities are separate planes.

Data classes used in feature inventories:

- `PHI-H`: clinical/identity/recording/transcript/insurance/device/intake data.
- `PHI-M`: scheduling, operational call metadata, patient-linked financial and communication data.
- `SENSITIVE`: credentials, authentication factors, security/audit evidence, commercial configuration.
- `INTERNAL`: aggregate operational/configuration data without patient identity.
- `PUBLIC-TOKEN`: deliberately minimized, token-scoped public response.

## Architecture risks discovered by inventory

1. M08 has user-facing Labs and Telehealth routes but no dedicated encounter, lab-result, medication, diagnosis, order, referral, or telehealth-session persistence. These must remain truthfully limited until feature contracts are implemented or explicitly scoped out; route presence is not clinical completion.
2. M16/M17/M18 use endpoint groups in the large shared `operations/routes.ts`; contract changes require central serialization to avoid domain ownership drift.
3. M05/M15/M22 share exports in `settings/routes.ts`; endpoint-level ownership is defined above, but file edits need a single integrator.
4. Several production-dependent features have truthful adapters but lack live/sandbox evidence: telephony, payer, payments, communications, devices, managed alerts, backup/restore and deployed accessibility/performance.
5. Existing broad evidence is strong for isolation, receptionist safety, money concurrency, RPM evidence, authentication and audit durability; it is not feature-level evidence for every analytics, reputation, inventory, portal, CRM, clinical or administrative action.
