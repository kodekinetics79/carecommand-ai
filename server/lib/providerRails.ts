import type { PrismaClient } from '../generated/prisma/client';
import { env } from '../config/env';
import { retellConfigStatus } from './retell';

// ===========================================================================
// The supplier catalogue, and every provider-readiness projection built from
// it.
//
// This used to live inside `server/modules/control-plane/routes.ts`, which is
// a TENANT plane: it answered a tenant JWT and painted a clinic's own screen
// with a grid of seventeen suppliers, their operating modes, their missing
// configuration counts and a Test-connection button per vendor.
//
// A clinic contracted for a working product, not a console of third-party
// services. None of this is actionable by the reader — a practice manager
// cannot open our voice supplier's dashboard or rotate our key — and all of it
// prices our stack for them. So the projections moved HERE, where both planes
// can import them, and the ROUTES that serve them moved to the platform plane
// (`/v1/platform/tenants/:tenantId/providers`). Nothing was deleted; the
// audience changed.
//
// What a tenant gets instead is `tenantCapabilities()` at the bottom of this
// file: the same underlying facts, stated as capabilities in our own words —
// "Card payments: not set up" — with no supplier named and no environment
// variable quoted.
// ===========================================================================

export const integrationDefinitions = [
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
  { key: 'voice', name: 'Voice (Retell)', category: 'Voice', envVars: ['RETELL_API_KEY', 'RETELL_FROM_NUMBER'], providerType: 'voice' },
  { key: 'ollama', name: 'Ollama', category: 'AI Providers', envVars: ['AI_PROVIDER', 'OLLAMA_BASE_URL', 'OLLAMA_MODEL'], providerType: 'ai' },
  { key: 'openai', name: 'OpenAI', category: 'AI Providers', envVars: ['AI_PROVIDER', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL'], providerType: 'ai' },
  { key: 'claude', name: 'Claude', category: 'AI Providers', envVars: ['AI_PROVIDER', 'CLAUDE_API_KEY', 'CLAUDE_BASE_URL', 'CLAUDE_MODEL'], providerType: 'ai' },
] as const;

export const insuranceProviders = ['stedi', 'availity', 'pverify', 'optum'] as const;
export const paymentProviders = ['stripe', 'square', 'authorize_net', 'clover', 'paypal'] as const;

export type InsuranceRailProvider = (typeof insuranceProviders)[number];
export type PaymentRailProvider = (typeof paymentProviders)[number];

export function insuranceRailCapability(
  provider: InsuranceRailProvider,
  runtime: { selectedProvider: string; stediApiKey?: string; stediTestMode: boolean },
): { configured: boolean; mode: 'sandbox' | 'live' | 'mock' } {
  const configured = provider === 'stedi' && runtime.selectedProvider === 'stedi' && Boolean(runtime.stediApiKey);
  return { configured, mode: configured ? (runtime.stediTestMode ? 'sandbox' : 'live') : 'mock' };
}

export function formatMode(mode: string, configured: boolean) {
  if (!configured && mode === 'live') return 'Live Not Configured';
  if (!configured && mode === 'sandbox') return 'Sandbox Ready';
  if (!configured) return 'Mock Mode';
  if (mode === 'live') return 'Live Active';
  if (mode === 'sandbox') return 'Sandbox Active';
  return 'Mock Mode';
}

export async function buildIntegrationRows(db: PrismaClient, tenantId: string) {
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
    const missingConfigCount = definition.providerType === 'voice'
      ? retellConfigStatus().missing.length
      : definition.envVars.filter(name => !process.env[name]).length;

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
    } else if (definition.providerType === 'voice') {
      // Status must come from the same resolver the senders use (platform
      // credential vault first, environment second), or the console would
      // disagree with the calls we actually place.
      const status = retellConfigStatus();
      configured = status.configured;
      mode = !configured ? 'mock' : status.mock ? 'sandbox' : 'live';
      health = configured ? 'healthy' : 'not_configured';
      lastSyncAt = latestLog?.createdAt.toISOString() ?? null;
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
            : definition.category === 'Voice'
              ? ['Inbound answering', 'Appointment booking', 'Message taking']
              : definition.category === 'AI Providers'
                ? ['Advisory brief', 'Summaries', 'Workflow suggestions']
                : ['Monitoring'],
      mode,
      modeLabel: formatMode(mode, configured),
      configured,
      health,
      lastSyncAt,
      missingConfigCount,
      // Operator-only. This is the list a support engineer needs and the exact
      // list a tenant must never receive, which is why it is served under the
      // platform JWT and nowhere else.
      missingConfigKeys: definition.providerType === 'voice'
        ? retellConfigStatus().missing
        : definition.envVars.filter(name => !process.env[name]),
      riskLevel: !configured ? 'high' : health === 'degraded' ? 'medium' : 'low',
      action: 'Test connection',
      integrationId: integrationRow?.id ?? null,
      providerConnectionId: paymentRow?.id ?? null,
      databaseStatus: integrationRow?.status ?? paymentRow?.status ?? null,
    };
  });
}

