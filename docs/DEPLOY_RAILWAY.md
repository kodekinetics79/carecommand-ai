# Deploy — Backend on Railway + Frontend on Vercel

The frontend (Vite SPA) already deploys to Vercel. For a split frontend/backend
pilot, host the backend on Railway, then point Vercel at it with `VITE_API_URL`.
If `VITE_API_URL` is blank in a production build, the SPA uses same-origin API
paths, which only works when the API is served from the same origin.

```
Browser ──► Vercel (static SPA, VITE_API_URL) ──► Railway API ──► Railway Postgres + Redis
```

---

## 1. Railway — backend API + Postgres + Redis

1. **New Project → Deploy from GitHub repo** → `kodekinetics79/carecommand-ai`
   (branch `feat/intelligent-crm` or `main`). Railway reads **`railway.json`** and
   builds **`Dockerfile.api`**; `prisma migrate deploy` runs automatically before
   each deploy (`preDeployCommand`).
2. **+ New → Database → Add PostgreSQL.**
3. **+ New → Database → Add Redis.**
4. On the **API service → Variables**, set:

   | Variable | Value |
   |---|---|
   | `NODE_ENV` | `production` |
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
   | `DATABASE_MIGRATION_URL` | `${{Postgres.DATABASE_URL}}` |
   | `REDIS_URL` | `${{Redis.REDIS_URL}}` |
   | `JWT_SECRET` | _32+ random chars_ (`openssl rand -base64 48`) |
   | `JWT_REFRESH_SECRET` | _32+ random chars_ (different value) |
   | `AUTH_ENCRYPTION_KEY` | _32 bytes_ (`openssl rand -base64 32`) |
   | `CORS_ORIGINS` | `https://<your-app>.vercel.app` (your Vercel domain) |
   | `PUBLIC_API_URL` | `https://<your-api>.up.railway.app` (this service's URL) |
   | `AI_PROVIDER` | `mock` (or `ollama` + `OLLAMA_MODE=cloud` + `OLLAMA_API_KEY`) |
   | `VITE_AUTH_MODE` | `login-required` |
   | `VITE_DEMO_FALLBACK` | `false` |
   | `VITE_DEFAULT_CLINIC_SLUG` | blank, unless the client explicitly wants a prefilled slug |
   | `PLATFORM_LEGACY_TOKEN_ENABLED` | `false` |

   Optional (seed a platform owner): `PLATFORM_OWNER_EMAIL`, `PLATFORM_OWNER_NAME`,
   `PLATFORM_OWNER_PASSWORD`. Do not use `PLATFORM_API_TOKEN` in production
   unless an approved break-glass procedure explicitly sets
   `PLATFORM_LEGACY_TOKEN_ENABLED=true`. Provider keys (Stripe/Twilio/Stedi…)
   stay empty until the client has approved sandbox/live validation; modules
   report `setup_required` until set.

5. **Settings → Networking → Generate Domain** → that's your `PUBLIC_API_URL`.
6. **Seed once** (data + sandbox demo). Railway CLI:
   ```bash
   railway link            # pick the project
   railway run npm run db:seed
   railway run npm run demo:sandbox   # optional: populates connected-care demo
   ```
   (or run them as one-off commands from the service shell).
7. Verify: `https://<your-api>.up.railway.app/health/live` → `{"status":"ok"}`.

> **Workers (optional):** the API enqueues background jobs (autopilot/campaign/
> compliance). To actually *process* them, add a second Railway service from the
> same repo with start command `npm run worker:start` and the same env vars. Not
> needed just to demo the UI/API.

> **RLS note:** for a fast demo the API connects as the Postgres owner, so the
> RLS pilot policies are present but bypassed. For hardened prod, create the
> `app_rls` role (see `prisma/rls/app_rls_setup.sql`) and point `DATABASE_URL`
> at it while keeping `DATABASE_MIGRATION_URL` as the owner.

---

## 2. Vercel — point the frontend at the API

1. **Project → Settings → Environment Variables** → add for **Production** (and
   Preview if you want PR deploys to work):

   | Variable | Value |
   |---|---|
   | `VITE_API_URL` | `https://<your-api>.up.railway.app` |
   | `VITE_AUTH_MODE` | `login-required` |
   | `VITE_DEMO_FALLBACK` | `false` |
   | `VITE_DEFAULT_CLINIC_SLUG` | blank, unless the client explicitly wants a prefilled slug |

   > `VITE_*` vars are **build-time** in Vite — you must **redeploy** after adding
   > them. Vars are inlined into the bundle; never put secrets in `VITE_*`.

2. **Deployments → ⋯ → Redeploy** (or push a commit).
3. Open the Vercel URL → sign in. API calls now hit Railway. ✅

---

## 3. Smoke test the live stack
```bash
API=https://<your-api>.up.railway.app
curl -s $API/health/live                       # {"status":"ok"}
curl -s -o /dev/null -w '%{http_code}\n' $API/v1/auth/me   # 401 (route is live)
```
Then in the browser: staff login, and patient portal at `/client/login` using
the client-provisioned clinic slug and approved validation patient email.

## Common gotchas
- **Still seeing localhost** → `VITE_API_URL` wasn't set, or you didn't redeploy Vercel after setting it.
- **CORS error in console** → set `CORS_ORIGINS` on Railway to the exact Vercel origin (comma-separate multiple).
- **502 / crash on boot** → app must listen on `PORT` (handled in `server/index.ts`); ensure `DATABASE_URL`/`REDIS_URL` reference the Railway plugins.
