import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env';
import { db } from '../../lib/db';
import { audit } from '../../lib/audit';
import { assertBranchAccess, branchScope } from '../../lib/scope';
import { requireRoles } from '../../plugins/roles';
import { runWithTenantContext } from '../../lib/tenantContext';

const channel = z.enum(['WHATSAPP', 'SMS', 'EMAIL', 'PUSH', 'CALL', 'VIDEO']);
const uuid = z.string().uuid();
const listLimit = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) });
const writeRoles = requireRoles('OWNER', 'ADMIN', 'MANAGER', 'FRONT_DESK');
const adminRoles = requireRoles('OWNER', 'ADMIN', 'MANAGER');

type IntegrationCatalogEntry = {
  key: string;
  name: string;
  category: string;
  description: string;
  supportedWorkflows: string[];
  envVars: string[];
  providerType: 'integration' | 'insurance' | 'payments' | 'placeholder' | 'ai';
};

const integrationCatalog: IntegrationCatalogEntry[] = [
  {
    key: 'whatsapp-business',
    name: 'WhatsApp Business',
    category: 'Communication',
    description: 'Two-way appointment follow-up and patient outreach.',
    supportedWorkflows: ['Missed-call recovery', 'Appointment reminders', 'Campaign replies'],
    envVars: [],
    providerType: 'integration',
  },
  {
    key: 'stedi',
    name: 'Stedi',
    category: 'Insurance',
    description: 'Eligibility, benefits, and payer verification.',
    supportedWorkflows: ['Eligibility verification', 'Benefit lookup', 'Prior auth prep'],
    envVars: ['INSURANCE_PROVIDER', 'STEDI_API_KEY', 'STEDI_BASE_URL', 'STEDI_TEST_MODE'],
    providerType: 'insurance',
  },
  {
    key: 'availity',
    name: 'Availity',
    category: 'Insurance',
    description: 'Insurance eligibility adapter placeholder.',
    supportedWorkflows: ['Eligibility verification', 'Payer lookup'],
    envVars: ['INSURANCE_PROVIDER'],
    providerType: 'placeholder',
  },
  {
    key: 'pverify',
    name: 'pVerify',
    category: 'Insurance',
    description: 'Insurance eligibility adapter placeholder.',
    supportedWorkflows: ['Eligibility verification', 'Benefit lookup'],
    envVars: ['INSURANCE_PROVIDER'],
    providerType: 'placeholder',
  },
  {
    key: 'optum',
    name: 'Optum / Change',
    category: 'Insurance',
    description: 'Insurance eligibility adapter placeholder.',
    supportedWorkflows: ['Eligibility verification', 'Prior auth prep'],
    envVars: ['INSURANCE_PROVIDER'],
    providerType: 'placeholder',
  },
  {
    key: 'stripe',
    name: 'Stripe',
    category: 'Payments',
    description: 'Payment links and checkout sessions.',
    supportedWorkflows: ['Payment links', 'Checkout sessions', 'Deposit collection'],
    envVars: ['PAYMENT_PROVIDER', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'],
    providerType: 'payments',
  },
  {
    key: 'square',
    name: 'Square',
    category: 'Payments',
    description: 'Payment provider adapter placeholder.',
    supportedWorkflows: ['Payment links', 'Card-on-file'],
    envVars: ['PAYMENT_PROVIDER', 'SQUARE_ACCESS_TOKEN'],
    providerType: 'placeholder',
  },
  {
    key: 'authorize_net',
    name: 'Authorize.Net',
    category: 'Payments',
    description: 'Payment provider adapter placeholder.',
    supportedWorkflows: ['Payment links', 'Card processing'],
    envVars: ['PAYMENT_PROVIDER', 'AUTHORIZE_NET_API_LOGIN_ID', 'AUTHORIZE_NET_TRANSACTION_KEY'],
    providerType: 'placeholder',
  },
  {
    key: 'clover',
    name: 'Clover',
    category: 'Payments',
    description: 'Payment provider adapter placeholder.',
    supportedWorkflows: ['Point-of-sale sync', 'Payments'],
    envVars: ['PAYMENT_PROVIDER'],
    providerType: 'placeholder',
  },
  {
    key: 'paypal',
    name: 'PayPal',
    category: 'Payments',
    description: 'Payment provider adapter placeholder.',
    supportedWorkflows: ['Online payments', 'Deposit links'],
    envVars: ['PAYMENT_PROVIDER'],
    providerType: 'placeholder',
  },
  {
    key: 'twilio_sms',
    name: 'Twilio SMS',
    category: 'Communication',
    description: 'SMS reminder and follow-up adapter placeholder.',
    supportedWorkflows: ['Appointment reminders', 'Missed-call recovery'],
    envVars: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER'],
    providerType: 'placeholder',
  },
  {
    key: 'sendgrid_smtp',
    name: 'SendGrid / SMTP',
    category: 'Communication',
    description: 'Email delivery adapter placeholder.',
    supportedWorkflows: ['Review requests', 'Campaign emails'],
    envVars: ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS'],
    providerType: 'placeholder',
  },
  {
    key: 'whatsapp',
    name: 'WhatsApp',
    category: 'Communication',
    description: 'WhatsApp provider readiness.',
    supportedWorkflows: ['Patient reminders', 'Campaign replies'],
    envVars: ['WHATSAPP_ACCESS_TOKEN'],
    providerType: 'placeholder',
  },
  {
    key: 'google_business_profile',
    name: 'Google Business Profile',
    category: 'Reputation / Marketing',
    description: 'Review and profile management placeholder.',
    supportedWorkflows: ['Review monitoring', 'Reputation alerts'],
    envVars: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
    providerType: 'placeholder',
  },
  {
    key: 'facebook_meta',
    name: 'Facebook / Meta',
    category: 'Reputation / Marketing',
    description: 'Social publishing and marketing placeholder.',
    supportedWorkflows: ['Campaign publishing', 'Lead capture'],
    envVars: ['META_APP_ID', 'META_APP_SECRET'],
    providerType: 'placeholder',
  },
  {
    key: 'ollama',
    name: 'Ollama',
    category: 'AI Providers',
    description: 'Local model adapter for the advisory room.',
    supportedWorkflows: ['Advisory brief', 'Summaries', 'Workflow suggestions'],
    envVars: ['AI_PROVIDER', 'OLLAMA_BASE_URL', 'OLLAMA_MODEL'],
    providerType: 'ai',
  },
  {
    key: 'openai',
    name: 'OpenAI',
    category: 'AI Providers',
    description: 'Hosted LLM adapter for advisory workflows.',
    supportedWorkflows: ['Advisory brief', 'Drafting', 'Summaries'],
    envVars: ['AI_PROVIDER', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL'],
    providerType: 'ai',
  },
  {
    key: 'claude',
    name: 'Claude',
    category: 'AI Providers',
    description: 'Hosted LLM adapter for advisory workflows.',
    supportedWorkflows: ['Advisory brief', 'Drafting', 'Summaries'],
    envVars: ['AI_PROVIDER', 'CLAUDE_API_KEY', 'CLAUDE_BASE_URL', 'CLAUDE_MODEL'],
    providerType: 'ai',
  },
] as const;

function scopedBranch(request: FastifyRequest, branchId?: string) {
  return request.auth.branchId ?? branchId;
}

function isEnvSet(name: string) {
  return typeof process.env[name] === 'string' && process.env[name]!.length > 0;
}

function integrationModeLabel(mode: 'mock' | 'sandbox' | 'live', configured: boolean) {
  if (!configured && mode === 'live') return 'Live Not Configured';
  if (!configured && mode === 'sandbox') return 'Sandbox Ready';
  if (mode === 'mock') return 'Mock Mode';
  if (mode === 'live') return 'Live Active';
  return 'Sandbox Active';
}

async function buildIntegrationStatuses(tenantId: string) {
  type IntegrationRow = { id: string; key: string; status: string; lastSyncAt: Date | null };
  type PaymentConnectionRow = { id: string; providerKey: string; status: string; mode: string; lastSyncAt: Date | null };
  type IntegrationLogRow = { provider: string; createdAt: Date };

  const [dbIntegrations, paymentConnections, logs] = await Promise.all([
    db.integration.findMany({ where: { tenantId } }),
    db.paymentProviderConnection.findMany({ where: { tenantId } }),
    db.integrationRunLog.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    }),
  ]) as [IntegrationRow[], PaymentConnectionRow[], IntegrationLogRow[]];

  return integrationCatalog.map(entry => {
    const integrationRow = dbIntegrations.find(row => row.key === entry.key);
    const paymentRow = paymentConnections.find(row => row.providerKey === entry.key);
    const latestLog = logs.find((log: IntegrationLogRow) => log.provider === entry.key || log.provider === entry.name.toLowerCase());

    const missingEnvVars = entry.envVars.filter((name: string) => !isEnvSet(name));

    let mode: 'mock' | 'sandbox' | 'live' = 'mock';
    let configured = false;
    let health: 'healthy' | 'degraded' | 'disconnected' | 'not_configured' = 'not_configured';
    let lastSyncAt: string | null = null;
    let label: string;

    if (entry.key === 'whatsapp-business') {
      configured = integrationRow?.status === 'CONNECTED';
      mode = configured ? 'live' : 'mock';
      health = integrationRow?.status === 'ERROR' ? 'degraded' : configured ? 'healthy' : 'disconnected';
      lastSyncAt = integrationRow?.lastSyncAt?.toISOString() ?? null;
    } else if (entry.key === 'stedi') {
      configured = env.INSURANCE_PROVIDER === 'stedi' && Boolean(env.STEDI_API_KEY);
      mode = configured ? (env.STEDI_TEST_MODE ? 'sandbox' : 'live') : 'mock';
      health = configured ? 'healthy' : 'not_configured';
      lastSyncAt = latestLog?.createdAt.toISOString() ?? null;
    } else if (entry.key === 'stripe') {
      const liveConfigured = env.PAYMENT_PROVIDER === 'stripe' && Boolean(env.STRIPE_SECRET_KEY);
      configured = liveConfigured || Boolean(paymentRow);
      mode = configured ? ((env.STRIPE_SECRET_KEY?.startsWith('sk_live_') ?? false) ? 'live' : 'sandbox') : 'mock';
      health = configured ? (paymentRow?.status === 'connected' ? 'healthy' : 'degraded') : 'not_configured';
      lastSyncAt = paymentRow?.lastSyncAt?.toISOString() ?? latestLog?.createdAt.toISOString() ?? null;
    } else if (entry.key === 'ollama') {
      configured = env.AI_PROVIDER === 'ollama' && Boolean(env.OLLAMA_BASE_URL);
      mode = configured ? 'sandbox' : 'mock';
      health = configured ? 'healthy' : 'not_configured';
      lastSyncAt = latestLog?.createdAt.toISOString() ?? null;
    } else if (entry.key === 'openai') {
      configured = env.AI_PROVIDER === 'openai' && Boolean(env.OPENAI_API_KEY);
      mode = configured ? 'live' : 'mock';
      health = configured ? 'healthy' : 'not_configured';
      lastSyncAt = latestLog?.createdAt.toISOString() ?? null;
    } else if (entry.key === 'claude') {
      configured = env.AI_PROVIDER === 'claude' && Boolean(env.CLAUDE_API_KEY);
      mode = configured ? 'live' : 'mock';
      health = configured ? 'healthy' : 'not_configured';
      lastSyncAt = latestLog?.createdAt.toISOString() ?? null;
    } else if (entry.providerType === 'placeholder') {
      configured = false;
      mode = 'mock';
      health = 'not_configured';
      lastSyncAt = latestLog?.createdAt.toISOString() ?? null;
    }

    if (entry.providerType === 'payments' && entry.key !== 'stripe') {
      const connection = paymentConnections.find((row: PaymentConnectionRow) => row.providerKey === entry.key);
      configured = Boolean(connection?.status === 'connected');
      mode = configured ? (connection?.mode === 'live' ? 'live' : 'sandbox') : 'mock';
      health = configured ? 'healthy' : 'not_configured';
      lastSyncAt = connection?.lastSyncAt?.toISOString() ?? latestLog?.createdAt.toISOString() ?? null;
    }

    if (!configured && entry.providerType === 'placeholder') {
      label = 'Live Not Configured';
    } else {
      label = integrationModeLabel(mode, configured);
    }

    return {
      key: entry.key,
      name: entry.name,
      category: entry.category,
      description: entry.description,
      supportedWorkflows: entry.supportedWorkflows,
      mode,
      modeLabel: label,
      configured,
      health,
      lastSyncAt,
      missingEnvVars,
      riskLevel: !configured ? 'high' : health === 'degraded' ? 'medium' : 'low',
      action: 'Test connection',
      integrationId: integrationRow?.id ?? null,
      providerConnectionId: paymentRow?.id ?? null,
      databaseStatus: integrationRow?.status ?? paymentRow?.status ?? null,
    };
  });
}

