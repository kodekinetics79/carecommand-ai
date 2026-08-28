import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { db } from '../../lib/db';
import { audit } from '../../lib/audit';
import { requireRoles } from '../../plugins/roles';
import { requireFeature } from '../../lib/entitlements';
import { assertBranchAccess, branchScope } from '../../lib/scope';
import { decryptSecret } from '../../lib/security';
import { verifyWebhookSignature, normalizeWebhook, readingDedupeKey, isPlausibleNormalizedReading } from '../../lib/connectedCare/deviceAdapters';
import { resolveRule, evaluateSeverity, weightBaselines } from '../../lib/monitoring';
import { computeRpmReadiness, RPM_MIN_READING_DAYS } from '../../lib/connectedCare/rpmReadiness';
import { DEVICE_KEYS } from '../../lib/connectedCare/catalog';
import { enterTenantContext } from '../../lib/tenantContext';
import { resolveDeviceWebhookVerifier } from '../../lib/tenantIngressResolvers';
import {
  buildRpmEvidenceSnapshot,
  invalidateRpmProviderSignoff,
  lockRpmEvidence,
  RPM_SIGNOFF_ATTESTATION_REVISION,
  rpmPeriodBounds,
} from '../../lib/connectedCare/rpmEvidence';
import { computeAndStoreRpmReadiness } from '../../lib/connectedCare/rpmReadinessService';

const uuid = z.string().uuid();
const manageRoles = requireRoles('OWNER', 'ADMIN', 'MANAGER');
const clinicalRoles = requireRoles('OWNER', 'ADMIN', 'MANAGER', 'PROVIDER');
const tenantAdminRoles = requireRoles('OWNER', 'ADMIN');
const providerRole = requireRoles('PROVIDER');
const deviceKey = z.enum(DEVICE_KEYS as [string, ...string[]]);

async function assertPatientEnrollmentAccess(request: FastifyRequest, patientId: string, requireActiveRpm = false) {
  const tenantId = request.auth.tenantId;
  const patient = await db.patient.findFirst({
    where: { id: patientId, tenantId, deletedAt: null },
    select: { id: true, branchId: true },
  });
  if (!patient) throw request.server.httpErrors.notFound('Patient not found');
  assertBranchAccess(request, patient.branchId);

  const enrollment = requireActiveRpm
    ? await db.patientDeviceEnrollment.findFirst({
        where: { tenantId, patientId, branchId: patient.branchId, status: 'active', programType: 'rpm' },
        select: { id: true, branchId: true },
      })
    : null;
  if (requireActiveRpm && !enrollment) throw request.server.httpErrors.conflict('Patient does not have an active RPM enrollment in this branch');
  return { patient, enrollment };
}

async function patientNames(tenantId: string, ids: (string | null | undefined)[]) {
  const unique = [...new Set(ids.filter((v): v is string => !!v))];
  if (!unique.length) return new Map<string, string>();
  const rows = await db.patient.findMany({ where: { id: { in: unique }, tenantId }, select: { id: true, firstName: true, lastName: true } });
  return new Map(rows.map(p => [p.id, `${p.firstName} ${p.lastName}`]));
}

