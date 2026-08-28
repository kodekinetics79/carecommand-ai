# Enterprise Client Validation Runbook

This runbook is for a full enterprise-grade client validation cycle using the
client's real workflows, real operational data, real user roles, and configured
live or sandbox integrations. It is stricter than the local automated suite and
stricter than a guided pilot demo.

Local synthetic tests prove the build is technically coherent. Enterprise
validation proves the client can run the product with their own data, their own
staff, their own operating constraints, and their own acceptance criteria.

## Non-Negotiable Position

Do not mark the product enterprise-ready for client implementation until all of
the following are true:

- The client has executed the test scripts in their own environment.
- The test data is client-provided or client-approved.
- Every integration is explicitly labeled as `live`, `sandbox`, `mock`, or
  `not configured`.
- All critical and high defects are fixed, retested, and accepted by the client.
- Evidence is captured for every pass/fail decision.
- Security, privacy, data retention, and support handoff are signed off.

## Test Organization

The validation should be run as a war-room program with named owners.

| Role | Owner | Responsibility |
|---|---|---|
| Client executive sponsor | Client | Confirms business acceptance and go/no-go. |
| Client operations lead | Client | Validates clinic workflows and module outcomes. |
| Client front desk tester | Client | Tests scheduling, calls, intake, patient requests. |
| Client clinical tester | Client | Tests provider workspace, patient records, care workflows. |
| Client billing tester | Client | Tests insurance, deposits, payment requests, revenue workflows. |
| Client compliance/security tester | Client | Tests access control, data export, audit, PHI boundaries. |
| CareCommand test manager | CareCommand | Owns test plan, daily triage, evidence log, defect status. |
| CareCommand engineering lead | CareCommand | Fixes defects, confirms root cause, ships patches. |
| CareCommand integration lead | CareCommand | Validates third-party credentials, webhooks, provider modes. |
| CareCommand sales/implementation lead | CareCommand | Confirms business fit, training, objections, and adoption risk. |

## Entry Criteria

Do not start client validation until these are complete.

### Environment

- Dedicated client test tenant exists.
- Production-like API, frontend, database, Redis, and worker process are running.
- Database migrations are deployed.
- Background worker is running continuously if queues are enabled.
- `VITE_DEMO_FALLBACK=false`.
- `VITE_AUTH_MODE=login-required`.
- Frontend production bundle does not contain local development API URLs,
  dev-token routes, absolute local paths, seed credentials, or demo tenant IDs.
- Health checks pass:
  - `/health/live`
  - `/health/ready`
- Protected routes reject unauthenticated requests.

### Data

The client must provide representative test data in agreed CSV or integration
export format.

Minimum data set:

| Entity | Minimum | Required variation |
|---|---:|---|
| Patients | 100 | active, new, retained, at-risk, duplicate/update rows |
| Appointments | 100 | future, past, cancelled/no-show, multiple providers, multiple branches |
| Insurance policies | 50 | active, inactive, pending, invalid member id, multiple payers |
| Payment/deposit examples | 20 | paid, unpaid, failed, waived, refunded if applicable |
| Reviews | 20 | positive, neutral, negative, responded/unresponded |
| Staff users | 10 | owner/admin, manager, provider, front desk, billing/compliance |
| Branches/locations | 2 or more | different hours, providers, inventory, workflows |
| Device/RPM readings | 30 | normal, warning, critical, unmatched patient/device |
| Campaign/CRM records | 30 | active leads, inactive patients, opt-outs, consent states |

Data must be either real client data cleared for testing under the contractual
privacy posture, or client-approved masked data that preserves workflow
characteristics.

### Integrations

Record the exact mode before testing:

| Area | Required enterprise validation mode |
|---|---|
| Auth/session | Live |
| Database | Live production-like managed DB |
| Redis/queues | Live production-like Redis/worker |
| Insurance eligibility | Live or payer sandbox approved by client |
| Payments | Stripe/Square/other sandbox or live test account |
| SMS/WhatsApp/email | Live sandbox/test provider account |
| Voice/AI receptionist | Live sandbox/test provider account |
| AI gateway | Configured model or explicitly accepted mock mode |
| Device/RPM | Vendor sandbox/live test feed or signed webhook simulator |
| Observability | Live logs/metrics/error reporting endpoint |

Mock mode is allowed only when the client signs that module as out of scope for
enterprise acceptance.