export const operationsRoutes: FastifyPluginAsync = async app => {
  app.get('/competitors/radar', async request => {
    const query = listLimit.extend({ branchId: uuid.optional() }).parse(request.query);
    return db.competitor.findMany({
      where: { tenantId: request.auth.tenantId, branchId: scopedBranch(request, query.branchId) },
      take: query.limit,
      orderBy: [{ googleRating: 'asc' }, { reviewVolume: 'desc' }],
      include: { branch: { select: { name: true } }, insights: { orderBy: { complaintCount: 'desc' } } },
    });
  });

  app.get('/reputation', async request => {
    const query = listLimit.extend({ branchId: uuid.optional() }).parse(request.query);
    const branchId = scopedBranch(request, query.branchId);
    const [cases, reviewRequests, unresolvedCount, averageRisk] = await Promise.all([
      db.reputationCase.findMany({
        where: { tenantId: request.auth.tenantId, branchId },
        take: query.limit,
        orderBy: [{ badReviewRisk: 'desc' }, { createdAt: 'desc' }],
        include: { branch: { select: { name: true } }, patient: { select: { firstName: true, lastName: true } } },
      }),
      db.reviewRequest.findMany({
        where: { tenantId: request.auth.tenantId, branchId },
        take: query.limit,
        orderBy: { createdAt: 'desc' },
        include: { branch: { select: { name: true } }, patient: { select: { firstName: true, lastName: true } } },
      }),
      db.reputationCase.count({ where: { tenantId: request.auth.tenantId, branchId, workflowStatus: { not: 'resolved' } } }),
      db.reputationCase.aggregate({
        where: { tenantId: request.auth.tenantId, branchId },
        _avg: { badReviewRisk: true, npsScore: true },
      }),
    ]);

    return {
      summary: {
        unresolvedCases: unresolvedCount,
        avgBadReviewRisk: Math.round(Number(averageRisk._avg.badReviewRisk ?? 0)),
        avgNpsScore: Math.round(Number(averageRisk._avg.npsScore ?? 0)),
        pendingReviewRequests: reviewRequests.filter(item => item.status !== 'SENT' && item.status !== 'DELIVERED').length,
      },
      cases,
      reviewRequests,
    };
  });

  // RLS (B-3): RevenueLeak is tenant-isolated — reads/writes run under context.
  app.get('/revenue-leaks', async request => {
    const query = listLimit.extend({ branchId: uuid.optional() }).parse(request.query);
    return runWithTenantContext(request.auth.tenantId, tx => tx.revenueLeak.findMany({
      where: { tenantId: request.auth.tenantId, branchId: scopedBranch(request, query.branchId) },
      take: query.limit,
      orderBy: { createdAt: 'desc' },
      include: { branch: { select: { name: true } }, ownerUser: { select: { displayName: true } }, patient: { select: { firstName: true, lastName: true } } },
    }));
  });

  app.patch('/revenue-leaks/:id', { preHandler: writeRoles }, async request => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const input = z.object({
      status: z.string().min(2).max(40).optional(),
      workflowStatus: z.string().min(2).max(40).optional(),
    }).parse(request.body);
    const row = await runWithTenantContext(request.auth.tenantId, async tx => {
      const existing = await tx.revenueLeak.findFirst({ where: { id, tenantId: request.auth.tenantId } });
      if (!existing) throw app.httpErrors.notFound('Revenue leak not found');
      if (existing.branchId) assertBranchAccess(request, existing.branchId);
      return tx.revenueLeak.update({ where: { id }, data: input });
    });
    await audit(request, { action: 'revenueLeak.workflowUpdated', resource: 'revenueLeak', resourceId: id, metadata: input });
    return row;
  });

  app.get('/opportunities', async request => {
    const query = listLimit.extend({ branchId: uuid.optional() }).parse(request.query);
    return db.opportunity.findMany({
      where: { tenantId: request.auth.tenantId, branchId: scopedBranch(request, query.branchId) },
      take: query.limit,
      orderBy: { createdAt: 'desc' },
      include: { branch: { select: { name: true } }, ownerUser: { select: { displayName: true } }, patient: { select: { firstName: true, lastName: true } } },
    });
  });
  app.patch('/opportunities/:id', { preHandler: writeRoles }, async request => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const input = z.object({
      status: z.string().min(2).max(40).optional(),
      ownerApprovalRequired: z.boolean().optional(),
      actualRevenue: z.coerce.number().min(0).optional(),
    }).parse(request.body);
    const existing = await db.opportunity.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!existing) throw app.httpErrors.notFound('Opportunity not found');
    if (existing.branchId) assertBranchAccess(request, existing.branchId);
    const row = await db.opportunity.update({ where: { id }, data: input });
    await audit(request, { action: 'opportunity.updated', resource: 'opportunity', resourceId: id, metadata: input });
    return row;
  });

  app.get('/leads', async request => {
    const { limit } = listLimit.parse(request.query);
    return db.lead.findMany({ where: { tenantId: request.auth.tenantId }, take: limit, orderBy: { createdAt: 'desc' } });
  });
  app.post('/leads', { preHandler: writeRoles }, async (request, reply) => {
    const input = z.object({
      patientId: uuid.optional(), name: z.string().min(2).max(160), phone: z.string().max(40).optional(),
      email: z.string().email().optional(), channel, service: z.string().min(2).max(160),
      stage: z.string().min(2).max(40), source: z.string().min(2).max(120), estimatedValue: z.coerce.number().min(0).default(0),
    }).parse(request.body);
    const row = await db.lead.create({ data: { tenantId: request.auth.tenantId, ...input } });
    await audit(request, { action: 'lead.created', resource: 'lead', resourceId: row.id });
    return reply.code(201).send(row);
  });
  app.patch('/leads/:id', { preHandler: writeRoles }, async request => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const input = z.object({
      stage: z.string().min(2).max(40).optional(),
      estimatedValue: z.coerce.number().min(0).optional(),
    }).parse(request.body);
    const existing = await db.lead.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!existing) throw app.httpErrors.notFound('Lead not found');
    const row = await db.lead.update({ where: { id }, data: input });
    await audit(request, { action: 'lead.updated', resource: 'lead', resourceId: id, metadata: input });
    return row;
  });

  app.get('/campaigns', async request => {
    const { limit } = listLimit.parse(request.query);
    return db.campaign.findMany({ where: { tenantId: request.auth.tenantId }, take: limit, orderBy: { createdAt: 'desc' } });
  });
  app.post('/campaigns', { preHandler: adminRoles }, async (request, reply) => {
    const input = z.object({
      name: z.string().min(2).max(160), goal: z.string().min(2).max(300),
      status: z.enum(['DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'SCHEDULED']).default('DRAFT'),
      channels: z.array(channel).min(1), audienceSize: z.coerce.number().int().min(0).default(0),
      aiGenerated: z.boolean().default(false), startsAt: z.coerce.date().optional(), endsAt: z.coerce.date().optional(),
    }).parse(request.body);
    const row = await db.campaign.create({ data: { tenantId: request.auth.tenantId, ...input } });
    await audit(request, { action: 'campaign.created', resource: 'campaign', resourceId: row.id });
    return reply.code(201).send(row);
  });
  app.patch('/campaigns/:id', { preHandler: adminRoles }, async request => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const input = z.object({
      status: z.enum(['DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'SCHEDULED']).optional(),
      name: z.string().min(2).max(160).optional(),
      goal: z.string().min(2).max(300).optional(),
    }).parse(request.body);
    const existing = await db.campaign.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!existing) throw app.httpErrors.notFound('Campaign not found');
    const row = await db.campaign.update({ where: { id }, data: input });
    await audit(request, { action: 'campaign.updated', resource: 'campaign', resourceId: id, metadata: input });
    return row;
  });

  app.get('/reviews', async request => {
    const query = listLimit.extend({ branchId: uuid.optional() }).parse(request.query);
    return db.review.findMany({ where: { tenantId: request.auth.tenantId, branchId: scopedBranch(request, query.branchId) }, take: query.limit, orderBy: { createdAt: 'desc' } });
  });
  app.post('/reviews', { preHandler: writeRoles }, async (request, reply) => {
    const input = z.object({
      patientId: uuid.optional(), branchId: uuid.optional(), rating: z.coerce.number().int().min(1).max(5),
      text: z.string().min(1).max(4000), platform: z.string().min(2).max(80), sentiment: z.string().min(2).max(40),
    }).parse(request.body);
    if (input.branchId) assertBranchAccess(request, input.branchId);
    const row = await db.review.create({ data: { tenantId: request.auth.tenantId, ...input } });
    await audit(request, { action: 'review.created', resource: 'review', resourceId: row.id });
    return reply.code(201).send(row);
  });
  app.patch('/reviews/:id/respond', { preHandler: writeRoles }, async request => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const input = z.object({ response: z.string().min(1).max(4000) }).parse(request.body);
    const existing = await db.review.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!existing) throw app.httpErrors.notFound('Review not found');
    if (existing.branchId) assertBranchAccess(request, existing.branchId);
    const row = await db.review.update({
      where: { id },
      data: { responded: true, aiDraftResponse: input.response },
    });
    await audit(request, { action: 'review.responded', resource: 'review', resourceId: id });
    return row;
  });

  app.get('/inventory', async request => {
    const query = listLimit.extend({ branchId: uuid.optional() }).parse(request.query);
    return db.inventoryItem.findMany({ where: { tenantId: request.auth.tenantId, branchId: scopedBranch(request, query.branchId) }, take: query.limit, orderBy: { name: 'asc' } });
  });
  app.post('/inventory', { preHandler: adminRoles }, async (request, reply) => {
    const input = z.object({
      branchId: uuid, name: z.string().min(2).max(160), category: z.string().min(2).max(100),
      currentStock: z.coerce.number().int().min(0), unit: z.string().min(1).max(40), reorderLevel: z.coerce.number().int().min(0),
      expiryDate: z.coerce.date().optional(), unitCost: z.coerce.number().min(0), usagePerWeek: z.coerce.number().int().min(0), supplier: z.string().min(2).max(160),
    }).parse(request.body);
    assertBranchAccess(request, input.branchId);
    const row = await db.inventoryItem.create({ data: { tenantId: request.auth.tenantId, ...input } });
    await audit(request, { action: 'inventory.created', resource: 'inventoryItem', resourceId: row.id });
    return reply.code(201).send(row);
  });
  app.patch('/inventory/:id', { preHandler: writeRoles }, async request => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    // Either set an absolute stock level or add a restock amount.
    const input = z.object({
      currentStock: z.coerce.number().int().min(0).optional(),
      restockBy: z.coerce.number().int().min(1).optional(),
      reorderLevel: z.coerce.number().int().min(0).optional(),
    }).parse(request.body);
    const existing = await db.inventoryItem.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!existing) throw app.httpErrors.notFound('Inventory item not found');
    assertBranchAccess(request, existing.branchId);
    const nextStock = input.currentStock ?? (input.restockBy ? existing.currentStock + input.restockBy : existing.currentStock);
    const row = await db.inventoryItem.update({
      where: { id },
      data: { currentStock: nextStock, reorderLevel: input.reorderLevel ?? existing.reorderLevel },
    });
    await audit(request, { action: 'inventory.restocked', resource: 'inventoryItem', resourceId: id, metadata: { from: existing.currentStock, to: nextStock } });
    return row;
  });

  app.get('/partner-reports', async request => {
    const query = listLimit.extend({ branchId: uuid.optional() }).parse(request.query);
    return db.partnerReport.findMany({
      where: { tenantId: request.auth.tenantId, branchId: scopedBranch(request, query.branchId) },
      take: query.limit,
      orderBy: { orderedAt: 'desc' },
      include: {
        branch: { select: { name: true } },
        patient: { select: { firstName: true, lastName: true } },
        reviewedByUser: { select: { displayName: true } },
      },
    });
  });
  app.post('/partner-reports', { preHandler: writeRoles }, async (request, reply) => {
    const input = z.object({
      branchId: uuid, patientId: uuid.optional(), providerRef: z.string().max(120).optional(),
      reportType: z.string().min(2).max(160), partner: z.string().min(2).max(160),
      urgency: z.string().min(2).max(40), status: z.string().min(2).max(60), summary: z.string().max(4000).optional(),
    }).parse(request.body);
    assertBranchAccess(request, input.branchId);
    const row = await db.partnerReport.create({ data: { tenantId: request.auth.tenantId, ...input } });
    await audit(request, { action: 'partnerReport.created', resource: 'partnerReport', resourceId: row.id });
    return reply.code(201).send(row);
  });

  app.patch('/partner-reports/:id/review', { preHandler: writeRoles }, async request => {
    const params = z.object({ id: uuid }).parse(request.params);
    const body = z.object({
      status: z.enum(['ordered', 'sample-collected', 'pending-result', 'result-received', 'doctor-reviewed']).default('doctor-reviewed'),
      summary: z.string().max(4000).optional(),
    }).parse(request.body);
    const row = await db.partnerReport.findFirst({ where: { id: params.id, tenantId: request.auth.tenantId } });
    if (!row) throw request.server.httpErrors.notFound('Partner report not found');
    if (row.branchId) assertBranchAccess(request, row.branchId);
    const updated = await db.partnerReport.update({
      where: { id: row.id },
      data: {
        status: body.status,
        reviewedAt: new Date(),
        reviewedByUserId: request.auth.userId,
        summary: body.summary ?? row.summary,
      },
      include: {
        branch: { select: { name: true } },
        patient: { select: { firstName: true, lastName: true } },
        reviewedByUser: { select: { displayName: true } },
      },
    });
    await audit(request, { action: 'partnerReport.reviewed', resource: 'partnerReport', resourceId: row.id });
    return updated;
  });

  app.get('/integrations', async request => {
    return db.integration.findMany({ where: { tenantId: request.auth.tenantId }, orderBy: { name: 'asc' } });
  });
  app.patch('/integrations/:id', { preHandler: adminRoles }, async request => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const input = z.object({
      status: z.enum(['CONNECTED', 'DISCONNECTED', 'ERROR', 'COMING_SOON']),
    }).parse(request.body);
    const existing = await db.integration.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!existing) throw app.httpErrors.notFound('Integration not found');
    const row = await db.integration.update({
      where: { id },
      data: { status: input.status, lastSyncAt: input.status === 'CONNECTED' ? new Date() : existing.lastSyncAt },
    });
    await audit(request, { action: 'integration.statusChanged', resource: 'integration', resourceId: id, metadata: { status: input.status } });
    return row;
  });

  app.get('/integrations/status', async request => {
    return buildIntegrationStatuses(request.auth.tenantId);
  });

  app.post('/integrations/:provider/test', { preHandler: adminRoles }, async (request, reply) => {
    const { provider } = z.object({ provider: z.string().trim().min(1).max(80) }).parse(request.params);
    const statuses = await buildIntegrationStatuses(request.auth.tenantId);
    const selected = statuses.find(entry => entry.key === provider);
    if (!selected) throw app.httpErrors.notFound('Integration provider not found');

    await db.integrationRunLog.create({
      data: {
        tenantId: request.auth.tenantId,
        branchId: request.auth.branchId ?? undefined,
        provider: selected.key,
        providerMode: selected.mode,
        operation: 'connection.test',
        status: selected.configured ? 'success' : 'not_configured',
        requestSummary: {
          provider: selected.key,
          category: selected.category,
        },
        responseSummary: {
          mode: selected.modeLabel,
          health: selected.health,
          configured: selected.configured,
        },
        errorMessage: selected.configured ? null : 'Provider not configured',
      },
    });

    if (selected.integrationId) {
      await db.integration.update({
        where: { id: selected.integrationId },
        data: { lastSyncAt: new Date() },
      });
    }
    if (selected.providerConnectionId) {
      await db.paymentProviderConnection.update({
        where: { id: selected.providerConnectionId },
        data: { lastSyncAt: new Date() },
      });
    }

    await audit(request, {
      action: 'integration.tested',
      resource: 'integration',
      resourceId: selected.integrationId ?? selected.providerConnectionId ?? selected.key,
      metadata: { provider: selected.key, configured: selected.configured, mode: selected.mode },
    });

    return reply.send({
      providerKey: selected.key,
      providerName: selected.name,
      category: selected.category,
      mode: selected.mode,
      modeLabel: selected.modeLabel,
      configured: selected.configured,
      health: selected.health,
      message: selected.configured ? 'Connection test recorded.' : 'Provider is not configured yet.',
      lastCheckedAt: new Date().toISOString(),
      supportedWorkflows: selected.supportedWorkflows,
      missingEnvVars: selected.missingEnvVars,
      riskLevel: selected.riskLevel,
    });
  });

  app.get('/tasks', async request => {
    const query = listLimit.extend({ branchId: uuid.optional() }).parse(request.query);
    const branchId = scopedBranch(request, query.branchId);
    return db.staffTask.findMany({
      where: { tenantId: request.auth.tenantId, branchId },
      take: query.limit,
      orderBy: { createdAt: 'desc' },
      include: {
        branch: { select: { name: true } },
        assignedTo: { select: { displayName: true } },
      },
    });
  });
  app.post('/tasks', { preHandler: adminRoles }, async (request, reply) => {
    const input = z.object({
      branchId: uuid.optional(), assignedToId: uuid.optional(), title: z.string().min(2).max(240),
      priority: z.string().min(2).max(40), dueAt: z.coerce.date().optional(),
    }).parse(request.body);
    if (input.branchId) assertBranchAccess(request, input.branchId);
    const row = await db.staffTask.create({ data: { tenantId: request.auth.tenantId, ...input } });
    await audit(request, { action: 'task.created', resource: 'staffTask', resourceId: row.id });
    return reply.code(201).send(row);
  });

  app.get('/revenue-snapshots', async request => {
    const query = listLimit.extend({ branchId: uuid.optional() }).parse(request.query);
    return db.revenueSnapshot.findMany({ where: { tenantId: request.auth.tenantId, branchId: scopedBranch(request, query.branchId) }, take: query.limit, orderBy: { period: 'desc' } });
  });

  app.get('/conversations', async request => {
    const query = listLimit.extend({ branchId: uuid.optional() }).parse(request.query);
    return db.conversation.findMany({
      where: { tenantId: request.auth.tenantId, ...branchScope(request), branchId: scopedBranch(request, query.branchId) },
      take: query.limit,
      orderBy: { updatedAt: 'desc' },
      include: {
        branch: { select: { name: true } },
        patient: { select: { firstName: true, lastName: true } },
      },
    });
  });

  app.post('/conversations/:id/reply', { preHandler: writeRoles }, async (request, reply) => {
    const params = z.object({ id: uuid }).parse(request.params);
    const body = z.object({
      message: z.string().min(1).max(2000),
      status: z.enum(['replied', 'ai-recovered', 'escalated', 'pending']).default('replied'),
    }).parse(request.body);
    const row = await db.conversation.findFirst({ where: { id: params.id, tenantId: request.auth.tenantId } });
    if (!row) throw request.server.httpErrors.notFound('Conversation not found');
    if (row.branchId) assertBranchAccess(request, row.branchId);
    const updated = await db.conversation.update({
      where: { id: row.id },
      data: {
        latestMessage: row.latestMessage,
        lastAgentMessage: body.message,
        lastAgentMessageAt: new Date(),
        status: body.status,
        aiHandled: true,
      },
      include: {
        branch: { select: { name: true } },
        patient: { select: { firstName: true, lastName: true } },
      },
    });
    await audit(request, { action: 'conversation.replied', resource: 'conversation', resourceId: row.id });
    return reply.send(updated);
  });
};
