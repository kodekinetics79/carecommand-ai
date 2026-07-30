# Route and Action Integrity Matrix

Validated against the real Fastify/PostgreSQL backend. Browser tests do not mock API routes.

## Role-aware route inventory

| Surface | Routes | OWNER / ADMIN | COMPLIANCE_OFFICER / AUDITOR | Other tenant roles | Evidence |
|---|---|---:|---:|---:|---|
| Command Center | `/`, `/advisory`, `/opportunities` | visible | visible | visible | Sidebar inventory + route crawl |
| Front Office | `/patients`, `/scheduling`, `/patient-intake`, `/ai-receptionist`, `/receptionist-studio`, `/staff` | visible | visible | visible | Sidebar inventory + route crawl |
| Growth | `/crm`, `/campaigner`, `/reactivation`, `/autopilot`, `/reviews`, `/clinic-radar` | visible | visible | visible | Sidebar inventory + route crawl |
| Revenue | `/revenue`, `/revenue-protection`, `/insurance`, `/insurance-eligibility`, `/doctor-workspace`, `/benchmarking` | visible | visible | visible | Sidebar inventory + route crawl |
| Connected Care | `/monitoring`, `/devices`, `/enrollments`, `/rpm-readiness`, `/sync-logs`, `/integration-setup` | visible | visible | visible | Sidebar inventory + route crawl |
| Compliance | `/compliance`, `/compliance/:section` | allowed | allowed | hidden and route-redirected | `ComplianceRoute` + role crawl |
| Tenant control plane | `/control-plane`, `/admin` | allowed | hidden and route-redirected | hidden and route-redirected | `AdminRoute` + role crawl |
| General governance | `/integrations`, `/subscription`, `/settings` | visible | visible | visible | Sidebar inventory + route crawl |
| Patient portal | `/client` plus appointments, requests, intake, insurance, payments, profile, preferences | separate patient identity | separate patient identity | separate patient identity | Golden journey |
| Public/tokenized | `/intake/:token`, `/pilot/:token` | token authority | token authority | token authority | Existing integration/golden tests |
| Platform console | `/platform/login`, `/platform` | separate platform identity | separate platform identity | separate platform identity | Not tenant-role authority |

Subscription-entitled modules remain server-enforced. Sidebar locks are usability hints, not authorization boundaries.

## Action integrity findings

| Area | Finding | Resolution | Status |
|---|---|---|---|
| Login footer | Privacy/Terms/Security links used `href="#"` | Removed dead links; retained working support and security-report email actions | fixed |
| Payment requests | Missing payment URL opened `#` in a new tab | Action is disabled with an explanatory title until a real URL exists | fixed |
| AI Front Desk | Fixed after-hours chart and `0/1` recovery display looked live | Chart and denominators now derive only from live conversation records | fixed |
| Scheduling | Sample patients, slot values, recommendations, and money appeared in the production workspace | Removed until backed by persisted scheduling/opportunity data | fixed |
| Revenue | Fixed lost-opportunity dollar figures appeared beside live metrics | Replaced with live revenue-protection and snapshot aggregates | fixed |
| Partner reports | Hardcoded named-patient AI notes | Replaced with live report counts and workflow-derived action text | fixed |
| Inventory | Hardcoded product/branch recommendations and a fixed 2025 expiry threshold | Recommendations and expiry state now derive from live inventory records | fixed |
| Patient profile | Fabricated dated communication timeline | Removed; UI explicitly reports that no live communication-history API is available | fixed |
| Telehealth | Local-only “send intake/start room” actions and fixed conversion/follow-up data | Removed; scheduling remains functional and provider-dependent actions are disclosed as unavailable | fixed |
| Integration tests | Permission denial was described as an unimplemented backend | Corrected to a role-permission explanation | fixed |
| CRM future analytics | Production tabs exposed missing source/lost/ROI/task contracts | Removed unsupported tabs and unused throwing service methods; live pipeline, segments, communications, and automation remain | fixed |
| Dashboard action drawer | Assign/snooze/dismiss controls called throwing future contracts | Removed unsupported controls and contracts; real route CTA remains | fixed |
| Opportunity audit | Audit button opened a synthesized lifecycle because no resource audit route exists | Removed the button, drawer, and throwing contract until a real filtered audit feed exists | fixed |
| Opportunity campaign CTAs | Status-only PATCH was labelled as launching patient outreach | Routes to Campaigner to build and approve real consent-checked campaigns | fixed |
| Platform service contracts | Unused duplicate service exported only throwing future methods | Removed; live platform operations remain in `platformAdmin.ts` | fixed |
| Compliance MFA | UI claimed tenant MFA policy was not enforced | Corrected to the implemented TOTP setup/challenge behavior | fixed |

## Automated crawl contract

`tests/e2e/role-route-action-crawl.spec.ts` seeds OWNER, FRONT_DESK, and AUDITOR identities, signs in through the real login endpoint, inventories the rendered role-aware navigation, visits every exposed route, and fails on:

- uncaught page errors;
- backend API responses with status 500 or higher;
- dead `href="#"` anchors;
- nested interactive controls;
- missing role gates for Compliance and Control Plane.

The crawl complements the end-to-end patient/staff golden journey; it does not claim that an unavailable third-party provider is configured.
