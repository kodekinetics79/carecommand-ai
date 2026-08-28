# Tenant Context Entry Points

This map records where tenant authority originates, what is verified before the tenant is selected, and how PostgreSQL context is applied. Tenant identifiers supplied by a URL, body, query string, webhook, AI tool, or queue payload are selectors only; they are not authority.

## Context lifecycle

1. Fastify creates an empty request-local `AsyncLocalStorage` scope in `onRequest`.
2. An authenticated or public bootstrap path verifies its credential and resolves a minimal tenant/resource mapping.
3. `enterTenantContext` records tenant, actor, role, source, and request/correlation metadata in that request scope.
4. The Prisma runtime proxy opens a short transaction for each protected operation and writes transaction-local `app.current_*` settings on the pinned connection.
5. `app_rls_tenant_allowed` validates the context, actor/source requirements, support authorization, and active tenant state.
6. PostgreSQL clears transaction-local settings on commit or rollback. Pool-reuse tests prove the settings do not leak.

## Entry-point map

| Entry path | Untrusted selector | Authority verified before mapping | Resolver / validation | Context source and actor | Status / evidence |
|---|---|---|---|---|---|
| Staff access JWT | JWT tenant/user/role claims | JWT signature, token type, UUID shape | `app_resolve_access_session(user, tenant)` verifies active user, role, branch, tenant and revocation state | `request`; verified user UUID and stored role | Implemented in `server/plugins/auth.ts`; auth/RBAC and context tests |
| Staff email/password login | Email and optional tenant slug | Password is checked against a bounded credential-bootstrap result | `app_auth_login_candidates`; inactive tenants fail closed | `request`; resolved user UUID/role | Implemented; normal login/refresh/logout and multi-workspace tests pass |
| Refresh/logout cookie | Opaque cookie | CSRF validation, then HMAC/hash of cookie | `app_resolve_ingress_tenant('refresh_token_hash', hash)` | `request`; resolved user/resource | Implemented for active tenants; inactive-token revocation needs a narrow privileged resolver/revoker |
| Password reset confirmation | Opaque reset token | Token is hashed before lookup | `password_reset_hash`, then scoped expiry/unused checks | `request`; reset-token resource | Implemented; password change and token consumption use one short transaction |
| Authenticated patient portal | Portal JWT tenant/account/patient claims | JWT signature and `type=portal` | Scoped account/patient/tenant match and active status | `portal`; portal-account UUID | Implemented in `server/lib/portalAuth.ts` |
| Portal signup/request-link | Clinic slug and contact | Rate limiting; slug is a selector only | `tenant_slug` returns an active tenant; contact matching occurs after context | `portal`; bounded public portal actor | Implemented; anti-enumeration and magic-token tests pass |
| Portal magic-link verification | Raw magic token | HMAC/hash before lookup | `portal_token_hash`, then scoped expiry/type/single-use compare-and-set | `portal`; account UUID after token row validation | Implemented; concurrent single-use proof passes |
| Public intake packet | Raw intake token | HMAC/hash before lookup | `intake_token_hash`, then scoped expiry/status checks | `portal`; packet resource UUID | Implemented; all reads/writes remain packet and tenant scoped |
| Public payment checkout | Opaque UUID token | Exact opaque-token match | `payment_public_token` | `portal`; payment-request UUID | Implemented; returns patient-safe summary only |
| Public pilot status share | Raw share token | HMAC/hash before lookup | `pilot_share_hash`, then scoped expiry check | `portal`; share UUID | Implemented; checklist reads run under tenant scope |
| Stripe webhook | Provider event body identifiers | Stripe HMAC over exact `request.rawBody`; missing verifier fails closed | Unique `stripe_provider_reference`; ambiguous matches fail closed | `webhook`; payment-request resource | Implemented; idempotency is claimed after tenant mapping |
| CRM delivery webhook | Provider message/event IDs | Provider HMAC over exact `request.rawBody`; missing verifier fails closed | Unique `campaign_provider_message` | `webhook`; campaign-delivery resource | Implemented; idempotency is tenant scoped after mapping |
| Retell event and live-tool webhooks | Query clinic/campaign and call ID | Retell HMAC over exact `request.rawBody`; missing verifier fails closed | Unique stored `retell_call_id`; query selectors are revalidated after context | `webhook`; call-log resource | Existing/outbound calls implemented. First inbound call remains fail-closed pending agent/phone/clinic resolver support |
| Connected-care provider webhook | URL tenant UUID and provider key | Narrow resolver returns only an active provider row and encrypted verifier candidate; exact raw-body HMAC must then pass | `app_resolve_device_webhook_verifier(tenant selector, provider key)`; selector alone grants nothing | `webhook`; verified device-provider resource UUID | Implemented; invalid/missing mappings and signatures fail 401 before tenant context, and focused connected-care/E2E tests pass 11/11 |
| Autopilot job | Signed/validated job data | Queue contract and worker dispatch | Direct `runWithJobTenantContext` | `worker`; worker identity | Implemented in `server/workers/autopilot.worker.ts` |
| Campaign/compliance schedulers | Optional scheduler tick and tenant envelope | Scheduler identity plus signed tenant job envelope | `app_active_tenant_ids()` for minimal active-tenant enumeration; tenant job envelope revalidated | `worker`; queue operation identity | Implemented; tenant jobs are separately enqueued and processed |
| Generic maintenance iteration | Optional tenant selector | Caller must be trusted internal code | `resolveActiveJobTenantIds` / `forEachActiveJobTenant` | `worker`; explicit actor | Implemented; resolver returns UUIDs only |
| Support impersonation | Tenant selection, reason, session | Authenticated support authorization is required | RLS function validates stored support session, tenant, expiry, active/terminated state and reason | `support`; support actor/session UUID | Database contract implemented; every support route still requires focused end-to-end evidence |
| Platform tenant-scoped operation | Platform-selected tenant | Platform authentication/authorization | Explicit trusted platform context; no universal RLS bypass | `platform`; platform actor | Pilot path implemented; broader platform/support entry-point regression remains required |

## Known fail-closed gaps

- First-ever inbound Retell calls cannot be mapped by `retell_call_id`; a signed agent/phone-number mapping is required without trusting `clinicId`.
- Refresh tokens belonging to a tenant suspended after issuance cannot be resolved or revoked by the active-only bootstrap function. Cookies are cleared and access is denied, but a narrow privileged revocation function is still required.
- Complete per-table same/cross-tenant CRUD fixtures are not yet present for 118 of 119 protected tables. The catalog and missing-context guards cover every table, while full CRUD proof currently uses `AiGuardrail` as the representative table.
