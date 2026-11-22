# CareCommand milestone ledger

| Order | Milestone | Baseline | Gate | Open blocker | Next controlled action |
| --- | --- | --- | --- | --- | --- |
| 0 | CC-00 Baseline and product truth | `659564f1a803482f5942282f3edf6249a8363a54` | REMEDIATION ACTIVE | `CC00-001` production API cannot boot because the rate limiter depends on a disabled queue client | Commit the verified candidate, deploy an isolated preview, and rerun production-equivalent readiness |
| 1 | CC-01 Database trust and canonical spine | — | NOT STARTED | CC-00 not accepted | Reconcile schema/RLS evidence after CC-00 |
| 2 | CC-02 Canonical scheduling | — | NOT STARTED | CC-01 not accepted | Certify shared scheduling transaction after CC-01 |
| 3 | CC-03 Telephony control and number binding | — | NOT STARTED | CC-02 not accepted | Bind and verify the tenant-owned number through CareCommand |
| 4 | CC-04 Outbound appointment conversion | — | NOT STARTED | CC-03 not accepted | Execute the call-to-appointment golden journey |
| 5 | CC-05 Inbound access and unified work queue | — | NOT STARTED | CC-04 not accepted | Certify inbound routing and exception ownership |
| 6 | CC-06 Omnichannel continuity | — | NOT STARTED | CC-05 not accepted | Add accepted channel adapters |
| 7 | CC-07 Patient readiness and revenue | — | NOT STARTED | CC-06 not accepted | Certify intake, eligibility, and payment reconciliation |
| 8 | CC-08 Multi-location pilot certification | — | NOT STARTED | CC-07 not accepted | Certify second clinic, recovery, and release controls |
| 9 | CC-09 UAE country pack | — | NOT STARTED | CC-08 not accepted | Activate the UAE design-partner path |
| 10 | CC-10 Growth/recovery and Saudi pack | — | NOT STARTED | CC-09 not accepted | Expand only from measured accepted workflows |

## CC-00 control record

### Executive gate

Module: Baseline and product truth

Gate: `REMEDIATION ACTIVE`

Baseline/deployed SHA: `659564f1a803482f5942282f3edf6249a8363a54`

Production deployment: `dpl_8J9iYiFaonmcV5KphQvkCt8NS7Aq`

Environment: `https://carecommand.kodekinetics.com`

Decision: frontend build identity matches the main candidate, but the production
API fails during cold start. No workflow acceptance is valid while the API is
unavailable.

### Evidence

| Requirement/risk | Evidence | Result | Finding |
| --- | --- | --- | --- |
| Exact repository baseline | Git main and Vercel deployment metadata resolve to the same full SHA | PASS | — |
| Production frontend availability | `/login` returns the hashed application assets built by the candidate | PASS | — |
| Production API readiness | `/health/ready` returns `FUNCTION_INVOCATION_FAILED` | FAIL | CC00-001 |
| API failure root cause | Vercel runtime log: `RateLimit: distributed store is required in production` before Fastify boot | FAIL | CC00-001 |
| Local API type safety | `npm run api:typecheck` after Prisma generation | PASS | — |
| Local production build | `npm run build` | PASS | — |
| Production artifact scan | `verifyNoProductionDemoArtifacts.ts` | PASS | — |
| Web regression suite | 83 files; 680 passed; one documented expected failure | PASS | — |
| Full server integration suite | Requires an approved disposable PostgreSQL test environment unavailable in the current executor | BLOCKED | CC00-002 |

### Findings

| ID | Severity | Observed fact | Impact | State | Owner/next action |
| --- | --- | --- | --- | --- | --- |
| CC00-001 | Critical | API rate limiting reused the BullMQ client; the deployed serverless profile disables queue workers, producing no distributed store and aborting startup | All API, authentication, and CareCommand-originated calling workflows are unavailable | REMEDIATION ACTIVE / PREVIEW REQUIRED | Deploy the dedicated API rate-limit Redis connection and prove `/health/ready` plus login |
| CC00-002 | Medium | Current executor has no disposable PostgreSQL service or approved test database URL | Full server/database regression cannot run here | OPEN | Run the release suite in CI/staging with its disposable database |

### Current candidate evidence

- The rate-limit adapter now exercises the real `@fastify/rate-limit` Lua-command
  contract across two application instances (`200` then shared-limit `429`).
- Dedicated API Redis lifecycle is independent of BullMQ workers and the queue
  readiness probe reports `disabled` when the serverless queue profile is off.
- Startup and command timeouts fail closed; a runtime command failure discards
  the dead client and reacquires a fresh connection after the bounded circuit.
- Partial application boot and Vercel post-build boot failures explicitly close
  initialized resources before a retry.
- Focused regression tests: 10 passed. API typecheck, full lint, production build,
  Vercel API bundle, production-artifact scan, and web regression suite (83
  files, 680 passed, one
  documented expected failure) pass locally.
- Production-equivalent preview and authenticated browser evidence remain
  mandatory before this finding or milestone can be accepted.

### Next controlled action

Deploy the CC00-001 candidate to an isolated preview using production-equivalent
Redis configuration, verify API readiness and authentication there, then promote
that exact tested artifact.
