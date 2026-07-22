# Deploy — All on Vercel (SPA + Fastify Function) + Neon

The whole app runs on **one Vercel project**: the Vite SPA as static files, and the
Fastify backend as a **Serverless Function** (`api/index.ts`). Same origin → **no
CORS**. Database is **Neon** (already migrated + seeded). Redis is optional.

```
Browser ─► Vercel
            ├─ /v1/*, /health/*  ─► api/index.ts (Fastify)  ─► Neon Postgres
            └─ everything else   ─► SPA (dist/)
```

## How routing works (`vercel.json`)
- `/v1/*` and `/health/*` → the Fastify function.
- everything else → the SPA.
- Build runs `prisma generate && npm run build`.
- The frontend defaults to **same-origin** in production (`import.meta.env.PROD`),
  so you do **not** need to set `VITE_API_URL`.

## 1. Set Environment Variables (Vercel → Project → Settings → Environment Variables, **Production**)

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | Neon **pooled** URL (`...-pooler...?sslmode=require`) |
| `DATABASE_MIGRATION_URL` | Neon **direct** URL (no `-pooler`, `?sslmode=require`) |
| `QUEUES_ENABLED` | `false`  *(no Redis → background jobs are skipped; all request routes still work)* |
| `JWT_SECRET` | 32+ random chars |
| `JWT_REFRESH_SECRET` | 32+ random chars (different) |
| `AUTH_ENCRYPTION_KEY` | 32 bytes (`openssl rand -base64 32`) |
| `AI_PROVIDER` | `mock` |
| `VITE_AUTH_MODE` | `login-required` |
| `VITE_DEMO_FALLBACK` | `false` |
| `VITE_DEFAULT_CLINIC_SLUG` | blank, unless the client explicitly wants a prefilled slug |
| `PLATFORM_LEGACY_TOKEN_ENABLED` | `false` |

> Leave provider keys (Stripe/Twilio/Stedi/Retell…) empty — those modules report
> `setup_required`; the Stedi sandbox + connected-care sandbox still work.
> `VITE_*` are build-time, so **redeploy** after changing them. Never put secrets in `VITE_*`.
> Do not use `PLATFORM_API_TOKEN` in production unless an approved break-glass
> procedure explicitly sets `PLATFORM_LEGACY_TOKEN_ENABLED=true`.

### Optional: enable Redis (background jobs)
Add a serverless Redis (Upstash), set `REDIS_URL=...` and `QUEUES_ENABLED=true`.
Even then, queued jobs only *process* if a worker runs — not available on
serverless. Fine to leave `QUEUES_ENABLED=false` for a demo.

## 2. Deploy
Push to the connected branch (Vercel auto-builds) **or** `vercel --prod`.

## 3. Smoke test
```
APP=https://<your-app>.vercel.app
curl -s $APP/health/live                                   # {"status":"ok"}
curl -s -o /dev/null -w '%{http_code}\n' $APP/v1/auth/me   # 401 (route live)
```
Then in the browser: staff login, and the patient portal at `/client/login`
using the client-provisioned clinic slug and approved validation patient email.

## Notes / limits (it's a demo/test env)
- **No background workers** on serverless — autopilot execution + scheduled
  campaigns won't *process*. Everything request-driven (Connected Care, AI,
  eligibility, monitoring, portal) works.
- First request after idle has a **cold start** (the API registers many routes).
- Migrations already applied to Neon; the function does **not** run migrations.
  Re-run them locally if the schema changes: `DATABASE_MIGRATION_URL=<neon direct> npm run db:deploy`.
