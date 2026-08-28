# PHI Data Flow Register

This register maps application-owned PHI flows. It is a technical control
record, not a legal data inventory or HIPAA/GDPR certification.

| Flow | Entry points | Persisted records | Authorized consumers | Egress/integration | Primary controls |
|---|---|---|---|---|---|
| Patient identity | Staff patient APIs, intake, portal signup, receptionist identity | Patient and identity/contact records | Tenant-scoped staff, authenticated patient/proxy | Approved communications and eligibility | Backend RBAC, forced RLS, canonical matching, audit, bounded errors |
| Consent/guardian/proxy | Intake, receptionist tools, portal acknowledgements | Consent, guardian/proxy, disclosure and audit records | Authorized clinical/front-desk roles and subject | Recording and document workflows | Fail-closed guardian rules, versioned disclosure hash, durable audit |
| Scheduling | Staff, portal, receptionist booking/cancel/reschedule | Appointment, availability and request records | Authorized staff and authenticated patient | Notification and payment workflows | Transactional conflict prevention, server confirmation, RLS, idempotency |
| Clinical/RPM | Clinical workspace, device webhooks, monitoring review | Encounter, clinical facts, readings, alerts, evidence snapshots | Authorized clinical roles | Device vendors and billing-readiness export | Signed ingress, immutable evidence, UTC period binding, RLS, audit |
| Receptionist calls | Signed telephony webhooks and staff review | Call logs, summaries, consent, requests and review state | Authorized receptionist/clinical staff | Retell/Twilio and approved communications | Signature/rate checks, destination routing, disclosure, DNC, manual review |
| Portal | Magic-link/session routes and patient self-service | Portal session, access request, acknowledgement and message records | Authenticated patient/proxy | Approved email delivery | HMAC/JTI session, memory-only bearer, revocation, tenant/patient binding |
| Insurance/revenue | Staff insurance, eligibility, claims-readiness and billing APIs | Policies, eligibility, revenue signals and audit | Authorized billing/clinical staff | Stedi/payers where configured | Provider-mode gates, RLS, RBAC, truthful unavailable state, audit |
| Payments | Staff payment request and signed provider webhook | Payment request, transaction, reconciliation and audit | Authorized billing staff and tokenized public payer | Stripe where configured | Signed webhook, advisory locks, terminal guards, tokenized checkout |
| Documents/AI | Intake/document APIs and approved AI gateway | Document metadata/content and derived results | Authorized staff and patient where exposed | Approved AI/translation provider | AI PHI disabled by default, approval gates, no body logging, RLS |
| Audit/DSR | Privileged/PHI actions and data-export request | Append-oriented audit evidence and export result | Auditors/admins and authorized subject | Approved secure export channel | Separate permissions, tenant scoping, minimized metadata, durable transaction |

## Prohibited telemetry content

Request bodies, authorization/cookie values, webhook signatures, raw call audio,
patient contact values, payment secrets, document text, and portal magic tokens
must not appear in logs, metrics labels, trace URLs, analytics, or exception
metadata. Existing logging and span-redaction tests enforce the repository-owned
portion; deployed vendor configuration requires separate validation.

## Retention and deletion

Repository workflows expose lifecycle and DSR controls, but final retention
periods, legal holds, deletion approvals, recording retention, backup expiry,
and processor-side deletion require the external policy decisions recorded in
the activation packet.
