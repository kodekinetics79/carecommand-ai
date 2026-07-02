# Pilot Readiness Audit

This is a blunt go/no-go matrix for a real customer handoff where the clinic receives credentials, loads its own data, and runs its own scenarios.

## Verdict

- `GO` for a customer handoff with customer-run testing.
- `NO-GO` for a broad production claim or general release.

## Matrix

| Area | Status | Why it is in that state | Pilot impact |
|---|---|---|---|
| Platform admin / tenant provisioning | `GO` | The platform console can create a clinic tenant, owner login, and branch, and it ties into the handoff workspace. | The client can be onboarded into a real tenant instead of a demo shell. |
| Pilot launchpad | `GO` | The launchpad supports tenant selection, checklist review, CSV template download, preset save, and customer-facing share links. | The operator can set up the clinic and guide the full handoff. |
| Client data import | `GO` | Patients, appointments, and insurance imports all have preview, mapping, commit, and preset flows connected to backend routes. | The customer can load real clinic data and re-run imports safely. |
| Patient portal auth and layout | `GO` | The client portal has a separate auth flow and a patient-safe shell that only exposes patient-facing sections. | The clinic can hand credentials to patients without showing staff/admin controls. |
| Patient portal modules | `GO` | Home, appointments, requests, intake, insurance, payments, profile, and preferences are wired through the portal API. | The customer can run live patient scenarios in the portal. |
| Public status link | `GO` | The share view is unauthenticated, has no PHI exposure, and surfaces checklist/readiness data. | The clinic team can review readiness without a staff login. |
| Backend auth / RBAC / tenant isolation | `GO` | Direct API calls are enforced server-side, and the test suite proves auth, RBAC, and tenant isolation behavior. | Customer tests cannot casually bypass tenant boundaries. |
| Module coverage | `GO` | The repo has coverage checks and seeded data so dead modules are less likely to appear in the handoff. | The app is less likely to open to empty or broken screens. |
| Backend observability | `GO` | PHI-safe structured logging and 5xx capture are in place. | Failures are diagnosable without leaking sensitive data. |
| DB-level tenant isolation (RLS) | `PARTIAL` | RLS is live on a subset of tables and still rolling out across the larger schema. | Good defense-in-depth, but not yet complete across the entire DB. |
| Background workers | `PARTIAL` | The worker runtime exists and is tested, but the always-on deployment shape is still a production concern. | Queue-backed automation works in tests, but hosting must be handled deliberately. |
| Third-party live integrations | `PARTIAL` | Live Stripe, Stedi production, Twilio/email, and AI provider wiring are not all in production mode. | Pilot can proceed with safe defaults, but not every external path is final. |
| Secrets rotation / environment hygiene | `PARTIAL` | The codebase still needs final secret rotation and deployment env verification outside git. | This is an operational blocker for a broad release, not for a customer pilot. |
| HIPAA / BAA posture | `NO-GO` | Vendor BAAs, encryption review, retention policy, and formal privacy/security signoff are not completed by code alone. | Fine for internal pilot evaluation, not a compliance claim. |
| Self-serve onboarding | `NO-GO` | The flow is operator-driven by design; it is not self-serve clinic provisioning yet. | That is acceptable for the pilot, but not for a public signup launch. |

## Module-by-Module Status

### Pilot-facing modules

| Module | Status | Notes |
|---|---|---|
| Platform Console | `GO` | Admin can provision a clinic and manage the handoff flow. |
| Platform Pilot Launchpad | `GO` | Imports, presets, checklist, and share links are wired. |
| Client Login | `GO` | Separate patient-safe auth path. |
| Client Dashboard / Home | `GO` | Stronger hierarchy and patient-safe module entry points. |
| Appointments | `GO` | Upcoming and past visits are surfaced with request flow. |
| Requests | `GO` | Request submission is connected and deduped. |
| Intake | `GO` | Intake readiness and secure completion path are present. |
| Insurance | `GO` | Add/update insurance flow is present. |
| Payments / Estimates | `GO` | Patient-safe balances and acknowledgment flow are present; live payment processing still depends on external configuration. |
| Profile | `GO` | Basic contact edits are present. |
| Preferences / Consents | `GO` | Notification preferences and consent history are visible. |
| Pilot Status Share | `GO` | Public readiness view is polished and safe to share. |

### Infrastructure and safety modules

| Module | Status | Notes |
|---|---|---|
| API auth | `GO` | Unauthorized and forged access is rejected in tests. |
| RBAC | `GO` | Server-side permission gates are present. |
| Tenant isolation | `GO` | App-level tenant filters are working and tested. |
| RLS | `PARTIAL` | Expanded database-level enforcement still in progress. |
| Worker runtime | `PARTIAL` | Queue processing works, but ops deployment still needs the right host. |
| Observability | `GO` | PHI-safe logging and error capture exist. |
| Secrets / env | `PARTIAL` | Needs final environment hygiene before broader release. |

## What makes this a `GO`

- The clinic can be provisioned.
- The clinic can load its own data.
- The clinic can save mappings and rerun imports.
- The clinic can hand patients portal credentials that only expose patient-safe features.
- The customer can open a public status link without staff auth.
- The repo has simulation and coverage paths that exercise the flow.

## What keeps this from a broader production `GO`

- RLS is not yet complete across the whole schema.
- Worker hosting is not yet locked to a permanent always-on runtime.
- Live third-party integrations are not all final.
- Secrets rotation and deployment hygiene still need the final pass.
- Compliance posture still needs the non-code operational work.

## Practical handoff standard

For handoff, the bar is:

1. Tenant created.
2. Clinic data loaded.
3. Import preview reviewed.
4. Mapping preset saved when needed.
5. Patient portal access configured to the clinic’s chosen permissions.
6. Public status link shared.
7. Customer team can test without operator help.

If those steps work in the target environment, the app is ready for customer handoff.
