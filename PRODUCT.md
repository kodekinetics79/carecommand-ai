# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The primary user is a practice manager or front-desk operator running a busy multi-clinic private healthcare organization. They need to understand what requires attention now, coordinate staff and providers, protect the schedule, handle patient communications, and move work safely between locations without navigating a collection of disconnected modules.

Clinic owners and administrators need consolidated operational, financial, security, and implementation visibility across locations. Providers need a focused view of their day and the handoffs that require clinical or operational attention. Prospective buyers need a PHI-safe, evidence-based view of product readiness, outcomes, controls, and integration status.

## Product Purpose

CareCommand AI is a business growth and operations platform for private clinics. It helps clinics coordinate front-desk work, scheduling, patient intake and engagement, staff workflows, revenue protection, reputation, connected-care operations, and governed automation across multiple locations.

Success means a clinic team can see what needs attention, act from one coherent workspace, understand who owns each item and its status, and prove operational outcomes without compromising patient privacy or clinical boundaries.

## Positioning

CareCommand connects signals from clinic operations to human-governed actions and an explainable audit trail. Its intended differentiator is not the number of modules; it is a closed-loop operating layer that detects operational or revenue risk, verifies consent and policy guardrails, recommends or executes an allowed next action, escalates higher-impact decisions, and records what happened.

## Operating Context

The product is used during live clinic operations: morning readiness, front-desk shifts, inbound and outbound calls, appointment booking and changes, patient intake review, provider schedule coordination, multi-location handoffs, communication follow-up, revenue and insurance workflows, management review, and implementation or buyer demonstrations.

Operational context includes shared staff and providers, clinic-specific hours and services, location and network reporting, timezone-aware work, queues, service-level expectations, patient communication consent, integration health, audit evidence, and desktop and mobile web use.

## Capabilities and Constraints

- CareCommand is a multi-tenant, multi-clinic operational platform with role- and entitlement-gated web routes and tenant-scoped backend data.
- Implemented areas include command-center reporting, patients, scheduling, intake, front desk and AI receptionist workflows, staff tasks, CRM and campaigns, reviews, revenue protection, insurance workflows, provider performance, connected-care workflows, compliance, control-plane administration, subscriptions, and settings.
- The product must expose truthful live, sandbox, mock, unavailable, stale, and not-configured states. It must not imply that an integration, automation, outcome, or metric is live when supporting evidence is absent.
- PHI must not be used in public buyer-facing proof. Synthetic data must be labelled wherever it could be mistaken for a real customer result.
- CareCommand is not an EHR or EMR and does not diagnose, recommend treatment, prescribe, interpret labs, or replace clinical judgment.
- RBAC, tenant boundaries, row-level security, auditability, consent controls, and platform-versus-tenant administration boundaries must remain enforced.
- The customer-facing information architecture will be consolidated around: Today, Patients, Schedule, Work Queue, Communications, Revenue Operations, Connected Care, Insights, and Administration. Existing capabilities may remain reachable while migration is staged.
- The daily clinic workspace and the buyer/demo experience are connected surfaces, not separate product stories.

## Brand Commitments

- Product name: CareCommand AI.
- Preserve the calm, credible clinical character and recognizable navy/indigo identity while substantially modernizing hierarchy, typography, spacing, interaction, responsiveness, and evidence presentation.
- The voice is concise, operational, trustworthy, and explicit about uncertainty, setup requirements, blocked states, and human responsibility.
- Avoid hype, decorative complexity, fabricated proof, gamification of healthcare work, or visual treatment that makes critical states harder to scan.

## Evidence on Hand

- Product positioning and capability boundaries: `README.md`.
- Current route and navigation inventory: `src/app/App.tsx` and `src/components/layout/Sidebar.tsx`.
- Tenant, clinic, role, schedule, patient, consent, and synthetic demonstration models: `prisma/` and `server/`.
- Connected-care readiness and tested operational behaviors: `docs/connected-care/PILOT-READINESS-LEDGER.md`.
- Live pilot-hardening findings and build evidence are maintained outside the repository in `CARECOMMAND_PILOT_CERTIFICATION_2026-08-29.md`.
- No verified public customer testimonials, production outcome benchmarks, or buyer-safe case studies are confirmed. Future surfaces must not fabricate them.

## Product Principles

1. Organize around the clinic's day and accountable work, not the internal module map.
2. Show scope, owner, urgency, freshness, provenance, and next action wherever a decision is expected.
3. Connect operations end to end while preserving human approval, consent, security, and clinical boundaries.
4. Demonstrate value with truthful evidence and recoverable workflows, never unsupported claims.
5. Make multi-clinic complexity understandable without hiding local differences or tenant boundaries.

## Accessibility & Inclusion

Core workflows must support keyboard operation, visible focus, semantic controls, readable contrast, responsive desktop and mobile layouts, accessible dialogs, non-color-only status communication, and error recovery that does not discard user work. Language and patient-facing communication must remain clear, respectful, and suitable for varied levels of health and digital literacy.