## Autonomous Test Lanes

Run these lanes in parallel. Each lane logs evidence and defects independently.

| Lane | Scope | Exit condition |
|---|---|---|
| Data migration/import | Client CSV/imports, mapping presets, duplicate handling | Client confirms imported data matches source extracts. |
| Access/security | login, MFA if enabled, RBAC, tenant isolation, portal boundary | No unauthorized access or PHI leakage. |
| Clinical operations | patients, provider workspace, intake, care workflows | Clinical tester accepts daily workflow. |
| Front desk | scheduling, portal booking, receptionist, staff tasks | Front desk tester can complete daily work without admin help. |
| Billing/revenue | insurance, payment requests, deposits, revenue protection | Billing tester accepts financial workflow and reconciliation. |
| Patient portal | signup, login, profile, appointments, insurance, payments | Patient tester sees only patient-safe data. |
| Integrations | webhooks, provider health, retries, idempotency, setup-required states | Every configured provider returns expected state and audit. |
| Reporting/observability | dashboards, morning briefing, audit, metrics, error reporting | Ops lead can see status and support team can triage failures. |
| Performance/resilience | concurrent users, repeated imports, large pages, refresh/retry | No critical failure under agreed client load. |

## Enterprise Scenario Scripts

Each scenario must be run with client data. Record tester, role, timestamp,
tenant, data IDs, expected result, actual result, screenshots, and defects.

### Scenario 1: Tenant and Access Setup

1. Create or verify client tenant.
2. Create users for owner, manager, provider, front desk, billing, compliance.
3. Log in as each user.
4. Confirm each role only sees allowed navigation and actions.
5. Suspend and reactivate a test user or tenant if in scope.

Pass criteria:

- Every login works for active users.
- Inactive/suspended users are blocked.
- Unauthorized actions return 401/403/404 as appropriate.
- No role sees another tenant's data.

### Scenario 2: Real Patient Import and Reconciliation

1. Import client patient extract.
2. Preview mapping.
3. Review warnings and invalid rows.
4. Commit import.
5. Re-run with duplicates/updates.
6. Compare row counts and sampled records against source system.

Pass criteria:

- Preview catches malformed rows before commit.
- Commit creates and updates expected records.
- Duplicate handling is deterministic.
- Sampled records match source data.

### Scenario 3: Appointment and Scheduling Flow

1. Import appointments.
2. Configure provider availability.
3. Book a staff appointment.
4. Book a patient portal appointment.
5. Attempt a double-book.
6. Add provider time off.
7. Confirm slot visibility updates.

Pass criteria:

- Appointments attach to correct patient, branch, and provider.
- Conflicts are rejected.
- Portal and staff booking reconcile to the same schedule.
- Provider time off removes affected slots.

### Scenario 4: Intake and Patient Portal

1. Create patient portal access.
2. Log in as patient.
3. Submit profile updates.
4. Submit intake section.
5. Submit appointment request.
6. Review as staff.

Pass criteria:

- Patient only sees patient-safe data.
- Staff/admin features are hidden from patient portal.
- Portal submissions appear in staff workflow.
- Audit events are created where expected.

### Scenario 5: Insurance Eligibility

1. Configure eligibility provider in agreed mode.
2. Run eligibility on active policy.
3. Run eligibility on inactive/pending policy.
4. Run invalid member/payer case.
5. Verify member ID masking in responses and UI.
6. Confirm eligibility history is tenant-scoped.

Pass criteria:

- Active/inactive responses match expected provider response.
- Invalid cases fail safely.
- Member identifiers are masked where displayed.
- No cross-tenant eligibility history is visible.

### Scenario 6: Payments and Revenue Protection

1. Create deposit/payment request.
2. Generate checkout/payment link.
3. Complete payment in provider sandbox/live test mode.
4. Redeliver webhook.
5. Test invalid signature.
6. Confirm revenue signal and morning briefing update.

Pass criteria:

- Valid webhook collects exactly once.
- Invalid webhook is rejected.
- Redelivery is idempotent.
- Patient-safe checkout leaks no internal tenant/PHI IDs.
- Payment status and audit trail persist after refresh.

### Scenario 7: AI Receptionist and Staff Workflow

1. Open receptionist inbox.
2. Process a real missed-call or message scenario.
3. Create follow-up task.
4. Convert to appointment request or staff review.
5. Complete task as assigned staff user.

