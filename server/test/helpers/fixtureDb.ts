import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client';

const migrationUrl = process.env.DATABASE_MIGRATION_URL;

if (!migrationUrl) {
  throw new Error('DATABASE_MIGRATION_URL is required for owner-only test fixtures');
}

/**
 * Schema-owner client used only for synthetic fixture setup, cleanup and
 * out-of-band assertions. Application requests continue to use app_rls, so
 * this client can never be isolation evidence by itself.
 */
const baseFixtureDb = new PrismaClient({
  adapter: new PrismaPg({ connectionString: migrationUrl }),
});

const OPERATIONAL_ROLES = new Set(['MANAGER', 'PROVIDER', 'FRONT_DESK', 'BILLING']);

/**
 * Most legacy integration fixtures predate UserClinicAccess and create an
 * operational user after creating the tenant's clinics. Keep those fixtures
 * representative of a usable account by filling the legacy primary branch
 * when exactly one or more active branches already exist. Tests that
 * deliberately exercise an unassigned account create no branch and therefore
 * still prove the fail-closed authentication path.
 *
 * This extension is owner-only test setup. Production account creation must
 * continue to require an explicit clinic choice.
 */
export const fixtureDb = baseFixtureDb.$extends({
  query: {
    branch: {
      async create({ args, query }) {
        const branch = await query(args);
        // The caller may project only `id`, so derive fields needed by the
        // fixture backfill from the write arguments, not the returned shape.
        const branchData = args.data as { tenantId: string; active?: boolean };
        if (branchData.active !== false) {
          await baseFixtureDb.user.updateMany({
            where: {
              tenantId: branchData.tenantId,
              branchId: null,
              role: { in: ['MANAGER', 'PROVIDER', 'FRONT_DESK', 'BILLING'] },
            },
            data: { branchId: branch.id },
          });
        }
        return branch;
      },
    },
    user: {
      async create({ args, query }) {
        const data = args.data as typeof args.data & { tenantId?: string; role?: string; branchId?: string | null };
        if (data.tenantId && data.role && OPERATIONAL_ROLES.has(data.role) && data.branchId === undefined) {
          const primaryBranch = await baseFixtureDb.branch.findFirst({
            where: { tenantId: data.tenantId, active: true },
            orderBy: { createdAt: 'asc' },
            select: { id: true },
          });
          if (primaryBranch) data.branchId = primaryBranch.id;
        }
        return query(args);
      },
    },
  },
}) as unknown as PrismaClient;
