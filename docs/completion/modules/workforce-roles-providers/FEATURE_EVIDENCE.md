# M05 Workforce, Roles, Providers and Staff — Pod Evidence

Date: 2026-07-30  
Embedded consultant: healthcare workforce/RBAC review  
Independent consultant: required before COMPLETE

| Feature | Positive journey | Negative / race journey | Closure and evidence | Embedded verdict |
|---|---|---|---|---|
| Administrator lifecycle safety | One of two administrators may be deactivated | Concurrent cross-deactivation cannot remove both; the last administrator gets 409; a blocked attempt is audited | Tenant advisory transaction lock; mutation and audit are atomic; `foundationMasterData.integration.test.ts` | PASS — independent review pending |
| Clinic access administration | Valid active clinic assignment is saved | Foreign/inactive clinic and invalid primary are rejected without changing existing access | Strict tenant-owned active-set validation and atomic replacement/audit; `foundationMasterData.integration.test.ts` | PASS — independent review pending |
| Provider identity onboarding | Clinician-capable PROVIDER, OWNER, and ADMIN users can receive provider profiles without destructive role conversion | Front desk denied; inactive, wrong-clinic and cross-tenant users rejected; concurrent duplicate yields exactly 201/409 | `admin:manage` for identity writes, `staff:read` for directory reads, per-user transaction lock and atomic provider/audit receipt; commit `524169f` | PASS — independent re-review pending |
| Staff task lifecycle | Front desk and managers can perform the narrow task-status transition required by operations | Auditor denied; permission does not grant broader staff writes; completed/canceled task cannot reopen | `staff:task-status`, per-task serialization, final terminal states, atomic transition/audit; commit `524169f` | PASS — independent re-review pending |

Remediation checkpoint: combined foundation/onboarding/RBAC run PASS 37/37; API typecheck, targeted lint, and diff hygiene PASS. Independent acceptance remains required.

Residual release evidence: complete role/permission endpoint matrix, workforce browser journeys, invitation/delivery, task creation/assignment/SLA ownership, and accessibility remain open. These controls are readiness evidence, not HIPAA/SOC 2/GDPR certification.