// ── Protected management routes ─────────────────────────────────────────────
export const connectedCareRoutes: FastifyPluginAsync = async app => {
  app.addHook('preHandler', requireFeature('device_integration'));
  app.addHook('preHandler', clinicalRoles);

  // Enrollments
  app.get('/enrollments', async request => {
    const rows = await db.patientDeviceEnrollment.findMany({ where: { tenantId: request.auth.tenantId, ...branchScope(request) }, orderBy: { enrolledAt: 'desc' }, take: 200 });
    const names = await patientNames(request.auth.tenantId, rows.map(r => r.patientId));
    await audit(request, { action: 'connectedcare.enrollment.list_read', resource: 'patientDeviceEnrollment', metadata: { count: rows.length } });
    return rows.map(r => ({ id: r.id, patientId: r.patientId, patientName: names.get(r.patientId) ?? 'Unknown', providerKey: r.providerKey, programType: r.programType, status: r.status, externalRef: r.externalRef, enrolledAt: r.enrolledAt, endedAt: r.endedAt }));
  });

  app.post('/enrollments', { preHandler: manageRoles }, async (request, reply) => {
    const input = z.object({ patientId: uuid, providerKey: deviceKey, programType: z.enum(['rpm', 'ccm', 'general']).default('rpm'), externalRef: z.string().trim().max(120).optional(), deviceId: uuid.optional() }).parse(request.body);
    const tenantId = request.auth.tenantId;
    const patient = await db.patient.findFirst({ where: { id: input.patientId, tenantId, deletedAt: null }, select: { id: true, branchId: true } });
    if (!patient) throw app.httpErrors.notFound('Patient not found');
    assertBranchAccess(request, patient.branchId);
    if (input.deviceId) {
      const device = await db.device.findFirst({ where: { id: input.deviceId, tenantId, active: true, OR: [{ branchId: patient.branchId }, { branchId: null }] }, select: { id: true } });
      if (!device) throw app.httpErrors.badRequest('Device is not active for this tenant and branch');
    }
    const period = rpmPeriodBounds();
    const row = await db.$transaction(async tx => {
      await lockRpmEvidence(tx, tenantId, input.patientId, period.start);
      if (input.externalRef) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`device-enrollment:${tenantId}:${input.providerKey}:${input.externalRef}`})::bigint)`;
        const collision = await tx.patientDeviceEnrollment.findFirst({ where: { tenantId, providerKey: input.providerKey, externalRef: input.externalRef, patientId: { not: input.patientId }, status: { not: 'ended' } }, select: { id: true } });
        if (collision) throw app.httpErrors.conflict('Provider patient reference is already assigned to another active enrollment');
      }
      const enrollment = await tx.patientDeviceEnrollment.upsert({
        where: { tenantId_patientId_providerKey: { tenantId, patientId: input.patientId, providerKey: input.providerKey } },
        create: { tenantId, patientId: input.patientId, branchId: patient.branchId, providerKey: input.providerKey, programType: input.programType, externalRef: input.externalRef, deviceId: input.deviceId, status: 'active', enrolledAt: new Date() },
        update: { branchId: patient.branchId, status: 'active', programType: input.programType, externalRef: input.externalRef ?? undefined, deviceId: input.deviceId ?? undefined, endedAt: null },
        select: { id: true, status: true },
      });
      await invalidateRpmProviderSignoff(tx, {
        tenantId, patientId: input.patientId, periodStart: period.start,
        reason: 'enrollment_mutated', actorUserId: request.auth.userId,
        requestId: request.id, ipAddress: request.ip,
        userAgent: request.headers['user-agent'], mutationResourceId: enrollment.id,
      });
      await tx.auditEvent.create({
        data: {
          tenantId, actorUserId: request.auth.userId,
          action: 'connectedcare.enrollment.created', resource: 'patientDeviceEnrollment',
          resourceId: enrollment.id, requestId: request.id, ipAddress: request.ip,
          userAgent: request.headers['user-agent'],
          metadata: { providerKey: input.providerKey, programType: input.programType },
        },
      });
      return enrollment;
    });
    return reply.code(201).send(row);
  });

  app.patch('/enrollments/:id', { preHandler: manageRoles }, async request => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const { status } = z.object({ status: z.enum(['active', 'paused', 'ended']) }).parse(request.body);
    const existing = await db.patientDeviceEnrollment.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!existing) throw app.httpErrors.notFound('Enrollment not found');
    if (!existing.branchId) throw app.httpErrors.conflict('Enrollment is missing branch attribution');
    assertBranchAccess(request, existing.branchId);
    const period = rpmPeriodBounds();
    const row = await db.$transaction(async tx => {
      await lockRpmEvidence(tx, request.auth.tenantId, existing.patientId, period.start);
      const updated = await tx.patientDeviceEnrollment.update({ where: { id }, data: { status, endedAt: status === 'ended' ? new Date() : null }, select: { id: true, status: true } });
      await invalidateRpmProviderSignoff(tx, {
        tenantId: request.auth.tenantId, patientId: existing.patientId,
        periodStart: period.start, reason: 'enrollment_mutated',
        actorUserId: request.auth.userId, requestId: request.id,
        ipAddress: request.ip, userAgent: request.headers['user-agent'], mutationResourceId: id,
      });
      await tx.auditEvent.create({
        data: {
          tenantId: request.auth.tenantId, actorUserId: request.auth.userId,
          action: 'connectedcare.enrollment.updated', resource: 'patientDeviceEnrollment',
          resourceId: id, requestId: request.id, ipAddress: request.ip,
          userAgent: request.headers['user-agent'], metadata: { status },
        },
      });
      return updated;
    });
    return row;
  });

  // Consent
  app.get('/consent', async request => {
    const q = z.object({ patientId: uuid }).parse(request.query);
    await assertPatientEnrollmentAccess(request, q.patientId);
    const rows = await db.patientConsent.findMany({ where: { tenantId: request.auth.tenantId, patientId: q.patientId }, orderBy: { updatedAt: 'desc' } });
    await audit(request, { action: 'connectedcare.consent.read', resource: 'patientConsent', resourceId: q.patientId, metadata: { count: rows.length } });
    return rows.map(r => ({ id: r.id, consentType: r.consentType, granted: r.granted, method: r.method, grantedAt: r.grantedAt, revokedAt: r.revokedAt, evidenceModel: 'immutable_audit_version' }));
  });

  app.post('/consent', { preHandler: manageRoles }, async (request, reply) => {
    const input = z.object({ patientId: uuid, consentType: z.enum(['rpm', 'communication', 'data_sharing']).default('rpm'), granted: z.boolean(), method: z.enum(['verbal', 'written', 'portal', 'esign']).optional() }).parse(request.body);
    const tenantId = request.auth.tenantId;
    await assertPatientEnrollmentAccess(request, input.patientId);
    const evidenceVersion = randomUUID();
    const evidenceCapturedAt = new Date();
    const period = rpmPeriodBounds(evidenceCapturedAt);
    const row = await db.$transaction(async tx => {
      if (input.consentType === 'rpm') await lockRpmEvidence(tx, tenantId, input.patientId, period.start);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`rpm-consent:${tenantId}:${input.patientId}:${input.consentType}`})::bigint)`;
      const current = await tx.patientConsent.upsert({
        where: { tenantId_patientId_consentType: { tenantId, patientId: input.patientId, consentType: input.consentType } },
        create: { tenantId, patientId: input.patientId, consentType: input.consentType, granted: input.granted, method: input.method, grantedAt: input.granted ? evidenceCapturedAt : null, revokedAt: input.granted ? null : evidenceCapturedAt },
        update: { granted: input.granted, method: input.method, grantedAt: input.granted ? evidenceCapturedAt : undefined, revokedAt: input.granted ? null : evidenceCapturedAt },
        select: { id: true, granted: true },
      });
      await tx.auditEvent.create({
        data: {
          tenantId,
          actorUserId: request.auth.userId,
          action: 'connectedcare.consent.version_created',
          resource: 'patientConsent',
          resourceId: input.patientId,
          requestId: request.id,
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'],
          metadata: { evidenceVersion, evidenceCapturedAt: evidenceCapturedAt.toISOString(), consentType: input.consentType, granted: input.granted, method: input.method ?? null, source: 'authenticated_staff_attestation', snapshotId: current.id },
        },
      });
      if (input.consentType === 'rpm') {
        await invalidateRpmProviderSignoff(tx, {
          tenantId, patientId: input.patientId, periodStart: period.start,
          reason: 'consent_evidence_mutated', actorUserId: request.auth.userId,
          requestId: request.id, ipAddress: request.ip,
          userAgent: request.headers['user-agent'], mutationResourceId: current.id,
        });
      }
      return current;
    });
    if (input.consentType === 'rpm') await computeAndStoreRpmReadiness(tenantId, input.patientId).catch(() => {});
    return reply.code(201).send({ ...row, evidenceVersion, evidenceModel: 'immutable_audit_version' });
  });

  // Sync logs
  app.get('/sync-logs', async request => {
    const q = z.object({ providerKey: z.string().optional(), limit: z.coerce.number().min(1).max(200).default(50) }).parse(request.query);
    const rows = await db.deviceProviderSyncLog.findMany({ where: { tenantId: request.auth.tenantId, ...(q.providerKey ? { providerKey: q.providerKey } : {}) }, orderBy: { createdAt: 'desc' }, take: q.limit, select: { id: true, providerKind: true, providerKey: true, direction: true, event: true, status: true, httpStatus: true, signatureValid: true, readingsIngested: true, alertsCreated: true, message: true, createdAt: true } });
    await audit(request, { action: 'connectedcare.sync_log.list_read', resource: 'deviceProviderSyncLog', metadata: { count: rows.length, providerKey: q.providerKey ?? null } });
    return rows;
  });

  app.get('/sync-logs/:id', { preHandler: tenantAdminRoles }, async request => {
    if (request.auth.branchId) throw app.httpErrors.forbidden('Raw provider payloads require tenant-wide administrator access');
    const { id } = z.object({ id: uuid }).parse(request.params);
    const row = await db.deviceProviderSyncLog.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!row) throw app.httpErrors.notFound('Sync log not found');
    await audit(request, { action: 'connectedcare.sync_log.raw_read', resource: 'deviceProviderSyncLog', resourceId: id, metadata: { providerKey: row.providerKey } });
    return row; // includes raw payload for the "view raw sync log" action
  });

  // RPM billing readiness
  app.get('/rpm-readiness', async request => {
    const tenantId = request.auth.tenantId;
    const enrollments = await db.patientDeviceEnrollment.findMany({ where: { tenantId, ...branchScope(request), status: 'active', programType: 'rpm' }, select: { patientId: true } });
    const patientIds = [...new Set(enrollments.map(e => e.patientId))];
    const names = await patientNames(tenantId, patientIds);
    const rows = await Promise.all(patientIds.map(async pid => {
      const { row, result, readingDays, evidence } = await computeAndStoreRpmReadiness(tenantId, pid);
      return {
        patientId: pid, patientName: names.get(pid) ?? 'Unknown', status: result.status,
        missing: result.missing, requirements: result.requirements, readingDays,
        reviewMinutes: row.reviewMinutes, communicationFlag: row.communicationFlag,
        providerSignoffAt: row.providerSignoffAt, minReadingDays: RPM_MIN_READING_DAYS,
        evidenceVersion: evidence.version, evidenceHash: evidence.hash,
        signoffAttestationRevision: RPM_SIGNOFF_ATTESTATION_REVISION,
        qualifyingReadingCount: evidence.qualifyingReadingCount,
        excludedReadingCount: evidence.excludedReadingCount,
        deviceExceptions: evidence.deviceExceptions,
      };
    }));
    await audit(request, { action: 'connectedcare.rpm_readiness.read', resource: 'rpmBillingReadiness', metadata: { patientCount: rows.length } });
    return rows.sort((a, b) => (a.status === 'READY' ? 1 : 0) - (b.status === 'READY' ? 1 : 0));
  });

  // Record clinical review minutes / patient communication for the period.
  app.patch('/rpm-readiness/:patientId/review', { preHandler: clinicalRoles }, async request => {
    const { patientId } = z.object({ patientId: uuid }).parse(request.params);
    const input = z.object({
      reviewEventId: uuid,
      sourceRef: z.string().trim().min(8).max(120),
      provenance: z.enum(['EHR_TIMER', 'DEVICE_SESSION', 'MANUAL_ATTESTATION']),
      startedAt: z.coerce.date(),
      endedAt: z.coerce.date(),
      communicationFlag: z.boolean().default(false),
    }).parse(request.body ?? {});
    const tenantId = request.auth.tenantId;
    const period = rpmPeriodBounds();
    await assertPatientEnrollmentAccess(request, patientId, true);
    const elapsedMs = input.endedAt.getTime() - input.startedAt.getTime();
    if (elapsedMs < 60_000 || elapsedMs > 4 * 60 * 60_000) throw app.httpErrors.badRequest('Review session must be between 1 and 240 minutes');
    if (input.startedAt < period.start || input.endedAt > new Date(Date.now() + 60_000)) throw app.httpErrors.badRequest('Review session is outside the current period');
    const reviewMinutes = Math.floor(elapsedMs / 60_000);
    const recorded = await db.$transaction(async tx => {
      await lockRpmEvidence(tx, tenantId, patientId, period.start);
      const replay = await tx.auditEvent.findFirst({ where: { tenantId, action: 'connectedcare.rpm.review_evidence_recorded', resourceId: input.reviewEventId }, select: { id: true } });
      if (replay) return false;
      const prior = await tx.auditEvent.findMany({
        where: { tenantId, action: 'connectedcare.rpm.review_evidence_recorded', resource: 'rpmReviewSession', occurredAt: { gte: period.start }, metadata: { path: ['patientId'], equals: patientId } },
        select: { metadata: true },
      });
      for (const event of prior) {
        const metadata = event.metadata && typeof event.metadata === 'object' && !Array.isArray(event.metadata) ? event.metadata as Record<string, unknown> : null;
        if (metadata?.patientId !== patientId) continue;
        if (metadata.sourceRef === input.sourceRef) throw app.httpErrors.conflict('Review source reference has already been recorded');
        const priorStart = typeof metadata.startedAt === 'string' ? new Date(metadata.startedAt) : null;
        const priorEnd = typeof metadata.endedAt === 'string' ? new Date(metadata.endedAt) : null;
        if (priorStart && priorEnd && input.startedAt < priorEnd && input.endedAt > priorStart) throw app.httpErrors.conflict('Review session overlaps evidence already recorded for this patient');
      }
      await tx.auditEvent.create({ data: { tenantId, actorUserId: request.auth.userId, action: 'connectedcare.rpm.review_evidence_recorded', resource: 'rpmReviewSession', resourceId: input.reviewEventId, requestId: request.id, ipAddress: request.ip, userAgent: request.headers['user-agent'], metadata: { patientId, sourceRef: input.sourceRef, provenance: input.provenance, startedAt: input.startedAt.toISOString(), endedAt: input.endedAt.toISOString(), reviewMinutes, communicationFlag: input.communicationFlag } } });
      await invalidateRpmProviderSignoff(tx, {
        tenantId, patientId, periodStart: period.start,
        reason: 'review_evidence_mutated', actorUserId: request.auth.userId,
        requestId: request.id, ipAddress: request.ip,
        userAgent: request.headers['user-agent'], mutationResourceId: input.reviewEventId,
      });
      return true;
    });
    const { result } = await computeAndStoreRpmReadiness(tenantId, patientId);
    return { ...result, recorded, reviewEventId: input.reviewEventId, reviewMinutes: recorded ? reviewMinutes : 0 };
  });

  // Provider signoff. Never auto-submits a claim.
  app.post('/rpm-readiness/:patientId/signoff', { preHandler: providerRole }, async request => {
    const { patientId } = z.object({ patientId: uuid }).parse(request.params);
    const input = z.object({
      expectedEvidenceVersion: z.string().trim().min(1).max(80),
      expectedEvidenceHash: z.string().regex(/^[a-f0-9]{64}$/),
      attestationRevision: z.string().trim().min(1).max(80),
    }).parse(request.body ?? {});
    const tenantId = request.auth.tenantId;
    const period = rpmPeriodBounds();
    const { patient } = await assertPatientEnrollmentAccess(request, patientId, true);
    const clinician = await db.user.findFirst({
      where: { id: request.auth.userId, tenantId, active: true, role: 'PROVIDER', providerProfile: { is: { tenantId, branchId: patient.branchId } } },
      select: { id: true, providerProfile: { select: { id: true, branchId: true } } },
    });
    if (!clinician?.providerProfile) throw app.httpErrors.forbidden('An active provider profile in the patient branch is required for signoff');
    const providerProfileId = clinician.providerProfile.id;
    return db.$transaction(async tx => {
      await lockRpmEvidence(tx, tenantId, patientId, period.start);
      const evidence = await buildRpmEvidenceSnapshot(tx, tenantId, patientId, period);
      if (input.expectedEvidenceVersion !== evidence.version || input.expectedEvidenceHash !== evidence.hash) {
        throw app.httpErrors.conflict('RPM evidence changed after review; refresh the preview and review the current evidence before signing');
      }
      if (input.attestationRevision !== RPM_SIGNOFF_ATTESTATION_REVISION) {
        throw app.httpErrors.conflict('RPM provider attestation revision is stale; refresh and review the current attestation');
      }
      const withoutSignoff = computeRpmReadiness({
        consentGranted: evidence.consentGranted,
        enrollmentActive: evidence.enrollmentActive,
        readingDays: evidence.readingDays,
        reviewMinutes: evidence.reviewMinutes,
        communicationFlag: evidence.communicationFlag,
        providerSignoff: false,
      });
      if (withoutSignoff.status === 'MISSING_REQUIREMENTS') {
        throw app.httpErrors.conflict(`Provider signoff requires complete current evidence: ${withoutSignoff.missing.join('; ')}`);
      }
      const signoffAt = new Date();
      const result = computeRpmReadiness({
        consentGranted: evidence.consentGranted,
        enrollmentActive: evidence.enrollmentActive,
        readingDays: evidence.readingDays,
        reviewMinutes: evidence.reviewMinutes,
        communicationFlag: evidence.communicationFlag,
        providerSignoff: true,
      });
      await tx.rPMBillingReadiness.upsert({
        where: { tenantId_patientId_periodStart: { tenantId, patientId, periodStart: period.start } },
        create: {
          tenantId, patientId, periodStart: period.start, periodEnd: period.end,
          readingDays: evidence.readingDays, reviewMinutes: evidence.reviewMinutes,
          communicationFlag: evidence.communicationFlag,
          providerSignoffUserId: request.auth.userId, providerSignoffAt: signoffAt,
          providerSignoffEvidenceVersion: evidence.version,
          providerSignoffEvidenceHash: evidence.hash,
          providerSignoffAttestationRevision: input.attestationRevision,
          status: result.status, missingRequirements: result.missing,
        },
        update: {
          readingDays: evidence.readingDays, reviewMinutes: evidence.reviewMinutes,
          communicationFlag: evidence.communicationFlag, periodEnd: period.end,
          providerSignoffUserId: request.auth.userId, providerSignoffAt: signoffAt,
          providerSignoffEvidenceVersion: evidence.version,
          providerSignoffEvidenceHash: evidence.hash,
          providerSignoffAttestationRevision: input.attestationRevision,
          status: result.status, missingRequirements: result.missing,
        },
      });
      await tx.auditEvent.create({
        data: {
          tenantId,
          actorUserId: request.auth.userId,
          action: 'connectedcare.rpm.signoff',
          resource: 'rpmBillingReadiness',
          resourceId: patientId,
          requestId: request.id,
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'],
          metadata: {
            providerProfileId, signedAt: signoffAt.toISOString(),
            evidenceModel: 'canonical_versioned_snapshot',
            evidenceVersion: evidence.version, evidenceHash: evidence.hash,
            attestationRevision: input.attestationRevision,
          },
        },
      });
      return result;
    });
  });
};

