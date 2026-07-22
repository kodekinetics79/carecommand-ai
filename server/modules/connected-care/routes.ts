import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../../lib/db';
import { audit } from '../../lib/audit';
import { requireRoles } from '../../plugins/roles';
import { requireFeature } from '../../lib/entitlements';
import { assertBranchAccess, branchScope } from '../../lib/scope';
import { decryptSecret } from '../../lib/security';
import { verifyWebhookSignature, normalizeWebhook, readingDedupeKey } from '../../lib/connectedCare/deviceAdapters';
import { resolveRule, evaluateSeverity, weightBaselines } from '../../lib/monitoring';
import { computeRpmReadiness, RPM_MIN_READING_DAYS } from '../../lib/connectedCare/rpmReadiness';
import { DEVICE_KEYS } from '../../lib/connectedCare/catalog';

const uuid = z.string().uuid();
const manageRoles = requireRoles('OWNER', 'ADMIN', 'MANAGER');
const clinicalRoles = requireRoles('OWNER', 'ADMIN', 'MANAGER', 'PROVIDER');
const deviceKey = z.enum(DEVICE_KEYS as [string, ...string[]]);

// Rolling 30-day RPM period (anchored to midnight so the unique key is stable
// within a day). Counting device-days over a rolling window is robust regardless
// of where we are in the calendar month.
function periodBounds(now = new Date()): { start: Date; end: Date } {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - 29);
  return { start, end: new Date(now) };
}

async function patientNames(tenantId: string, ids: (string | null | undefined)[]) {
  const unique = [...new Set(ids.filter((v): v is string => !!v))];
  if (!unique.length) return new Map<string, string>();
  const rows = await db.patient.findMany({ where: { id: { in: unique }, tenantId }, select: { id: true, firstName: true, lastName: true } });
  return new Map(rows.map(p => [p.id, `${p.firstName} ${p.lastName}`]));
}

// Compute + persist RPM readiness for one enrolled patient in the current period.
async function computeAndStoreReadiness(tenantId: string, patientId: string) {
  const { start, end } = periodBounds();
  const [enrollment, consent, readings, existing] = await Promise.all([
    db.patientDeviceEnrollment.findFirst({ where: { tenantId, patientId, status: 'active' } }),
    db.patientConsent.findFirst({ where: { tenantId, patientId, consentType: 'rpm', granted: true, active: true } }),
    db.deviceReading.findMany({ where: { tenantId, patientId, validationStatus: 'valid', capturedAt: { gte: start, lte: end } }, select: { capturedAt: true } }),
    db.rPMBillingReadiness.findFirst({ where: { tenantId, patientId, periodStart: start } }),
  ]);
  const readingDays = new Set(readings.map(r => r.capturedAt.toISOString().slice(0, 10))).size;
  const reviewMinutes = existing?.reviewMinutes ?? 0;
  const communicationFlag = existing?.communicationFlag ?? false;
  const providerSignoff = !!existing?.providerSignoffAt;
  const result = computeRpmReadiness({ consentGranted: !!consent, enrollmentActive: !!enrollment, readingDays, reviewMinutes, communicationFlag, providerSignoff });
  const row = await db.rPMBillingReadiness.upsert({
    where: { tenantId_patientId_periodStart: { tenantId, patientId, periodStart: start } },
    create: { tenantId, patientId, periodStart: start, periodEnd: end, readingDays, reviewMinutes, communicationFlag, status: result.status, missingRequirements: result.missing },
    update: { readingDays, periodEnd: end, status: result.status, missingRequirements: result.missing },
  });
  return { row, result, readingDays };
}