export async function buildInsuranceRails(db: PrismaClient, tenantId: string) {
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
      actions: ['Test eligibility check', 'View normalized response', 'View integration logs'],
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

export async function buildFinanceRails(db: PrismaClient, tenantId: string) {
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
      actions: ['Test payment link', 'View payment provider logs'],
    };
  });
}

// ===========================================================================
// What the TENANT gets instead.
//
// One capability, one sentence, no supplier and no environment variable. The
// three states are deliberately distinct, because collapsing them is how a
// clinic ends up believing a thing works:
//
//   available   — it will do the real thing.
//   test_data   — it answers, but with simulated data. Say so, every time.
//   not_set_up  — it cannot do it at all, and the clinic cannot fix that
//                 alone, so the next step is us.
//
// There is no fourth state that renders as a comforting zero or a green tick.
// ===========================================================================

export type CapabilityState = 'available' | 'test_data' | 'not_set_up';

export interface TenantCapability {
  key: 'eligibility_checks' | 'card_payments';
  /** The clinic's word for the thing, not ours and not a supplier's. */
  label: string;
  state: CapabilityState;
  /** One sentence a practice manager can act on. */
  detail: string;
  /** Convenience for a control that must disable itself. */
  usable: boolean;
}

/** The one sentence to print when a capability needs us, not the clinic. */
export const CONTACT_SUPPORT = 'Contact CareCommand support to switch it on.';

export function eligibilityCapability(configured: boolean, simulated: boolean): TenantCapability {
  if (!configured) {
    return {
      key: 'eligibility_checks',
      label: 'Insurance eligibility checks',
      state: 'not_set_up',
      detail: `Eligibility checks are not set up for this clinic, so coverage cannot be confirmed here. ${CONTACT_SUPPORT}`,
      usable: false,
    };
  }
  if (simulated) {
    return {
      key: 'eligibility_checks',
      label: 'Insurance eligibility checks',
      state: 'test_data',
      detail: 'Eligibility checks run against test data. Results are simulated and must not be quoted to a patient.',
      usable: true,
    };
  }
  return {
    key: 'eligibility_checks',
    label: 'Insurance eligibility checks',
    state: 'available',
    detail: 'Eligibility checks reach the payer. A response is a point-in-time answer, not a guarantee of coverage or payment.',
    usable: true,
  };
}

export function cardPaymentsCapability(configured: boolean, simulated: boolean): TenantCapability {
  if (!configured) {
    return {
      key: 'card_payments',
      label: 'Card payments',
      state: 'not_set_up',
      detail: `Card payments are not set up for this clinic, so no payment link can be sent. ${CONTACT_SUPPORT}`,
      usable: false,
    };
  }
  if (simulated) {
    return {
      key: 'card_payments',
      label: 'Card payments',
      state: 'test_data',
      detail: 'Card payments run against test data. No patient is charged and no money moves.',
      usable: true,
    };
  }
  return {
    key: 'card_payments',
    label: 'Card payments',
    state: 'available',
    detail: 'Card payments are live. A payment link charges the patient for real.',
    usable: true,
  };
}
