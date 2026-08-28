# Payment and Finance Evidence

No real charge, refund, dispute, or payment provider call occurred. Provider behavior was exercised through local test doubles and signed-event integration paths.

Remediation corrected three financial-integrity defects:

- a later legitimate success can recover a previously failed/expired request;
- refund-before-success remains retryable and does not consume its idempotency result;
- cumulative partial refunds apply only the newly observed delta, restore AR by that delta, preserve collected state until fully refunded, and fail closed on over-settlement.

Focused post-fix regression passed 3 files / 42 tests in 70.09 seconds, including payments, money integrity, and money-path hardening. Existing broader finance/RCM evidence passed 7 files / 45 tests.

This is a scoped payment-request/AR integrity result. A complete double-entry accounting ledger, staff dual-control refund approval, claims/remittance posting, and comprehensive dispute accounting are absent and must not be inferred.