// ── Protected management routes ─────────────────────────────────────────────
export const connectedCareRoutes: FastifyPluginAsync = async app => {
  app.addHook('preHandler', requireFeature('device_integration'));
  app.addHook('preHandler', clinicalRoles);

  // Enrollments
  app.get('/enrollments', async request => {
    const rows = await db.patientDeviceEnrollment.findMany({ where: { tenantId: request.auth.tenantId, ...branchScope(request) }, orderBy: { enrolledAt: 'desc' }, take: 200 });
    const names = await patientNames(request.auth.tenantId, rows.map(r => r.patientId));
    return rows.map(r => ({ id: r.id, patientId: r.patientId, patientName: names.get(r.patientId) ?? 'Unknown', providerKey: r.providerKey, programType: r.programType, status: r.status, externalRef: r.externalRef, enrolledAt: r.enrolledAt, endedAt: r.endedAt }));
  });

  app.post('/enrollments', { preHandler: manageRoles }, async (request, reply) => {
    const input = z.object({ patientId: uuid, providerKey: deviceKey, programType: z.enum(['rpm', 'ccm', 'general']).default('rpm'), externalRef: z.string().trim().max(120).optional(), deviceId: uuid.optional() }).parse(request.body);
    const tenantId = request.auth.tenantId;
    const patient = await db.patient.findFirst({ where: { id: input.patientId, tenantId, deletedAt: null }, select: { id: true, branchId: true } });
    if (!patient) throw app.httpErrors.notFound('Patient not found');
    assertBranchAccess(request, patient.branchId);
    const row = await db.patientDeviceEnrollment.upsert({
      where: { tenantId_patientId_providerKey: { tenantId, patientId: input.patientId, providerKey: input.providerKey } },
      create: { tenantId, patientId: input.patientId, branchId: patient.branchId, providerKey: input.providerKey, programType: input.programType, externalRef: input.externalRef, deviceId: input.deviceId, status: 'active', enrolledAt: new Date() },
      update: { status: 'active', programType: input.programType, externalRef: input.externalRef ?? undefined, endedAt: null },
      select: { id: true, status: true },
    });
    await audit(request, { action: 'connectedcare.enrollment.created', resource: 'patientDeviceEnrollment', resourceId: row.id, metadata: { providerKey: input.providerKey, programType: input.programType } });
    return reply.code(201).send(row);
  });

  app.patch('/enrollments/:id', { preHandler: manageRoles }, async request => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const { status } = z.object({ status: z.enum(['active', 'paused', 'ended']) }).parse(request.body);
    const existing = await db.patientDeviceEnrollment.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!existing) throw app.httpErrors.notFound('Enrollment not found');
    const row = await db.patientDeviceEnrollment.update({ where: { id }, data: { status, endedAt: status === 'ended' ? new Date() : null }, select: { id: true, status: true } });
    await audit(request, { action: 'connectedcare.enrollment.updated', resource: 'patientDeviceEnrollment', resourceId: id, metadata: { status } });
    return row;
  });

  // Consent
  app.get('/consent', async request => {
    const q = z.object({ patientId: uuid }).parse(request.query);
    const rows = await db.patientConsent.findMany({ where: { tenantId: request.auth.tenantId, patientId: q.patientId }, orderBy: { updatedAt: 'desc' } });
    return rows.map(r => ({ id: r.id, consentType: r.consentType, granted: r.granted, method: r.method, grantedAt: r.grantedAt, revokedAt: r.revokedAt }));
  });

  app.post('/consent', { preHandler: manageRoles }, async (request, reply) => {
    const input = z.object({ patientId: uuid, consentType: z.enum(['rpm', 'communication', 'data_sharing']).default('rpm'), granted: z.boolean(), method: z.enum(['verbal', 'written', 'portal', 'esign']).optional() }).parse(request.body);
    const tenantId = request.auth.tenantId;
    const patient = await db.patient.findFirst({ where: { id: input.patientId, tenantId, deletedAt: null }, select: { id: true } });
    if (!patient) throw app.httpErrors.notFound('Patient not found');
    const row = await db.patientConsent.upsert({
      where: { tenantId_patientId_consentType: { tenantId, patientId: input.patientId, consentType: input.consentType } },
      create: { tenantId, patientId: input.patientId, consentType: input.consentType, granted: input.granted, method: input.method, grantedAt: input.granted ? new Date() : null },
      update: { granted: input.granted, method: input.method, grantedAt: input.granted ? new Date() : undefined, revokedAt: input.granted ? null : new Date() },
      select: { id: true, granted: true },
    });
    await audit(request, { action: 'connectedcare.consent.updated', resource: 'patientConsent', resourceId: row.id, metadata: { consentType: input.consentType, granted: input.granted } });
    if (input.consentType === 'rpm') await computeAndStoreReadiness(tenantId, input.patientId).catch(() => {});
    return reply.code(201).send(row);
  });

  // Sync logs
  app.get('/sync-logs', async request => {
    const q = z.object({ providerKey: z.string().optional(), limit: z.coerce.number().min(1).max(200).default(50) }).parse(request.query);
    const rows = await db.deviceProviderSyncLog.findMany({ where: { tenantId: request.auth.tenantId, ...(q.providerKey ? { providerKey: q.providerKey } : {}) }, orderBy: { createdAt: 'desc' }, take: q.limit, select: { id: true, providerKind: true, providerKey: true, direction: true, event: true, status: true, httpStatus: true, signatureValid: true, readingsIngested: true, alertsCreated: true, message: true, createdAt: true } });
    return rows;
  });

  app.get('/sync-logs/:id', async request => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const row = await db.deviceProviderSyncLog.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!row) throw app.httpErrors.notFound('Sync log not found');
    return row; // includes raw payload for the "view raw sync log" action
  });

  // RPM billing readiness
  app.get('/rpm-readiness', async request => {
    const tenantId = request.auth.tenantId;
    const enrollments = await db.patientDeviceEnrollment.findMany({ where: { tenantId, ...branchScope(request), status: 'active', programType: 'rpm' }, select: { patientId: true } });
    const patientIds = [...new Set(enrollments.map(e => e.patientId))];
    const names = await patientNames(tenantId, patientIds);
    const rows = await Promise.all(patientIds.map(async pid => {
      const { row, result, readingDays } = await computeAndStoreReadiness(tenantId, pid);
      return { patientId: pid, patientName: names.get(pid) ?? 'Unknown', status: result.status, missing: result.missing, requirements: result.requirements, readingDays, reviewMinutes: row.reviewMinutes, communicationFlag: row.communicationFlag, providerSignoffAt: row.providerSignoffAt, minReadingDays: RPM_MIN_READING_DAYS };
    }));
    return rows.sort((a, b) => (a.status === 'READY' ? 1 : 0) - (b.status === 'READY' ? 1 : 0));
  });

  // Record clinical review minutes / patient communication for the period.
  app.patch('/rpm-readiness/:patientId/review', { preHandler: clinicalRoles }, async request => {
    const { patientId } = z.object({ patientId: uuid }).parse(request.params);
    const input = z.object({ addReviewMinutes: z.number().int().min(0).max(600).optional(), communicationFlag: z.boolean().optional() }).parse(request.body ?? {});
    const tenantId = request.auth.tenantId;
    const { start, end } = periodBounds();
    const existing = await db.rPMBillingReadiness.findFirst({ where: { tenantId, patientId, periodStart: start } });
    await db.rPMBillingReadiness.upsert({
      where: { tenantId_patientId_periodStart: { tenantId, patientId, periodStart: start } },
      create: { tenantId, patientId, periodStart: start, periodEnd: end, reviewMinutes: input.addReviewMinutes ?? 0, communicationFlag: input.communicationFlag ?? false, status: 'MISSING_REQUIREMENTS' },
      update: { reviewMinutes: (existing?.reviewMinutes ?? 0) + (input.addReviewMinutes ?? 0), ...(input.communicationFlag !== undefined ? { communicationFlag: input.communicationFlag } : {}) },
    });
    const { result } = await computeAndStoreReadiness(tenantId, patientId);
    await audit(request, { action: 'connectedcare.rpm.review_recorded', resource: 'rpmBillingReadiness', resourceId: patientId, metadata: { addReviewMinutes: input.addReviewMinutes, communicationFlag: input.communicationFlag, status: result.status } });
    return result;
  });

  // Provider signoff. Never auto-submits a claim.
  app.post('/rpm-readiness/:patientId/signoff', { preHandler: clinicalRoles }, async request => {
    const { patientId } = z.object({ patientId: uuid }).parse(request.params);
    const tenantId = request.auth.tenantId;
    const { start, end } = periodBounds();
    await db.rPMBillingReadiness.upsert({
      where: { tenantId_patientId_periodStart: { tenantId, patientId, periodStart: start } },
      create: { tenantId, patientId, periodStart: start, periodEnd: end, providerSignoffUserId: request.auth.userId, providerSignoffAt: new Date(), status: 'NEEDS_REVIEW' },
      update: { providerSignoffUserId: request.auth.userId, providerSignoffAt: new Date() },
    });
    const { result } = await computeAndStoreReadiness(tenantId, patientId);
    await audit(request, { action: 'connectedcare.rpm.signoff', resource: 'rpmBillingReadiness', resourceId: patientId, metadata: { status: result.status } });
    return result;
  });
};

