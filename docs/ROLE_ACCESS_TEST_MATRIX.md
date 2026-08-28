# Role Access Test Matrix

Last updated: 2026-07-20

Purpose: give QA, client IT, and implementation teams a single matrix for role
and permission testing. API tests already cover core RBAC and tenant isolation;
client-run validation must execute this same matrix through browser sessions and
API probes in the deployed environment.

## Roles

| Role | Pilot intent | Must allow | Must deny |
| --- | --- | --- | --- |
| Platform owner | Internal multi-tenant operations | provision tenant, inspect readiness, view platform status | tenant PHI unless explicitly support-authorized and audited |
| Clinic owner/admin | clinic business owner | users, locations, settings, imports, reports, billing overview | other tenants, platform secrets, raw provider credentials |
| Manager | operational lead | scheduling, staff queues, reporting, escalations | security settings, tenant switching, platform operations |
| Provider | clinical care team | assigned patients, encounters, alerts, follow-up | billing admin, unrelated patients, exports beyond role |
| Front desk | scheduling and intake ops | availability, appointments, patient demographics needed for operations | clinical-only fields, financial admin, platform operations |
| Billing staff | insurance and revenue ops | eligibility, payment requests, invoices, reconciliation | clinical note editing, connected-care alert clinical action |
| Compliance officer | privacy/audit reviewer | audit events, DSR/export workflows, policy evidence | operational mutation outside compliance scope |
| Patient/client | patient portal user | own appointments, intake, consent, insurance, payments, messages | staff APIs, other patients, raw tenant data |

## Required Test Cases

| Area | Test | Expected result |
| --- | --- | --- |
| Authentication | unauthenticated access to protected API and UI | 401 or login redirect |
| Session expiry | expired access token with refresh unavailable | user is signed out with no data leak |
| Session revocation | revoked/terminated user calls API | 401/403 and audit event where applicable |
| Horizontal access | tenant A user reads tenant B patient, appointment, report, export, alert | 404/403 with no object details |
| Vertical access | provider attempts admin/settings/payment admin actions | 403 |
| Patient portal | patient attempts staff token route or another patient ID | 401/403/404 with no PHI leak |
| Invitations | invited user before activation | only activation path allowed |
| Password reset | reset token replay | second use denied |
| Tenant switching | user switches to tenant without membership | denied |
| Bulk export | provider/front desk requests patient export | denied and audited when appropriate |
| Audit visibility | compliance officer reads audit log | allowed within tenant |
| Audit mutation | any non-system user attempts to edit audit records | denied |

## Local Evidence

Existing automated coverage includes:

- `server/test/security.integration.test.ts`
- `server/test/rbac.permissions.test.ts`
- `server/test/dsr.export.test.ts`
- `server/test/rls.test.ts`
- `server/test/rlsEnforcement.test.ts`
- `server/test/portalBooking.integration.test.ts`
- `server/test/portalSignup.integration.test.ts`

Latest local run:

- `npm test` passed: 28 files, 132 tests
- focused security regression passed: 3 files, 11 tests

## Client-Run Evidence Required

For enterprise validation, capture for each role:

- browser recording or trace
- API response code and correlation ID
- audit event ID for allowed sensitive actions and denied privileged actions
- screenshot of user-visible denial message
- database spot check proving no cross-tenant mutation
