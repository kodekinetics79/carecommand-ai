# M05 Workforce, Roles, Providers and Staff — Pod Evidence

Date: 2026-07-30  
Embedded consultant: healthcare workforce/RBAC review  
Independent consultant: required before COMPLETE

| Feature | Positive journey | Negative / race journey | Closure and evidence | Embedded verdict |
|---|---|---|---|---|
| Administrator lifecycle safety | One of two administrators may be deactivated | Concurrent cross-deactivation cannot remove both; the last administrator gets 409; a blocked attempt is audited | Tenant advisory transaction lock; mutation and audit are atomic; `foundationMasterData.integration.test.ts` | PASS — independent review pending |
| Clinic access administration | Valid active clinic assignment is saved | Foreign/inactive clinic and invalid primary are rejected without changing existing access | Strict tenant-owned active-set validation and atomic replacement/audit; `foundationMasterData.integration.test.ts` | PASS — independent review pending |
| Provider identity onboarding | Administrator onboards an active PROVIDER with selected-clinic access | Front desk denied; non-provider, inactive, wrong-clinic and cross-tenant users rejected; concurrent duplicate yields exactly 201/409 | `admin:manage` for identity writes, `staff:read` for directory reads, per-user transaction lock and atomic provider/audit receipt; `onboardingReadCompliance.integration.test.ts` | PASS — independent review pending |
| Staff task lifecycle | Authorized administrator completes a task | Auditor denied; completed/canceled task cannot reopen | `staff:write`, per-task serialization, final terminal states, atomic transition/audit; `onboardingReadCompliance.integration.test.ts` | PASS — independent review pending |

Focused result: workforce/provider/staff coverage is included in `onboardingReadCompliance.integration.test.ts`; combined pod run PASS, 16/16 in that file and 21/21 with foundation master-data tests. API typecheck and targeted lint PASS.

Residual release evidence: complete role/permission endpoint matrix, workforce browser journeys, invitation/delivery, task creation/assignment/SLA ownership, and accessibility remain open. These controls are readiness evidence, not HIPAA/SOC 2/GDPR certification.

