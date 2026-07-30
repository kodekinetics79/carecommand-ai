# Security Findings Ledger

| ID | Severity | Finding | Resolution | Evidence | Status |
|---|---|---|---|---|---|
| SEC-RC-001 | P0 | Tenant runtime could bypass isolation in an unsafe database posture | Production boot validates the restricted runtime role; 119 tables use forced RLS | RLS catalog, lifecycle and 962 behavioral assertions | CLOSED |
| SEC-RC-002 | P0 | Platform and tenant data planes could share an over-privileged client | Dedicated `app_platform` client/role, privilege checks and no fallback | Platform database-plane integration tests | CLOSED |
| SEC-RC-003 | P0 | Public/receptionist/webhook entry points could resolve ambiguous tenant context | Signed ingress and fail-closed destination/tenant resolution | Ingress, receptionist and RLS tests | CLOSED |
| SEC-RC-004 | P1 | Login failure differences exposed account state | Uniform response and password-work behavior with fail-closed throttling | Platform auth hardening tests | CLOSED |
| SEC-RC-005 | P1 | Payment and audit side effects could race under duplicate delivery | Advisory locks, terminal checks and transactionally durable audit | Payment concurrency and audit durability tests | CLOSED |
| SEC-RC-006 | P1 | Pilot profile could be selected without production-mode operational controls | Profile now requires production mode, platform plane, HTTPS callbacks/origins, queues and protected metrics | `envSchema.test.ts` and `productionEngineering.test.ts` | CLOSED, PENDING INDEPENDENT REVIEW |

No repository P0/P1/P2 item may be moved to an external activation list. The
ledger is updated after every independent challenge; certification and deployed
operating evidence remain separate from code-level closure.
