# Tenant password recovery

## Customer journey

1. Open the tenant sign-in page and choose **Forgot password?**
2. Enter the account email. Add the clinic workspace identifier when the same email is used in more than one tenant.
3. The page always shows the same neutral confirmation. It does not reveal whether the account, workspace, or email exists.
4. Open the emailed single-use link. The browser reads the reset credential from the URL fragment, immediately removes it from the address bar, and keeps it only in memory.
5. Enter and confirm a new password. A successful reset signs out every existing session, clears lockout state, and preserves MFA enrollment.

## Required production configuration

| Setting | Required value |
|---|---|
| `PUBLIC_APP_URL` | Exact public HTTPS tenant-app origin, for example `https://carecommand.kodekinetics.com` |
| `PASSWORD_RESET_TTL_MINUTES` | 30 recommended; pilot and enterprise reject values above 60 |
| `EMAIL_HTTP_PROVIDER` | `sendgrid` for SendGrid v3 Mail Send, otherwise `generic` |
| `EMAIL_HTTP_API_URL` | Provider HTTPS send endpoint |
| `EMAIL_HTTP_API_KEY` | Provider API credential; keep only in Render or the encrypted provider vault |
| `EMAIL_FROM_ADDRESS` | Verified sender address |

The generic adapter sends `{ to, from, subject, text }` and treats a 2xx JSON response containing `id` or `messageId` as accepted. The SendGrid adapter sends the documented v3 request body and accepts only HTTP 202. Both receive an `Idempotency-Key` header.

Check the protected `GET /health/integrations` response before testing. `tenantPasswordRecovery` must be `configured`. This is configuration evidence, not delivery proof.

## Pilot verification

- Use a synthetic tenant account and a controlled test inbox.
- Confirm known, unknown, inactive, suspended, ambiguous-workspace, and invalid-workspace requests return the same status, body, and cache policy.
- Confirm the link is absent from the DOM, browser storage, server access logs, referrer traffic, and later requests.
- Confirm invalid, expired, reused, and tampered links fail identically.
- Confirm the old password, access token, refresh cookie, and any outstanding reset links stop working after success.
- Confirm MFA is still required and its secret is unchanged.
- Confirm provider rejection/timeout leaves a previously delivered link usable and does not activate the failed replacement.

Until a controlled inbox receives and completes a link from the deployed environment, record production delivery as `EXTERNAL_BLOCKED`, not passed.
