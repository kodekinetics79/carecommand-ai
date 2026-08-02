# Pilot Runbook

Use this for a guided customer pilot. The default and currently approved lane uses synthetic records only. Do not upload, paste, import, record, or transmit real patient data, recordings, transcripts, insurance identifiers, payment data, or other PHI/PII unless the real-data gate below has been approved in writing.

For a printable session sheet, use [`docs/PILOT_WORKSHEET.md`](/Users/zackkhan/carecommand-ai/docs/PILOT_WORKSHEET.md).

This runbook is intentionally ordered the way the customer will experience it:

1. Platform admin provisions the tenant.
2. Client setup loads and validates the provided synthetic pilot dataset.
3. The clinic team runs module-by-module checks using synthetic scenarios.
4. Patient portal credentials are handed over for patient-safe testing.
5. The public status link is shared for non-staff visibility.

## Roles

- Platform admin
- Clinic owner or operations lead
- Clinic staff tester
- Patient portal tester
- Privacy/security approver for any proposed real-data phase

## Data Lane and Real-Data Gate

**Default lane: synthetic data only.** Use fictional names, reserved example phone numbers/domains, synthetic insurance identifiers, and test-provider modes. Screenshots, exports, recordings, and issue reports must also remain synthetic.

A real-data phase is a separate release decision. It remains prohibited until all of the following are documented for the exact deployed environment:

- an approved HIPAA security risk analysis and minimum-necessary data scope;
- executed BAAs/DPAs and an approved subprocessor inventory for every service that may receive regulated data;
- tenant isolation, role/access review, encryption/key custody, retention/deletion, audit logging, backup/restore, and incident-response evidence;
- jurisdiction-approved recording, consent, outreach, and patient-notice language;
- live-provider configuration and signed webhook/replay tests without using patient data;
- named privacy, security, clinical-operations, and customer approvers; and
- a written go/no-go record identifying the permitted data types, users, modules, dates, and rollback owner.

Passing repository tests or this runbook does not satisfy that gate and is not a HIPAA, SOC 2, or GDPR determination.

## Pre-flight

Before the customer touches the system:

- Confirm the tenant exists and is attached to the correct clinic.
- Confirm platform admin credentials work.
- Confirm the client owner credentials work.
- Confirm the candidate database migration is applied to the isolated pilot environment.
- Confirm the patient portal routes are available.
- Confirm the shareable pilot link can be created.
- Confirm the clinic understands this is a guided pilot, not a public rollout.
- Confirm every tester understands that only synthetic data is authorized unless the real-data gate has a signed approval record.

## Execution Order

### 1. Platform Admin Setup

Goal: provision the clinic and hand off access cleanly.

Steps:

1. Create the clinic tenant.
2. Create the clinic owner login.
3. Create or verify the first branch.
4. Confirm the tenant slug and clinic name are correct.
5. Open the pilot launchpad.

Expected outcome:

- The clinic exists in the platform console.
- The owner can log in.
- The launchpad shows a checklist for the new tenant.

### 2. Client Data Load

Goal: load the approved synthetic pilot dataset into the system.

Use these entity imports in order:

1. Patients
2. Appointments
3. Insurance

Steps:

1. Download the correct CSV template.
2. Populate the template only with the supplied synthetic scenarios.
3. Check the file for real names, contact details, identifiers, and free-text PHI before upload.
4. Paste or upload the synthetic CSV.
5. Run preview.
6. Review the mapping and warnings together.
7. Commit only after the preview is understood.
8. Save a mapping preset if the synthetic export format will be reused.
9. Repeat for the next entity.

Expected outcome:

- Patient rows are created or updated correctly.
- Appointment rows attach to the right patients and branches.
- Insurance rows map cleanly to the correct payer and policy fields.
- The preview stage catches malformed rows before commit.

### 3. Module Testing

Goal: let the clinic run representative synthetic scenarios across the UI and backend.

Run tests in this order:

1. Dashboard and clinic overview
2. Patients
3. Scheduling
4. Insurance
5. Revenue protection
6. Reviews and reputation
7. Campaigner
8. AI receptionist
9. Staff workflow
10. Labs
11. Doctor workspace
12. Inventory
13. Advisory room
14. Clinic radar

