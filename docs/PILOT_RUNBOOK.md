# Pilot Runbook

Use this when a real prospect or customer receives credentials and runs the app with their own clinic data, live scenarios, and their own team.

For a printable session sheet, use [`docs/PILOT_WORKSHEET.md`](/Users/zackkhan/carecommand-ai/docs/PILOT_WORKSHEET.md).

This runbook is intentionally ordered the way the customer will experience it:

1. Platform admin provisions the tenant.
2. Client setup loads and validates the clinic's data.
3. The clinic team runs module-by-module checks using real scenarios.
4. Patient portal credentials are handed over for patient-safe testing.
5. The public status link is shared for non-staff visibility.

## Roles

- Platform admin
- Clinic owner or operations lead
- Clinic staff tester
- Patient portal tester

## Pre-flight

Before the customer touches the system:

- Confirm the tenant exists and is attached to the correct clinic.
- Confirm platform admin credentials work.
- Confirm the client owner credentials work.
- Confirm the live database migration is applied.
- Confirm the patient portal routes are available.
- Confirm the shareable pilot link can be created.
- Confirm the clinic understands this is a guided pilot, not a public rollout.

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

Goal: load the customer's own data into the system.

Use these entity imports in order:

1. Patients
2. Appointments
3. Insurance

Steps:

1. Download the correct CSV template.
2. Ask the clinic team to export their data into that format.
3. Paste or upload the CSV.
4. Run preview.
5. Review the mapping and warnings together.
6. Commit only after the preview is understood.
7. Save a mapping preset if the export format will be reused.
8. Repeat for the next entity.

Expected outcome:

- Patient rows are created or updated correctly.
- Appointment rows attach to the right patients and branches.
- Insurance rows map cleanly to the correct payer and policy fields.
- The preview stage catches malformed rows before commit.

### 3. Module Testing

Goal: let the clinic run real scenarios across the UI and backend.

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
- Confirm the data is live and scoped to the clinic.
- Create, edit, and delete one real record if the module supports it.
- Refresh the page and confirm the change persists.
- Check that the UI labels match the action the user just took.
- Record anything confusing or missing.

Expected outcome:

- The clinic sees the system respond to real data.
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

- Pass if the clinic can load its own data, test modules, and use the portal and share link without operator intervention.
- Fail if any core import, auth, tenant boundary, or patient-safe access breaks.
- Fail if the system falls back to fake data instead of telling the user the live request failed.

## Customer Test Script

Use these prompts during the live pilot:

1. Create a clinic tenant and owner account.
2. Load real patient data.
3. Load appointments and verify schedule links.
4. Load insurance and confirm payer mapping.
5. Open the patient record and verify history.
6. Run an insurance verification.
7. Create a campaign for inactive patients.
8. Open the AI receptionist and answer a real inbox scenario.
9. Check the staff queue and complete one task.
10. Open the patient portal and confirm the visible surface.
11. Open the public status link and confirm it is readable.

## Module Test Script

Use this table during the live session. The tester should perform the action with their own clinic data and confirm the expected result before moving on.

| Module | Test action | Expected result |
|---|---|---|
| Platform Console | Create a tenant, owner login, and first branch. | Tenant is created, login works, and the clinic appears in the console. |
| Pilot Launchpad | Open the handoff workspace and select the tenant. | Checklist, import tools, and share-link controls load for the selected clinic. |
| Patients | Import a patient CSV, preview it, then commit it. | Rows preview correctly and save into the tenant without fake fallback data. |
| Appointments | Import an appointment CSV tied to loaded patients. | Appointment rows connect to the correct patients and branches. |
| Insurance | Import coverage rows and verify payer mapping. | Coverage records attach to the right patient and payer. |
| Scheduling | Open the schedule and run a booking or slot check. | Availability reflects the live clinic data and the flow does not break. |
| Revenue Protection | Run eligibility verification on a real patient or appointment. | Live eligibility results appear and persist after refresh. |
| Payments | Open balances or payment requests and test one payment action. | Payment or request state updates correctly, or a real API error is shown. |
| Reviews | Load a review record and respond to a negative review. | Response saves, the review updates, and the workflow stays tenant-scoped. |
| Campaigner | Launch or edit a campaign for an inactive cohort. | Campaign state saves and the UI reflects the change on reload. |
| AI Receptionist | Open the inbox, answer a message, and create a follow-up action. | The reply or task is stored and linked to the correct clinic. |
| Staff Workflow | Open the staff queue and complete one task. | Task status updates and the board refreshes correctly. |
| Labs | Open a lab record and mark one action complete if available. | The record updates and the change persists after refresh. |
| Doctor Workspace | Load the provider view and inspect the assigned clinic data. | The page shows the correct clinic context and live provider records. |
| Inventory | Review low-stock items and restock one item. | Stock level updates and remains tied to the correct branch. |
| Advisory Room | Ask a real operational question from the clinic owner. | The response uses live data and links to a real action path. |
| Clinic Radar | Open the radar board and inspect signals and competitors. | Live clinic signals load, competitor data loads, and filters work. |
| Patient Profile | Open a real patient and verify history, insurance, and follow-up actions. | The profile shows live data and actions persist without placeholders. |
| Patient Portal | Log in as a patient and inspect the exposed modules. | Only patient-safe features are visible and usable. |
| Public Status Share | Open the link in a private browser. | The page loads without staff auth and shows readiness only. |

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
- The clinic team has loaded real data.
- The clinic team has run the major module scenarios.
- The patient portal is safe and usable.
- The public status link works.
- Open issues are documented with owners and follow-up dates.