// ── Public webhook receiver (signature-verified, no JWT) ────────────────────
export const connectedCareWebhookRoutes: FastifyPluginAsync = async app => {
  app.post('/:tenantId/providers/:key/webhook', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { tenantId, key } = z.object({ tenantId: uuid, key: deviceKey }).parse(request.params);
    const provider = await db.deviceProvider.findFirst({ where: { tenantId, providerKey: key } });

    const rawBody = JSON.stringify(request.body ?? {});
    const signature = (request.headers['x-cc-signature'] as string | undefined) ?? null;
    let secret: string | null = null;
    if (provider?.encryptedConfig) {
      try { const cfg = JSON.parse(decryptSecret(provider.encryptedConfig) ?? '{}'); secret = cfg.webhookSecret ?? cfg.apiKey ?? null; } catch { secret = null; }
    }
    const signatureValid = verifyWebhookSignature(secret, rawBody, signature);

    // FAIL CLOSED. Ingest ONLY when the signature is explicitly valid.
    //   • signatureValid === true  → a per-provider secret is configured AND the
    //     HMAC matches. That verified secret is the ONLY thing binding this
    //     request to the URL `tenantId`; nothing else here authenticates it.
    //   • signatureValid === false → a secret exists but the signature is wrong/absent.
    //   • signatureValid === null  → NO usable secret (no provider row, or a row
    //     with no webhookSecret/apiKey). The request is unverifiable, so the URL
    //     `tenantId` is attacker-controlled and MUST NOT be trusted.
    // Both `false` and `null` REJECT — an unverifiable webhook never writes
    // readings/alerts. (Previously `null` slipped past the guard and let an
    // unauthenticated caller inject fabricated readings into any tenant by URL.)
    if (signatureValid !== true) {
      // Anti-enumeration: one generic 401 for every rejection reason, so a prober
      // cannot learn whether the tenant/provider exists or a secret is configured.
      // Logs are id-only (no PHI) and best-effort — a probe against a non-existent
      // tenantId cannot satisfy the Tenant FK, so the write silently no-ops.
      request.log.warn({ ip: request.ip, tenantId, providerKey: key, hasSecret: !!secret }, 'connected-care webhook signature verification failed');
      await db.deviceProviderSyncLog.create({ data: { tenantId, providerKind: 'device', providerKey: key, direction: 'inbound', event: 'webhook', status: 'rejected', httpStatus: 401, signatureValid, message: 'Webhook signature verification failed' } }).catch(() => {});
      await db.auditEvent.create({ data: { tenantId, action: 'connectedcare.webhook.verification_failed', resource: 'deviceProviderWebhook', ipAddress: request.ip, userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : undefined, metadata: { providerKey: key } } }).catch(() => {});
      return reply.code(401).send({ error: 'Invalid signature' });
    }

    const { readings } = normalizeWebhook(key, request.body);
    let ingested = 0;
    let alertsCreated = 0;
    let duplicates = 0;
    for (const r of readings) {
      // Resolve patient by explicit id or by enrollment external ref.
      let patientId = r.patientId ?? null;
      let branchId: string | null = null;
      if (!patientId && r.patientExternalRef) {
        const enr = await db.patientDeviceEnrollment.findFirst({ where: { tenantId, providerKey: key, externalRef: r.patientExternalRef, status: 'active' }, select: { patientId: true, branchId: true } });
        if (enr) { patientId = enr.patientId; branchId = enr.branchId; }
      }
      if (patientId && branchId === null) {
        const p = await db.patient.findFirst({ where: { id: patientId, tenantId }, select: { branchId: true } });
        branchId = p?.branchId ?? null;
      }
      // Idempotency: a redelivered webhook for the SAME measurement collapses to
      // one reading (no duplicate alert, no inflated RPM device-day). Skip on a
      // pre-existing key, and defensively catch the unique-constraint race.
      const dedupeKey = readingDedupeKey({ providerKey: key, externalId: r.externalId, patientId, patientExternalRef: r.patientExternalRef, readingType: r.readingType, capturedAt: r.capturedAt, value: r.value, numericValue: r.numericValue ?? null, valueSecondary: r.valueSecondary ?? null });
      const dup = await db.deviceReading.findFirst({ where: { tenantId, dedupeKey }, select: { id: true } });
      if (dup) { duplicates++; continue; }
      let reading: { id: string; numericValue: number | null };
      try {
        reading = await db.deviceReading.create({
          data: { tenantId, patientId, branchId, readingType: r.readingType, value: r.value, numericValue: r.numericValue ?? null, valueSecondary: r.valueSecondary ?? null, unit: r.unit ?? null, capturedAt: r.capturedAt, source: 'webhook', validationStatus: 'valid', dedupeKey, rawPayload: r as unknown as object },
          select: { id: true, numericValue: true },
        });
      } catch (e) {
        // Unique (tenantId, dedupeKey) violation → concurrent redelivery. No-op.
        if ((e as { code?: string }).code === 'P2002') { duplicates++; continue; }
        throw e;
      }
      ingested++;
      // Backend decides severity — never the client. Weight uses a CHF baseline
      // delta, BP evaluates the diastolic half, ECG uses the rhythm class.
      const rule = await resolveRule(tenantId, { readingType: r.readingType, patientId, branchId });
      const weight = r.readingType === 'weight' && patientId ? await weightBaselines(tenantId, patientId, r.capturedAt) : null;
      const { severity, reason } = evaluateSeverity(r.readingType, reading.numericValue, rule, {
        valueSecondary: r.valueSecondary ?? null,
        ecgClassification: r.readingType === 'ecg' ? r.value : null,
        unit: r.unit ?? null,
        weight,
      });
      if (severity !== 'normal') {
        await db.readingAlert.create({ data: { tenantId, patientId, branchId, readingId: reading.id, severity, alertType: 'abnormal_reading', status: 'open', generatedReason: reason } });
        alertsCreated++;
      }
    }

    if (provider) await db.deviceProvider.update({ where: { id: provider.id }, data: { lastSyncAt: new Date() } }).catch(() => {});
    await db.deviceProviderSyncLog.create({ data: { tenantId, providerKind: 'device', providerKey: key, direction: 'inbound', event: 'webhook', status: 'processed', httpStatus: 200, signatureValid, readingsIngested: ingested, alertsCreated, message: `Normalized ${ingested} reading(s), ${alertsCreated} alert(s)${duplicates ? `, ${duplicates} duplicate(s) skipped` : ''}`, payload: (request.body ?? {}) as object } });
    return reply.send({ received: readings.length, ingested, alertsCreated, duplicates, signatureValid });
  });
};
