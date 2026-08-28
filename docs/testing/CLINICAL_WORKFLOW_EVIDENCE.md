# Clinical Workflow and Portal Release Evidence

Date: 2026-07-30  
Lane: patients, appointments, insurance, monitoring, and patient portal  
Boundary: operational support and staff routing only; no diagnosis, treatment, or emergency-dispatch automation

## Verdict

The original clinical workflow findings below are fixed. The current authoritative release review in `RELEASE_READINESS_REPORT.md` keeps RPM evidence-bound signoff open while offline-device invalidation and event-derived rolling-window evidence are corrected and independently re-reviewed. This is engineering evidence, not HIPAA, SOC 2, GDPR, clinical-safety, or production certification. Live payer/provider behavior and organizational controls remain outside this local test.

## Launch-critical defects fixed

| Area | Defect | Resolution/evidence |
|---|---|---|
| Portal identity | A victim phone plus attacker email could match by OR and choose attacker email for credential delivery. | All supplied contact attributes must match the same account/patient. Mixed-contact signup and request-link create no token. |
| Portal lifecycle | Soft-deleted patients retained usable portal JWT/account paths. | Login, `/me`, and all portal routes require a non-deleted tenant-matching patient; patient deactivation also disables portal accounts atomically. |
| Portal governance | Concurrent access-request reviewers could both approve and mint tokens; approved requests could later be rejected. | Approval/rejection use compare-and-set transactions with credential issuance and audit in the same transaction. |
| Portal insurance | Pending, unknown, failed, and expired insurance could be shown as complete; member-ID PATCH was ignored. | Only recently verified coverage is complete; other states remain pending/action-required. Member-ID changes persist and clear prior verification. |
| Appointments | New appointments accepted terminal/historical states, terminal visits could be cancelled/rescheduled, and read-then-write transitions could overwrite concurrent changes. | Create is limited to confirmed/waitlist; explicit state machines and compare-and-set updates protect cancel, reschedule, and lifecycle transitions. |
| Patient records | Future dates of birth were accepted; deactivation did not revoke portal access or account for future appointments. | Future DOB is rejected; future active appointments block deactivation; portal account disable is atomic with soft delete. |
| Monitoring provenance | Staff ingestion could claim device/webhook provenance, provide contradictory display/numeric values, unsupported units, future timestamps, or cross-branch patients/devices. | Staff path is manual/import only, values are normalized server-side, canonical units and time bounds are enforced, and patient/device/branch ownership is verified. |
| Monitoring safety | Reading creation committed before alert/notification creation, permitting a partial abnormal-reading result. | Reading, derived alert, notification, and audit now commit in one transaction. |
| Monitoring risk | Every valid reading was counted as abnormal and trend direction was calculated backwards. | Risk uses recent `abnormal_reading` alerts only; trend compares newer readings with the next older reading. |
| Monitoring branch isolation | Tenant-wide notifications, signals, eligibility/RPM counts, and AI briefing could reach branch-restricted users; signal mutation had branch IDOR paths. | Branch filters now cover these surfaces; tenant-wide AI briefing is suppressed for branch-restricted sessions; signal patient/branch consistency and mutation scope are enforced. |
| Monitoring workflow | Resolved alerts could be acknowledged/reassigned and concurrent mutations could overwrite state. | Terminal-state checks, idempotent repeats, and compare-and-set transitions enforce alert lifecycle. |

## Verification

Commands:

```text
npm run api:typecheck
npx eslint server/modules/patients/routes.ts server/modules/appointments/routes.ts server/modules/insurance/routes.ts server/modules/monitoring/routes.ts server/modules/portal/auth.ts server/modules/portal/admin.ts server/modules/portal/routes.ts server/test/clinicalWorkflowHardening.integration.test.ts
npx vitest run <19 focused clinical/portal/scheduling/insurance/monitoring suites> --reporter=json --outputFile=/tmp/clinical-workflow-final.json
git diff --check -- <owned clinical lane>
```

Results:

- API TypeScript: PASS.
- Focused ESLint: PASS.
- Final focused regression: 52 suites, 108 tests; 108 passed, 0 failed, 0 pending.
- New hardening regression: 9 tests covering mixed-contact credential attacks, deleted-patient access, concurrent portal approval, insurance status truthfulness, appointment disposition, atomic abnormal-reading persistence, provenance/value validation, branch isolation, abnormal-risk scoring, and chronological trends.
- Diff whitespace validation: PASS.

## Residual launch gates and product boundaries

- Guardian/proxy portal access is not implemented and is fail-closed: minor/unknown-age and asserted-guardian approval attempts return `proxy_access_not_supported`, create no account or credential, and leave the review request pending. Pilot enrollment must use verified adult patient self-access and must not represent proxy access as supported.
- Portal logout atomically revokes its server-side HMAC-JTI session and writes a logout audit; the client also discards its memory-only bearer. Deployment cookie/origin behavior still requires validation.
- No live payer eligibility request, device vendor webhook, payment, SMS/email delivery, real PHI, or production database was used in this evidence run.
- Live eligibility still depends on deployment credentials and adapter readiness; sandbox results remain explicitly labeled simulated.
- Monitoring thresholds route operational work to humans. They are not diagnostic or treatment decisions and require clinic-approved protocols and human review.
- Compliance readiness still requires organization-level policies, BAAs/DPAs, access reviews, retention validation, incident response, backup/restore evidence, vendor assessment, and production observability evidence.
