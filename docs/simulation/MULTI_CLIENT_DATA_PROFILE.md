# Multi-Client Tier 1 Data Profile

Generated with fixed seed `20260730` and controlled clock `2026-07-15T14:00:00.000Z` through the repository seed path after applying all 86 migrations to a disposable local PostgreSQL database.

| Domain | Count |
|---|---:|
| Tenants | 4 |
| Clinics | 8 |
| Tenant users | 40 |
| Platform users | 2 |
| Portal accounts | 4 |
| Patients | 1,000 |
| Appointments | 1,600 |
| Calls | 400 |
| Payment requests | 250 |
| Documents | 500 |
| Notifications | 1,000 |
| Audit events | 2,000 |

The last tenant is suspended to exercise entitlement/tenant-state boundaries. The profile represents supported schema relationships; it does not claim every requested archetype or domain is implemented. Provider profiles were not generated, which Chrome exposed as a truthful setup-required state after the unsafe scheduling fallback was removed. Claims, payer prior-auth submission, guardians/proxies, and production object/email artifacts are not claimed by this profile.

The seed database was dropped after verification. A separate disposable database with the same profile supported the Chrome walk-through and was also force-dropped.
