import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client';
import { env } from '../../config/env';
import { db } from '../../lib/db';
import { platformDb } from '../../lib/platformDb';
import { runInTenantContext } from '../../lib/tenantContext';
import { runWithPlatformDatabaseRequest } from '../../lib/platformContextStore';
import { requirePlatformAccess, platformAuditEvent } from '../../lib/platformAuth';
import { paymentProviderStatus } from '../../lib/deposits';
import { eligibilityProviderStatus } from '../../lib/insuranceIntelligence';
import { createPaymentProvider, createInsuranceProvider, type PaymentRequestContext } from '../revenue-protection';
import {
  buildIntegrationRows,
  buildInsuranceRails,
  buildFinanceRails,
  formatMode,
  insuranceProviders,
  paymentProviders,
} from '../../lib/providerRails';

// ===========================================================================
// The supplier console, on the plane that is allowed to have one.
//
// Every route here used to answer a TENANT JWT under /v1/control-plane: the
// seventeen-provider readiness grid, the eligibility rails, the payment rails,
// their run logs and their Test buttons. A clinic bought a working phone line
// and a working payment link; it did not buy a directory of the companies we
// pay. Those screens are gone from the tenant app.
//
// The CAPABILITY did not go anywhere. It is here, behind the platform JWT a
// tenant token cannot mint, keyed by tenantId so a support engineer can answer
// "why can this clinic not take a card" without asking the clinic to read a
// vendor name off its own screen. Behaviour is unchanged from the tenant
// versions, including every honesty gate: a provider with no live probe is
// still reported as "configured, not verified", never as a passing test.
//
// ON WHICH DATABASE ROLE THIS RUNS. The platform plane's own role (`app_platform`)
// is granted a deliberately narrow table set — Tenant, PlatformUser, the plan
// catalogue, UsageEvent — and nothing that carries clinical or billing detail.
// Widening it to read PaymentProviderConnection, InsurancePayer and
// EligibilityVerification would trade a screen for a permanent privilege
// expansion on the operator role, which is a far worse bargain than the one
// this change exists to make.
//
// So these handlers authenticate with the platform JWT and then read through
// the TENANT runtime role under an explicit `source: 'platform'` tenant
// context. Row-level security stays the data boundary: the scope is one
// tenantId, set on the connection, and a suspended or archived tenant fails
// closed exactly as it does everywhere else.
// ===========================================================================

const uuid = z.string().uuid();
const consoleRead = requirePlatformAccess();
const consoleAct = requirePlatformAccess('PLATFORM_ADMIN');

/**
 * Run one operator read/probe inside a tenant-scoped context.
 *
 * `runInTenantContext` sets the scope for the async call tree rather than
 * opening one long transaction, so a six-second Stripe probe does not hold a
 * database connection open while it waits.
 */
type PlatformRequestLike = { platformUser?: { id: string; role: string } | null; id?: string };

function asTenant<T>(request: PlatformRequestLike, tenantId: string, run: () => Promise<T>): Promise<T> {
  return runInTenantContext({
    tenantId,
    actorId: request.platformUser?.id ?? 'platform:unknown',
    actorRole: request.platformUser?.role ?? 'PLATFORM_ADMIN',
    source: 'platform',
    requestId: request.id,
  }, run);
}

/**
 * The run log is written from the platform plane on behalf of a tenant. It is
 * the same table the tenant-side adapters write, so a support engineer's probe
 * and a real workflow run appear in one ordered history rather than two.
 */
async function recordRun(request: PlatformRequestLike, input: {
  tenantId: string;
  branchId: string | null;
  provider: string;
  providerMode: string;
  operation: string;
  status: string;
  requestSummary?: Prisma.InputJsonObject;
  responseSummary?: Prisma.InputJsonObject;
  errorMessage?: string;
}) {
  await asTenant(request, input.tenantId, () => db.integrationRunLog.create({
    data: {
      tenantId: input.tenantId,
      branchId: input.branchId ?? undefined,
      provider: input.provider,
      providerMode: input.providerMode,
      operation: input.operation,
      status: input.status,
      requestSummary: input.requestSummary ?? {},
      responseSummary: input.responseSummary ?? {},
      errorMessage: input.errorMessage ?? null,
    },
  }));
}

