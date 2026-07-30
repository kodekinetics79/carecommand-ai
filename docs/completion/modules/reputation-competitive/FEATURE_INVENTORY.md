# M17 Reputation, Reviews and Competitive Intelligence — Feature Inventory

Pod: Reputation Pod. Embedded consultant: healthcare reputation/competitive-intelligence consultant. Independent reviewer: consumer-protection/analytics consultant. Data: INTERNAL with possible PHI-M in review content. Dependencies: M01, M02, M04-M06, M11, M19, M23.

| ID | Feature/value | Roles/journeys | UI/API trace | Data/jobs/integrations | Controls/audit/isolation/flags/demo | Evidence/missing/acceptance | Status |
|---|---|---|---|---|---|---|---|
| M17-F01 | Review inbox/create | Staff; list/create/empty/duplicate | `/reviews`; review APIs | `Review` | tenant scope, content minimization, audit | CRUD route/crawl only; focused role/content/browser tests missing | IN DISCOVERY |
| M17-F02 | Review response | Authorized staff; respond/re-edit/foreign | review respond API | `Review` | write role, tenant scope, no external publish claim, audit | Route exists; external platform publication not integrated; feature evidence incomplete | IN DISCOVERY |
| M17-F03 | Review request workflow | Staff/system; create/send/status/opt-out | growth/reputation consumers | `ReviewRequest` | communication consent, tenant/patient scope, truthful send state | Model exists; complete API/UI/provider evidence not identified | IN DISCOVERY |
| M17-F04 | Reputation cases | Managers; open/assign/resolve/escalate | reputation endpoint | `ReputationCase` | tenant scope, sensitive content, audit | Aggregate endpoint exists; lifecycle UI/API/test evidence incomplete | IN DISCOVERY |
| M17-F05 | Competitor radar/insights | Owner/analyst; list/compare/empty/source failure | Clinic Radar; competitor APIs | `Competitor`, `CompetitorReviewInsight` | provenance, no fabricated market data, tenant scope | Production hardcoding cleaned; statistical/source ingestion tests missing | IN DISCOVERY |

