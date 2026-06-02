# CareCommand Backend Architecture

## Purpose

The backend is an operational platform boundary, not an EHR. It stores clinic operations, customer engagement, scheduling, consent history, governed automation approvals, and immutable-style audit events. Clinical diagnosis, treatment decisions, prescriptions, and clinical record replacement remain out of scope.

## Modules

| Module | Route | Responsibility |
| --- | --- | --- |
| Health | `/health/*` | Liveness and database readiness probes |
| Auth | `/v1/auth/dev-token` | Local-only bootstrap token; replace with the production identity provider |
| Branches | `/v1/branches` | Tenant-scoped clinic locations |
| Patients | `/v1/patients` | Customer360 operational profiles and consent timeline |
| Appointments | `/v1/appointments` | Scheduling records, risk flags, and operational value |
| Autopilot | `/v1/autopilot/*` | Playbooks, approval inbox, queued execution, and audit history |
| CRM Leads | `/v1/leads` | Inquiry pipeline and estimated conversion value |
| Campaigns | `/v1/campaigns` | Multi-channel campaign configuration and outcomes |
| Reviews | `/v1/reviews` | Reputation monitoring and response workflow |
| Inventory | `/v1/inventory` | Branch supplies, reorder thresholds, and expiry dates |
| Partner Reports | `/v1/partner-reports`, `/v1/partner-reports/:id/review` | Operational tracking for external reports and review workflow |
| Integrations | `/v1/integrations` | Tenant integration connection state |
| Staff Tasks | `/v1/tasks` | Branch workflow assignments and due dates |
| Staff Overview | `/v1/staff/overview` | Staff performance, SLA, and workload snapshots |
| Revenue | `/v1/revenue-snapshots` | Periodic branch and network performance snapshots |
| Providers | `/v1/providers/overview` | Provider productivity, utilization, and revenue snapshots |
| Conversations | `/v1/conversations`, `/v1/conversations/:id/reply` | AI front-desk inbox state and reply mutations |

## Security Boundaries

- Every operational query includes `tenantId`.
- Write routes apply role checks.
- Patient deletions should use `deletedAt`; avoid destructive deletion in application code.
- Consent is append-only through `ConsentEvent`, enforced by a database trigger.
- Sensitive actions write an append-only `AuditEvent` with request, actor, IP, and user-agent context.
- Autopilot executes higher-impact actions only after an atomic pending-to-approved transition.
- Production must replace the local token endpoint with OIDC or SAML-backed identity and short-lived access tokens.

## Data Operations

- Apply migrations with `npm run db:deploy`.
- Generate the Prisma client with `npm run db:generate`.
- Seed local demo records with `npm run db:seed`.
- Use encrypted managed PostgreSQL backups with point-in-time recovery in production.
- Run Redis as a managed durable service with alerting and dead-letter monitoring.
- Treat provider productivity as snapshot data sourced from the operational database, not a clinical source of truth.

## Deployment Checklist

1. Provision separate development, staging, and production databases.
2. Store secrets in the hosting platform secret manager.
3. Run migrations as a release step before rolling API instances.
4. Run API and worker processes separately.
5. Configure `/health/live` and `/health/ready` probes.
6. Add Sentry or OpenTelemetry exporters and central log retention.
7. Add database backup verification and restore drills.
8. Add API integration tests before onboarding real customer data.
9. Treat front-desk replies as operational writes: persist the outbound text, timestamp, and escalation state in PostgreSQL and audit every change.
