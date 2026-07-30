# M20 Subscription, Usage, Entitlements and Feature Flags — Feature Inventory

Pod: Entitlements Pod. Embedded consultant: SaaS subscription/FinOps consultant. Independent reviewer: entitlement/billing-control consultant. Data: SENSITIVE commercial/INTERNAL. Dependencies: M01-M05, M19, M23; all gated modules consume it.

| ID | Feature/value | Roles/journeys | UI/API trace | Data/jobs/integrations | Controls/audit/isolation/flags/demo | Evidence/missing/acceptance | Status |
|---|---|---|---|---|---|---|---|
| M20-F01 | Plan/add-on catalog | Tenant/platform; list plans/add-ons | `/subscription`; subscription APIs | `SubscriptionPlan`, `SubscriptionPlanFeature`, `SubscriptionAddon` | stable keys, server source of truth, no fake price/entitlement | Catalog tests exist; migration/versioning/browser evidence incomplete | IN DISCOVERY |
| M20-F02 | Tenant current subscription | Owner; view trial/active/past-due/suspended | subscription current/admin | `TenantSubscription`, addon links | tenant scope, status semantics, audit | Subscription verification exists; browser state matrix incomplete | IN DISCOVERY |
| M20-F03 | Entitlement resolution | All modules; plan/add-on/override/disabled/limit | `useEntitlements` + `requireFeature` | `TenantFeatureEntitlement` | backend authoritative, deny by default, consistent UI lock, no bypass | Subscription tests and server gates exist; all 15 consumer contract tests incomplete | IN DISCOVERY |
| M20-F04 | Plan/add-on change | Platform/owner request; upgrade/downgrade/concurrency | tenant/platform subscription APIs | subscription/addon models | permission plane, CAS, audit, no external charge claim | Platform audit durability covers mutations; commercial proration/workflow incomplete | IN DISCOVERY |
| M20-F05 | Subscription requests | Owner/platform reviewer; request/approve/reject/race | subscription request APIs | `TenantSubscriptionRequest` | requester/reviewer separation, CAS, audit | Platform audit tests accepted core race behavior; browser workflow incomplete | IN DISCOVERY |
| M20-F06 | Tenant billing/usage limits/AI usage | Platform/tenant viewer; view/update/kill switch | platform billing/usage APIs | `TenantBilling`, `TenantUsageLimit`, `TenantAiUsage` | permission, tenant scope, no payment claim, audit | Platform tests selected; usage ingestion/reconciliation/browser evidence incomplete | IN DISCOVERY |
| M20-F07 | Feature catalog completeness | Release/admin; unknown key/plan drift/UI map | catalog, Sidebar `NAV_FEATURE`, domain guards | 15 feature keys | single source, unknown denied, migration compatibility, artifact scan | Exact consumer inventory exists in registry; automated UI/API/catalog drift assertion missing | IN DISCOVERY |

