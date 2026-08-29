# CTO decision memo — AI Receptionist pilot program (Phase 1 → Phase 2)

Date 2026-08-29. Author: CTO/CIO/Sales Director seat (acting). Inputs: phase1-ledger.md (71 merged backlog items), A6 re-audit pending.

## Verdict accepted
NOT READY for a customer-independent pilot. The governance core is ahead of market; the receptionist itself cannot yet replace a human front desk. We build, feature by feature, in the mandated cycle (design → build → CTO review → SDET verify → approve).

## Decisions on the owner questions (acting decisions; the owner can reverse any of them)
1. **Deployment ownership → CareCommand owns it.** Build "Deploy to Retell" (M04) with prompt-hash attestation; keep BYO link as fallback. Ship M02 + M32 immediately as the interim. Rationale: "customer-independent pilot" is impossible if an operator hand-builds 13 tools in a vendor console.
2. **Inbound topology → dedicated inbound line per clinic/location (Retell DID forwarded from the public number).** Add `inboundDestinationNumber` distinct from the public phone; implement `call_inbound` (M38). Public number stays what the agent speaks.
3. **Artifact policy → metadata-only by default; tenant setting `storeTranscriptsAfterConsent` (default off).** Consent ladder split (M10): AI acknowledgment required, recording optional; refusal never ends service. Transcript ingestion (M60) only when the tenant setting is on and consent is GRANTED.
4. **Locale → locale packs, en-GB and en-US first-class from day one.** `clinic.country` drives the emergency number (999/911/112/000), phone normalisation, Intl formatting. Activation blocked without an approved pack for the agent's language.
5. **Fate of /ai-receptionist → becomes the Front Desk (live board) for staff; Studio stays configuration.** Fed from ReceptionistCallLog + StaffTask + AppointmentRequest, not `Conversation`. Sidebar: "Front Desk" and "Receptionist Studio". All "missed calls" links point at Front Desk.
6. **Insurance → list-membership answers allowed** ("that plan is on our accepted list"); no eligibility/benefits/coverage claims. Knowledge model carries `acceptedPayers` with provenance.
7. **Inbound modelling → do the split now** (`campaign.mode = INBOUND_RECEPTION | OUTBOUND_OFFER`, M06). One inbound profile per clinic line; offer fields optional for inbound.
8. **Process → A6 re-run in flight; A8 verdict recovered from the journal.**

## Non-negotiables for every cycle
- No hardcoded tenant-facing values: catalogs come from the server, locale packs from data, limits from config.
- Every failure has a spoken message for the caller and a visible, actionable error for staff.
- Every new route/tool ships with integration tests; every new panel ships with a jsdom test; seeds cover it; runbook names it.
- Prompt/tool changes are snapshot-tested; deploy attestation includes the prompt hash.
- Commit per cycle on `feat/receptionist-pilot-program-20260829`; never push main.

## Phase 2 cycles (dependency order)
- **C0 Decompose for parallel work** — split `ReceptionistStudio.tsx` into `src/components/receptionist/*` per tab, split `routes.ts` into `server/modules/receptionist/{clinics,agents,campaigns,intake,activity,webhooks}.ts` with unchanged behaviour (331 tests green as the proof). Enables file-ownership partitioning.
- **C1 Truth & catalogs** — M20 error surfacing, M27 server catalog, M52 option catalogs, M48 outbound builder fix, M02 webhook URL, M30/M31/M32 status+export, M44/M45 review & front-desk page fixes, M65 identity, M71.
- **C2 Clinic knowledge, hours, locale** — M01 (hours engine + knowledge + prompt facts + after-hours), M24 per-day hours + closures, M22/M23 tz derivation, M21 transfer readiness, M29 locale packs + country, M53/M54 guards.
- **C3 Inbound reception** — M06 mode split, M07 multi-provider, M08 location_id, M09 service enum, M10 consent ladder, M11 graceful fail-closed, M12 DOB/second factor, M33 tool guards, M34 availability windows, M35 configurable limits, M36/M37, M38 inbound line + call_inbound, M58, M59 caller-facing messages.
- **C4 Front desk loop** — M13/M14/M15/M16/M19 queue truth + notifications, M17 requests re-point, M18 Front Desk board, M39 callback window, M40 task FKs, M41 appointment notes tool + PATCH, M42 call queue filters, M43 KPIs, M49 FRONT_DESK access, M61/M62/M63/M64/M68.
- **C5 Deployment & activation** — M03 re-verify worker, M04 Deploy to Retell, M05 mock provider, M46 readiness + Activate/Pause/Archive, M50, M56, M66.
- **C6 Outbound** — A6 findings + M69 scheduler (reminders/recall/reactivation), M47 transfer directory, M57 waitlist.
- **C7 Harness & pilot pack** — M25 seeds/demo, M51 UI/integration/e2e, M67 a11y pass, M70 docs/runbook/limitations, pilot readiness scorecard.
