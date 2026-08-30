-- Period-keyed usage metering.
--
-- The voice-minute quota was enforced against LIFETIME counters
-- (TenantUsageLimit.used, TenantAiUsage.receptionistMinutes) that nothing ever
-- reset: no period key, no reset job. Both call-admission gates refuse a call
-- once used >= limitValue, so a clinic on 500 included minutes stops answering
-- patient calls permanently, part-way through month two, with a 402.
--
-- UsageEvent is the ledger the gates read instead. Append-only by grant and by
-- trigger: a billing record that can be updated in place is not evidence.

CREATE TABLE "UsageEvent" (
  -- No database default: every other model in this schema declares
  -- `@id @default(uuid())`, which Prisma generates client-side, and
  -- 20260613220605_device_integration_module already dropped exactly this
  -- stray default from thirteen tables. A default here reads as drift.
  "id"              UUID NOT NULL,
  "tenantId"        UUID NOT NULL,
  "metric"          TEXT NOT NULL,
  "quantity"        INTEGER NOT NULL,
  "occurredAt"      TIMESTAMP(3) NOT NULL,
  "periodKey"       TEXT NOT NULL,
  "sourceModule"    TEXT NOT NULL,
  "sourceType"      TEXT NOT NULL,
  "sourceId"        UUID,
  "dedupeKey"       TEXT NOT NULL,
  "providerCostUsd" DECIMAL(12,6),
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UsageEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "UsageEvent_quantity_nonnegative" CHECK ("quantity" >= 0),
  CONSTRAINT "UsageEvent_periodKey_shape" CHECK ("periodKey" ~ '^[0-9]{4}-[0-9]{2}$')
);

ALTER TABLE "UsageEvent"
  ADD CONSTRAINT "UsageEvent_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Redelivered provider webhooks are routine. This index, not application care,
-- is what stops the same minute being billed twice.
CREATE UNIQUE INDEX "UsageEvent_tenantId_dedupeKey_key" ON "UsageEvent"("tenantId", "dedupeKey");
CREATE INDEX "UsageEvent_tenantId_periodKey_metric_idx" ON "UsageEvent"("tenantId", "periodKey", "metric");
CREATE INDEX "UsageEvent_tenantId_metric_occurredAt_idx" ON "UsageEvent"("tenantId", "metric", "occurredAt");

-- ---------------------------------------------------------------------------
-- Row-level security. 20260730120000_complete_rls_isolation applied its policy
-- loop once, at that migration; a table created afterwards inherits nothing and
-- must declare its own or it would be readable across tenants.
--
-- SELECT + INSERT only: this is a billing ledger, so the runtime may add to it
-- and read it back and may never rewrite or erase it. Corrections are recorded
-- as further events, the way the money path already treats refunds.
-- ---------------------------------------------------------------------------
ALTER TABLE "UsageEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "UsageEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_usage_event_select ON "UsageEvent" FOR SELECT TO app_rls USING (app_rls_tenant_allowed("tenantId"));
CREATE POLICY rls_usage_event_insert ON "UsageEvent" FOR INSERT TO app_rls WITH CHECK (app_rls_tenant_allowed("tenantId"));
REVOKE ALL ON TABLE "UsageEvent" FROM app_rls;
GRANT SELECT, INSERT ON TABLE "UsageEvent" TO app_rls;

-- The Control Tower reports usage and will price it, so the platform plane
-- reads this ledger. It never writes it: usage is asserted by the runtime that
-- did the work, never by an operator.
GRANT SELECT ON TABLE "UsageEvent" TO app_platform;

-- Append-only for EVERY role, owner included - the same trigger discipline
-- AuditEvent uses. A grant protects against the application; a trigger protects
-- against everyone.
CREATE OR REPLACE FUNCTION public.app_usage_event_append_only() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'UsageEvent is append-only';
END
$fn$;

CREATE TRIGGER usage_event_no_update BEFORE UPDATE ON "UsageEvent"
  FOR EACH ROW EXECUTE FUNCTION public.app_usage_event_append_only();
CREATE TRIGGER usage_event_no_delete BEFORE DELETE ON "UsageEvent"
  FOR EACH ROW EXECUTE FUNCTION public.app_usage_event_append_only();
