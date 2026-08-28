# Security Findings Ledger

| ID | Severity | Finding | Resolution | Evidence | Status |
|---|---|---|---|---|---|
| SEC-RC-001 | P0 | Tenant runtime could bypass isolation in an unsafe database posture | Production boot validates the restricted runtime role; 119 tables use forced RLS | RLS catalog, lifecycle and 962 behavioral assertions | CLOSED |
| SEC-RC-002 | P0 | Platform and tenant data planes could share an over-privileged client | Dedicated `app_platform` client/role, privilege checks and no fallback | Platform database-plane integration tests | CLOSED |
| SEC-RC-003 | P0 | Public/receptionist/webhook entry points could resolve ambiguous tenant context | Signed ingress and fail-closed destination/tenant resolution | Ingress, receptionist and RLS tests | CLOSED |
| SEC-RC-004 | P1 | Login failure differences exposed account state | Uniform response and password-work behavior with fail-closed throttling | Platform auth hardening tests | CLOSED |
| SEC-RC-005 | P1 | Payment and audit side effects could race under duplicate delivery | Advisory locks, terminal checks and transactionally durable audit | Payment concurrency and audit durability tests | CLOSED |
| SEC-RC-006 | P1 | Pilot profile could be selected without production-mode operational controls | Profile now requires production mode, platform plane, HTTPS callbacks/origins, queues and protected metrics | `envSchema.test.ts` and `productionEngineering.test.ts`; independent 28/28 retest | CLOSED |
| SEC-RC-007 | P1 | Split-site pilot cookies could remain `SameSite=Lax`, breaking refresh/logout while posture output stayed misleading | Pilot/enterprise require `SameSite=None`; posture reflects configured value | Environment, auth and browser acceptance at `a07ba0f` / `3ac14ac` | CLOSED |
| SEC-RC-008 | P2 | Public URL and migration-owner checks admitted ambiguous aliases or required excess release-job secrets | Strict public host/origin validation; explicit migration principal with optional runtime comparisons | Adversarial URL/principal tests and independent shell execution | CLOSED |

No repository P0/P1/P2 item may be moved to an external activation list. The
ledger is updated after every independent challenge; certification and deployed
operating evidence remain separate from code-level closure.
