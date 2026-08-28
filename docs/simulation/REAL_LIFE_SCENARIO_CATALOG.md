# Tier 1 Real-Life Scenario Catalog

| Scenario | Role / channel | Expected operational result | Result |
|---|---|---|---|
| SC-AI-01 signed inbound event | Public voice ingress | Authenticate, bind exactly one tenant, reject forgery/replay | PASS (simulated) |
| SC-AI-02 consent and DNC race | Receptionist / patient | Latest valid revocation wins; no provider intent after suppression | PASS (13/13 disposable race suite) |
| SC-AI-03 Redis unavailable | Public voice ingress | Fail closed or hand off; no unsafe continuation | PASS (simulated) |
| SC-AI-04 approved autopilot staff task | Worker | Exactly one domain side effect with durable receipt | PASS (4/4) |
| SC-AI-05 stale dispatch attempt | Worker | No side effect and no false execution | PASS (4/4) |
| SC-FIN-01 success after failed/expired | Payment webhook | Recover legitimate settlement without duplicate financial effect | PASS after remediation |
| SC-FIN-02 refund before settlement | Payment webhook | Retryable, not falsely completed | PASS after remediation |
| SC-FIN-03 cumulative partial refunds | Payment webhook | Apply delta; preserve remaining AR until full refund | PASS after remediation |
| SC-RCM-01 capability inspection | Owner | Only implemented/configured functionality is advertised | PASS after remediation |
| SC-RCM-02 eligibility retry after partial persistence | Billing | No duplicate payer call or partial durable result | REJECTED; P1 open |
| SC-CORE-01 dashboard with unentitled campaign | Owner / Chrome | Other panels render; unavailable module is explicit | PASS after remediation |
| SC-CORE-02 branch-scoped branch list | Owner / Chrome | Return authorized branch without ORM error | PASS after remediation |
| SC-CORE-03 appointment without provider | Front desk / Chrome | Block booking; explain configuration requirement | PASS after remediation |
| SC-CORE-04 mobile scheduling | Owner / Chrome 390x844 | Usable responsive controls and truthful empty state | PASS visually |

Live-call scenarios were not run because the mandatory authorization flag and provider credentials were absent. Object upload and email-delivery scenarios are setup-required because no local emulator/capture service is configured.
