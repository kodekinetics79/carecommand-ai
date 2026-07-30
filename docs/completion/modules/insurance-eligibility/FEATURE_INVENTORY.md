# M12 Insurance, Eligibility and Prior Authorization — Feature Inventory

Pod: Insurance Pod. Embedded consultant: payer eligibility/prior-auth consultant. Independent reviewer: payer workflow/data-integrity consultant. Data: PHI-H/financial. Dependencies: M01-M07, M10, M13, M19-M23.

| ID | Feature/value | Roles/journeys | UI/API trace | Data/jobs/integrations | Controls/audit/isolation/flags/demo | Evidence/missing/acceptance | Status |
|---|---|---|---|---|---|---|---|
| M12-F01 | Payer catalog | Admin/billing; list/create/update/duplicate | `/insurance`; payer APIs | `InsurancePayer` | admin write, tenant scope, audit, no mock accepted status | Insurance tests selected; full CRUD/browser evidence incomplete | IN DISCOVERY |
| M12-F02 | Patient policy CRUD/integrity | Billing/front desk/patient; add/edit, overlap, wrong payer/tenant | staff and portal policy APIs | `PatientInsurancePolicy` | billing/portal self scope, composite ownership, overlap rules, audit | Policy-integrity independent evidence passes | COMPLETE |
| M12-F03 | Insurance intake/denial prevention | Front desk/billing; appointment intake, missing policy, flags | insurance intake/denial APIs | policy/appointment/eligibility | permission/branch scope, evidence-based flags, no invented denial | Handler tests selected; focused business/browser evidence incomplete | IN DISCOVERY |
| M12-F04 | Provider configuration/health | Admin/billing; configure/test/unconfigured/bad credential | insurance provider APIs | `InsuranceProvider`; Stedi/etc. | secrets write-only, truthful mode, rate limit, audit | Provider gating/failure honesty tests pass; live credential test external | EXTERNAL BLOCKED |
| M12-F05 | Eligibility request/check | Billing/front desk; active/inactive/unknown/timeout/retry | eligibility check APIs | `EligibilityVerification`; payer adapter | policy/tenant/branch scope, rate/idempotency, explicit simulator label, audit | Insurance/revenue tests pass locally; payer sandbox/live evidence external | EXTERNAL BLOCKED |
| M12-F06 | Benefit snapshot/history | Billing/patient self; history/view, stale, foreign | eligibility history/portal | `BenefitSnapshot` | source/time/provider provenance, immutable snapshot, minimum necessary | Local policy/eligibility tests selected; comprehensive stale/version/browser evidence incomplete | IN DISCOVERY |
| M12-F07 | Prior authorization workflow | Billing/provider; list/status, invalid transition/foreign | Revenue Protection prior-auth APIs | `PriorAuthorization` | billing permissions, branch/patient scope, audit | Revenue authorization tests selected; creation/doc/payer submission workflow incomplete | IN DISCOVERY |
| M12-F08 | Accepted plans/provider directory | Patient/front desk; list/empty/unconfigured | `/insurance`; accepted/providers GET | payer/provider models | tenant scope, truthful configured state, no global fake network | Browser crawl only; focused data correctness evidence missing | IN DISCOVERY |

