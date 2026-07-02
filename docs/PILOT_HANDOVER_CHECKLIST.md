# Pilot Handover Checklist

Use this for a real prospect or customer that gets credentials and runs their own tests against their own clinic data.

For the execution order and role-by-role run steps, use [`docs/PILOT_RUNBOOK.md`](/Users/zackkhan/carecommand-ai/docs/PILOT_RUNBOOK.md).
For a printable check-off sheet, use [`docs/PILOT_WORKSHEET.md`](/Users/zackkhan/carecommand-ai/docs/PILOT_WORKSHEET.md).

Customer handoff flow:

1. Platform admin creates the clinic tenant and owner login.
2. Client setup loads or updates the clinic’s real data, previews mappings, and runs module tests with the customer team.
3. Patient portal access is then handed over for the patient-level features the clinic wants enabled.

## What the client gets

- A login for the platform console
- One tenant already provisioned for their clinic
- CSV templates for:
  - patients
  - appointments
  - insurance
- A shareable status link
- A clinic-specific mapping preset when their export format is known

## Before handoff

- Confirm the tenant exists and is tied to the correct clinic name and slug.
- Confirm the owner/operator credentials work.
- Confirm the database migration has been applied in the live environment.
- Confirm the client understands this is a customer handoff, not a general production rollout.
- Confirm the client data they will upload is limited to the entities supported by the pilot import flow.

## Handoff steps

1. Share the platform login credentials.
2. Open the handoff launchpad and select the clinic tenant.
3. Download the correct CSV template for the first import type.
4. Ask the client to export their data into that format.
5. Upload or paste the CSV and run a preview.
6. Review warnings and errors together before committing.
7. Save a mapping preset if their export format will be reused.
8. Create the shareable status link and send it to their team.
9. Repeat the process for appointments and insurance after patients are loaded.

## What to test during handoff

- Patient import with real clinic records
- Appointment import with real schedule data
- Insurance import with active coverage rows
- Re-running imports to confirm updates behave as expected
- Mapping presets across multiple clinics if more than one tenant is used
- The customer-facing status link from a browser that is not logged in

## Go / no-go checks

- The checklist score is visible and updates after imports.
- The preview shows the expected column mapping.
- Committing an import creates or updates rows without crashing.
- The status link opens without requiring staff authentication.
- The client can repeat the workflow on a second clinic tenant.

## Support / rollback

- If the client uploads the wrong CSV, stop at preview and do not commit.
- If the mapping is wrong, save a corrected preset before the next import.
- If the tenant needs a reset, clear only that tenant’s data.
- If the share link needs to be revoked, expire or replace it with a new one.

## Exit criteria

- The client has successfully loaded their own data.
- The client team can repeat the workflow without operator help.
- The client can open the shared status page and understand readiness.
- Any unresolved import gaps are documented before the next review.
- Patient portal access matches the clinic’s chosen permissions and only exposes the features they approve.
