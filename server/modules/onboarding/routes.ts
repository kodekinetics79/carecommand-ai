import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requirePlatformOperator } from '../../lib/platform';
import { provisionTenant, ProvisionError } from '../../lib/tenantProvisioning';

// Tenant onboarding. Operator-gated (no open self-signup in this phase) — a
// platform operator provisions new clinics. Returns a tenant summary and the
// owner's next step (sign in); never returns the password hash.
export const onboardingRoutes: FastifyPluginAsync = async app => {
  app.post('/tenant', { preHandler: requirePlatformOperator, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    const input = z.object({
      clinicName: z.string().trim().min(2).max(160),
      clinicSlug: z.string().trim().min(3).max(40),
      ownerName: z.string().trim().min(2).max(120),
      ownerEmail: z.string().email().trim().toLowerCase(),
      ownerPassword: z.string().min(1).max(200),
      defaultBranchName: z.string().trim().min(2).max(160),
      timezone: z.string().trim().max(80).optional(),
      phone: z.string().trim().max(40).optional(),
      address: z.string().trim().max(300).optional(),
      planKey: z.string().trim().max(40).optional(),
    }).parse(request.body);

    try {
      const result = await provisionTenant({ ...input, actorLabel: 'onboarding-api' });
      return reply.code(201).send({
        status: 'ok',
        tenant: result.tenant,
        owner: result.owner,
        branch: result.branch,
        subscription: result.subscription,
        nextStep: { action: 'sign_in', message: 'The owner can now sign in with their email and password.' },
      });
    } catch (error) {
      if (error instanceof ProvisionError) return reply.code(400).send({ error: error.code, message: error.message });
      throw error;
    }
  });
};
