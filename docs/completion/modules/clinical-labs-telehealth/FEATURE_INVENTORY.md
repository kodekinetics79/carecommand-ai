# M08 Clinical Workspace, Labs and Telehealth — Feature Inventory

Pod: Clinical Pod. Embedded consultant: practicing physician/clinical-informatics consultant. Independent reviewer: clinical-safety consultant. Data: PHI-H. Dependencies: M01-M07, M14, M19, M23.

Critical scope fact: the repository has no dedicated Encounter, ClinicalNote, Diagnosis, Allergy, Medication, Order, Referral, LabResult or TelehealthSession model. These routes must not be represented as an EHR or completed clinical record system.

| ID | Feature/value | Roles/journeys | UI/API trace | Data/jobs/integrations | Controls/audit/isolation/flags/demo | Evidence/missing/acceptance | Status |
|---|---|---|---|---|---|---|---|
| M08-F01 | Provider workspace operational view | Provider/manager; overview, empty, denied | `/doctor-workspace`; provider/staff/ops APIs | consumes provider/appointment/task/analytics models | minimum necessary, assigned clinic, truthful unavailable | Crawl passes; dedicated provider authorization/data correctness/browser tests incomplete | IN DISCOVERY |
| M08-F02 | Labs review surface | Provider; list/review/escalate/empty | `/labs` | No LabResult model/API; may consume operational signals | Must not fabricate results or imply clinical signoff; PHI audit required if implemented | No real persistence/API Definition of Done; implementation or explicit scope retirement required | IN DISCOVERY |
| M08-F03 | Telehealth session listing | Provider/front desk; list/empty/provider unavailable | `/telehealth`; `GET /v1/telehealth/sessions` | derives appointment data; no session model/provider | patient/clinic scope; truthful provider-unavailable state | Handler/crawl evidence only; dedicated auth and browser tests incomplete | IN DISCOVERY |
| M08-F04 | Telehealth room/join workflow | Provider/patient; create/join/expire/failure | UI actions intentionally removed when unsupported | No model/provider | No fake room or success; PHI-safe external URL | Not implemented; must remain unavailable or gain real provider/model/tests | IN DISCOVERY |
| M08-F05 | Clinical documentation/diagnosis/medication/order/referral | Clinical users; create/review/amend/sign | No owned UI/API | No owned models | Safety, provenance, immutable amendment, least privilege required | Not present in actual architecture; out-of-scope decision must be explicit before sales claims | IN DISCOVERY |
| M08-F06 | Clinical safety boundary | All actors/AI; emergency, advice request, unsupported action | receptionist/advisory/connected-care consumers | audit and handoff dependencies | No diagnosis/prescribing/autonomous clinical action; escalation/human review | Receptionist/RPM safety evidence exists; module-wide clinical claims review required | IN DISCOVERY |