// ── Public webhook receiver (signature-verified, no JWT) ────────────────────
export const connectedCareWebhookRoutes: FastifyPluginAsync = async app => {
  app.post('/:tenantId/providers/:key/webhook', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { tenantId: tenantSelector, key } = z.object({ tenantId: uuid, key: deviceKey }).parse(request.params);
    const verifier = await resolveDeviceWebhookVerifier(tenantSelector, key);
    const rawBody = typeof request.rawBody === 'string'
      ? request.rawBody
      : Buffer.isBuffer(request.rawBody)
        ? request.rawBody.toString('utf8')
        : JSON.stringify(request.body ?? {});
    const signature = (request.headers['x-cc-signature'] as string | undefined) ?? null;
    let secret: string | null = null;
    if (verifier?.encryptedConfig) {
      try {
        const cfg = JSON.parse(decryptSecret(verifier.encryptedConfig) ?? '{}') as { webhookSecret?: string; apiKey?: string };
        secret = cfg.webhookSecret ?? cfg.apiKey ?? null;
      } catch { secret = null; }
    }
    const signatureValid = verifyWebhookSignature(secret, rawBody, signature);

    // The selector only locates a candidate verifier. Tenant authority is
    // established exclusively after the exact raw-body HMAC succeeds.
    if (!verifier || signatureValid !== true) {
      request.log.warn({ ip: request.ip, providerKey: key }, 'connected-care webhook signature verification failed');
      return reply.code(401).send({ error: 'Invalid signature' });
    }

    const tenantId = verifier.tenantId;
    enterTenantContext({
      tenantId,
      actorId: `webhook:device:${verifier.resourceId}`,
      actorRole: 'WEBHOOK',
      source: 'webhook',
      requestId: request.id,
    });

    const { readings } = normalizeWebhook(key, request.body);
    let ingested = 0;
    let alertsCreated = 0;
    let duplicates = 0;
    let invalid = 0;
    for (const r of readings) {
      if (!isPlausibleNormalizedReading(r)) { invalid++; continue; }
      let patientId = r.patientId ?? null;
      let branchId: string | null = null;
      let sourceEnrollment: { id: string; patientId: string; branchId: string | null; deviceId: string | null } | null = null;
      if (patientId) {
        const [patient, enrollment] = await Promise.all([
          db.patient.findFirst({ where: { id: patientId, tenantId, deletedAt: null }, select: { id: true } }),
          db.patientDeviceEnrollment.findFirst({
            where: { tenantId, patientId, providerKey: key, status: 'active' },
            select: { id: true, patientId: true, branchId: true, deviceId: true },
          }),
        ]);
        if (!patient || !enrollment) { invalid++; continue; }
        patientId = enrollment.patientId;
        branchId = enrollment.branchId;
        sourceEnrollment = enrollment;
      }
      if (!patientId && r.patientExternalRef) {
        const enrollments = await db.patientDeviceEnrollment.findMany({
          where: { tenantId, providerKey: key, externalRef: r.patientExternalRef, status: 'active' },
          select: { id: true, patientId: true, branchId: true, deviceId: true },
          take: 2,
        });
        if (enrollments.length === 1) {
          sourceEnrollment = enrollments[0]!;
          patientId = sourceEnrollment.patientId;
          branchId = sourceEnrollment.branchId;
        }
      }
      if (!patientId || !sourceEnrollment || !branchId) { invalid++; continue; }

      const dedupeKey = readingDedupeKey({
        providerKey: key,
        externalId: r.externalId,
        patientId,
        patientExternalRef: r.patientExternalRef,
        readingType: r.readingType,
        capturedAt: r.capturedAt,
        value: r.value,
        numericValue: r.numericValue ?? null,
        valueSecondary: r.valueSecondary ?? null,
      });
      const rule = await resolveRule(tenantId, { readingType: r.readingType, patientId, branchId });
      const weight = r.readingType === 'weight' && patientId
        ? await weightBaselines(tenantId, patientId, r.capturedAt)
        : null;
      const { severity, reason } = evaluateSeverity(r.readingType, r.numericValue ?? null, rule, {
        valueSecondary: r.valueSecondary ?? null,
        ecgClassification: r.readingType === 'ecg' ? r.value : null,
        unit: r.unit ?? null,
        weight,
      });

      let outcome: { duplicate: boolean; alert: boolean };
      try {
        outcome = await db.$transaction(async tx => {
          const evidencePeriod = rpmPeriodBounds(r.capturedAt);
          await lockRpmEvidence(tx, tenantId, patientId, evidencePeriod.start);
          const duplicate = await tx.deviceReading.findFirst({ where: { tenantId, dedupeKey }, select: { id: true } });
          if (duplicate) return { duplicate: true, alert: false };
          const reading = await tx.deviceReading.create({
            data: {
              tenantId, patientId, branchId, deviceId: sourceEnrollment.deviceId,
              readingType: r.readingType, value: r.value,
              numericValue: r.numericValue ?? null, valueSecondary: r.valueSecondary ?? null,
              unit: r.unit ?? null, capturedAt: r.capturedAt, source: 'webhook',
              validationStatus: 'valid', dedupeKey,
              sourceProviderKey: sourceEnrollment.deviceId ? key : null,
              sourceEnrollmentId: sourceEnrollment.deviceId ? sourceEnrollment.id : null,
              rawPayload: r as unknown as object,
            },
            select: { id: true },
          });
          let alertId: string | null = null;
          if (severity !== 'normal') {
            const recipient = rule?.assignedToUserId
              ? await tx.user.findFirst({ where: { id: rule.assignedToUserId, tenantId, active: true }, select: { id: true, displayName: true, role: true } })
              : await tx.user.findFirst({ where: { tenantId, active: true, role: { in: ['PROVIDER', 'MANAGER', 'ADMIN', 'OWNER'] }, ...(branchId ? { OR: [{ branchId }, { role: { in: ['ADMIN', 'OWNER'] } }] } : {}) }, orderBy: { createdAt: 'asc' }, select: { id: true, displayName: true, role: true } });
            const alert = await tx.readingAlert.create({ data: { tenantId, patientId, branchId, readingId: reading.id, severity, alertType: 'abnormal_reading', status: 'open', generatedReason: reason, assignedToUserId: recipient?.id ?? null }, select: { id: true } });
            alertId = alert.id;
            await tx.notificationEvent.create({ data: { tenantId, alertId, patientId, recipientType: recipient?.role.toLowerCase() ?? 'unassigned_staff', recipientUserId: recipient?.id ?? null, recipientLabel: recipient?.displayName ?? 'unassigned clinical safety queue', channel: 'in_app', status: 'queued', attempts: 0, consentChecked: true, consentResult: 'not_required' } });
          }
          await invalidateRpmProviderSignoff(tx, {
            tenantId, patientId, periodStart: evidencePeriod.start,
            reason: 'device_reading_evidence_mutated', actorUserId: null,
            requestId: request.id, userAgent: 'connected-care-webhook',
            mutationResourceId: reading.id,
          });
          await tx.auditEvent.create({ data: { tenantId, actorUserId: null, action: 'connected_care.reading.ingested', resource: 'deviceReading', resourceId: reading.id, requestId: request.id, userAgent: 'connected-care-webhook', metadata: { readingType: r.readingType, severity, alertId } } });
          return { duplicate: false, alert: Boolean(alertId) };
        });
      } catch (error) {
        if ((error as { code?: string }).code === 'P2002') { duplicates++; continue; }
        throw error;
      }
      if (outcome.duplicate) { duplicates++; continue; }
      ingested++;
      if (outcome.alert) alertsCreated++;
    }

    await db.deviceProvider.update({ where: { id: verifier.resourceId }, data: { lastSyncAt: new Date() } }).catch(() => {});
    await db.deviceProviderSyncLog.create({
      data: {
        tenantId,
        providerKind: 'device',
        providerKey: key,
        direction: 'inbound',
        event: 'webhook',
        status: 'processed',
        httpStatus: 200,
        signatureValid,
        readingsIngested: ingested,
        alertsCreated,
        message: `Normalized ${ingested} reading(s), ${alertsCreated} alert(s)${duplicates ? `, ${duplicates} duplicate(s) skipped` : ''}${invalid ? `, ${invalid} invalid reading(s) rejected` : ''}`,
        payload: (request.body ?? {}) as object,
      },
    });
    return reply.send({ received: readings.length, ingested, alertsCreated, duplicates, invalid, signatureValid });
  });
};