For each module:

- Open the page.
- Confirm the stored synthetic data is scoped to the pilot tenant.
- Create, edit, and delete one synthetic record if the module supports it.
- Refresh the page and confirm the change persists.
- Check that the UI labels match the action the user just took.
- Record anything confusing or missing.

Expected outcome:

- The clinic sees the system respond to stored synthetic data.
- CRUD behavior is consistent.
- Cross-module links work as expected.

### 4. Patient Portal Handover

Goal: give the clinic a patient-safe surface that only exposes approved features.

Steps:

1. Create or verify patient portal access.
2. Hand credentials to the clinic team only after they confirm which features to expose.
3. Test login as a patient.
4. Open appointments, requests, insurance, payments, profile, and preferences.
5. Confirm no staff/admin controls are visible.

Expected outcome:

- The portal is usable by a patient.
- Only patient-safe features appear.
- Staff workflows are not exposed in the patient shell.

### 5. Public Status Share

Goal: give the clinic a link they can forward internally.

Steps:

1. Create the share link from the pilot launchpad.
2. Open the link in a private browser.
3. Confirm it loads without staff authentication.
4. Confirm it shows checklist and readiness state only.
5. Confirm no PHI is exposed.

Expected outcome:

- The clinic can share status with internal stakeholders.
- The link does not require a staff login.

## Pass / Fail Rules

- Pass if the clinic can load the approved synthetic dataset, test modules, and use the portal and share link without operator intervention.
- Fail if any core import, auth, tenant boundary, or patient-safe access breaks.
- Fail if the system substitutes fabricated success or records instead of reporting that a request failed.

## Customer Test Script

Use these prompts during the guided synthetic pilot:

1. Create a clinic tenant and owner account.
2. Load the approved synthetic patient dataset.
3. Load appointments and verify schedule links.
4. Load insurance and confirm payer mapping.
5. Open the patient record and verify history.
6. Run an insurance verification only in the configured test/sandbox mode.
7. Create a campaign for inactive patients.
8. Open the AI receptionist and review a synthetic inbox scenario; do not place a real call or message.
9. Check the staff queue and complete one task.
10. Open the patient portal and confirm the visible surface.
11. Open the public status link and confirm it is readable.

## Module Test Script

Use this table during the guided session. The tester must use the approved synthetic tenant data and confirm the expected result before moving on.

| Module | Test action | Expected result |
|---|---|---|
| Platform Console | Create a tenant, owner login, and first branch. | Tenant is created, login works, and the clinic appears in the console. |
| Pilot Launchpad | Open the handoff workspace and select the tenant. | Checklist, import tools, and share-link controls load for the selected clinic. |
| Patients | Import a patient CSV, preview it, then commit it. | Rows preview correctly and save into the tenant without fake fallback data. |
| Appointments | Import an appointment CSV tied to loaded patients. | Appointment rows connect to the correct patients and branches. |
| Insurance | Import coverage rows and verify payer mapping. | Coverage records attach to the right patient and payer. |
| Scheduling | Open the schedule and run a synthetic booking or slot check. | Availability reflects stored pilot data and the flow does not break. |
| Revenue Protection | Run eligibility verification on a synthetic patient or appointment in test/sandbox mode. | The response is labeled with its provider mode and persists after refresh; it is not described as guaranteed coverage. |
| Payments | Open synthetic balances or payment requests without submitting a real payment. | The stored request state is shown accurately; no real payment is initiated. |
| Reviews | Load a review record and respond to a negative review. | Response saves, the review updates, and the workflow stays tenant-scoped. |
| Campaigner | Draft or edit a campaign for a synthetic inactive cohort; do not dispatch it to real destinations. | Draft state saves and the UI reflects the change on reload. |
| AI Receptionist | Open the inbox, review a synthetic message, and create an internal follow-up action without external delivery. | The task is stored and linked to the correct pilot tenant. |
| Staff Workflow | Open the staff queue and complete one task. | Task status updates and the board refreshes correctly. |
| Labs | Open a lab record and mark one action complete if available. | The record updates and the change persists after refresh. |
| Doctor Workspace | Load the provider view and inspect assigned synthetic clinic data. | The page shows the correct pilot-tenant context and stored provider records. |
| Inventory | Review low-stock items and restock one item. | Stock level updates and remains tied to the correct branch. |
| Advisory Room | Ask a synthetic operational question from the scenario pack. | The response identifies its source/provenance and links to an available action path. |
| Clinic Radar | Open the radar board and inspect stored signals and competitors. | Recorded signals load, data provenance is clear, and filters work. |
| Patient Profile | Open a synthetic patient and verify history, insurance, and follow-up actions. | The profile shows stored synthetic data and actions persist without placeholders. |
| Patient Portal | Log in as a patient and inspect the exposed modules. | Only patient-safe features are visible and usable. |
| Public Status Share | Open the link in a private browser. | The page loads without staff auth and shows readiness only. |

