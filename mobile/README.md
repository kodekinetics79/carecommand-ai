# CareCommand Mobile

Native mobile client for CareCommand patients/users, clinic staff, clinicians, managers and owners.

This is intentionally **not a WebView wrapper**. It calls the same CareCommand backend and preserves the existing identity boundaries:

- Patients use the isolated `/v1/portal/*` identity and patient-safe APIs.
- Staff/clinicians/managers/owners use `/v1/auth/*` plus the existing tenant RBAC and clinic-scope rules.
- Session material is stored with `expo-secure-store`, not AsyncStorage.
- Mobile never accepts a patient/tenant/branch identity from a screen when the backend already owns that scope.

## Current vertical slice

### Patient / user

- Clinic-scoped magic-link request and self-signup request.
- Deep-link token detection plus manual token verification fallback.
- Patient dashboard with next visit, intake, insurance, payments and estimate status.
- Upcoming appointments.
- Real appointment-request submission to the clinic (idempotency remains backend-owned).
- Encrypted local session persistence and server-side logout.

### Staff / clinician

- Tenant login using the existing staff authentication endpoint.
- Existing MFA challenge and required-MFA setup flow.
- Role and branch scope retained from the server session.
- Live clinic dashboard metrics.
- Today's appointment schedule in the authenticated clinic scope.

### Owner / admin

- Same hardened staff identity with owner/admin role detection.
- Network command-center view.
- Revenue, opportunity, operational-risk and approval metrics from the existing dashboard API.
- Tenant-wide schedule behavior when the server session is tenant-wide.

## Run locally

Requirements: Node.js 22.13+ and native iOS/Android tooling supported by Expo SDK 57.

```bash
cd mobile
cp .env.example .env
npm install
npm run typecheck
npm run ios
# or
npm run android
```

The default API URL is `https://carecommand.kodekinetics.com`. Override it only through `EXPO_PUBLIC_API_URL` for a controlled local/staging environment.

## Security posture

The mobile client does not downgrade CareCommand's server-side controls. Staff API calls carry the existing bearer access token and clinic-scope header. Patient calls carry only the isolated portal token. Sensitive session values are stored in the platform Keychain/Keystore through Expo SecureStore.

Do not put PHI in push-notification payloads, analytics events, crash breadcrumbs, device logs or deep-link query parameters. Notification work must use opaque event identifiers and fetch authorized detail after the app opens.

## Acceptance gates before pilot distribution

1. Build and typecheck cleanly from a fresh checkout.
2. Real-device iOS and Android sign-in, lock/restart, expiry, logout and MFA testing.
3. Prove refresh-cookie persistence across native app restart. If native cookie behavior is not reliable enough, add a dedicated mobile refresh-token rotation contract; do not silently extend access-token lifetime.
4. Configure production universal/app links so portal magic links open the app without exposing PHI.
5. Add push registration with PHI-safe notification payloads and server-side device revocation.
6. Exercise patient A/patient B, branch A/branch B and owner/staff cross-scope negative tests against production-shaped data.
7. Add patient self-booking/slots, intake, insurance, payments, telehealth and connected-care screens only against their existing real APIs; no mocked success states.

## Next product slice

The next slice should surface the backend capabilities that already exist: direct self-booking from real provider availability, digital intake, insurance card/status, estimates/payments, telehealth entry, secure patient preferences, RPM/connected-care alerts, staff inbox/work queue, and owner multi-clinic switching. Push notifications and biometric re-entry should be added after the native session contract passes the real-device gate above.
