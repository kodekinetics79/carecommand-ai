# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type-aware lint rules:

```js
export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...

      // Remove tseslint.configs.recommended and replace with this
      tseslint.configs.recommendedTypeChecked,
      // Alternatively, use this for stricter rules
      tseslint.configs.strictTypeChecked,
      // Optionally, add this for stylistic rules
      tseslint.configs.stylisticTypeChecked,

      // Other configs...
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```

You can also install [eslint-plugin-react-x](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-x) and [eslint-plugin-react-dom](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-dom) for React-specific lint rules:

```js
// eslint.config.js
import reactX from 'eslint-plugin-react-x'
import reactDom from 'eslint-plugin-react-dom'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...
      // Enable lint rules for React
      reactX.configs['recommended-typescript'],
      // Enable lint rules for React DOM
      reactDom.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```

## Product positioning

CareCommand AI — Business Growth & Operations OS for Private Clinics.

- Purpose: a business/management platform for private clinics that helps owners and managers manage branches, improve front-desk efficiency, recover missed calls, convert leads into appointments, reactivate inactive customers, reduce no-shows, fill empty appointment slots, run intelligent marketing campaigns, track revenue leakage, improve reviews and referrals, monitor staff productivity and provider utilization, manage supplies, and control communication permissions and privacy settings.
- Guardrail: This platform is NOT an EHR, EMR, diagnostic system, treatment recommendation tool, prescription platform, lab interpretation service, or replacement for clinical judgment. It focuses on operational workflows and customer engagement only.

See the application UI for module names such as `Command Center`, `ClinicRadar AI`, `CareFlow Autopilot`, `GrowthPulse CRM`, `AI Front Desk`, `Smart Scheduling`, `Customer360`, `Campaigner`, `RevenuePulse`, `Opportunity Center`, `Provider Productivity`, `Staff Workflow`, `Reviews & Referrals`, `Inventory Intelligence`, `Documents & Partner Reports`, `Virtual Visit Booking`, `Privacy & Communication Controls`, `Integrations Hub`, and `Settings`. `ClinicRadar AI` now surfaces Competitor Radar live data, `Reviews & Referrals` now includes Reputation Defense workflows, `Provider Productivity` is now backed by live provider profiles in PostgreSQL, and `Staff Workflow` now uses live staff profiles plus task completion mutations.

## Competitive product review

The expected clinic-management capabilities are covered: scheduling, CRM, communications, campaigns, revenue, staff, provider utilisation, inventory, reviews, telehealth, privacy controls, and integrations.

The main differentiator is `CareFlow Autopilot`: a closed-loop operating layer that moves beyond passive dashboards by detecting revenue leakage, verifying consent and operational guardrails, selecting the next-best action, executing safe workflows, escalating higher-impact decisions for approval, and preserving an explainable audit trail.

This creates a stronger product story than a collection of disconnected modules:

- `Outcome-driven`: recovered revenue and staff time saved are visible per playbook.
- `Human-governed`: higher-impact actions are routed to an approval inbox.
- `Consent-safe`: communication suppression and non-clinical boundaries are explicit.
- `Explainable`: each agent exposes its detect, verify, decide, and act trace.
- `Cross-module`: slot-fill, missed-call recovery, winback, and reputation workflows connect the full operating system.

## Backend quickstart

The production-oriented backend foundation lives in `server/`, with the PostgreSQL schema and migrations in `prisma/`.

```bash
cp .env.example .env
docker compose up -d postgres redis
npm run db:generate
npm run db:deploy
npm run db:seed
npm run dev:all
```

- Frontend: `http://localhost:12000`
- API: `http://localhost:3001`
- API docs: `http://localhost:3001/docs`
- Readiness probe: `http://localhost:3001/health/ready`
- Local development token: `POST http://localhost:3001/v1/auth/dev-token`

Before using real customer data, configure a managed PostgreSQL service, managed Redis, a production identity provider, secret management, monitoring, encrypted backups, restore drills, and API integration tests. See `docs/backend-architecture.md`.
The production baseline now includes live PostgreSQL-backed modules for dashboard summaries, scheduling, CRM, revenue intelligence, competitor radar, reputation defense, provider productivity, staff workflow, integrations, staff tasks, partner report review mutations, conversations, AI front-desk reply mutations, and governed Autopilot actions.

## Frontend API bridge

The UI now authenticates against the local API and hydrates operational records from PostgreSQL for the executive dashboard, Customer360, customer profiles, scheduling, CRM leads, campaigns, reviews, competitor radar, reputation defense, provider productivity, staff workflow, inventory, partner reports and review actions, integrations, staff tasks, revenue snapshots, AI front-desk conversations and replies, and Autopilot approvals.

- Development blends live records with demo rows so product walkthroughs remain visually rich.
- Production disables demo fallback unless `VITE_DEMO_FALLBACK=true` is explicitly configured.
- The topbar reports `API Live` when the readiness endpoint responds successfully.
