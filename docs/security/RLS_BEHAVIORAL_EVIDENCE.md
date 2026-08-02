# RLS Behavioral Evidence

## Verdict and scope

The restricted-role PostgreSQL behavioral boundary is **PASS** for all 123 protected tables on a clean disposable database with all 86 migrations applied. The exercised connection reports `current_user = app_rls`. The schema-owner connection is limited to database lifecycle, the two Tenant rows, the persisted request actors, global reference prerequisites, and public-ingress fixture activation.

This is database-isolation evidence, not HIPAA, SOC 2, or GDPR certification. It does not replace route authorization, provider-contract, production-operations, or live pilot evidence.

## Adapter inventory

`server/test/helpers/rlsBehaviorHarness.ts` derives the expected protected inventory from `prisma/schema.prisma` and independently rejects any difference from the deployed PostgreSQL RLS catalog.

| Contract | Tables | Restricted-role behavior executed |
|---|---:|---|
| Mutable tenant table | 118 | SELECT; committed non-conflicting INSERT; meaningful UPDATE; tenant and cross-parent reassignment; DELETE; UPSERT; bulk UPDATE/DELETE |
| Append-only evidence | 4 | SELECT and committed INSERT; UPDATE/DELETE/UPSERT mutation denial, including bulk operations |
| Read-only tenant root | 1 | Same-tenant SELECT; every runtime write denied |
| **Total** | **123** | **One catalog-checked adapter per protected table** |

Append-only adapters are `AuditEvent`, `ConsentEvent`, `ReceptionistArtifactLifecycleEvent`, and `ReceptionistRecordingConsentEvent`. `Tenant` is read-only to `app_rls`.

## Executed semantics

For every table, the suite executes real SQL for:

- primary-key visibility with Tenant A, Tenant B, and no context;
- list, text-search, aggregate count, and JSON export surfaces with the same three contexts;
- a committed, non-conflicting `app_rls` INSERT for each of the 122 writable protected tables; no `ON CONFLICT DO NOTHING` is used as INSERT evidence;
- explicit Tenant INSERT denial;
- cross-tenant and no-context INSERT denial using an existing fixture payload;
- a meaningful same-tenant UPDATE that changes a safe scalar value, plus cross/no-context UPDATE behavior;
- ownership reassignment to Tenant B;
- same-tenant DELETE captured before dependent fixtures are added, plus cross/no-context DELETE behavior;
- `INSERT ... ON CONFLICT ... DO UPDATE` UPSERT behavior;
- predicate-based bulk UPDATE and bulk DELETE behavior;
- append-only trigger/privilege behavior and Tenant read-only privileges.

The harness captures same-tenant mutation proof immediately after each restricted-role fixture INSERT, before downstream fixtures can turn a valid DELETE into an unrelated foreign-key refusal. Each operation is rolled back after its row count, changed value, or SQLSTATE is captured.

Cross-parent reassignment is exercised with direct SQL on every adapter that has a tenant-protected parent reference. All fail closed through RLS, tenant-consistent FK/check constraints, uniqueness constraints, or immutable-evidence triggers. Tables without a protected parent reference are structurally not applicable.

Prisma `connect`, nested-create, and nested-update syntax is not a PostgreSQL operation and is genuinely not applicable to this database-only harness. Its security-relevant database equivalent is covered by the direct cross-parent FK reassignment cases. Prisma API behavior remains an application/integration-test responsibility.

## Public ingress and pool semantics

Eight additional ingress cases execute the public actor rules:

- `PatientPortalAccount` / `PATIENT_PORTAL`;
- `PatientIntakePacket` / `PUBLIC_INTAKE`;
- `PaymentRequest` / `PUBLIC_PAYMENT`;
- `PilotStatusShare` / `PILOT_SHARE`;
- the three allowlisted `PUBLIC_PORTAL` bootstrap actors;
- a well-formed `WEBHOOK` actor.

Each valid context sees its Tenant A fixture; the same actor bound to Tenant B and a forged/malformed actor see zero. The webhook case proves the database actor-shape boundary only; signature and resource resolution must already have succeeded in application ingress code.

The pool cleanup case releases an authorized transaction, reacquires the same PostgreSQL backend PID from a single-connection pool, verifies the transaction-local tenant setting is empty, and confirms that the earlier Tenant A row is no longer visible.

## Disposable database boundary

`server/scripts/withDisposableRlsDatabase.ts` creates, migrates, exercises, and drops a uniquely generated database. It requires the exact acknowledgement `CREATE_AND_DROP_LOCAL_RLS_TEST_DATABASE`, refuses `NODE_ENV=production`, permits only PostgreSQL URLs addressed to localhost/IPv4 loopback/IPv6 loopback, validates the connected server as loopback or a private local-container address, and accepts only generated `carecommand_rls_behavior_` names of at most 63 characters.

Cleanup runs only after this process successfully created the database. A name collision therefore cannot cause a pre-existing database to be dropped. Operation and cleanup errors are both retained when both fail. The lifecycle never resets or deletes a shared application database and never disables RLS, constraints, or evidence triggers.

## Execution evidence

```text
RLS_DISPOSABLE_DB_ACK=CREATE_AND_DROP_LOCAL_RLS_TEST_DATABASE \
NODE_ENV=test \
npx tsx server/scripts/withDisposableRlsDatabase.ts -- \
  npx vitest run server/test/rlsBehavioralCoverage.integration.test.ts --reporter=dot

86 migrations applied
1 test file passed
994 tests passed
0 failed / 0 skipped
generated database removed; zero matching disposable databases remained
```

The 994 tests are one inventory assertion, eight cases for each of 123 protected tables, eight public-ingress cases, and one pool-cleanup case.

Lifecycle refusal and URL/address safety tests:

```text
npx vitest run server/test/rlsDatabaseLifecycle.unit.test.ts --reporter=dot
1 test file passed
20 tests passed
```

Static verification:

```text
npm run api:typecheck
npx eslint server/test/helpers/rlsBehaviorHarness.ts \
  server/test/rlsBehavioralCoverage.integration.test.ts \
  server/scripts/withDisposableRlsDatabase.ts \
  server/test/rlsDatabaseLifecycle.unit.test.ts
git diff --check
```

API typecheck and scoped ESLint passed. This lane did not edit the Prisma schema, migrations, package scripts, CI, or application code.
