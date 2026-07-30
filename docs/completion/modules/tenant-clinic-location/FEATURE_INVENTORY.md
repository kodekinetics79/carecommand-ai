# M04 Tenant, Clinic, Location and Service Catalog — Feature Inventory

Pod: Organization Pod. Embedded consultant: multi-site medical-practice operations consultant. Independent reviewer: tenant-lifecycle/data-integrity reviewer. Data: INTERNAL with clinic-linked PHI relationships. Dependencies: M01, M02, M23, M20.

| ID | Feature/value | Roles/journeys | UI/API trace | Data/jobs/integrations | Controls/audit/isolation/flags/demo | Evidence/missing/acceptance | Status |
|---|---|---|---|---|---|---|---|
| M04-F01 | Tenant master/lifecycle contract | Platform owner/tenant owner; provision, active, suspend, archive | consumed by platform/control plane | `Tenant` | platform-only create/lifecycle, tenant read scope, audit, RLS exemptions explicit | Platform/RLS evidence exists; complete state-transition contract not feature-reviewed | IN DISCOVERY |
| M04-F02 | Clinic/branch CRUD | Owner/admin; list/create/status; duplicate/foreign ID | control plane; `/v1/branches`, clinic status APIs | `Branch` | admin permission, tenant FK/RLS, audit, no hardcoded clinic | Browser route crawl/RBAC selected tests; update/delete/closure journey incomplete | IN DISCOVERY |
| M04-F03 | Multi-location limits and timezone | Owner/admin; add within/over limit, DST behavior | control plane/scheduling consumers | `Branch`; M20 entitlement | `multi_location` limit, IANA timezone, tenant scope | Scheduling timezone tests exist; entitlement/location browser contract incomplete | IN DISCOVERY |
| M04-F04 | Service catalog | Owner/admin/manager; list/create/update/disable | scheduling/receptionist; `/v1/services/**` | `ServiceCatalogItem` | appointments feature, tenant scope, pricing/duration validation, audit | Handler tests not identified as dedicated feature suite | IN DISCOVERY |
| M04-F05 | Receptionist location mapping dependency | Receptionist manager; map clinic/location/destination; ambiguous duplicate | Receptionist Studio consumes M09 endpoints/models | M09 location models; Retell | unique trusted destination, no inferred tenant, audit | First-inbound tests accepted in M09; organization-side lifecycle not separately reviewed | IN DISCOVERY |

