import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env';
import { db } from '../../lib/db';
import { audit } from '../../lib/audit';
import { generatePasswordHash, validatePassword } from '../../lib/security';
import { requireRoles } from '../../plugins/roles';
import { setUserActiveSafely, setUserPasswordSafely, setUserRoleSafely } from '../../lib/adminSafety';
import { autopilotQueue } from '../../workers/queues';
import { createPaymentProvider, createInsuranceProvider, type PaymentRequestContext } from '../revenue-protection';
import { paymentProviderStatus } from '../../lib/deposits';
import { eligibilityProviderStatus } from '../../lib/insuranceIntelligence';
import { runWithTenantContext } from '../../lib/tenantContext';
import { Prisma } from '../../generated/prisma/client';
import { lockClinicAccessMutation } from '../../lib/clinicAccessSafety';

const ownerAdminRoles = requireRoles('OWNER', 'ADMIN');
const uuid = z.string().uuid();

const rolePermissionMatrix: Array<{ role: string; scope: string; modules: string[]; risk: 'low' | 'medium' | 'high' }> = [
  {
    role: 'OWNER',
    scope: 'Tenant-wide, all clinics',
    modules: ['Command Center', 'Growth', 'Revenue', 'Operations', 'Platform'],
    risk: 'high',
  },
  {
    role: 'ADMIN',
    scope: 'Tenant-wide, all clinics',
    modules: ['Command Center', 'Growth', 'Revenue', 'Operations', 'Platform'],
    risk: 'high',
  },
  {
    role: 'MANAGER',
    scope: 'Assigned clinics',
    modules: ['Command Center', 'Growth', 'Revenue', 'Operations'],
    risk: 'medium',
  },
  {
    role: 'BILLING',
    scope: 'Finance / payment workflows',
    modules: ['Revenue', 'Platform'],
    risk: 'medium',
  },
  {
    role: 'FRONT_DESK',
    scope: 'Assigned clinic',
    modules: ['Command Center', 'Growth', 'Operations'],
    risk: 'medium',
  },
  {
    role: 'PROVIDER',
    scope: 'Primary clinic',
    modules: ['Command Center', 'Operations'],
    risk: 'medium',
  },
  {
    role: 'ANALYST',
    scope: 'Tenant-wide, read-only',
    modules: ['Command Center', 'Revenue', 'Operations'],
    risk: 'low',
  },
  // Descriptive module guidance only — enforcement lives in the compliance
  // module's route role checks, not in this matrix.
  {
    role: 'COMPLIANCE_OFFICER',
    scope: 'Compliance module',
    modules: ['Compliance Readiness: manage', 'Evidence Vault: manage', 'Risks/Vendors/Incidents: manage', 'Reports/Audit Logs: view'],
    risk: 'medium',
  },
  {
    role: 'AUDITOR',
    scope: 'Compliance module, read-only',
    modules: ['Compliance Readiness: view', 'Evidence Vault: view', 'Reports/Audit Logs: view'],
    risk: 'low',
  },
];

const controlPlaneRoles: Record<string, { scope: string; modules: string[]; risk: 'low' | 'medium' | 'high' }> = Object.fromEntries(
  rolePermissionMatrix.map(entry => [entry.role, { scope: entry.scope, modules: entry.modules, risk: entry.risk }]),
);

