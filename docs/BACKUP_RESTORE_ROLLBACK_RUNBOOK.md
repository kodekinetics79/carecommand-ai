# Backup, Restore, And Rollback Runbook

Last updated: 2026-07-20

This is the operational gate for client-run enterprise validation. Do not claim
production recovery readiness until this runbook has been executed against the
actual pilot hosting stack.

## Backup Minimums

- automated encrypted database backups
- documented backup frequency and retention
- restore target isolated from production
- Redis/queue recovery expectations documented
- object storage backup policy if uploads are enabled
- secrets backup and rotation ownership documented outside the repo

## Restore Drill

1. Record source environment, commit SHA, migration version, backup ID, and time.
2. Create an isolated restore environment.
3. Restore the database backup into the isolated database.
4. Apply migrations only if the drill intentionally validates forward recovery.
5. Start API and worker against the restored database and isolated Redis.
6. Run:
   - `npm run db:validate`
   - `npm run api:typecheck`
   - `npm test -- server/test/security.integration.test.ts server/test/worker.integration.test.ts`
   - health checks for `/health/live` and `/health/ready`
7. Verify tenant counts, selected appointment/payment/alert records, and audit
   records against the source snapshot.
8. Confirm no production webhooks, emails, SMS, payment captures, or device
   alerts are sent from the restore environment.
9. Capture evidence in `docs/EVIDENCE_LEDGER.md`.

## Rollback Drill

1. Identify current deployed version and target rollback version.
2. Confirm schema compatibility and whether rollback requires a data migration.
3. Disable scheduled jobs/webhook consumers if duplicate processing is possible.
4. Roll back application version.
5. Keep database rollback separate; only run destructive data rollback after
   explicit executive approval.
6. Re-enable workers after idempotency checks pass.
7. Run smoke checks:
   - login
   - patient list
   - scheduling
   - payment status
   - worker queue drain
   - audit event creation
8. Notify implementation, support, and client stakeholders with impact and next
   actions.

## Failure Criteria

Treat the drill as failed if:

- restore cannot boot without production credentials
- restored environment sends real patient/provider communications
- tenant data is missing or mixed
- migration rollback path is unclear
- worker replay creates duplicate financial or clinical actions
- no named owner can approve rollback decisions
