# Patient Experience Test Matrix

Last updated: 2026-07-20

The patient experience is a release gate. These tests must be run on mobile and
desktop against the deployed-style environment with real client workflows and
non-production patient records.

## Personas

| Persona | Scenario focus |
| --- | --- |
| New adult patient | portal signup, booking, intake, consent, insurance, payment |
| Returning patient | sign-in, reschedule, cancel, payment receipt, follow-up |
| Caregiver/guardian | dependent workflow where enabled; explicit limitation where not enabled |
| Billing-question patient | failed payment, receipt, refund status, insurance transparency |
| Connected-care patient | device enrollment, reading submission, alert communication |
| Accessibility user | keyboard, screen reader, high zoom, mobile viewport |

## Required Journey Tests

| Journey | Test data | Expected result |
| --- | --- | --- |
| Portal access | provisioned clinic slug, matched patient email | one-time code flow succeeds without exposing whether unknown email exists |
| Unknown email | valid clinic slug, unrecognized email | generic response and staff review queue where configured |
| Mobile booking | small viewport, available provider/location | slot can be selected and confirmed without horizontal scrolling |
| Conflict handling | two users attempt same slot | one succeeds; second receives safe conflict message |
| Intake continuation | partially completed intake then browser refresh | saved progress or clear recovery path |
| Consent | current consent form, required checkbox/signature | completion timestamp is persisted and auditable |
| Insurance | valid and invalid payer/member data | valid policy accepted; invalid data gives clear correction path |
| Eligibility | active, inactive, uncertain payer responses | human-readable status and staff-visible next action |
| Payment | success, failure, duplicate submit | no duplicate charge; receipt/failure message is clear |
| Follow-up | post-visit instructions available | patient can view instructions without staff data leakage |
| Connected care | valid device reading | reading appears in patient/staff context |
| Critical reading | out-of-range reading | alert routes to authorized staff; patient language avoids guaranteed-monitoring claims |
| Expired session | stale portal token | sign-in recovery path; no stale PHI displayed |
| Offline/slow network | throttled network or dropped connection | loading, retry, and error states are readable |
| Accessibility | keyboard-only and screen reader smoke | controls reachable, labels announced, focus visible |

## Safety Language Rules

- Do not imply emergency monitoring unless the signed operating model provides it.
- Device alerts are not medical diagnosis.
- Payment and insurance screens must distinguish estimate, deposit, paid, failed,
  refunded, disputed, and pending states.
- Unsupported caregiver/minor/dependent flows must be explicitly scoped out for
  the pilot instead of implied.

## Local Evidence

Current automated local evidence proves backend/API behavior for portal signup,
portal booking, scheduling conflicts, payments, connected-care ingestion, and
security denials. Browser/video evidence is still required from the final
deployed pilot URL.