Pass criteria:

- The message/task links to the correct patient/clinic.
- Escalations are visible to staff.
- Completed tasks persist.
- Any AI-generated content is clearly governed by configured mode.

### Scenario 8: Campaigns, Consent, and Reviews

1. Create segment from inactive/at-risk patients.
2. Confirm consent filtering.
3. Launch or dry-run campaign depending on provider mode.
4. Review delivery/suppression results.
5. Respond to a negative review.

Pass criteria:

- Opt-outs and consent are respected.
- Suppressed records are explainable.
- Campaign state and review response persist.
- No messages are sent outside agreed test scope.

### Scenario 9: Connected Care / RPM

1. Enroll patient in device/RPM program.
2. Send normal reading.
3. Send warning reading.
4. Send critical reading.
5. Send unmatched patient/device reading.
6. Review alerts and RPM readiness.

Pass criteria:

- Readings normalize and persist.
- Alert severity is backend-decided.
- Unmatched data does not attach to wrong patient.
- RPM readiness checklist reflects consent/signoff requirements.

### Scenario 10: Reporting, Audit, and Observability

1. Open dashboard and morning briefing.
2. Trigger known workflow events.
3. Export patient data as authorized user.
4. Attempt export as unauthorized user.
5. Review audit trail.
6. Confirm metrics/logs/errors are visible to support team.

Pass criteria:

- Counts update from real activity.
- Authorized export succeeds and is audited.
- Unauthorized export is denied.
- Support team can trace a failure without PHI in logs.

## Performance and Resilience Tests

Minimum enterprise validation:

| Test | Target |
|---|---|
| Concurrent staff users | Client-defined, minimum 25 |
| Concurrent portal users | Client-defined, minimum 25 |
| Import size | Client's largest expected file or 10,000 rows |
| Repeated import | 3 reruns with updates and duplicates |
| Webhook redelivery | 10 repeated delivery attempts |
| Page refresh persistence | Every critical workflow |
| Browser coverage | Chrome, Edge, Safari where client requires |
| Mobile portal coverage | iOS Safari and Android Chrome where client requires |

## Defect Severity

| Severity | Definition | Enterprise exit rule |
|---|---|---|
| Critical | Data leak, PHI exposure, payment error, tenant isolation failure, system unavailable | Zero open |
| High | Core workflow blocked, incorrect financial/clinical result, auth/RBAC bug | Zero open unless client signs waiver |
| Medium | Workflow degraded but workaround exists | Client-approved backlog |
| Low | Cosmetic, copy, minor usability issue | Client-approved backlog |

## Evidence Log Required Fields

Every executed test must capture:

- Test ID
- Module
- Scenario
- Tester
- User role
- Tenant/branch
- Data record IDs or masked source row references
- Integration mode
- Steps performed
- Expected result
- Actual result
- Pass/fail
- Screenshot/video/log link
- Defect ID if failed
- Retest result
- Client acceptance initials/date

## Exit Criteria

Enterprise client validation passes only when:

- 100% of critical scenarios are executed.
- 100% of critical and high defects are closed or formally waived.
- Client confirms imported data reconciliation.
- Client confirms role/access behavior.
- Client confirms integration modes and limitations.
- Client confirms support handoff and rollback process.
- CareCommand confirms production build artifact scan is clean.
- CareCommand confirms database, worker, observability, and security gates are green.

## Current Local Evidence Baseline

The local suite is not a substitute for client validation, but it is the
engineering baseline before the client starts:

- Full automated suite: 28 files / 132 tests passing.
- Higher-concurrency E2E: 12 concurrent clinic journeys passing.
- Module coverage: 107/107 non-ephemeral models covered for demo tenant.
- Production build: passes with `NODE_ENV=production` enforced.
- Artifact scan: no `jsxDEV`, absolute local paths, localhost API URL, dev-token
  endpoint, seed credentials, or demo tenant IDs in `dist`.
- API smoke: live/ready healthy; protected route rejects unauthenticated access.

## Go / No-Go Language

Use this language with the client:

- "Engineering baseline is green for enterprise validation."
- "Enterprise acceptance begins when your team runs the agreed scenarios with
  your data and integrations."
- "We will not claim implementation readiness until your critical workflows pass
  and your sign-off evidence is complete."

