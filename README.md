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

See the application UI for module names such as `Command Center`, `ClinicRadar AI`, `CareFlow Autopilot`, `GrowthPulse CRM`, `AI Front Desk`, `Smart Scheduling`, `Customer360`, `Campaigner`, `RevenuePulse`, `Opportunity Center`, `Provider Productivity`, `Staff Workflow`, `Reviews & Referrals`, `Inventory Intelligence`, `Documents & Partner Reports`, `Virtual Visit Booking`, `Privacy & Communication Controls`, `Integrations Hub`, `Security/Admin`, and `Settings`. `ClinicRadar AI` now surfaces Competitor Radar live data, `Reviews & Referrals` now includes Reputation Defense workflows, `Provider Productivity` is now backed by live provider profiles in PostgreSQL, and `Staff Workflow` now uses live staff profiles plus task completion mutations.

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
- Local development login:
  - Email: `admin@carecommand.ai`
  - Password: `ChangeMe123!`
- Optional local provider test login:
  - Email: `sarah.mitchell@carecommand.local`
  - Password: `Provider123!`
- Local development token: `POST http://localhost:3001/v1/auth/dev-token` when `VITE_AUTH_MODE=dev-token` and `NODE_ENV=development` are both true.

Before using real customer data, configure a managed PostgreSQL service, managed Redis, a production identity provider, secret management, monitoring, encrypted backups, restore drills, and API integration tests. Production login/session wiring now uses short-lived JWT access tokens plus HttpOnly cookie-backed rotating refresh sessions; the seeded admin credential exists only for local development. See `docs/backend-architecture.md`.
The production baseline now includes live PostgreSQL-backed modules for dashboard summaries, scheduling, CRM, revenue intelligence, competitor radar, reputation defense, provider productivity, staff workflow, integrations, admin/security controls, staff tasks, partner report review mutations, conversations, AI front-desk reply mutations, and governed Autopilot actions.

## AI Advisory Room

CareCommand AI now includes a premium advisory layer that turns the product into a built-in operating team for owners.

- Provider strategy: `AI_PROVIDER=mock|ollama|openai|claude`
- Ollama adapter defaults to `OLLAMA_BASE_URL=http://localhost:11434` and `OLLAMA_MODEL=llama3.1`
- OpenAI and Claude adapters are adapter-ready and fall back to the mock provider when not configured
- Default runtime mode is `mock`, so the app works without any local LLM running
- The advisory layer is business-only: revenue, growth, front desk, competition, and operations guidance only
- Clinical diagnosis, treatment, prescriptions, and medical advice remain out of scope
- The room uses live app data and maps recommendations back to real modules and workflows

## Revenue Protection Command Center

CareCommand AI also includes a revenue-protection workflow for insurance readiness, patient responsibility capture, prior authorisation tracking, and payment follow-up.

- Provider strategy: `INSURANCE_PROVIDER=mock|stedi|availity|pverify|optum` and `PAYMENT_PROVIDER=mock|stripe|square|authorize_net|clover|paypal`
- Stedi and Stripe are server-side only; if credentials are missing or invalid, the backend falls back to mock mode instead of crashing the app
- `STEDI_TEST_MODE=true` keeps Stedi in sandbox mode when credentials exist; `STRIPE_SECRET_KEY` controls Stripe test/live behavior
- Refresh/status labels in the UI intentionally show `Mock Mode`, `Sandbox Active`, or `Live Active`
- The Stripe webhook route is currently a placeholder; it records a safe integration log and does not fake completed payments
- No card numbers, CVV, or raw payment payloads are stored; provider references and payment URLs only
- Insurance responses are normalized into internal eligibility and responsibility models before they reach the UI
- If the API becomes cross-site later, add a dedicated CSRF strategy before enabling cookie-authenticated writes across origins

## Enterprise Admin, Security, and Integrations

The platform now exposes working enterprise control surfaces for access control, security posture, audit history, and integration readiness.