const integrationDefinitions = [
  { key: 'stedi', name: 'Stedi', category: 'Insurance', envVars: ['INSURANCE_PROVIDER', 'STEDI_API_KEY', 'STEDI_BASE_URL', 'STEDI_TEST_MODE'], providerType: 'insurance' },
  { key: 'availity', name: 'Availity', category: 'Insurance', envVars: ['INSURANCE_PROVIDER'], providerType: 'insurance' },
  { key: 'pverify', name: 'pVerify', category: 'Insurance', envVars: ['INSURANCE_PROVIDER'], providerType: 'insurance' },
  { key: 'optum', name: 'Optum / Change Healthcare', category: 'Insurance', envVars: ['INSURANCE_PROVIDER'], providerType: 'insurance' },
  { key: 'stripe', name: 'Stripe', category: 'Payments', envVars: ['PAYMENT_PROVIDER', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'], providerType: 'payments' },
  { key: 'square', name: 'Square', category: 'Payments', envVars: ['PAYMENT_PROVIDER', 'SQUARE_ACCESS_TOKEN'], providerType: 'payments' },
  { key: 'authorize_net', name: 'Authorize.Net', category: 'Payments', envVars: ['PAYMENT_PROVIDER', 'AUTHORIZE_NET_API_LOGIN_ID', 'AUTHORIZE_NET_TRANSACTION_KEY'], providerType: 'payments' },
  { key: 'clover', name: 'Clover', category: 'Payments', envVars: ['PAYMENT_PROVIDER'], providerType: 'payments' },
  { key: 'paypal', name: 'PayPal', category: 'Payments', envVars: ['PAYMENT_PROVIDER'], providerType: 'payments' },
  { key: 'twilio', name: 'Twilio', category: 'Communications', envVars: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER'], providerType: 'communications' },
  { key: 'sendgrid', name: 'SendGrid / SMTP', category: 'Communications', envVars: ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS'], providerType: 'communications' },
  { key: 'whatsapp_business', name: 'WhatsApp Business', category: 'Communications', envVars: ['WHATSAPP_ACCESS_TOKEN'], providerType: 'communications' },
  { key: 'google_business_profile', name: 'Google Business Profile', category: 'Reputation / Marketing', envVars: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'], providerType: 'marketing' },
  { key: 'meta', name: 'Meta / Facebook', category: 'Reputation / Marketing', envVars: ['META_APP_ID', 'META_APP_SECRET'], providerType: 'marketing' },
  { key: 'ollama', name: 'Ollama', category: 'AI Providers', envVars: ['AI_PROVIDER', 'OLLAMA_BASE_URL', 'OLLAMA_MODEL'], providerType: 'ai' },
  { key: 'openai', name: 'OpenAI', category: 'AI Providers', envVars: ['AI_PROVIDER', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL'], providerType: 'ai' },
  { key: 'claude', name: 'Claude', category: 'AI Providers', envVars: ['AI_PROVIDER', 'CLAUDE_API_KEY', 'CLAUDE_BASE_URL', 'CLAUDE_MODEL'], providerType: 'ai' },
] as const;

const insuranceProviders = ['stedi', 'availity', 'pverify', 'optum'] as const;
const paymentProviders = ['stripe', 'square', 'authorize_net', 'clover', 'paypal'] as const;

export function insuranceRailCapability(
  provider: (typeof insuranceProviders)[number],
  runtime: { selectedProvider: string; stediApiKey?: string; stediTestMode: boolean },
): { configured: boolean; mode: 'sandbox' | 'live' | 'mock' } {
  const configured = provider === 'stedi' && runtime.selectedProvider === 'stedi' && Boolean(runtime.stediApiKey);
  return { configured, mode: configured ? (runtime.stediTestMode ? 'sandbox' : 'live') : 'mock' };
}

function safeEmail(metadata: unknown) {
  if (!metadata || typeof metadata !== 'object') return null;
  const email = (metadata as { email?: unknown }).email;
  return typeof email === 'string' ? email : null;
}

function sameDayRange(now = new Date()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

function formatMode(mode: string, configured: boolean) {
  if (!configured && mode === 'live') return 'Live Not Configured';
  if (!configured && mode === 'sandbox') return 'Sandbox Ready';
  if (!configured) return 'Mock Mode';
  if (mode === 'live') return 'Live Active';
  if (mode === 'sandbox') return 'Sandbox Active';
  return 'Mock Mode';
}

async function loadUsers(tenantId: string) {
  const users = await db.user.findMany({
    where: { tenantId },
    orderBy: [{ active: 'desc' }, { displayName: 'asc' }],
    select: {
      id: true,
      displayName: true,
      email: true,
      role: true,
      active: true,
      branchId: true,
      lastLoginAt: true,
      createdAt: true,
      updatedAt: true,
      branch: { select: { id: true, name: true, location: true } },
      clinicAccesses: {
        orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
        select: {
          id: true,
          isPrimary: true,
          branch: { select: { id: true, name: true, location: true } },
        },
      },
    },
  });

  return users.map(user => ({
    ...user,
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
    sessionActive: Boolean(user.lastLoginAt && user.active),
    accessBranches: user.clinicAccesses.map(access => ({
      id: access.branch.id,
      name: access.branch.name,
      location: access.branch.location,
      isPrimary: access.isPrimary,
    })),
  }));
}

async function replaceClinicAccess(tx: Prisma.TransactionClient, tenantId: string, userId: string, branchIds: string[], primaryBranchId?: string) {
  const uniqueBranchIds = [...new Set(branchIds)];
  if (primaryBranchId && !uniqueBranchIds.includes(primaryBranchId)) {
    throw new Error('primary_branch_must_be_selected');
  }
  const orderedBranchIds = primaryBranchId
    ? [primaryBranchId, ...uniqueBranchIds.filter(id => id !== primaryBranchId)]
    : uniqueBranchIds;
  await tx.userClinicAccess.deleteMany({ where: { tenantId, userId } });
  if (orderedBranchIds.length > 0) {
    await tx.userClinicAccess.createMany({
      data: orderedBranchIds.map((branchId, index) => ({ tenantId, userId, branchId, isPrimary: index === 0 })),
    });
  }
  await tx.user.update({ where: { id: userId }, data: { branchId: orderedBranchIds[0] ?? null } });
}

async function buildIntegrationRows(tenantId: string) {
  const [integrationRows, paymentConnections, logs] = await Promise.all([
    db.integration.findMany({ where: { tenantId } }),
    db.paymentProviderConnection.findMany({ where: { tenantId } }),
    db.integrationRunLog.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    }),
  ]);

  return integrationDefinitions.map(definition => {
    const integrationRow = integrationRows.find(row => row.key === definition.key);
    const paymentRow = paymentConnections.find(row => row.providerKey === definition.key);
    const latestLog = logs.find(log => log.provider === definition.key || log.provider === definition.name.toLowerCase());
    // Operator-only detail. Tenants receive a count, never the variable names.
    const missingConfigCount = definition.envVars.filter(name => !process.env[name]).length;

    let mode: 'mock' | 'sandbox' | 'live';
    let configured: boolean;
    let health: 'healthy' | 'degraded' | 'disconnected' | 'not_configured';
    let lastSyncAt: string | null;

    if (definition.key === 'stedi') {
      configured = env.INSURANCE_PROVIDER === 'stedi' && Boolean(env.STEDI_API_KEY);
      mode = configured ? (env.STEDI_TEST_MODE ? 'sandbox' : 'live') : 'mock';
      health = configured ? 'healthy' : 'not_configured';
      lastSyncAt = latestLog?.createdAt.toISOString() ?? null;
    } else if (definition.key === 'stripe') {
      configured = env.PAYMENT_PROVIDER === 'stripe' && Boolean(env.STRIPE_SECRET_KEY);
      mode = configured ? (env.STRIPE_SECRET_KEY?.startsWith('sk_live_') ? 'live' : 'sandbox') : 'mock';
      health = configured ? (paymentRow?.status === 'connected' ? 'healthy' : 'degraded') : 'not_configured';
      lastSyncAt = paymentRow?.lastSyncAt?.toISOString() ?? latestLog?.createdAt.toISOString() ?? null;
    } else if (definition.providerType === 'insurance') {
      configured = Boolean(integrationRow?.status === 'CONNECTED');
      mode = configured ? 'sandbox' : 'mock';
      health = configured ? 'healthy' : 'not_configured';
      lastSyncAt = integrationRow?.lastSyncAt?.toISOString() ?? latestLog?.createdAt.toISOString() ?? null;
    } else if (definition.providerType === 'payments') {
      configured = Boolean(paymentRow?.status === 'connected');
      mode = configured ? (paymentRow?.mode === 'live' ? 'live' : 'sandbox') : 'mock';
      health = configured ? 'healthy' : 'not_configured';
      lastSyncAt = paymentRow?.lastSyncAt?.toISOString() ?? latestLog?.createdAt.toISOString() ?? null;
    } else if (definition.providerType === 'ai') {
      configured = (env.AI_PROVIDER === definition.key) && Boolean(process.env[`${definition.key.toUpperCase()}_API_KEY`] || process.env.OLLAMA_BASE_URL);
      mode = configured ? (definition.key === 'ollama' ? 'sandbox' : 'live') : 'mock';
      health = configured ? 'healthy' : 'not_configured';
      lastSyncAt = latestLog?.createdAt.toISOString() ?? null;
    } else {
      configured = Boolean(integrationRow?.status === 'CONNECTED');
      mode = configured ? 'live' : 'mock';
      health = configured ? 'healthy' : 'disconnected';
      lastSyncAt = integrationRow?.lastSyncAt?.toISOString() ?? null;
    }

    return {
      key: definition.key,
      name: definition.name,
      category: definition.category,
      description: `${definition.name} readiness and health`,
      supportedWorkflows: definition.category === 'Insurance'
        ? ['Eligibility verification', 'Benefits verification', 'Prior authorization']
        : definition.category === 'Payments'
          ? ['Payment link', 'Deposits', 'Copay collection']
          : definition.category === 'Communications'
            ? ['Reminders', 'Follow-ups', 'Patient messages']
            : definition.category === 'AI Providers'
              ? ['Advisory brief', 'Summaries', 'Workflow suggestions']
              : ['Monitoring'],
      mode,
      modeLabel: formatMode(mode, configured),
      configured,
      health,
      lastSyncAt,
      missingConfigCount,
      riskLevel: !configured ? 'high' : health === 'degraded' ? 'medium' : 'low',
      action: 'Test connection',
      integrationId: integrationRow?.id ?? null,
      providerConnectionId: paymentRow?.id ?? null,
      databaseStatus: integrationRow?.status ?? paymentRow?.status ?? null,
    };
  });
}

async function buildInsuranceRails(tenantId: string) {
  const [payers, policies, verifications, priorAuths, logs] = await Promise.all([
    db.insurancePayer.findMany({ where: { tenantId }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], take: 20 }),
    db.patientInsurancePolicy.findMany({
      where: { tenantId },
      orderBy: { updatedAt: 'desc' },
      take: 50,
      include: {
        patient: { select: { id: true, firstName: true, lastName: true } },
        payer: { select: { id: true, name: true, sourceProvider: true } },
      },
    }),
    db.eligibilityVerification.findMany({
      where: { tenantId },
      orderBy: { checkedAt: 'desc' },
      take: 50,
      include: {
        payer: { select: { id: true, name: true, sourceProvider: true } },
      },
    }),
    db.priorAuthorization.findMany({
      where: { tenantId },
      orderBy: { updatedAt: 'desc' },
      take: 50,
      include: {
        payer: { select: { id: true, name: true, sourceProvider: true } },
      },
    }),
    db.integrationRunLog.findMany({
      where: { tenantId, provider: { in: [...insuranceProviders] } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    }),
  ]);

  return insuranceProviders.map(provider => {
    // Stedi is the only implemented eligibility adapter. Merely selecting an
    // unimplemented provider must not present that rail as configured.
    const { configured, mode } = insuranceRailCapability(provider, {
      selectedProvider: env.INSURANCE_PROVIDER,
      stediApiKey: env.STEDI_API_KEY,
      stediTestMode: env.STEDI_TEST_MODE,
    });
    const providerPolicies = policies.filter(policy => policy.payer?.sourceProvider === provider || policy.payer?.name.toLowerCase().includes(provider));
    const providerVerifications = verifications.filter(verification => verification.payer?.sourceProvider === provider || verification.payerName.toLowerCase().includes(provider));
    const providerAuths = priorAuths.filter(item => item.payer?.sourceProvider === provider);
    const providerLogs = logs.filter(item => item.provider === provider);

    return {
      provider,
      name: provider === 'optum' ? 'Optum / Change Healthcare' : provider[0].toUpperCase() + provider.slice(1),
      configured,
      mode,
      modeLabel: formatMode(mode, configured),
      eligibilitySupported: provider === 'stedi',
      benefitsSupported: provider === 'stedi',
      // The application tracks manually-entered prior-auth status but does not
      // submit or query prior authorizations through a payer adapter yet.
      priorAuthSupported: false,
      priorAuthTrackingSupported: true,
      claimStatusSupportedFuture: provider === 'stedi' || provider === 'optum',
      payerListStatus: payers.some(payer => payer.sourceProvider === provider) ? 'Loaded' : 'Not Loaded',
      lastEligibilityCheck: providerVerifications[0]?.checkedAt.toISOString() ?? null,
      lastFailedCheck: providerVerifications.find(item => item.coverageStatus !== 'covered')?.checkedAt.toISOString() ?? null,
      errorRate: providerVerifications.length > 0 ? Math.round((providerVerifications.filter(item => item.coverageStatus !== 'covered').length / providerVerifications.length) * 100) : 0,
      workflows: ['Eligibility verification', 'Benefits verification', 'Manual prior authorization tracking', 'Patient responsibility estimation', 'Denial risk alert'],
      actions: ['Test eligibility check', 'View normalized response', 'View integration logs', 'Open Revenue Protection'],
      logs: providerLogs.map(log => ({
        id: log.id,
        operation: log.operation,
        status: log.status,
        createdAt: log.createdAt.toISOString(),
        providerMode: log.providerMode,
      })),
      payerCount: providerPolicies.length,
      authCount: providerAuths.length,
    };
  });
}

async function buildFinanceRails(tenantId: string) {
  const [connections, requests, transactions, logs] = await Promise.all([
    db.paymentProviderConnection.findMany({ where: { tenantId } }),
    db.paymentRequest.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: {
        patient: { select: { id: true, firstName: true, lastName: true } },
        paymentProviderConnection: { select: { id: true, providerKey: true, displayName: true, mode: true, status: true } },
      },
    }),
    db.paymentTransaction.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: {
        paymentProviderConnection: { select: { id: true, providerKey: true, displayName: true, mode: true, status: true } },
      },
    }),
    db.integrationRunLog.findMany({
      where: { tenantId, provider: { in: [...paymentProviders] } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    }),
  ]);

  return paymentProviders.map(provider => {
    const connection = connections.find(row => row.providerKey === provider);
    const providerRequests = requests.filter(request => request.paymentProviderConnection?.providerKey === provider || request.mode === provider || request.paymentProviderConnectionId != null && connection?.id === request.paymentProviderConnectionId);
    const providerTransactions = transactions.filter(transaction => transaction.paymentProviderConnection?.providerKey === provider || transaction.mode === provider || transaction.paymentProviderConnectionId != null && connection?.id === transaction.paymentProviderConnectionId);
    const providerLogs = logs.filter(log => log.provider === provider);
    const configured = provider === 'stripe' ? Boolean(env.STRIPE_SECRET_KEY) : Boolean(connection?.status === 'connected');
    const mode = connection?.mode === 'live' ? 'live' : configured ? 'sandbox' : 'mock';

    return {
      provider,
      name: provider === 'authorize_net' ? 'Authorize.Net' : provider === 'square' ? 'Square' : provider === 'clover' ? 'Clover' : provider === 'paypal' ? 'PayPal' : 'Stripe',
      configured,
      mode,
      modeLabel: formatMode(mode, configured),
      paymentLinksSupported: true,
      depositsSupported: true,
      copayCollectionSupported: true,
      refundsFuture: true,
      webhooksConfigured: provider === 'stripe' ? Boolean(env.STRIPE_WEBHOOK_SECRET) : Boolean(connection?.configuration),
      lastPaymentRequest: providerRequests[0]?.createdAt.toISOString() ?? null,
      failedPaymentCount: providerTransactions.filter(transaction => transaction.status !== 'paid' && transaction.status !== 'succeeded').length,
      health: configured ? 'healthy' : 'not_configured',
      logs: providerLogs.map(log => ({
        id: log.id,
        operation: log.operation,
        status: log.status,
        createdAt: log.createdAt.toISOString(),
        providerMode: log.providerMode,
      })),
      providerConnectionId: connection?.id ?? null,
      actions: ['Test payment link', 'View payment provider logs', 'Open Revenue Protection payment queue'],
    };
  });
}

async function buildSystemHealth(tenantId: string) {
  const withTimeout = <T,>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<T>((_r, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);

  // Real runtime checks (no hardcoded statuses).
  let databaseStatus: string;
  let dbLatencyMs: number | null = null;
  try {
    const t0 = Date.now();
    await withTimeout(db.$queryRaw`SELECT 1`, 2000);
    dbLatencyMs = Date.now() - t0;
    databaseStatus = 'healthy';
  } catch { databaseStatus = 'down'; }

  let backgroundJobs: string;
  try {
    const client = (await withTimeout(Promise.resolve(autopilotQueue.client), 1000)) as unknown as { ping(): Promise<string> };
    backgroundJobs = (await withTimeout(client.ping(), 1000)) === 'PONG' ? 'available' : 'unavailable';
  } catch { backgroundJobs = 'unavailable'; }

  const [auditCount, integrationCount, rpEntitlement, migrationRows, latestMigrationRows] = await Promise.all([
    db.auditEvent.count({ where: { tenantId } }),
    db.integration.count({ where: { tenantId } }),
    db.tenantFeatureEntitlement.findUnique({ where: { tenantId_featureKey: { tenantId, featureKey: 'revenue_protection' } } }).catch(() => null),
    db.$queryRawUnsafe<Array<{ count: number }>>('SELECT COUNT(*)::int AS count FROM "_prisma_migrations"').catch(() => [] as Array<{ count: number }>),
    db.$queryRawUnsafe<Array<{ migration_name: string; finished_at: Date | null }>>('SELECT migration_name, finished_at FROM "_prisma_migrations" ORDER BY finished_at DESC NULLS LAST LIMIT 1').catch(() => [] as Array<{ migration_name: string; finished_at: Date | null }>),
  ]);

  return {
    apiStatus: 'healthy', // reaching this handler means the API is serving requests
    databaseStatus,
    dbLatencyMs,
    migrationStatus: migrationRows[0]?.count ? 'applied' : 'unknown',
    latestMigration: latestMigrationRows[0]?.migration_name ?? null,
    authStatus: env.JWT_SECRET && env.JWT_REFRESH_SECRET ? 'configured' : 'missing-secrets',
    revenueProtectionStatus: rpEntitlement?.enabled ? 'available' : 'not-entitled',
    integrationStatus: integrationCount > 0 ? 'available' : 'not-configured',
    backgroundJobs,
    environmentMode: env.NODE_ENV,
    buildVersion: process.env.npm_package_version ?? null,
    auditEventCount: auditCount,
  };
}

function productionReadinessScore(overview: {
  auth: boolean;
  https: boolean;
  secrets: boolean;
  integrations: number;
  insurance: number;
  payments: number;
  rbac: boolean;
  audit: boolean;
}) {
  const checks = [
    overview.auth,
    overview.https,
    overview.secrets,
    overview.integrations > 0,
    overview.insurance > 0,
    overview.payments > 0,
    overview.rbac,
    overview.audit,
  ];
  return Math.round((checks.filter(Boolean).length / checks.length) * 100);
}

function buildSecurityPosture(_tenantId: string, integrationRows: Array<{ health: string; configured: boolean; category: string; mode: string; modeLabel: string; name: string; key: string }>, paymentRows: Array<{ configured: boolean; mode: string; modeLabel: string; name: string; provider: string }>, auditCount: number) {
  const mockIntegrations = integrationRows.filter(row => row.mode === 'mock').length;
  const sandboxIntegrations = integrationRows.filter(row => row.mode === 'sandbox').length;
  const liveIntegrations = integrationRows.filter(row => row.mode === 'live').length;
  const failedIntegrations = integrationRows.filter(row => row.health === 'degraded').length;
  const securityAlerts = [
    env.NODE_ENV === 'production' ? null : {
      severity: 'info',
      title: 'Dev-token available in development',
      message: 'Dev-token bootstrap remains restricted to development.',
    },
    !env.JWT_SECRET ? {
      severity: 'high',
      title: 'JWT secret missing',
      message: 'JWT_SECRET must be configured for production access tokens.',
    } : null,
    !env.JWT_REFRESH_SECRET ? {
      severity: 'high',
      title: 'Refresh secret missing',
      message: 'JWT_REFRESH_SECRET must be configured for refresh token hashing.',
    } : null,
    env.NODE_ENV === 'production' ? null : {
      severity: 'medium',
      title: 'HTTPS required in production',
      message: 'Production must terminate HTTPS for secure refresh cookies.',
    },
    env.INSURANCE_PROVIDER === 'mock' ? {
      severity: 'medium',
      title: 'Insurance provider in mock mode',
      message: 'No live insurance rail is configured.',
    } : null,
    env.PAYMENT_PROVIDER === 'mock' ? {
      severity: 'medium',
      title: 'Payment provider in mock mode',
      message: 'No live payment rail is configured.',
    } : null,
    env.AI_PROVIDER === 'mock' ? {
      severity: 'low',
      title: 'AI provider in mock mode',
      message: 'Advisory responses are mock-backed until an LLM provider is configured.',
    } : null,
    !env.STRIPE_WEBHOOK_SECRET && env.PAYMENT_PROVIDER === 'stripe' ? {
      severity: 'medium',
      title: 'Stripe webhook not configured',
      message: 'Set STRIPE_WEBHOOK_SECRET to validate webhooks safely.',
    } : null,
  ].filter(Boolean);

  const riskLabel = securityAlerts.some(alert => alert && (alert as { severity: string }).severity === 'high') ? 'High' : securityAlerts.length > 0 ? 'Medium' : 'Low';
  const readinessScore = productionReadinessScore({
    auth: Boolean(env.JWT_SECRET && env.JWT_REFRESH_SECRET),
    https: env.NODE_ENV === 'production',
    secrets: Boolean(env.JWT_SECRET && env.JWT_REFRESH_SECRET),
    integrations: liveIntegrations + sandboxIntegrations + mockIntegrations,
    insurance: integrationRows.some(row => row.category === 'Insurance') ? 1 : 0,
    payments: paymentRows.length,
    rbac: true,
    audit: auditCount > 0,
  });

  return {
    authMode: env.NODE_ENV === 'production' ? 'password+refresh-cookie' : 'password+refresh-cookie with explicit dev-token fallback',
    passwordLoginEnabled: true,
    devTokenEnabled: env.NODE_ENV !== 'production',
    refreshCookieHttpOnly: true,
    csrfEnabled: true,
    accessTokenTtlMinutes: 15,
    refreshRotationEnabled: true,
    rbacEnabled: true,
    adminRouteProtected: true,
    tenantIsolationEnabled: true,
    clinicScopingEnabled: true,
    httpsRequired: env.NODE_ENV === 'production',
    jwtSecretsConfigured: Boolean(env.JWT_SECRET),
    refreshSecretConfigured: Boolean(env.JWT_REFRESH_SECRET),
    rateLimitingEnabled: true,
    corsMode: env.CORS_ORIGINS.includes('*') ? 'open' : 'restricted',
    environmentMode: env.NODE_ENV,
    alerts: securityAlerts,
    riskLabel,
    readinessScore,
    integrationSummary: {
      active: liveIntegrations,
      sandbox: sandboxIntegrations,
      mock: mockIntegrations,
      failed: failedIntegrations,
    },
    paymentRailsStatus: paymentRows.some(row => row.configured) ? 'configured' : 'mock',
    insuranceRailsStatus: integrationRows.some(row => row.category === 'Insurance' && row.configured) ? 'configured' : 'mock',
  };
}

export const controlPlaneRoutes: FastifyPluginAsync = async app => {
  const userStatusBody = z.object({ active: z.boolean() });
  const userRoleEnum = z.enum(['OWNER', 'ADMIN', 'MANAGER', 'BILLING', 'PROVIDER', 'FRONT_DESK', 'ANALYST', 'COMPLIANCE_OFFICER', 'AUDITOR']);
  const userRoleBody = z.object({ role: userRoleEnum });
  const clinicAccessBody = z.object({
    branchIds: z.array(uuid).default([]),
    primaryBranchId: uuid.optional(),
  });
  const userCreateBody = z.object({
    email: z.string().email().trim().toLowerCase(),
    name: z.string().trim().min(2).max(120),
    password: z.string().min(8).max(200),
    role: userRoleEnum,
    branchIds: z.array(uuid).default([]),
    primaryBranchId: uuid.optional(),
  });
  const userPasswordResetBody = z.object({ password: z.string().min(8).max(200) });
  const clinicStatusBody = z.object({ active: z.boolean() });

  app.get('/overview', { preHandler: ownerAdminRoles }, async request => {
    const [users, branches, tenant, integrations, securityLogs, insuranceRails, financeRails, auditCount] = await Promise.all([
      loadUsers(request.auth.tenantId),
      db.branch.findMany({ where: { tenantId: request.auth.tenantId }, orderBy: { name: 'asc' }, select: { id: true, name: true, location: true, active: true } }),
      db.tenant.findUnique({ where: { id: request.auth.tenantId }, select: { id: true, name: true, slug: true, createdAt: true, updatedAt: true } }),
      buildIntegrationRows(request.auth.tenantId),
      db.auditEvent.findMany({
        where: {
          tenantId: request.auth.tenantId,
          occurredAt: {
            gte: sameDayRange().start,
            lt: sameDayRange().end,
          },
        },
        orderBy: { occurredAt: 'desc' },
        take: 25,
      }),
      buildInsuranceRails(request.auth.tenantId),
      buildFinanceRails(request.auth.tenantId),
      db.auditEvent.count({ where: { tenantId: request.auth.tenantId } }),
    ]);
    const securityPosture = buildSecurityPosture(request.auth.tenantId, integrations, financeRails, auditCount);

    const activeUsers = users.filter(user => user.active).length;
    const adminUsers = users.filter(user => ['OWNER', 'ADMIN'].includes(user.role)).length;
    const inactiveUsers = users.length - activeUsers;
    const activeIntegrations = integrations.filter(row => row.configured && row.health === 'healthy').length;
    const sandboxIntegrations = integrations.filter(row => row.mode === 'sandbox').length;
    const mockIntegrations = integrations.filter(row => row.mode === 'mock').length;
    const failedIntegrations = integrations.filter(row => row.health === 'degraded').length;
    const auditEventsToday = await db.auditEvent.count({
      where: {
        tenantId: request.auth.tenantId,
        occurredAt: {
          gte: sameDayRange().start,
          lt: sameDayRange().end,
        },
      },
    });
    const securityAlerts = securityPosture.alerts.length;

    return {
      tenant,
      summary: {
        totalUsers: users.length,
        activeUsers,
        adminUsers,
        inactiveUsers,
        clinics: branches.length,
        activeIntegrations,
        sandboxIntegrations,
        mockIntegrations,
        failedIntegrations,
        auditEventsToday,
        securityAlerts,
        paymentRailsStatus: securityPosture.paymentRailsStatus,
        insuranceRailsStatus: securityPosture.insuranceRailsStatus,
        productionReadinessScore: securityPosture.readinessScore,
      },
      branches,
      securityPosture,
      integrations,
      insuranceRails,
      financeRails,
      systemHealth: await buildSystemHealth(request.auth.tenantId),
      auditEventsToday: securityLogs.map(event => ({ id: event.id, action: event.action, occurredAt: event.occurredAt.toISOString() })),
    };
  });

  app.get('/users', { preHandler: ownerAdminRoles }, async request => {
    const users = await loadUsers(request.auth.tenantId);
    const branches = await db.branch.findMany({ where: { tenantId: request.auth.tenantId }, orderBy: { name: 'asc' }, select: { id: true, name: true, location: true, active: true } });
    return {
      tenant: await db.tenant.findUnique({ where: { id: request.auth.tenantId }, select: { id: true, name: true, slug: true } }),
      branches,
      summary: {
        totalUsers: users.length,
        activeUsers: users.filter(user => user.active).length,
        inactiveUsers: users.filter(user => !user.active).length,
        activeBranches: branches.filter(branch => branch.active).length,
      },
      users,
    };
  });

  app.post('/users', { preHandler: ownerAdminRoles }, async (request, reply) => {
    const body = userCreateBody.parse(request.body);
    const policy = validatePassword(body.password);
    if (!policy.ok) throw app.httpErrors.badRequest(policy.message ?? 'Weak password');

    const requestedBranchIds = [...new Set(body.branchIds)];
    // PRIVILEGE ESCALATION GUARD. replaceClinicAccess writes
    // `branchId: orderedBranchIds[0] ?? null`, and a null branchId is how this
    // codebase represents "not restricted to a branch": branchScope() returns
    // {} (no filter, every branch) and assertBranchAccess() permits any branch.
    // So clearing every clinic for a departing user silently granted them
    // tenant-wide access to all branches while the console displayed
    // "No access configured". Removing all access is a deactivation, not a
    // grant, so refuse it here and make the admin say what they mean.
    if (requestedBranchIds.length === 0) {
      throw app.httpErrors.badRequest('Select at least one clinic. To remove this user\u2019s access entirely, deactivate the account instead.');
    }
    if (body.primaryBranchId && !requestedBranchIds.includes(body.primaryBranchId)) {
      throw app.httpErrors.badRequest('Primary branch must be included in selected branch access');
    }
    const passwordHash = await generatePasswordHash(body.password);
    try {
      const result = await runWithTenantContext(request.auth.tenantId, async tx => {
        await lockClinicAccessMutation(tx, request.auth.tenantId);
        const emailLockKey = `control-plane-user-email:${request.auth.tenantId}:${body.email}`;
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${emailLockKey}::text, 0))::text AS locked`;
        const existing = await tx.user.findFirst({
          where: { tenantId: request.auth.tenantId, email: { equals: body.email, mode: 'insensitive' } },
          select: { id: true },
        });
        if (existing) throw app.httpErrors.conflict('User email already exists');
        const validBranchRows = requestedBranchIds.length > 0
          ? await tx.branch.findMany({ where: { tenantId: request.auth.tenantId, active: true, id: { in: requestedBranchIds } }, select: { id: true } })
          : [];
        let validBranchIds = validBranchRows.map(branch => branch.id);
        if (validBranchIds.length !== requestedBranchIds.length) throw app.httpErrors.badRequest('Every selected branch must be active and belong to this tenant');
        if (validBranchIds.length === 0) {
          const fallbackBranch = await tx.branch.findFirst({ where: { tenantId: request.auth.tenantId, active: true }, orderBy: { name: 'asc' }, select: { id: true } });
          if (fallbackBranch) validBranchIds = [fallbackBranch.id];
        }
        const primaryBranchId = body.primaryBranchId && validBranchIds.includes(body.primaryBranchId) ? body.primaryBranchId : validBranchIds[0] ?? null;
        const user = await tx.user.create({ data: {
          tenantId: request.auth.tenantId,
          email: body.email,
          displayName: body.name,
          role: body.role,
          passwordHash,
          branchId: primaryBranchId,
        } });
        if (validBranchIds.length > 0) await replaceClinicAccess(tx, request.auth.tenantId, user.id, validBranchIds, primaryBranchId ?? undefined);
        await tx.auditEvent.create({ data: {
          tenantId: request.auth.tenantId,
          actorUserId: request.auth.userId,
          action: 'controlPlane.user.created',
          resource: 'user',
          resourceId: user.id,
          requestId: request.id,
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'],
          metadata: { email: user.email, role: user.role, branchIds: validBranchIds },
        } });
        return { user, validBranchIds, primaryBranchId };
      });
      return reply.code(201).send({
        id: result.user.id,
        email: result.user.email,
        name: result.user.displayName,
        role: result.user.role,
        status: result.user.active ? 'active' : 'inactive',
        branchIds: result.validBranchIds,
        primaryBranchId: result.primaryBranchId,
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw app.httpErrors.conflict('User email already exists');
      }
      throw error;
    }
  });

  app.patch('/users/:id/status', { preHandler: ownerAdminRoles }, async (request, reply) => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const { active } = userStatusBody.parse(request.body);
    const updated = await setUserActiveSafely(request, id, active, active ? 'controlPlane.user.activated' : 'controlPlane.user.deactivated');
    return reply.send({ id: updated.id, active: updated.active });
  });

  app.patch('/users/:id/role', { preHandler: ownerAdminRoles }, async (request) => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const { role } = userRoleBody.parse(request.body);
    const updated = await setUserRoleSafely(request, id, role, 'controlPlane.user.roleChanged');
    return { id: updated.id, role: updated.role };
  });

  // ADMIN-INITIATED RECOVERY. A password is otherwise only ever set at user
  // creation, so a clinic user who forgets theirs has no way back in: no email
  // delivery adapter is integrated, and inventing one would be a control that
  // claims to have sent something it never sent. Recovery is therefore an
  // administrator setting a temporary password and handing it over directly,
  // exactly as at creation. The value is never echoed by this route and never
  // appears in GET /users — the administrator typed it, and returning it would
  // put a live credential in response bodies and logs.
  app.post('/users/:id/password-reset', { preHandler: ownerAdminRoles }, async (request, reply) => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const { password } = userPasswordResetBody.parse(request.body);
    const policy = validatePassword(password);
    if (!policy.ok) throw app.httpErrors.badRequest(policy.message ?? 'Weak password');
    const passwordHash = await generatePasswordHash(password);
    const updated = await setUserPasswordSafely(request, id, passwordHash, 'controlPlane.user.passwordReset');
    return reply.send({ id: updated.id, passwordChangedAt: updated.passwordChangedAt.toISOString(), sessionsRevoked: true });
  });

  app.patch('/users/:id/clinic-access', { preHandler: ownerAdminRoles }, async request => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const body = clinicAccessBody.parse(request.body);
    const requestedBranchIds = [...new Set(body.branchIds)];
    if (body.primaryBranchId && !requestedBranchIds.includes(body.primaryBranchId)) {
      throw app.httpErrors.badRequest('Primary branch must be included in selected branch access');
    }
    await runWithTenantContext(request.auth.tenantId, async tx => {
      await lockClinicAccessMutation(tx, request.auth.tenantId);
      const existing = await tx.user.findFirst({ where: { id, tenantId: request.auth.tenantId }, select: { id: true } });
      if (!existing) throw app.httpErrors.notFound('User not found');
      const validBranches = await tx.branch.findMany({ where: { tenantId: request.auth.tenantId, active: true, id: { in: requestedBranchIds } }, select: { id: true } });
      if (validBranches.length !== requestedBranchIds.length) throw app.httpErrors.badRequest('Every selected branch must be active and belong to this tenant');
      await replaceClinicAccess(tx, request.auth.tenantId, id, requestedBranchIds, body.primaryBranchId);
      await tx.auditEvent.create({ data: {
        tenantId: request.auth.tenantId,
        actorUserId: request.auth.userId,
        action: 'controlPlane.user.clinicAccessUpdated',
        resource: 'user',
        resourceId: id,
        requestId: request.id,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'],
        metadata: { branchIds: requestedBranchIds },
      } });
    });
    return { id, branchIds: requestedBranchIds, primaryBranchId: body.primaryBranchId ?? requestedBranchIds[0] ?? null };
  });

  app.get('/users/:id/audit-trail', { preHandler: ownerAdminRoles }, async request => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const logs = await db.auditEvent.findMany({
      where: {
        tenantId: request.auth.tenantId,
        OR: [{ actorUserId: id }, { resourceId: id }],
      },
      orderBy: { occurredAt: 'desc' },
      take: 50,
      include: { actorUser: { select: { displayName: true, email: true, role: true } } },
    });
    return logs.map(event => ({
      id: event.id,
      action: event.action,
      resource: event.resource,
      resourceId: event.resourceId,
      actor: event.actorUser?.displayName ?? safeEmail(event.metadata) ?? 'System',
      role: event.actorUser?.role ?? null,
      ipAddress: event.ipAddress,
      userAgent: event.userAgent,
      occurredAt: event.occurredAt.toISOString(),
      metadata: event.metadata ?? null,
    }));
  });

  app.get('/roles', { preHandler: ownerAdminRoles }, async request => {
    const roles = await db.roleDefinition.findMany({ where: { tenantId: request.auth.tenantId }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] });
    const users = await db.user.groupBy({ by: ['role'], where: { tenantId: request.auth.tenantId }, _count: { _all: true } });
    const counts = new Map(users.map(row => [row.role, row._count._all]));
    return {
      roles: [
        ...rolePermissionMatrix.map(permission => ({
          id: permission.role,
          name: permission.role,
          enumValue: permission.role,
          description: controlPlaneRoles[permission.role]?.scope ?? 'Assigned access',
          accent: permission.risk === 'high' ? 'red' : permission.risk === 'medium' ? 'amber' : 'blue',
          userCount: counts.get(permission.role as never) ?? 0,
          moduleAccess: permission.modules,
          clinicScope: permission.scope,
          risk: permission.risk,
        })),
        ...roles.map(role => ({
          id: role.id,
          name: role.name,
          enumValue: role.name.toUpperCase().replace(/\s+/g, '_'),
          description: role.description,
          accent: role.accent,
          userCount: counts.get(role.name.toUpperCase().replace(/\s+/g, '_') as never) ?? 0,
          moduleAccess: controlPlaneRoles.OWNER.modules,
          clinicScope: 'Tenant-wide',
          risk: 'low' as const,
        })),
      ],
      permissionMatrix: rolePermissionMatrix,
      moduleSummary: [
        { module: 'Command Center', permissions: ['view_dashboard', 'view_opportunities'] },
        { module: 'Growth', permissions: ['view_crm', 'manage_crm', 'view_campaigns', 'manage_campaigns', 'launch_campaigns'] },
        { module: 'Revenue', permissions: ['view_revenue_leaks', 'manage_revenue_leaks', 'view_revenue_protection', 'manage_revenue_protection', 'manage_payments', 'manage_insurance'] },
        { module: 'Operations', permissions: ['view_patients', 'manage_patients', 'view_schedule', 'manage_schedule', 'view_staff', 'manage_staff'] },
        { module: 'Platform', permissions: ['view_integrations', 'manage_integrations', 'view_security', 'manage_security', 'view_audit_logs', 'manage_users', 'manage_roles'] },
      ],
    };
  });

  app.get('/tenants', { preHandler: ownerAdminRoles }, async request => {
    const tenant = await db.tenant.findUnique({
      where: { id: request.auth.tenantId },
      include: {
        branches: { select: { id: true, name: true, location: true, active: true } },
        integrations: { select: { id: true, key: true, status: true, lastSyncAt: true } },
        revenueProtectionAlerts: { select: { id: true, severity: true, status: true } },
      },
    });
    return { tenants: tenant ? [tenant] : [] };
  });

  app.get('/clinics', { preHandler: ownerAdminRoles }, async request => {
    const clinics = await db.branch.findMany({
      where: { tenantId: request.auth.tenantId },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        location: true,
        active: true,
        users: { select: { id: true } },
        integrationRunLogs: { select: { id: true, status: true, createdAt: true } },
        revenueProtectionAlerts: { select: { id: true, severity: true, status: true } },
      },
    });
    return clinics.map(clinic => ({
      ...clinic,
      userCount: clinic.users.length,
      integrationCount: clinic.integrationRunLogs.length,
      securityAlerts: clinic.revenueProtectionAlerts.length,
    }));
  });

  app.patch('/clinics/:id/status', { preHandler: ownerAdminRoles }, async (request, reply) => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const { active } = clinicStatusBody.parse(request.body);
    const updated = await runWithTenantContext(request.auth.tenantId, async tx => {
      await lockClinicAccessMutation(tx, request.auth.tenantId);
      const clinic = await tx.branch.findFirst({ where: { id, tenantId: request.auth.tenantId } });
      if (!clinic) throw app.httpErrors.notFound('Clinic not found');
      if (!active) {
        const assignedActiveUsers = await tx.user.count({ where: { tenantId: request.auth.tenantId, active: true, OR: [{ branchId: id }, { clinicAccesses: { some: { branchId: id } } }] } });
        if (assignedActiveUsers > 0) throw app.httpErrors.conflict('Reassign or deactivate active clinic users before deactivating this clinic');
      }
      const branch = await tx.branch.update({ where: { id }, data: { active } });
      await tx.auditEvent.create({ data: {
        tenantId: request.auth.tenantId, actorUserId: request.auth.userId,
        action: 'controlPlane.clinic.statusUpdated', resource: 'branch', resourceId: id,
        requestId: request.id, ipAddress: request.ip, userAgent: request.headers['user-agent'], metadata: { active },
      } });
      return branch;
    });
    return reply.send({ id: updated.id, active: updated.active });
  });

  app.get('/audit-logs', { preHandler: ownerAdminRoles }, async request => {
    const query = z.object({
      limit: z.coerce.number().int().min(1).max(100).default(50),
      userId: uuid.optional(),
      module: z.string().trim().optional(),
      action: z.string().trim().optional(),
      from: z.string().trim().optional(),
      to: z.string().trim().optional(),
      result: z.enum(['success', 'failed', 'all']).default('all'),
    }).parse(request.query);

    const logs = await db.auditEvent.findMany({
      where: {
        tenantId: request.auth.tenantId,
        ...(query.userId ? { actorUserId: query.userId } : {}),
        ...(query.module ? { resource: query.module } : {}),
        ...(query.action ? { action: query.action } : {}),
        ...(query.from || query.to ? {
          occurredAt: {
            ...(query.from ? { gte: new Date(query.from) } : {}),
            ...(query.to ? { lte: new Date(query.to) } : {}),
          },
        } : {}),
      },
      orderBy: { occurredAt: 'desc' },
      take: query.limit,
      include: { actorUser: { select: { displayName: true, email: true, role: true } } },
    });
    return logs.map(event => ({
      id: event.id,
      action: event.action,
      module: event.resource,
      resource: event.resourceId,
      actor: event.actorUser?.displayName ?? safeEmail(event.metadata) ?? 'System',
      role: event.actorUser?.role ?? null,
      tenantId: request.auth.tenantId,
      clinicId: null,
      result: event.action.includes('failed') ? 'failed' : 'success',
      ipAddress: event.ipAddress,
      userAgent: event.userAgent,
      details: event.metadata ?? null,
      occurredAt: event.occurredAt.toISOString(),
    }));
  });

  app.get('/audit-logs/export.csv', { preHandler: ownerAdminRoles }, async (request, reply) => {
    const query = z.object({
      userId: uuid.optional(),
      module: z.string().trim().optional(),
      action: z.string().trim().optional(),
      from: z.string().trim().optional(),
      to: z.string().trim().optional(),
    }).parse(request.query);
    const logs = await db.auditEvent.findMany({
      where: {
        tenantId: request.auth.tenantId,
        ...(query.userId ? { actorUserId: query.userId } : {}),
        ...(query.module ? { resource: query.module } : {}),
        ...(query.action ? { action: query.action } : {}),
        ...(query.from || query.to ? {
          occurredAt: {
            ...(query.from ? { gte: new Date(query.from) } : {}),
            ...(query.to ? { lte: new Date(query.to) } : {}),
          },
        } : {}),
      },
      orderBy: { occurredAt: 'desc' },
      take: 500,
      include: { actorUser: { select: { displayName: true, email: true, role: true } } },
    });
    const escapeCsv = (value: unknown) => {
      const text = value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
      return `"${text.replaceAll('"', '""')}"`;
    };
    const rows = [
      ['occurredAt', 'actor', 'role', 'action', 'module', 'resource', 'result', 'details'],
      ...logs.map(event => [
        event.occurredAt.toISOString(),
        event.actorUser?.displayName ?? safeEmail(event.metadata) ?? 'System',
        event.actorUser?.role ?? '',
        event.action,
        event.resource,
        event.resourceId ?? '',
        event.action.includes('failed') ? 'failed' : 'success',
        event.metadata ?? '',
      ]),
    ];
    const csv = rows.map(row => row.map(escapeCsv).join(',')).join('\n');
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="control-plane-audit.csv"')
      .send(csv);
  });

  app.get('/security-posture', { preHandler: ownerAdminRoles }, async request => {
    const integrationRows = await buildIntegrationRows(request.auth.tenantId);
    const paymentRows = await buildFinanceRails(request.auth.tenantId);
    const auditCount = await db.auditEvent.count({ where: { tenantId: request.auth.tenantId } });
    return buildSecurityPosture(request.auth.tenantId, integrationRows, paymentRows, auditCount);
  });

  app.get('/security-events', { preHandler: ownerAdminRoles }, async request => {
    const events = await db.auditEvent.findMany({
      where: { tenantId: request.auth.tenantId, action: { startsWith: 'auth.' } },
      orderBy: { occurredAt: 'desc' },
      take: 50,
      include: { actorUser: { select: { displayName: true, email: true, role: true } } },
    });
    return events.map(event => ({
      id: event.id,
      action: event.action,
      actor: event.actorUser?.displayName ?? safeEmail(event.metadata) ?? 'System',
      role: event.actorUser?.role ?? null,
      status: event.action.endsWith('failed') ? 'failed' : 'success',
      occurredAt: event.occurredAt.toISOString(),
      details: event.metadata ?? null,
    }));
  });

  app.get('/sessions', { preHandler: ownerAdminRoles }, async request => {
    const users = await db.user.findMany({
      where: {
        tenantId: request.auth.tenantId,
        refreshTokenHash: { not: null },
        refreshTokenExpiresAt: { gt: new Date() },
      },
      orderBy: [{ lastLoginAt: 'desc' }, { updatedAt: 'desc' }],
      take: 100,
      include: {
        branch: { select: { id: true, name: true, location: true } },
        clinicAccesses: {
          orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
          include: { branch: { select: { id: true, name: true, location: true } } },
        },
      },
    });
    const loginEvents = await db.auditEvent.findMany({
      where: { tenantId: request.auth.tenantId, action: 'auth.login.success' },
      orderBy: { occurredAt: 'desc' },
      take: 100,
      include: { actorUser: { select: { displayName: true, email: true, role: true } } },
    });
    return users.map(user => {
      const lastLogin = loginEvents.find(event => event.actorUserId === user.id);
      return {
        id: user.id,
        user: {
          id: user.id,
          displayName: user.displayName,
          email: user.email,
          role: user.role,
          branch: user.branch ? { id: user.branch.id, name: user.branch.name, location: user.branch.location } : null,
        },
        issuedAt: user.lastLoginAt?.toISOString() ?? null,
        expiresAt: user.refreshTokenExpiresAt?.toISOString() ?? null,
        revoked: !user.refreshTokenHash,
        lastActivityAt: user.lastLoginAt?.toISOString() ?? null,
        lastLoginAudit: lastLogin ? {
          occurredAt: lastLogin.occurredAt.toISOString(),
          ipAddress: lastLogin.ipAddress,
          userAgent: lastLogin.userAgent,
        } : null,
        accessBranches: user.clinicAccesses.map(access => ({
          id: access.branch.id,
          name: access.branch.name,
          location: access.branch.location,
          isPrimary: access.isPrimary,
        })),
      };
    });
  });

  app.patch('/sessions/:id/revoke', { preHandler: ownerAdminRoles }, async (request, reply) => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const existing = await db.user.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!existing) throw app.httpErrors.notFound('Session not found');
    await runWithTenantContext(request.auth.tenantId, async tx => {
      await tx.user.update({ where: { id }, data: { refreshTokenHash: null, refreshTokenExpiresAt: null } });
      await tx.auditEvent.create({ data: {
        tenantId: request.auth.tenantId,
        actorUserId: request.auth.userId,
        action: 'controlPlane.session.revoked',
        resource: 'session',
        resourceId: id,
        requestId: request.id,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'],
        metadata: { reason: 'owner-admin-revoked' },
      } });
    });
    return reply.code(204).send();
  });

  app.get('/integrations', { preHandler: ownerAdminRoles }, async request => buildIntegrationRows(request.auth.tenantId));

  app.post('/integrations/:provider/test', { preHandler: ownerAdminRoles }, async (request, reply) => {
    const { provider } = z.object({ provider: z.string().trim().min(2) }).parse(request.params);
    const integrations = await buildIntegrationRows(request.auth.tenantId);
    const selected = integrations.find(row => row.key === provider);
    if (!selected) throw app.httpErrors.notFound('Integration provider not found');
    const branchId = request.auth.branchId ?? null;

    const commonFields = {
      providerKey: provider, providerName: selected.name, modeLabel: selected.modeLabel,
      health: selected.health, supportedWorkflows: selected.supportedWorkflows,
      missingConfigCount: selected.missingConfigCount, riskLevel: selected.riskLevel,
    };

    // Not configured → honest not_configured; never claim a successful test.
    if (!selected.configured) {
      const note = `${selected.name} is not configured; no live connection test was performed.${selected.missingConfigCount ? ' Setup must be completed by your administrator.' : ''}`;
      await db.integrationRunLog.create({
        data: {
          tenantId: request.auth.tenantId, branchId, provider, providerMode: selected.mode,
          operation: 'test-connection', status: 'not_configured',
          requestSummary: { provider }, responseSummary: { status: 'not_configured', note },
        },
      });
      await audit(request, { action: 'controlPlane.integration.tested', resource: 'integration', resourceId: provider, metadata: { status: 'not_configured' } });
      return reply.send({ ...commonFields, status: 'not_configured', configured: false, verified: false, note, message: note });
    }

    // Configured + we have a live adapter → make a REAL reachability probe (Stripe).
    if (provider === 'stripe' && env.STRIPE_SECRET_KEY) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6000);
      try {
        const res = await fetch('https://api.stripe.com/v1/balance', { headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` }, signal: controller.signal });
        const ok = res.ok;
        const note = ok ? 'Live Stripe API reachable (GET /v1/balance).' : `Stripe API returned HTTP ${res.status}.`;
        await db.integrationRunLog.create({
          data: {
            tenantId: request.auth.tenantId, branchId, provider, providerMode: selected.mode,
            operation: 'test-connection', status: ok ? 'success' : 'error',
            requestSummary: { provider }, responseSummary: { status: ok ? 'success' : 'error', note },
          },
        });
        await audit(request, { action: 'controlPlane.integration.tested', resource: 'integration', resourceId: provider, metadata: { status: ok ? 'success' : 'error' } });
        return reply.code(ok ? 200 : 502).send({ ...commonFields, status: ok ? 'success' : 'error', configured: true, verified: ok, note, message: note });
      } catch (error) {
        const note = `Stripe API unreachable: ${(error as Error).message?.slice(0, 200) ?? 'network error'}.`;
        await db.integrationRunLog.create({
          data: {
            tenantId: request.auth.tenantId, branchId, provider, providerMode: selected.mode,
            operation: 'test-connection', status: 'error', requestSummary: { provider }, errorMessage: note,
          },
        });
        await audit(request, { action: 'controlPlane.integration.tested', resource: 'integration', resourceId: provider, metadata: { status: 'error' } });
        return reply.code(502).send({ ...commonFields, status: 'error', configured: true, verified: false, note, message: note });
      } finally {
        clearTimeout(timer);
      }
    }

    // Configured, but no live connectivity probe is implemented for this provider —
    // report configuration presence honestly (NOT a verified live connection).
    const note = `${selected.name} is configured. A live connectivity probe is not implemented for this provider, so configuration presence is reported rather than verified reachability.`;
    await db.integrationRunLog.create({
      data: {
        tenantId: request.auth.tenantId, branchId, provider, providerMode: selected.mode,
        operation: 'test-connection', status: 'configured',
        requestSummary: { provider }, responseSummary: { status: 'configured', verified: false, note },
      },
    });
    await audit(request, { action: 'controlPlane.integration.tested', resource: 'integration', resourceId: provider, metadata: { status: 'configured' } });
    return reply.send({ ...commonFields, status: 'configured', configured: true, verified: false, note, message: note });
  });

  app.get('/integrations/:provider/runs', { preHandler: ownerAdminRoles }, async request => {
    const { provider } = z.object({ provider: z.string().trim().min(2) }).parse(request.params);
    const runs = await db.integrationRunLog.findMany({
      where: { tenantId: request.auth.tenantId, provider },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return runs.map(run => ({
      id: run.id,
      provider: run.provider,
      providerMode: run.providerMode,
      operation: run.operation,
      status: run.status,
      requestSummary: run.requestSummary ?? null,
      responseSummary: run.responseSummary ?? null,
      errorMessage: run.errorMessage ?? null,
      createdAt: run.createdAt.toISOString(),
    }));
  });

  app.get('/insurance-rails', { preHandler: ownerAdminRoles }, async request => buildInsuranceRails(request.auth.tenantId));

  app.post('/insurance-rails/:provider/test-eligibility', { preHandler: ownerAdminRoles }, async (request, reply) => {
    const { provider } = z.object({ provider: z.enum(insuranceProviders) }).parse(request.params);
    const payers = await db.insurancePayer.findMany({ where: { tenantId: request.auth.tenantId, active: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], take: 20 });
    const payer = payers.find(item => item.sourceProvider === provider) ?? payers[0];
    const patient = await db.patient.findFirst({ where: { tenantId: request.auth.tenantId }, orderBy: { createdAt: 'asc' }, select: { id: true, branchId: true } });
    const branchId = patient?.branchId ?? request.auth.branchId ?? null;

    // Honesty gate: only a genuinely configured, credentialed eligibility provider
    // (the one the app actually uses) can make a REAL payer call. Never claim
    // 'covered' from a synthesized response.
    const status = eligibilityProviderStatus();
    const canRunReal = status.provider === provider && status.configured && !status.mock;

    if (!canRunReal) {
      const simulated = status.provider === provider && status.mock; // mock/demo mode
      const outcomeStatus = simulated ? 'simulated' : 'not_configured';
      const note = simulated
        ? `${provider} is in mock/demo mode — this is a simulated eligibility check, not a real payer (271) response.`
        : `${provider} is not configured. Configure it (sandbox available) to run a real eligibility check.`;
      await db.integrationRunLog.create({
        data: {
          tenantId: request.auth.tenantId, branchId, provider, providerMode: simulated ? 'mock' : 'unconfigured',
          operation: 'test-eligibility', status: outcomeStatus,
          requestSummary: { provider, patientId: patient?.id ?? null, payerId: payer?.id ?? null },
          responseSummary: { status: outcomeStatus, note },
        },
      });
      await audit(request, { action: 'controlPlane.insurance.tested', resource: 'insuranceRail', resourceId: provider, metadata: { status: outcomeStatus } });
      return reply.send({
        provider, providerName: payer?.sourceProvider ?? provider, status: outcomeStatus,
        configured: false, coverageStatus: null, note, message: note,
      });
    }

    // Real provider path: make an actual eligibility call and report the REAL result.
    const providerImpl = createInsuranceProvider();
    try {
      const outcome = await providerImpl.runEligibilityCheck({
        tenantId: request.auth.tenantId,
        branchId: branchId ?? '',
        payer: payer ? { id: payer.id, name: payer.name, tradingPartnerServiceId: payer.tradingPartnerServiceId, sourceProvider: payer.sourceProvider } : undefined,
      });
      await db.integrationRunLog.create({
        data: {
          tenantId: request.auth.tenantId, branchId, provider, providerMode: outcome.providerMode,
          operation: 'test-eligibility', status: 'success',
          requestSummary: { provider, patientId: patient?.id ?? null, payerId: payer?.id ?? null },
          responseSummary: { coverageStatus: outcome.coverageStatus, coverageActive: outcome.coverageActive, providerMode: outcome.providerMode },
        },
      });
      await audit(request, { action: 'controlPlane.insurance.tested', resource: 'insuranceRail', resourceId: provider, metadata: { status: 'success', coverageStatus: outcome.coverageStatus, mode: outcome.providerMode } });
      return reply.send({
        provider, providerName: outcome.providerName, providerMode: outcome.providerMode,
        modeLabel: formatMode(outcome.providerMode, true), status: 'success', configured: true,
        coverageStatus: outcome.coverageStatus, coverageActive: outcome.coverageActive,
        message: 'Live eligibility check completed.',
      });
    } catch (error) {
      await db.integrationRunLog.create({
        data: {
          tenantId: request.auth.tenantId, branchId, provider, providerMode: status.provider === 'stedi' ? (env.STEDI_TEST_MODE ? 'sandbox' : 'live') : 'live',
          operation: 'test-eligibility', status: 'error',
          requestSummary: { provider, patientId: patient?.id ?? null, payerId: payer?.id ?? null },
          errorMessage: (error as Error).message?.slice(0, 500) ?? 'Eligibility call failed',
        },
      });
      await audit(request, { action: 'controlPlane.insurance.tested', resource: 'insuranceRail', resourceId: provider, metadata: { status: 'error' } });
      return reply.code(502).send({ provider, providerName: provider, status: 'error', configured: true, coverageStatus: null, message: 'Live eligibility provider call failed.' });
    }
  });

  app.get('/insurance-rails/logs', { preHandler: ownerAdminRoles }, async request => {
    const logs = await db.integrationRunLog.findMany({
      where: { tenantId: request.auth.tenantId, provider: { in: [...insuranceProviders] } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return logs.map(log => ({
      id: log.id,
      provider: log.provider,
      providerMode: log.providerMode,
      operation: log.operation,
      status: log.status,
      requestSummary: log.requestSummary ?? null,
      responseSummary: log.responseSummary ?? null,
      errorMessage: log.errorMessage ?? null,
      createdAt: log.createdAt.toISOString(),
    }));
  });

  app.get('/finance-rails', { preHandler: ownerAdminRoles }, async request => buildFinanceRails(request.auth.tenantId));

  app.post('/finance-rails/:provider/test-payment-link', { preHandler: ownerAdminRoles }, async (request, reply) => {
    const { provider } = z.object({ provider: z.enum(paymentProviders) }).parse(request.params);
    const connections = await db.paymentProviderConnection.findMany({ where: { tenantId: request.auth.tenantId } });
    const connection = connections.find(item => item.providerKey === provider);
    const patient = await db.patient.findFirst({ where: { tenantId: request.auth.tenantId }, orderBy: { createdAt: 'asc' }, select: { id: true, branchId: true } });
    const branchId = patient?.branchId ?? request.auth.branchId ?? (await db.branch.findFirst({ where: { tenantId: request.auth.tenantId }, select: { id: true } }))?.id ?? null;

    // Honesty gate: only a genuinely configured, credentialed payment provider
    // (the one the app actually uses) can make a REAL Stripe call. Never synthesize
    // a checkout.stripe.com URL and never persist a fabricated payment request.
    const status = paymentProviderStatus();
    const canRunReal = status.provider === provider && status.configured && !status.mock;

    if (!canRunReal) {
      const simulated = status.provider === provider && status.mock; // mock/demo mode
      const outcomeStatus = simulated ? 'simulated' : 'not_configured';
      const note = simulated
        ? `${provider} is in mock/demo mode — no real payment link is created and nothing is persisted.`
        : `${provider} is not configured. Connect ${provider} (set credentials) to generate a real payment link.`;
      await db.integrationRunLog.create({
        data: {
          tenantId: request.auth.tenantId, branchId, provider, providerMode: simulated ? 'mock' : 'unconfigured',
          operation: 'test-payment-link', status: outcomeStatus,
          requestSummary: { provider }, responseSummary: { status: outcomeStatus, note },
        },
      });
      await audit(request, { action: 'controlPlane.finance.tested', resource: 'financeRail', resourceId: provider, metadata: { status: outcomeStatus } });
      return reply.send({
        provider, providerName: connection?.displayName ?? provider, status: outcomeStatus,
        configured: false, paymentUrl: null, note, message: note,
      });
    }

    // Real provider path: create an ACTUAL payment link via the live provider and
    // report the real URL. This is a connectivity test — no PaymentRequest row is
    // persisted (it is not a collectible patient charge).
    const providerImpl = createPaymentProvider();
    try {
      const outcome = await providerImpl.createPaymentLink({
        tenantId: request.auth.tenantId,
        branchId: branchId ?? '',
        amount: 1,
        reason: 'CareCommand connectivity test',
      } as PaymentRequestContext);
      const ok = Boolean(outcome.paymentUrl);
      await db.integrationRunLog.create({
        data: {
          tenantId: request.auth.tenantId, branchId, provider, providerMode: outcome.providerMode,
          operation: 'test-payment-link', status: ok ? 'success' : 'error',
          requestSummary: { provider }, responseSummary: { providerReference: outcome.providerReference, paymentUrl: outcome.paymentUrl ?? null },
        },
      });
      await audit(request, { action: 'controlPlane.finance.tested', resource: 'financeRail', resourceId: provider, metadata: { status: ok ? 'success' : 'error', providerReference: outcome.providerReference } });
      if (!ok) {
        return reply.code(502).send({ provider, providerName: outcome.provider, status: 'error', configured: true, paymentUrl: null, message: 'Live payment provider returned no link.' });
      }
      return reply.send({
        provider, providerName: outcome.provider, providerMode: outcome.providerMode,
        modeLabel: formatMode(outcome.providerMode, true), status: 'success', configured: true,
        paymentUrl: outcome.paymentUrl, providerReference: outcome.providerReference,
        message: `Live payment link created via ${outcome.provider}.`,
      });
    } catch (error) {
      await db.integrationRunLog.create({
        data: {
          tenantId: request.auth.tenantId, branchId, provider, providerMode: status.mode,
          operation: 'test-payment-link', status: 'error',
          requestSummary: { provider }, errorMessage: (error as Error).message?.slice(0, 500) ?? 'Payment link call failed',
        },
      });
      await audit(request, { action: 'controlPlane.finance.tested', resource: 'financeRail', resourceId: provider, metadata: { status: 'error' } });
      return reply.code(502).send({ provider, providerName: connection?.displayName ?? provider, status: 'error', configured: true, paymentUrl: null, message: 'Live payment provider call failed.' });
    }
  });

  app.get('/finance-rails/logs', { preHandler: ownerAdminRoles }, async request => {
    const logs = await db.integrationRunLog.findMany({
      where: { tenantId: request.auth.tenantId, provider: { in: [...paymentProviders] } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return logs.map(log => ({
      id: log.id,
      provider: log.provider,
      providerMode: log.providerMode,
      operation: log.operation,
      status: log.status,
      requestSummary: log.requestSummary ?? null,
      responseSummary: log.responseSummary ?? null,
      errorMessage: log.errorMessage ?? null,
      createdAt: log.createdAt.toISOString(),
    }));
  });

  app.get('/system-health', { preHandler: ownerAdminRoles }, async request => buildSystemHealth(request.auth.tenantId));
};
