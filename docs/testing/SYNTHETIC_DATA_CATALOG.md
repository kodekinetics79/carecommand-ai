# Synthetic Data Catalog

Generated from `prisma/synthetic/profileManifest.ts` and `scenarioCatalog.ts`. Data is fictional, uses example-domain identities and must only be loaded into an explicitly confirmed disposable test database.

| Profile | Tenants | Clinics | Users | Portal accounts | Patients | Appointments | Calls | Payments | Documents | Notifications | Audit events |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| FUNCTIONAL | 2 | 3 | 12 | 2 | 24 | 48 | 16 | 12 | 12 | 24 | 48 |
| PILOT | 4 | 8 | 40 | 4 | 2000 | 4000 | 1000 | 500 | 1000 | 2000 | 5000 |
| EDGE | 5 | 6 | 20 | 5 | 40 | 60 | 40 | 24 | 24 | 40 | 80 |

- Fixed seed: 20260730
- Controlled clock: 2026-07-15T14:00:00.000Z
- Reset strategy: drop the disposable database; never cascade-delete append-only audit evidence.
- Test credential, when seeded: `synthetic.user.N@example.test` / `SyntheticOnly!2026`. The seeder refuses non-test or unconfirmed targets.
- Machine-readable catalog: `docs/testing/synthetic-scenarios.json`.