export const platformProviderConsoleRoutes: FastifyPluginAsync = async app => {
  // Same two hooks the rest of the platform plane installs. Without the first,
  // `platformDb` reads run with no platform context and every RLS-protected
  // read fails closed — which looks exactly like "tenant not found".
  app.addHook('onRequest', (_request, _reply, done) => runWithPlatformDatabaseRequest(done));
  /**
   * One tenant's whole provider picture: catalogue readiness, eligibility
   * rails, payment rails. `missingConfigKeys` is included here and NOWHERE
   * else — naming an environment variable is only useful to somebody who can
   * go and set it.
   */
  app.get('/tenants/:tenantId/providers', { preHandler: consoleRead }, async (request, reply) => {
    const { tenantId } = z.object({ tenantId: uuid }).parse(request.params);
    // The Tenant row is one of the few tables the platform role may read on its
    // own, so a missing tenant answers 404 before any tenant context is opened.
    const tenant = await platformDb.tenant.findUnique({ where: { id: tenantId }, select: { id: true, name: true } });
    if (!tenant) return reply.code(404).send({ error: 'not_found', message: 'Tenant not found' });

    const [integrations, insuranceRails, financeRails] = await asTenant(request, tenantId, () => Promise.all([
      buildIntegrationRows(db, tenantId),
      buildInsuranceRails(db, tenantId),
      buildFinanceRails(db, tenantId),
    ]));

    return {
      tenantId,
      tenantName: tenant.name,
      summary: {
        active: integrations.filter(row => row.configured && row.health === 'healthy').length,
        sandbox: integrations.filter(row => row.mode === 'sandbox').length,
        mock: integrations.filter(row => row.mode === 'mock').length,
        failed: integrations.filter(row => row.health === 'degraded').length,
        total: integrations.length,
      },
      integrations,
      insuranceRails,
      financeRails,
    };
  });

  /** The run history for one provider on one tenant. */
  app.get('/tenants/:tenantId/providers/:provider/runs', { preHandler: consoleRead }, async request => {
    const { tenantId, provider } = z.object({ tenantId: uuid, provider: z.string().trim().min(2).max(80) }).parse(request.params);
    const runs = await asTenant(request, tenantId, () => db.integrationRunLog.findMany({
      where: { tenantId, provider },
      orderBy: { createdAt: 'desc' },
      take: 50,
    }));
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

  app.post('/tenants/:tenantId/providers/:provider/test', { preHandler: consoleAct }, async (request, reply) => {
    const { tenantId, provider } = z.object({ tenantId: uuid, provider: z.string().trim().min(2).max(80) }).parse(request.params);
    const [integrations, branchId] = await asTenant(request, tenantId, async () => [
      await buildIntegrationRows(db, tenantId),
      (await db.branch.findFirst({ where: { tenantId }, select: { id: true } }))?.id ?? null,
    ] as const);
    const selected = integrations.find(row => row.key === provider);
    if (!selected) return reply.code(404).send({ error: 'not_found', message: 'Integration provider not found' });

    const commonFields = {
      providerKey: provider, providerName: selected.name, modeLabel: selected.modeLabel,
      health: selected.health, supportedWorkflows: selected.supportedWorkflows,
      missingConfigCount: selected.missingConfigCount, missingConfigKeys: selected.missingConfigKeys,
      riskLevel: selected.riskLevel,
    };

    // Not configured → honest not_configured; never claim a successful test.
    if (!selected.configured) {
      const note = selected.missingConfigKeys.length
        ? `${selected.name} is not configured; no live connection test was performed. Unset: ${selected.missingConfigKeys.join(', ')}.`
        : `${selected.name} is not configured; no live connection test was performed.`;
      await recordRun(request, { tenantId, branchId, provider, providerMode: selected.mode, operation: 'test-connection', status: 'not_configured', requestSummary: { provider }, responseSummary: { status: 'not_configured', note } });
      await platformAuditEvent(request, 'tenant.integration.tested', { type: 'integration', id: provider, tenantId }, { status: 'not_configured' });
      return reply.send({ ...commonFields, status: 'not_configured', configured: false, verified: false, note, message: note });
    }

    // Configured + we have a live adapter → make a REAL reachability probe.
    if (provider === 'stripe' && env.STRIPE_SECRET_KEY) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6000);
      try {
        const res = await fetch('https://api.stripe.com/v1/balance', { headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` }, signal: controller.signal });
        const ok = res.ok;
        const note = ok ? 'Live Stripe API reachable (GET /v1/balance).' : `Stripe API returned HTTP ${res.status}.`;
        await recordRun(request, { tenantId, branchId, provider, providerMode: selected.mode, operation: 'test-connection', status: ok ? 'success' : 'error', requestSummary: { provider }, responseSummary: { status: ok ? 'success' : 'error', note } });
        await platformAuditEvent(request, 'tenant.integration.tested', { type: 'integration', id: provider, tenantId }, { status: ok ? 'success' : 'error' });
        return reply.code(ok ? 200 : 502).send({ ...commonFields, status: ok ? 'success' : 'error', configured: true, verified: ok, note, message: note });
      } catch (error) {
        const note = `Stripe API unreachable: ${(error as Error).message?.slice(0, 200) ?? 'network error'}.`;
        await recordRun(request, { tenantId, branchId, provider, providerMode: selected.mode, operation: 'test-connection', status: 'error', requestSummary: { provider }, errorMessage: note });
        await platformAuditEvent(request, 'tenant.integration.tested', { type: 'integration', id: provider, tenantId }, { status: 'error' });
        return reply.code(502).send({ ...commonFields, status: 'error', configured: true, verified: false, note, message: note });
      } finally {
        clearTimeout(timer);
      }
    }

    // Configured, but no live connectivity probe exists for this provider —
    // report configuration presence, NOT a verified live connection.
    const note = `${selected.name} is configured. A live connectivity probe is not implemented for this provider, so configuration presence is reported rather than verified reachability.`;
    await recordRun(request, { tenantId, branchId, provider, providerMode: selected.mode, operation: 'test-connection', status: 'configured', requestSummary: { provider }, responseSummary: { status: 'configured', verified: false, note } });
    await platformAuditEvent(request, 'tenant.integration.tested', { type: 'integration', id: provider, tenantId }, { status: 'configured' });
    return reply.send({ ...commonFields, status: 'configured', configured: true, verified: false, note, message: note });
  });

  app.post('/tenants/:tenantId/insurance-rails/:provider/test-eligibility', { preHandler: consoleAct }, async (request, reply) => {
    const { tenantId, provider } = z.object({ tenantId: uuid, provider: z.enum(insuranceProviders) }).parse(request.params);
    const { payer, patient, branchId } = await asTenant(request, tenantId, async () => {
      const payers = await db.insurancePayer.findMany({ where: { tenantId, active: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], take: 20 });
      const chosenPayer = payers.find(item => item.sourceProvider === provider) ?? payers[0] ?? null;
      const firstPatient = await db.patient.findFirst({ where: { tenantId }, orderBy: { createdAt: 'asc' }, select: { id: true, branchId: true } });
      return {
        payer: chosenPayer,
        patient: firstPatient,
        branchId: firstPatient?.branchId ?? (await db.branch.findFirst({ where: { tenantId }, select: { id: true } }))?.id ?? null,
      };
    });

    // Honesty gate: only a genuinely configured, credentialed eligibility
    // provider can make a REAL payer call. Never claim 'covered' from a
    // synthesized response.
    const status = eligibilityProviderStatus();
    const canRunReal = status.provider === provider && status.configured && !status.mock;

    if (!canRunReal) {
      const simulated = status.provider === provider && status.mock;
      const outcomeStatus = simulated ? 'simulated' : 'not_configured';
      const note = simulated
        ? `${provider} is in mock/demo mode — this is a simulated eligibility check, not a real payer (271) response.`
        : `${provider} is not configured. Configure it (sandbox available) to run a real eligibility check.`;
      await recordRun(request, { tenantId, branchId, provider, providerMode: simulated ? 'mock' : 'unconfigured', operation: 'test-eligibility', status: outcomeStatus, requestSummary: { provider, patientId: patient?.id ?? null, payerId: payer?.id ?? null }, responseSummary: { status: outcomeStatus, note } });
      await platformAuditEvent(request, 'tenant.insuranceRail.tested', { type: 'insuranceRail', id: provider, tenantId }, { status: outcomeStatus });
      return reply.send({ provider, providerName: payer?.sourceProvider ?? provider, status: outcomeStatus, configured: false, coverageStatus: null, note, message: note });
    }

    const providerImpl = createInsuranceProvider();
    try {
      const outcome = await asTenant(request, tenantId, () => providerImpl.runEligibilityCheck({
        tenantId,
        branchId: branchId ?? '',
        payer: payer ? { id: payer.id, name: payer.name, tradingPartnerServiceId: payer.tradingPartnerServiceId, sourceProvider: payer.sourceProvider } : undefined,
      }));
      await recordRun(request, { tenantId, branchId, provider, providerMode: outcome.providerMode, operation: 'test-eligibility', status: 'success', requestSummary: { provider, patientId: patient?.id ?? null, payerId: payer?.id ?? null }, responseSummary: { coverageStatus: outcome.coverageStatus, coverageActive: outcome.coverageActive, providerMode: outcome.providerMode } });
      await platformAuditEvent(request, 'tenant.insuranceRail.tested', { type: 'insuranceRail', id: provider, tenantId }, { status: 'success', coverageStatus: outcome.coverageStatus, mode: outcome.providerMode });
      return reply.send({
        provider, providerName: outcome.providerName, providerMode: outcome.providerMode,
        modeLabel: formatMode(outcome.providerMode, true), status: 'success', configured: true,
        coverageStatus: outcome.coverageStatus, coverageActive: outcome.coverageActive,
        message: 'Live eligibility check completed.',
      });
    } catch (error) {
      await recordRun(request, { tenantId, branchId, provider, providerMode: status.provider === 'stedi' ? (env.STEDI_TEST_MODE ? 'sandbox' : 'live') : 'live', operation: 'test-eligibility', status: 'error', requestSummary: { provider, patientId: patient?.id ?? null, payerId: payer?.id ?? null }, errorMessage: (error as Error).message?.slice(0, 500) ?? 'Eligibility call failed' });
      await platformAuditEvent(request, 'tenant.insuranceRail.tested', { type: 'insuranceRail', id: provider, tenantId }, { status: 'error' });
      return reply.code(502).send({ provider, providerName: provider, status: 'error', configured: true, coverageStatus: null, message: 'Live eligibility provider call failed.' });
    }
  });

  app.post('/tenants/:tenantId/finance-rails/:provider/test-payment-link', { preHandler: consoleAct }, async (request, reply) => {
    const { tenantId, provider } = z.object({ tenantId: uuid, provider: z.enum(paymentProviders) }).parse(request.params);
    const { connection, branchId } = await asTenant(request, tenantId, async () => {
      const connections = await db.paymentProviderConnection.findMany({ where: { tenantId } });
      const firstPatient = await db.patient.findFirst({ where: { tenantId }, orderBy: { createdAt: 'asc' }, select: { id: true, branchId: true } });
      return {
        connection: connections.find(item => item.providerKey === provider) ?? null,
        branchId: firstPatient?.branchId ?? (await db.branch.findFirst({ where: { tenantId }, select: { id: true } }))?.id ?? null,
      };
    });

    // Honesty gate: never synthesize a checkout URL and never persist a
    // fabricated payment request.
    const status = paymentProviderStatus();
    const canRunReal = status.provider === provider && status.configured && !status.mock;

    if (!canRunReal) {
      const simulated = status.provider === provider && status.mock;
      const outcomeStatus = simulated ? 'simulated' : 'not_configured';
      const note = simulated
        ? `${provider} is in mock/demo mode — no real payment link is created and nothing is persisted.`
        : `${provider} is not configured. Connect ${provider} (set credentials) to generate a real payment link.`;
      await recordRun(request, { tenantId, branchId, provider, providerMode: simulated ? 'mock' : 'unconfigured', operation: 'test-payment-link', status: outcomeStatus, requestSummary: { provider }, responseSummary: { status: outcomeStatus, note } });
      await platformAuditEvent(request, 'tenant.financeRail.tested', { type: 'financeRail', id: provider, tenantId }, { status: outcomeStatus });
      return reply.send({ provider, providerName: connection?.displayName ?? provider, status: outcomeStatus, configured: false, paymentUrl: null, note, message: note });
    }

    // Real provider path: create an ACTUAL payment link and report the real
    // URL. This is a connectivity test — no PaymentRequest row is persisted.
    const providerImpl = createPaymentProvider();
    try {
      const outcome = await asTenant(request, tenantId, () => providerImpl.createPaymentLink({
        tenantId,
        branchId: branchId ?? '',
        amount: 1,
        reason: 'CareCommand connectivity test',
      } as PaymentRequestContext));
      const ok = Boolean(outcome.paymentUrl);
      await recordRun(request, { tenantId, branchId, provider, providerMode: outcome.providerMode, operation: 'test-payment-link', status: ok ? 'success' : 'error', requestSummary: { provider }, responseSummary: { providerReference: outcome.providerReference, paymentUrl: outcome.paymentUrl ?? null } });
      await platformAuditEvent(request, 'tenant.financeRail.tested', { type: 'financeRail', id: provider, tenantId }, { status: ok ? 'success' : 'error', providerReference: outcome.providerReference });
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
      await recordRun(request, { tenantId, branchId, provider, providerMode: status.mode, operation: 'test-payment-link', status: 'error', requestSummary: { provider }, errorMessage: (error as Error).message?.slice(0, 500) ?? 'Payment link call failed' });
      await platformAuditEvent(request, 'tenant.financeRail.tested', { type: 'financeRail', id: provider, tenantId }, { status: 'error' });
      return reply.code(502).send({ provider, providerName: connection?.displayName ?? provider, status: 'error', configured: true, paymentUrl: null, message: 'Live payment provider call failed.' });
    }
  });
};
