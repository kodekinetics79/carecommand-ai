# M23 Database, Prisma and Row-Level Security — Feature Inventory

Pod: Database Council Pod. Embedded consultant: PostgreSQL/RLS/data-integrity consultant. Independent reviewer: database security consultant. Data: all classes. Dependencies: M24 environment; all persistent modules depend on this module.

| ID | Feature/value | Roles/journeys | UI/API trace | Data/jobs/integrations | Controls/audit/isolation/flags/demo | Evidence/missing/acceptance | Status |
|---|---|---|---|---|---|---|---|
| M23-F01 | Migration lifecycle | Release/DBA; clean deploy, upgrade, seed, teardown/failure | Prisma CLI/scripts | 69 migrations/127 models | owner connection separated, deterministic order, no prod demo seed | Current disposable lifecycle passes 69/69 | COMPLETE |
| M23-F02 | Tenant runtime database role | API/worker; normal/no context/bypass role | Prisma proxy/context | all tenant models | `app_rls` non-super/non-bypass/owns zero, boot guard available | Role posture verification passes | COMPLETE |
| M23-F03 | Platform database plane | Platform operator/tenant user; allowed/denied cross-plane | platform Prisma client/context | platform models | `app_platform` separate curated grants; tenant role no platform privilege | Independent plane tests accepted | COMPLETE |
| M23-F04 | RLS policy catalog | Tenant actors; SELECT/INSERT/UPDATE/DELETE/no context | all tenant APIs/direct harness | 119 protected tables, 8 exemptions | ENABLE+FORCE, 522 policies, exact exemptions | Catalog verification passes 119/119 | COMPLETE |
| M23-F05 | Behavioral RLS | Tenant A/B/no context/pool reuse | disposable DB harness | all protected tables | same tenant allow; cross/no-context deny | 962/962 assertions pass | COMPLETE |
| M23-F06 | Tenant relationship integrity | Domain writers; foreign parent/reassignment/race | Prisma/SQL mutations | 120 composite tenant FKs | database-level tenant key, not app-only | Behavioral/FK evidence passes | COMPLETE |
| M23-F07 | Prisma drift guard | DB council/release; schema diff, missing protected object | drift script | migration-owned FKs/indexes | fail on destructive/unexpected drift; no silent removal | Drift verification passes | COMPLETE |
| M23-F08 | Database backup/restore integrity | DBA/release; backup/encrypt/restore/check/login/RLS/RPO/RTO | operational scripts/runbook | PostgreSQL | isolated target, integrity/RLS/login proof, no shared destructive action | Prior isolated local drill reported; managed production-like restore evidence external | EXTERNAL BLOCKED |

