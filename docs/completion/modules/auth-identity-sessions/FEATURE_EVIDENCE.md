# M02 Authentication, Identity and Sessions — Pod Evidence

Date: 2026-07-30  
Pod: Foundation/Master Data  
Embedded consultant: IAM and session-security review  
Independent consultant: required before any feature status is changed to COMPLETE

## Implemented checkpoints

| Feature | Positive journey | Negative / abuse journey | Control and audit result | Evidence | Embedded verdict |
|---|---|---|---|---|---|
| Staff access-session revocation | Login, authenticated `/me`, revoke, fresh login remains usable | Reuse of the revoked access token returns 401 | Each issued session carries millisecond issuance evidence; user and tenant revocation receipts are enforced at the authentication boundary; refresh material is cleared and the revocation audit is committed atomically | `server/test/authSession.integration.test.ts`; focused and combined integration run passed | PASS — independent review pending |
| Platform operator logout | Two distinct tokens issued at the same frozen instant remain separate; logging out token A leaves token B active | Exact replay of token A returns 401; raw session identifier is absent from the audit ledger | Cryptorandom per-token session ID; full SHA-256 audit receipt; protected platform access fails closed without a session ID | `server/test/platformAuthHardening.integration.test.ts`, commits `6184d51` and remediation `75c22db`; 6/6 focused tests passed | PASS — independent re-review pending |

## Verification

- `npm run api:typecheck` — PASS.
- Targeted ESLint — PASS.
- `npx vitest run server/test/platformAuthHardening.integration.test.ts` — PASS, 6/6.
- `npx vitest run server/test/authSession.integration.test.ts server/test/rbac.permissions.test.ts` — PASS in focused/combined pod runs.

## Open acceptance items

- SSO is not represented as an implemented customer feature in the current repository. Production OIDC/SAML support needs an explicit identity-provider selection, metadata/credentials, account-linking policy, SCIM decision, and browser acceptance plan; it must not be marketed as available before those external and product decisions are completed.
- Live cross-site cookie behavior, production Redis fail-closed behavior, MFA recovery, and full browser enrollment/logout/session-administration journeys remain release evidence, not implied by these API tests.
- No compliance certification is asserted. These controls support HIPAA/SOC 2/GDPR readiness and still require policy, deployment, vendor, and independent assessment evidence.
