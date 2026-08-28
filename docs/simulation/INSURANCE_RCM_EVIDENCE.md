# Insurance and Revenue-Cycle Evidence

Official sandbox/mock modes only; no real eligibility transaction or claim was submitted.

The focused finance/RCM run covered payments, money integrity/hardening, insurance policy integrity, revenue authorization, provider gating, and portal insurance: 7 files / 45 tests passed before remediation. Control-plane capability claims were corrected so only implemented Stedi eligibility is configurable, sandbox/live mode reflects `STEDI_TEST_MODE`, and prior authorization is described as manual tracking rather than payer-connected automation.

Release-blocking integrity gap: both eligibility POST workflows call the payer and then persist verification, patient/policy, derived estimate/benefit, integration log, and audit in separate commits without a tenant-scoped idempotency claim. A mid-chain failure can produce partial durable state and a duplicate payer call on retry. The required correction is a durable pending/result request identity, atomic canonical/derived/audit persistence, and manual reconciliation for ambiguous provider outcomes.

Claims submission/adjudication and payer prior-authorization submission are not implemented and are not represented as working. Their status is truthful product scope, not a passing workflow result.
