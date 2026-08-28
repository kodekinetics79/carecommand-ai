# CareCommand Backend Architecture

## Purpose

The backend is an operational platform boundary, not an EHR. It stores clinic operations, customer engagement, scheduling, consent history, governed automation approvals, and immutable-style audit events. Clinical diagnosis, treatment decisions, prescriptions, and clinical record replacement remain out of scope.

## Modules

| Module | Route | Responsibility |
| --- | --- | --- |
| Health | `/health/*` | Liveness and database readiness probes |
| Auth | `/v1/auth/login`, `/v1/auth/refresh`, `/v1/auth/logout`, `/v1/auth/me` | Password login, HttpOnly cookie-backed refresh rotation, logout revocation, and session introspection |
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
| Integrations Status | `/v1/integrations/status`, `/v1/integrations/:provider/test` | Honest provider readiness, mode labels, and safe connection tests |
| Staff Tasks | `/v1/tasks` | Branch workflow assignments and due dates |
| Staff Overview | `/v1/staff/overview` | Staff performance, SLA, and workload snapshots |
| Revenue | `/v1/revenue-snapshots` | Periodic branch and network performance snapshots |
| Providers | `/v1/providers/overview` | Provider productivity, utilization, and revenue snapshots |
| Conversations | `/v1/conversations`, `/v1/conversations/:id/reply` | AI front-desk inbox state and reply mutations |
| Advisory | `/v1/advisory/brief`, `/v1/advisory/ask` | Premium AI advisory room for revenue, growth, operations, and competitor guidance |
| Admin | `/v1/admin/users`, `/v1/admin/users/:id/status`, `/v1/admin/users/:id/role`, `/v1/admin/users/:id/branches`, `/v1/admin/roles`, `/v1/admin/audit-logs` | Tenant users, clinic access, permissions, and audit history |
| Security | `/v1/security/posture`, `/v1/security/sessions`, `/v1/security/sessions/:userId/revoke`, `/v1/security/login-history` | Security posture dashboard, session controls, and login history |
| Revenue Protection | `/v1/revenue-protection/*` | Insurance eligibility, prior auth, patient responsibility, and payment workflows |

## Security Boundaries

- Every operational query includes `tenantId`.
- Write routes apply role checks.
- Admin and security routes require OWNER or ADMIN access, and the frontend hides the nav item for non-admin users.
- Clinic access updates persist in `UserClinicAccess` and keep a primary branch on the `User` record for scope-sensitive routes.
- Patient deletions should use `deletedAt`; avoid destructive deletion in application code.
- Consent is append-only through `ConsentEvent`, enforced by a database trigger.
- Sensitive actions write an append-only `AuditEvent` with request, actor, IP, and user-agent context.
- Autopilot executes higher-impact actions only after an atomic pending-to-approved transition.
- Production must keep short-lived access tokens, HttpOnly cookie-backed refresh rotation, and a real identity provider or SSO gateway.
- Passwords must be stored only as salted hashes. The seeded local admin account is for development only.
- Refresh and logout require a lightweight double-submit CSRF header check (`X-CSRF-Token` plus `cc_csrf` cookie) to keep the cookie-backed session safer without adding a heavy framework.
- The advisory room must stay business-only: revenue, growth, front desk, operations, reputation, and competitor guidance only. Clinical advice stays out of scope even when using LLM providers.
- Revenue Protection is operational, not clinical: it handles insurance readiness, copay/deposit capture, prior auth tracking, and payment follow-up. Provider credentials are server-side only; mock fallback is used when live sandbox credentials are absent or invalid.
- Integration readiness is configuration-aware: mock and placeholder providers never claim live status, and connection tests only record safe metadata rather than PHI or card data.

## Data Operations

- Apply migrations with `npm run db:deploy`.
- Generate the Prisma client with `npm run db:generate`.
- Seed local demo records with `npm run db:seed`.
- Use encrypted managed PostgreSQL backups with point-in-time recovery in production.
- Run Redis as a managed durable service with alerting and dead-letter monitoring.
- Treat provider productivity as snapshot data sourced from the operational database, not a clinical source of truth.

## Deployment Checklist

1. Provision separate development, staging, and production databases.
2. Store `JWT_SECRET` and `JWT_REFRESH_SECRET` in the hosting platform secret manager.
3. Run migrations as a release step before rolling API instances.
4. Run API and worker processes separately.
5. Configure `/health/live` and `/health/ready` probes.
6. Add Sentry or OpenTelemetry exporters and central log retention.
7. Add database backup verification and restore drills.
8. Add API integration tests before onboarding real customer data.
9. Treat front-desk replies as operational writes: persist the outbound text, timestamp, and escalation state in PostgreSQL and audit every change.
10. Replace the seeded admin credential with SSO/OIDC in production.
11. Serve the application over HTTPS in production so the refresh cookie can remain `Secure`.
12. If the API becomes cross-site, add a CSRF token strategy before allowing cookie-authenticated writes.
