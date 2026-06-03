import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { askAdvisor, getAdvisoryBrief } from './service';

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

export const advisoryRoutes: FastifyPluginAsync = async app => {
  app.get('/brief', async request => {
    const query = briefQuerySchema.parse(request.query);
    return getAdvisoryBrief(request, query.clinicId, { from: query.from, to: query.to });
  });

  app.post('/ask', async request => {
    const body = askSchema.parse(request.body);
    return askAdvisor(request, body);
  });
};
