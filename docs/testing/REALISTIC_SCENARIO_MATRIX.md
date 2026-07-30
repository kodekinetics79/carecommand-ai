# Realistic Scenario Matrix

The 45 deterministic scenarios below define tenant, actors, preconditions, input, expected database/API/UI/audit behavior, authorization and reset strategy in the machine-readable catalog. 33 scenarios link to current executable evidence; the remainder are explicitly marked specification-only and are not release evidence.

| Category | Scenarios |
|---|---:|
| AUTH | 3 |
| PAT | 5 |
| SCH | 7 |
| REC | 11 |
| FIN | 5 |
| INT | 3 |
| PLAT | 5 |
| RLS | 3 |
| OPS | 3 |

| ID | Profile | Evidence | Tenant | Input event | Expected authorization |
|---|---|---|---|---|---|
| AUTH-001 | FUNCTIONAL | EXECUTABLE | functional-family | Password login and browser reload | Only the matching tenant owner is admitted |
| AUTH-002 | EDGE | SPECIFICATION_ONLY | edge-suspended | Attempt password login | Suspended tenant actors are denied |
| AUTH-003 | EDGE | SPECIFICATION_ONLY | edge-archived | Attempt API and object access | Archived actors are denied |
| PAT-001 | FUNCTIONAL | EXECUTABLE | functional-family | Register new adult patient | Front desk may create within its tenant |
| PAT-002 | EDGE | EXECUTABLE | edge-multitenant | Search and open by known foreign ID | Tenant A cannot observe Tenant B |
| PAT-003 | EDGE | SPECIFICATION_ONLY | functional-family | Run duplicate detection | Authorized staff only |
| PAT-004 | FUNCTIONAL | EXECUTABLE | functional-family | Attempt self-signup for the minor record | Automatic access is denied until a reviewed guardian/proxy authority model is implemented |
| PAT-005 | EDGE | SPECIFICATION_ONLY | functional-family | Request restricted communication | Consent policy overrides workflow role |
| SCH-001 | FUNCTIONAL | EXECUTABLE | functional-family | Book new-patient appointment | Front desk may book in assigned clinic |
| SCH-002 | FUNCTIONAL | EXECUTABLE | functional-family | Book through patient portal | Patient may book only for self |
| SCH-003 | EDGE | EXECUTABLE | functional-family | Attempt double booking | No bypass of provider conflict guard |
| SCH-004 | EDGE | SPECIFICATION_ONLY | functional-family | Attempt unavailable booking | No role may override without explicit workflow |
| SCH-005 | FUNCTIONAL | EXECUTABLE | functional-family | Reschedule appointment | Clinic-scoped staff only |
| SCH-006 | FUNCTIONAL | EXECUTABLE | functional-family | Cancel in portal | Patient cannot cancel another patient appointment |
| SCH-007 | EDGE | EXECUTABLE | edge-dst | Book ambiguous/nonexistent local time | Authorized actor remains subject to time validation |
| REC-001 | FUNCTIONAL | EXECUTABLE | functional-family | Existing caller verifies identity | Protected actions require call-scoped proof |
| REC-002 | FUNCTIONAL | EXECUTABLE | functional-family | First inbound call starts | Tenant derives only from trusted provider destination |
| REC-003 | EDGE | EXECUTABLE | functional-family | First inbound call has no unique mapping | No tenant guessing or autonomous action |
| REC-004 | EDGE | EXECUTABLE | functional-family | Send forged webhook | Unauthenticated ingress denied |
| REC-005 | EDGE | EXECUTABLE | functional-family | Request outbound or continued call action | DNC cannot be overridden by AI |
| REC-006 | EDGE | EXECUTABLE | functional-family | Caller describes urgent emergency | No clinical diagnosis or booking continuation |
| REC-007 | EDGE | EXECUTABLE | functional-family | Retry identity proof | Protected actions denied |
| REC-008 | EDGE | EXECUTABLE | functional-family | Attempt inbound tool action | Kill switch is authoritative |
| REC-009 | EDGE | EXECUTABLE | functional-family | Admit another call | Atomic capacity control enforced |
| REC-010 | EDGE | EXECUTABLE | functional-family | Replay duplicate/out-of-order webhook | Signed webhook remains tenant-scoped |
| REC-011 | EDGE | EXECUTABLE | functional-family | Start provider operation | No local bypass |
| FIN-001 | FUNCTIONAL | EXECUTABLE | functional-family | Run eligibility simulator | Billing role within tenant only |
| FIN-002 | EDGE | SPECIFICATION_ONLY | functional-family | Request eligibility | No payer call without policy |
| FIN-003 | FUNCTIONAL | EXECUTABLE | functional-family | Complete simulator payment | Opaque public token is resource-bound |
| FIN-004 | EDGE | EXECUTABLE | functional-family | Replay payment callback | Signature and provider reference required |
| FIN-005 | EDGE | EXECUTABLE | functional-family | Submit payment | No fabricated success |
| INT-001 | FUNCTIONAL | SPECIFICATION_ONLY | functional-family | Open integration status | Secrets never returned |
| INT-002 | EDGE | SPECIFICATION_ONLY | functional-family | Invoke integration | No silent fallback |
| INT-003 | EDGE | SPECIFICATION_ONLY | functional-family | Process integration job | Worker reestablishes tenant context |
| PLAT-001 | PILOT | EXECUTABLE | pilot-multispecialty | Create tenant and owner | Platform admin only; no PHI access |
| PLAT-002 | PILOT | SPECIFICATION_ONLY | pilot-multispecialty | Change plan and features | Platform billing permission required |
| PLAT-003 | PILOT | EXECUTABLE | pilot-multispecialty | Suspend then reactivate tenant | Tenant sessions denied while suspended |
| PLAT-004 | EDGE | SPECIFICATION_ONLY | pilot-multispecialty | Impersonate selected tenant | No platform-wide PHI connection |
| PLAT-005 | EDGE | SPECIFICATION_ONLY | pilot-multispecialty | Reuse ended impersonation | Ended grant cannot reenter tenant |
| RLS-001 | EDGE | EXECUTABLE | edge-multitenant | SELECT/list/aggregate/export Tenant B | Restricted role and RLS deny access |
| RLS-002 | EDGE | EXECUTABLE | edge-multitenant | INSERT/update/reassign using foreign parent | Composite tenant relationship enforced |
| RLS-003 | EDGE | EXECUTABLE | edge-multitenant | Run model and raw query | No-context runtime cannot access protected tables |
| OPS-001 | PILOT | EXECUTABLE | pilot-multispecialty | Retry completed job | Worker context derives from verified envelope |
| OPS-002 | EDGE | EXECUTABLE | pilot-multispecialty | API request fails | No authorization fallback |
| OPS-003 | PILOT | EXECUTABLE | pilot-multispecialty | Search and paginate audit events | Auditor reads only permitted tenant events |
