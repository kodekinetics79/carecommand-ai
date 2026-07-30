# M18 Inventory, Partner Reports and Tenant Integrations — Feature Inventory

Pod: Integration Operations Pod. Embedded consultant: healthcare integration/vendor-operations consultant. Independent reviewer: API/webhook/reliability consultant. Data: INTERNAL with possible PHI-H partner payloads. Dependencies: M01-M07, M19-M24.

| ID | Feature/value | Roles/journeys | UI/API trace | Data/jobs/integrations | Controls/audit/isolation/flags/demo | Evidence/missing/acceptance | Status |
|---|---|---|---|---|---|---|---|
| M18-F01 | Inventory list/create/update | Staff/admin; list/create/edit/expiry/foreign | `/inventory`; inventory APIs | `InventoryItem` | tenant/branch scope, admin writes, validated quantities/dates, audit | Hardcoded recommendations removed/crawl passes; focused CRUD/concurrency tests missing | IN DISCOVERY |
| M18-F02 | Inventory expiry/low-stock intelligence | Managers; threshold/expired/empty | Inventory UI | inventory data | current date derived, no fixed threshold/fake recommendation | Cleanup verified; business threshold tests missing | IN DISCOVERY |
| M18-F03 | Partner report lifecycle | Staff; list/create/review/foreign | partner report APIs | `PartnerReport` | tenant scope, PHI minimization, review audit, no fabricated notes | Hardcoded named-patient note removed; focused workflow tests missing | IN DISCOVERY |
| M18-F04 | Tenant integration registry | Admin; list/configure/disable, secret fields | `/integrations`; operations integration APIs | `Integration` | custom integration flag, secrets not returned, tenant scope, audit | Provider honesty tests selected; CRUD secret/encryption/browser matrix incomplete | IN DISCOVERY |
| M18-F05 | Integration test/run logs | Admin; test success/failure/timeout/retry | integration status/test APIs | `IntegrationRunLog` | truthful mode/result, redacted error, tenant scope, audit | Control-plane provider tests selected; every tenant provider evidence incomplete | IN DISCOVERY |
| M18-F06 | Integration failure/retry contract | Admin/worker; timeout, duplicate event, retry/dead letter | integration seams/run logs | provider APIs; Redis if queued | idempotency, backoff, circuit/fail closed, trace/audit | Runbook and selected retry tests exist; generic queue/DLQ and live provider evidence incomplete | IN DISCOVERY |

