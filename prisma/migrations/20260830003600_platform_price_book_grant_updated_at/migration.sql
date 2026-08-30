-- Complete the column-scoped price grant.
--
-- SubscriptionPlan carries `updatedAt @updatedAt`, so Prisma writes that column
-- on every update. A grant covering only "monthlyPrice" therefore still failed
-- with 42501. Both columns together are still exactly "may set a price": name,
-- key, tier, active and the feature mapping remain migration-owned, so an
-- operator cannot redefine what a plan IS - only what it costs.
GRANT UPDATE ("monthlyPrice", "updatedAt") ON TABLE "SubscriptionPlan" TO app_platform;
