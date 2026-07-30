# M04 Tenant, Clinic and Location — Pod Evidence

Date: 2026-07-30  
Embedded consultant: multi-location medical-practice operations review  
Independent consultant: required before COMPLETE

| Feature | Journeys exercised | Closure | Evidence | Embedded verdict |
|---|---|---|---|---|
| Clinic timezone integrity | Valid `America/Los_Angeles` creation succeeds; invalid `Mars/Olympus` is rejected | IANA timezone validation now applies across tenant/platform/onboarding/branch ingress; platform setup UIs submit an explicit browser timezone | `server/test/foundationMasterData.integration.test.ts`; commit `b2e4068` | PASS — independent review pending |
| Clinic access assignment | Active tenant clinic selection succeeds; foreign, inactive, and primary-not-selected inputs fail | Replacement is strict and atomic; invalid input cannot silently drop access or damage prior access; primary clinic is deterministic | `server/test/foundationMasterData.integration.test.ts`; control-plane and settings routes | PASS — independent review pending |
| Clinic deactivation safety | Clinic with active assigned users returns 409 | Operators must reassign or deactivate active users before clinic deactivation; authenticated sessions also fail closed if their primary clinic is inactive | `server/test/foundationMasterData.integration.test.ts`; auth boundary coverage in `server/plugins/auth.ts` | PASS — independent review pending |

Focused result: `foundationMasterData.integration.test.ts` PASS, 5/5. API typecheck and targeted lint PASS.

Residual release evidence: daylight-saving browser scheduling scenarios, location entitlement limits, service-catalog lifecycle, and full clinic CRUD/browser journeys remain separately owned acceptance work. No regulatory certification is claimed.

