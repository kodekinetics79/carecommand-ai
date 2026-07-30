# M06 Patient Master and Identity — Pod Evidence

Date: 2026-07-30  
Embedded consultant: health-information-management/patient-registration review  
Independent consultant: required before COMPLETE

| Feature | Positive journey | Negative / concurrent journey | Closure and evidence | Embedded verdict |
|---|---|---|---|---|
| Patient identity creation | Canonical email persists; lookup works by phone and external reference | Two simultaneous matching registrations yield exactly one patient and one 409 duplicate response | Tenant/identity advisory transaction lock, external-reference and demographic/contact duplicate checks, patient and audit committed atomically; `foundationMasterData.integration.test.ts` | PASS — independent review pending |
| Patient directory truthfulness | Live records drive preferred-channel, consent-rate and risk-follow-up summaries | Empty/partial data no longer presents invented production KPIs | Removed hard-coded WhatsApp adoption, customer-count, outreach-age and consent percentage claims from `src/pages/Patients.tsx`; commit `b2e4068` | PASS — independent review pending |

Focused result: `foundationMasterData.integration.test.ts` PASS, 5/5, including duplicate concurrency, one-row/one-audit assertions and phone/external-reference search. API typecheck and targeted lint PASS.

Important boundary: the duplicate rule is a conservative operational guard, not an enterprise master-patient-index merge engine. Human review/merge, legal-name variants, normalized international phone handling, documented identifier precedence, consent lifecycle, intake documents/storage/malware scanning, data-subject delivery and browser accessibility remain separate acceptance items. No compliance certification is claimed.

