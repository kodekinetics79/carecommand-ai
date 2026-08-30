import type { FastifyPluginAsync } from 'fastify';
import { requireFeature } from '../../lib/entitlements';
import { outboundRoutes } from './outbound';
import { clinicRoutes } from './clinics';
import { agentRoutes } from './agents';
import { campaignRoutes, campaignExportRoutes, campaignLifecycleRoutes } from './campaigns';
import { deploymentRoutes } from './deployment';
import { intakeRoutes } from './intake';
import { activityRoutes } from './activity';

export { receptionistWebhookRoutes, verifyRetellSignature } from './webhooks';

export const receptionistRoutes: FastifyPluginAsync = async app => {
  // Feature gate: the entire authenticated AI receptionist surface requires the
  // ai_receptionist entitlement (the public Retell webhook is a separate plugin).
  app.addHook('preHandler', requireFeature('ai_receptionist'));

  // ===== Clinics + locations ==============================================
  await app.register(clinicRoutes);

  // ===== Agents ===========================================================
  await app.register(agentRoutes);

  // ===== Campaigns ========================================================
  await app.register(campaignRoutes);
  await app.register(campaignLifecycleRoutes);

  // ===== Intake fields ====================================================
  await app.register(intakeRoutes);

  // ===== Prompt generation + RetellAI export ==============================
  await app.register(campaignExportRoutes);

  // ===== Deployment, provider status, voice catalogue =====================
  await app.register(deploymentRoutes);

  // ===== Appointment requests, reconciliations, call logs, opt-outs, overview
  await app.register(activityRoutes);

  // ===== Outbound calling (campaigns, targets, launch, booking queue) =====
  // Registered here so it inherits the ai_receptionist feature gate above.
  await app.register(outboundRoutes);
};
