# External Activation Packet

All repository-actionable work must be complete before these items are used to
activate a PHI environment or unattended automation.

## Credentials and vendor configuration

- Restricted tenant, platform, and migration database principals
- Managed Redis and always-on worker service
- Retell/Twilio numbers, signing secrets, callback allowlists, and delivery logs
- Stripe restricted/test or live keys, webhook endpoint, refunds and disputes
- Stedi/payer sandbox or production credentials and trading-partner approval
- Approved email/SMS provider credentials, suppression and delivery callbacks
- Device-vendor credentials and webhook signing material
- Approved AI provider endpoint, data-retention setting, and organization key
- Metrics, trace, error-reporting, paging, and external uptime destinations
- Encrypted backup store, retention policy, and restore environment

## Contracts and legal determinations

- BAAs and data-processing agreements for every PHI processor
- Jurisdiction-specific AI, call-recording, and outbound-contact approval
- HIPAA security risk analysis, policies, training, breach, and retention program
- GDPR controller/processor roles, legal bases, DPIA where required, and DSAR
  ownership
- Payment, payer, telecom, messaging, and device-vendor contractual approval

## Named approvals and evidence

- Product/release owner
- Security and privacy officer
- Clinical safety owner
- Operations/on-call and incident commander
- Customer implementation owner
- Legal/compliance approver
- Backup/restore and disaster-recovery drill evidence
- Penetration test and vulnerability-remediation evidence
- Synthetic staging acceptance and explicit PHI activation decision
- Separate unattended AI Receptionist activation decision

No credential, contract, legal decision, certification, or organizational
approval is fabricated or treated as complete by repository code.