- Admin console endpoints: `/v1/admin/users`, `/v1/admin/users/:id/status`, `/v1/admin/users/:id/role`, `/v1/admin/users/:id/branches`, `/v1/admin/roles`, and `/v1/admin/audit-logs`
- Security endpoints: `/v1/security/posture`, `/v1/security/sessions`, `/v1/security/sessions/:userId/revoke`, and `/v1/security/login-history`
- Integration endpoints: `/v1/integrations/status` and `/v1/integrations/:provider/test`
- The admin console lists users, roles, clinic access, active sessions, login history, and audit logs using tenant-scoped PostgreSQL data
- Branch access updates persist per-user clinic access rows and keep primary clinic access visible in the UI
- Security posture reports auth mode, cookie posture, CSRF state, rate limiting, secret configuration, and enterprise warning signals without exposing secret values
- Integration status uses honest labels: `Mock Mode`, `Sandbox Ready`, `Sandbox Active`, `Live Not Configured`, and `Live Active`
- Mock and placeholder providers are safe fallbacks; they do not claim to be connected unless configuration is actually present
- Non-admin users do not see the Security/Admin nav item and the backend returns `403` for protected admin endpoints

### Provider configuration

- Auth: `JWT_SECRET`, `JWT_REFRESH_SECRET`, `VITE_AUTH_MODE=login-required` for production, `VITE_AUTH_MODE=dev-token` only for local development
- AI: `AI_PROVIDER=mock|ollama|openai|claude`, `OLLAMA_BASE_URL`, `OLLAMA_MODEL`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL`, `CLAUDE_API_KEY`, `CLAUDE_BASE_URL`, `CLAUDE_MODEL`
- Insurance: `INSURANCE_PROVIDER=mock|stedi|availity|pverify|optum`, `STEDI_API_KEY`, `STEDI_BASE_URL`, `STEDI_TEST_MODE`
- Payments: `PAYMENT_PROVIDER=mock|stripe|square|authorize_net|clover|paypal`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_SUCCESS_URL`, `STRIPE_CANCEL_URL`, `SQUARE_ACCESS_TOKEN`, `AUTHORIZE_NET_API_LOGIN_ID`, `AUTHORIZE_NET_TRANSACTION_KEY`
- Communications and marketing: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, `WHATSAPP_ACCESS_TOKEN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `META_APP_ID`, `META_APP_SECRET`
- Integration tests are configuration-aware: mock providers stay mock, sandbox providers stay sandbox, and live providers only report live when they are actually configured

## Frontend API bridge

The UI now authenticates against the local API and hydrates operational records from PostgreSQL for the executive dashboard, Customer360, customer profiles, scheduling, CRM leads, campaigns, reviews, competitor radar, reputation defense, provider productivity, staff workflow, inventory, partner reports and review actions, integrations, staff tasks, revenue snapshots, AI front-desk conversations and replies, and Autopilot approvals.

- Development blends live records with demo rows so product walkthroughs remain visually rich.
- Production disables demo fallback unless `VITE_DEMO_FALLBACK=true` is explicitly configured.
- The topbar reports `API Live` when the readiness endpoint responds successfully.
- Required secrets: `JWT_SECRET` and `JWT_REFRESH_SECRET`.
- Refresh cookies are `HttpOnly`, `SameSite=Lax`, scoped to `/v1/auth`, and `Secure` in production; serve the app over HTTPS in production.
- Access tokens stay in memory only; refresh is restored via the cookie on page reload.
- Access tokens expire in 15 minutes; already-issued access tokens remain valid until they naturally expire.
- Auth endpoints are lightly rate-limited and refresh/logout require a matching `X-CSRF-Token` header plus the `cc_csrf` cookie.
- Passwords are stored as salted hashes; never commit plaintext credentials.
- If the API ever moves cross-site, add a CSRF token strategy before exposing cookie-authenticated writes.
- Future work: replace local email/password login with OIDC or SSO for production.

### Auth production checklist

- HTTPS is required in production.
- `JWT_SECRET` and `JWT_REFRESH_SECRET` must be set.
- Refresh cookies are `HttpOnly` and never exposed to JavaScript.
- `VITE_AUTH_MODE=dev-token` must stay disabled in production.
- Refresh and logout require a CSRF header/cookie match.
- OIDC/SSO remains the recommended long-term production identity path.