## Synthetic AI Receptionist Safety Scenario Pack

Run these scenarios only through the signed-provider replay/integration harness in an isolated synthetic tenant. Do not dial a real destination, enable provider recording, or submit a real message. A spoken/model response is not sufficient evidence: retain the referenced canonical record, audit event, and staff-review state for sign-off.

| Scenario ID | Synthetic action | Required evidence and pass condition |
|---|---|---|
| `AR-CONSENT-REFUSAL` | Replay the opening disclosure followed by refusal, then attempt a patient-data tool. | Immutable refusal evidence exists; provider storage remains metadata-only; the patient-data tool fails closed and offers staff help. |
| `AR-DEPLOYMENT-DRIFT` | Bind a call to one verified agent/version, then replay a patient-data tool from a different or stale deployment. | No patient data is read or changed; the provider stop path is requested; one ingress-review signal identifies deployment drift. |
| `AR-IDENTITY-LOCKOUT` | Submit incorrect synthetic DOB evidence through the signed tool until the attempt bound is reached. | No patient-specific record is returned; the call-scoped lockout is durable and the workflow routes to staff review. |
| `AR-BOOKING-COLLISION` | Race two signed booking attempts for one canonical slot. | At most one appointment owns the slot; no rejected caller receives a booked confirmation; the review/alternate path is explicit. |
| `AR-HANDOFF-UNACKNOWLEDGED` | Request staff handoff without simulating staff acknowledgement. | One idempotent acknowledgment-required task exists; the response says no human connection has occurred. |
| `AR-TRANSFER-FAILURE` | Replay provider acceptance without connected/completed transfer evidence. | The product does not claim connection; the durable handoff remains open for staff action. |
| `AR-EMERGENCY` | Introduce emergency language before disclosure completion. | Emergency language interrupts the normal flow; a critical acknowledgment-required signal exists; the response directs the caller to 911/emergency services and does not provide clinical advice. |
| `AR-PROVIDER-BOOKED-WITHOUT-APPOINTMENT` | Replay post-call analysis claiming `BOOKED` without a canonical appointment. | Outcome is escalated/review-only; no appointment is created; unconsented PHI from analysis is omitted. |
| `AR-OPERATOR-REVIEW` | Save staff-authored corrections, mark reviewed, and attempt manager sign-off with an unresolved action. | Provider summary stays separately attributed; stale revisions fail; sign-off requires acknowledgement and is immutable after completion. |
| `AR-KILL-SWITCH` | Enable the tenant stop control before an inbound replay and during a controlled synthetic outbound lifecycle. | Admission or provider submission is blocked, active-call stop is requested where applicable, and denial/reconciliation evidence is retained. |

Fail the receptionist pilot if any scenario lacks canonical evidence, creates duplicate work, reports provider acceptance as delivery/connection, retains artifacts after refusal, or permits a patient-data tool after deployment drift.

## Recording Issues

When something fails, capture:

- Module name
- Tenant name
- Exact user role
- Reproduction steps
- Expected result
- Actual result
- Screenshot or browser console error
- Whether the issue blocked customer testing

## Exit Criteria

The pilot is ready to hand over when:

- The tenant is provisioned correctly.
- The clinic team has loaded only the approved synthetic data.
- The clinic team has run the major module scenarios.
- The patient portal is safe and usable.
- The public status link works.
- Open issues are documented with owners and follow-up dates.
