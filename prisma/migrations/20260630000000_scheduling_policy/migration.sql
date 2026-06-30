-- Per-tenant self-scheduling policy (self-book toggle, horizon/notice, pre-visit
-- requirement gates). Additive; absence of a row = defaults, so behaviour is
-- unchanged until a tenant opts in. FK cascades on tenant delete.
--
-- Rollback: DROP TABLE "SchedulingPolicy";

CREATE TABLE "SchedulingPolicy" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "selfBookEnabled" BOOLEAN NOT NULL DEFAULT true,
    "requireEligibilityForSelfBook" BOOLEAN NOT NULL DEFAULT false,
    "requireIntakeForSelfBook" BOOLEAN NOT NULL DEFAULT false,
    "maxHorizonDays" INTEGER NOT NULL DEFAULT 90,
    "minNoticeHours" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SchedulingPolicy_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SchedulingPolicy_tenantId_key" ON "SchedulingPolicy"("tenantId");

ALTER TABLE "SchedulingPolicy" ADD CONSTRAINT "SchedulingPolicy_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
