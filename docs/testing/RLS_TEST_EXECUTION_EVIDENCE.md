# RLS Test Execution Evidence

Date: 2026-07-30  
Scope: disposable local PostgreSQL databases and the restricted local runtime role; synthetic data only.

The values below are the current completed 69-migration checkpoint, including both RPM evidence-binding migrations.

## Current catalog

| Measure | Result |
|---|---:|
| Application tables | 127 |
| Prisma migration-metadata tables | 1 |
| Tenant/PHI protected tables | 119 |
| RLS enabled / forced | 119 / 119 |
| Explicit exemptions | 8 |
| PostgreSQL policies | 522 |
| Public views/materialized views | 0 |
| Protected tables owned by `app_rls` | 0 |
| Runtime superuser / BYPASSRLS | false / false |
| Protected tables with behavioral adapters | 119 / 119 |
| Behavioral assertions | 962 / 962 passing |
| Runtime platform-table privilege mismatches | 0 |

## Reproducible commands

| Command | Result |
|---|---|
| `npm run rls:verify` | PASS: complete protected/exemption classification, 522 policies, safe runtime posture |
| `RLS_DISPOSABLE_DB_ACK=CREATE_AND_DROP_LOCAL_RLS_TEST_DATABASE npm run test:rls:behavior` | PASS: all 69 migrations; 1 file, 962/962 restricted-role assertions |
| `NODE_ENV=test RELEASE_DB_LIFECYCLE_ACK=CREATE_DROP_LOCAL_RELEASE_TEST_DATABASES npm run verify:db-lifecycle` | PASS: 69-migration clean/upgrade lifecycle, 119 forced tables, 120 tenant-integrity FKs |
| `npm run verify:prisma-drift` | PASS: migration-owned security objects are preserved and unexpected destructive drift fails the guard |

The tenant runtime and platform control plane use separate roles, clients, context setters, and curated grants. Unknown/no context fails closed. Pool-reuse tests verify that transaction-local tenant context does not leak between requests. Narrow public ingress resolvers verify signed provider data and do not grant general tenant bypass.

This is local engineering evidence, not deployed-topology proof or HIPAA, SOC 2, or GDPR certification.
