import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { askAdvisor, getAdvisoryBrief } from './service';
import { requirePermission } from '../../lib/permissions';
import { audit } from '../../lib/audit';

const advisorTypeSchema = z.enum(['revenue', 'growth', 'front-desk', 'competitor', 'operations']);
const dateRangeSchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
}).optional();

const briefQuerySchema = z.object({
  clinicId: z.string().uuid().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

const askSchema = z.object({
  advisorType: advisorTypeSchema,
  question: z.string().trim().min(3).max(1000),
  clinicId: z.string().uuid().optional(),
  dateRange: dateRangeSchema,
});

/**
 * The advisory brief is a PHI surface: it returns named patients with churn
 * risk, lifetime value and outstanding balance, plus named patients on revenue
 * leaks and opportunities. It shipped with no permission check at all beyond
 * `authenticate`, so every authenticated role - front desk, analyst, auditor,
 * billing - could read it, and it recorded no audit event.
 *
 * Both grants are required on purpose: `patient:read` because patients are
 * named, `revenue:read` because the brief exists to discuss money. That leaves
 * it open to OWNER / ADMIN / MANAGER / BILLING / ANALYST and closes it to
 * FRONT_DESK, PROVIDER and COMPLIANCE_OFFICER, which is the minimum-necessary
 * reading of who needs a commercial brief naming patients.
 */
const canReadAdvisory = requirePermission('patient:read', 'revenue:read');

export const advisoryRoutes: FastifyPluginAsync = async app => {
  app.get('/brief', { preHandler: canReadAdvisory }, async request => {
    const query = briefQuerySchema.parse(request.query);
    const brief = await getAdvisoryBrief(request, query.clinicId, { from: query.from, to: query.to });
    // Counts only. The point of the record is that a disclosure happened and
    // who caused it, never a copy of the patients disclosed.
    await audit(request, {
      action: 'advisory.brief.read',
      resource: 'advisoryBrief',
      metadata: { clinicId: query.clinicId ?? null, ranged: Boolean(query.from || query.to) },
    });
    return brief;
  });

  app.post('/ask', { preHandler: canReadAdvisory }, async request => {
    const body = askSchema.parse(request.body);
    const answer = await askAdvisor(request, body);
    // The question itself is never recorded: a user can type PHI into it.
    await audit(request, {
      action: 'advisory.question.asked',
      resource: 'advisoryAnswer',
      metadata: { advisorType: body.advisorType, clinicId: body.clinicId ?? null },
    });
    return answer;
  });
};
