import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../../lib/db';
import { audit } from '../../lib/audit';
import { requireRoles } from '../../plugins/roles';
import { requireFeature } from '../../lib/entitlements';
import { assertBranchAccess, branchScope } from '../../lib/scope';
import { resolveRule, evaluateSeverity, computeRiskScore, SEVERITY_RANK, DEFAULT_THRESHOLDS } from '../../lib/monitoring';
import { aiMorningBriefingService } from '../../lib/ai/services';

const uuid = z.string().uuid();
const readRoles = requireRoles('OWNER', 'ADMIN', 'MANAGER', 'PROVIDER');
const ingestRoles = requireRoles('OWNER', 'ADMIN', 'MANAGER');

const OPEN_STATUSES = ['open', 'acknowledged', 'assigned'];
const READING_TYPES = ['glucose', 'blood_pressure', 'oxygen', 'weight', 'temperature', 'heart_rate', 'ecg'] as const;

function startOfToday(): Date { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }

async function patientNameMap(tenantId: string, ids: (string | null | undefined)[]) {
  const unique = [...new Set(ids.filter((v): v is string => !!v))];
  if (!unique.length) return new Map<string, string>();
  const rows = await db.patient.findMany({ where: { id: { in: unique }, tenantId }, select: { id: true, firstName: true, lastName: true } });
  return new Map(rows.map(p => [p.id, `${p.firstName} ${p.lastName}`]));
}
async function userNameMap(tenantId: string, ids: (string | null | undefined)[]) {
  const unique = [...new Set(ids.filter((v): v is string => !!v))];
  if (!unique.length) return new Map<string, string>();
  const rows = await db.user.findMany({ where: { id: { in: unique }, tenantId }, select: { id: true, displayName: true, role: true } });
  return new Map(rows.map(u => [u.id, u.displayName]));
}
async function deviceNameMap(tenantId: string, ids: (string | null | undefined)[]) {
  const unique = [...new Set(ids.filter((v): v is string => !!v))];
  if (!unique.length) return new Map<string, { name: string; deviceType: string; status: string }>();
  const rows = await db.device.findMany({ where: { id: { in: unique }, tenantId }, select: { id: true, name: true, deviceType: true, status: true } });
  return new Map(rows.map(d => [d.id, { name: d.name, deviceType: d.deviceType, status: d.status }]));
}

export const monitoringRoutes: FastifyPluginAsync = async app => {
  // Entire monitoring surface requires the device_integration entitlement.
  app.addHook('preHandler', requireFeature('device_integration'));
  // Read access for clinical + leadership roles.
  app.addHook('preHandler', readRoles);

  // ── Overview: KPIs + recent readings + device health + notifications ───────
  app.get('/overview', async request => {
    const tenantId = request.auth.tenantId;
    const scope = branchScope(request);
    const todayStart = startOfToday();

    const [readingsToday, openAlerts, criticalAlerts, missedReadings, offlineDevices, atRiskPatients, recentRaw, offlineRaw, notifRaw, assignableUsers] = await Promise.all([
      db.deviceReading.count({ where: { tenantId, ...scope, capturedAt: { gte: todayStart } } }),
      db.readingAlert.count({ where: { tenantId, ...scope, status: { in: OPEN_STATUSES } } }),
      db.readingAlert.count({ where: { tenantId, ...scope, severity: 'critical', status: { in: OPEN_STATUSES } } }),
      db.readingAlert.count({ where: { tenantId, ...scope, alertType: 'missed_reading', status: { in: OPEN_STATUSES } } }),
      db.device.count({ where: { tenantId, ...scope, active: true, status: { in: ['offline', 'error'] } } }),
      db.readingAlert.findMany({ where: { tenantId, ...scope, status: { in: OPEN_STATUSES }, severity: { in: ['high', 'critical'] } }, select: { patientId: true }, distinct: ['patientId'] }),
      db.deviceReading.findMany({ where: { tenantId, ...scope }, orderBy: { capturedAt: 'desc' }, take: 40 }),
      db.device.findMany({ where: { tenantId, ...scope, active: true, status: { in: ['offline', 'error'] } }, select: { id: true, name: true, deviceType: true, status: true, branchId: true, location: true, lastSeenAt: true } }),
      db.notificationEvent.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' }, take: 10 }),
      db.user.findMany({ where: { tenantId, active: true, role: { in: ['OWNER', 'ADMIN', 'MANAGER', 'PROVIDER'] } }, select: { id: true, displayName: true, role: true }, orderBy: { displayName: 'asc' }, take: 50 }),
    ]);

    const pNames = await patientNameMap(tenantId, [...recentRaw.map(r => r.patientId), ...notifRaw.map(n => n.patientId)]);
    const dNames = await deviceNameMap(tenantId, recentRaw.map(r => r.deviceId));
    const uNames = await userNameMap(tenantId, notifRaw.map(n => n.recipientUserId));

    // Trend vs previous same patient+type reading within the batch.
    const seen = new Map<string, number>();
    const recentReadings = recentRaw.slice(0, 12).map(r => {
      const key = `${r.patientId}|${r.readingType}`;
      const prev = seen.get(key);
      if (r.numericValue != null && !seen.has(key)) seen.set(key, r.numericValue);
      const trend = r.numericValue != null && prev != null ? (r.numericValue > prev ? 'up' : r.numericValue < prev ? 'down' : 'flat') : 'flat';
      return {
        id: r.id, patientName: r.patientId ? pNames.get(r.patientId) ?? 'Unknown' : 'Unassigned',
        deviceName: r.deviceId ? dNames.get(r.deviceId)?.name ?? 'Unknown device' : 'Manual entry',
        readingType: r.readingType, value: r.value, unit: r.unit, capturedAt: r.capturedAt,
        validationStatus: r.validationStatus, source: r.source, trend,
      };
    });

    const offlinePatientCounts = await Promise.all(offlineRaw.map(async d => ({
      id: d.id,
      patients: (await db.deviceReading.findMany({ where: { tenantId, deviceId: d.id }, select: { patientId: true }, distinct: ['patientId'] })).filter(x => x.patientId).length,
    })));
    const offMap = new Map(offlinePatientCounts.map(o => [o.id, o.patients]));

    return {
      summary: {
        readingsToday, openAlerts, criticalAlerts, missedReadings, offlineDevices, patientsAtRisk: atRiskPatients.filter(a => a.patientId).length,
      },
      recentReadings,
      deviceHealth: offlineRaw.map(d => ({ id: d.id, name: d.name, deviceType: d.deviceType, status: d.status, branchId: d.branchId, location: d.location, lastSeenAt: d.lastSeenAt, patientsMonitored: offMap.get(d.id) ?? 0 })),
      notifications: notifRaw.map(n => ({
        id: n.id, recipientType: n.recipientType, recipientName: n.recipientUserId ? uNames.get(n.recipientUserId) ?? n.recipientLabel : n.recipientLabel,
        patientName: n.patientId ? pNames.get(n.patientId) ?? null : null, channel: n.channel, status: n.status, attempts: n.attempts,
        failureReason: n.failureReason, consentChecked: n.consentChecked, consentResult: n.consentResult, createdAt: n.createdAt,
      })),
      assignableUsers: assignableUsers.map(u => ({ id: u.id, name: u.displayName, role: u.role })),
    };
  });

  // ── Readings list ──────────────────────────────────────────────────────────
  app.get('/readings', async request => {
    const q = z.object({ patientId: uuid.optional(), readingType: z.enum(READING_TYPES).optional(), limit: z.coerce.number().min(1).max(200).default(50) }).parse(request.query);
    const tenantId = request.auth.tenantId;
    const rows = await db.deviceReading.findMany({
      where: { tenantId, ...branchScope(request), ...(q.patientId ? { patientId: q.patientId } : {}), ...(q.readingType ? { readingType: q.readingType } : {}) },
      orderBy: { capturedAt: 'desc' }, take: q.limit,
    });
    const pNames = await patientNameMap(tenantId, rows.map(r => r.patientId));
    const dNames = await deviceNameMap(tenantId, rows.map(r => r.deviceId));
    return rows.map(r => ({
      id: r.id, patientName: r.patientId ? pNames.get(r.patientId) ?? 'Unknown' : 'Unassigned',
      deviceName: r.deviceId ? dNames.get(r.deviceId)?.name ?? 'Unknown device' : 'Manual entry',
      readingType: r.readingType, value: r.value, unit: r.unit, capturedAt: r.capturedAt, receivedAt: r.receivedAt,
      source: r.source, validationStatus: r.validationStatus,
    }));
  });

  // ── Alert queue ────────────────────────────────────────────────────────────
  app.get('/alerts', async request => {
    const q = z.object({ status: z.enum(['open', 'acknowledged', 'assigned', 'resolved']).optional(), severity: z.enum(['normal', 'warning', 'high', 'critical']).optional() }).parse(request.query);
    const tenantId = request.auth.tenantId;
    const rows = await db.readingAlert.findMany({
      where: { tenantId, ...branchScope(request), ...(q.status ? { status: q.status } : {}), ...(q.severity ? { severity: q.severity } : {}) },
      orderBy: { createdAt: 'desc' }, take: 100,
    });
    const pNames = await patientNameMap(tenantId, rows.map(r => r.patientId));
    const uNames = await userNameMap(tenantId, rows.map(r => r.assignedToUserId));
    const readingIds = rows.map(r => r.readingId).filter((v): v is string => !!v);
    const readings = readingIds.length ? await db.deviceReading.findMany({ where: { id: { in: readingIds }, tenantId }, select: { id: true, readingType: true, value: true, unit: true } }) : [];
    const rMap = new Map(readings.map(r => [r.id, r]));
    return rows
      .map(a => {
        const reading = a.readingId ? rMap.get(a.readingId) : null;
        return {
          id: a.id, patientName: a.patientId ? pNames.get(a.patientId) ?? 'Unknown' : 'Unassigned',
          readingType: reading?.readingType ?? null, value: reading?.value ?? null, unit: reading?.unit ?? null,
          severity: a.severity, alertType: a.alertType, status: a.status,
          assignedTo: a.assignedToUserId ? uNames.get(a.assignedToUserId) ?? null : null,
          generatedReason: a.generatedReason, createdAt: a.createdAt, acknowledgedAt: a.acknowledgedAt, resolvedAt: a.resolvedAt,
        };
      })
      .sort((a, b) => (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0));
  });

  // ── Alert actions (acknowledge / assign / resolve) ─────────────────────────
  async function loadAlert(request: { auth: { tenantId: string } }, id: string) {
    const alert = await db.readingAlert.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!alert) throw app.httpErrors.notFound('Alert not found');
    return alert;
  }

  app.patch('/alerts/:id/acknowledge', async request => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const alert = await loadAlert(request, id);
    if (alert.branchId) assertBranchAccess(request, alert.branchId);
    const updated = await db.readingAlert.update({ where: { id }, data: { status: alert.status === 'open' ? 'acknowledged' : alert.status, acknowledgedAt: alert.acknowledgedAt ?? new Date() }, select: { id: true, status: true, acknowledgedAt: true } });
    await audit(request, { action: 'monitoring.alert.acknowledged', resource: 'readingAlert', resourceId: id });
    return updated;
  });

  app.patch('/alerts/:id/assign', async request => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const { assignedToUserId } = z.object({ assignedToUserId: uuid }).parse(request.body);
    const alert = await loadAlert(request, id);
    if (alert.branchId) assertBranchAccess(request, alert.branchId);
    const assignee = await db.user.findFirst({ where: { id: assignedToUserId, tenantId: request.auth.tenantId, active: true }, select: { id: true, displayName: true } });
    if (!assignee) throw app.httpErrors.badRequest('Assignee not found in this workspace');
    const updated = await db.readingAlert.update({ where: { id }, data: { assignedToUserId, status: alert.status === 'resolved' ? alert.status : 'assigned', acknowledgedAt: alert.acknowledgedAt ?? new Date() }, select: { id: true, status: true, assignedToUserId: true } });
    await audit(request, { action: 'monitoring.alert.assigned', resource: 'readingAlert', resourceId: id, metadata: { assignedTo: assignee.displayName } });
    return { ...updated, assignedToName: assignee.displayName };
  });

  app.patch('/alerts/:id/resolve', async request => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const { note } = z.object({ note: z.string().trim().max(500).optional() }).parse(request.body ?? {});
    const alert = await loadAlert(request, id);
    if (alert.branchId) assertBranchAccess(request, alert.branchId);
    const updated = await db.readingAlert.update({ where: { id }, data: { status: 'resolved', resolvedAt: new Date() }, select: { id: true, status: true, resolvedAt: true } });
    await audit(request, { action: 'monitoring.alert.resolved', resource: 'readingAlert', resourceId: id, metadata: note ? { note } : undefined });
    return updated;
  });

  // ── Patients at risk (operational urgency summary, not diagnosis) ──────────
  app.get('/patients-at-risk', async request => {
    const tenantId = request.auth.tenantId;
    const scope = branchScope(request);
    const since = new Date(Date.now() - 24 * 36e5);
    const [openAlerts, recentAbnormal, missed] = await Promise.all([
      db.readingAlert.findMany({ where: { tenantId, ...scope, status: { in: OPEN_STATUSES } }, select: { patientId: true, severity: true, assignedToUserId: true, createdAt: true } }),
      db.deviceReading.findMany({ where: { tenantId, ...scope, capturedAt: { gte: since }, validationStatus: 'valid' }, select: { patientId: true, numericValue: true, readingType: true, capturedAt: true } }),
      db.readingAlert.findMany({ where: { tenantId, ...scope, alertType: 'missed_reading', status: { in: OPEN_STATUSES } }, select: { patientId: true } }),
    ]);

    const patientIds = [...new Set([...openAlerts, ...missed].map(a => a.patientId).filter((v): v is string => !!v))];
    const pNames = await patientNameMap(tenantId, patientIds);
    const uNames = await userNameMap(tenantId, openAlerts.map(a => a.assignedToUserId));

    const rows = patientIds.map(pid => {
      const alerts = openAlerts.filter(a => a.patientId === pid);
      const abn = recentAbnormal.filter(r => r.patientId === pid);
      const missedCount = missed.filter(m => m.patientId === pid).length;
      const { score, reasons } = computeRiskScore({
        patientId: pid,
        openCritical: alerts.filter(a => a.severity === 'critical').length,
        openHigh: alerts.filter(a => a.severity === 'high').length,
        abnormal24h: abn.length,
        missedReadings: missedCount,
        trendingWorse: false,
      });
      const assignee = alerts.map(a => a.assignedToUserId).find(Boolean);
      const lastReading = abn.sort((a, b) => b.capturedAt.getTime() - a.capturedAt.getTime())[0];
      const recommended = alerts.some(a => a.severity === 'critical') ? 'Escalate for doctor review now'
        : missedCount > 0 ? 'Outreach to capture missed reading'
        : alerts.some(a => a.severity === 'high') ? 'Nurse follow-up today'
        : 'Continue monitoring';
      return {
        patientId: pid, patientName: pNames.get(pid) ?? 'Unknown', riskScore: score, reasons,
        missedReadings: missedCount, lastReadingType: lastReading?.readingType ?? null, lastReadingAt: lastReading?.capturedAt ?? null,
        assignedTo: assignee ? uNames.get(assignee) ?? null : null, recommendedAction: recommended,
      };
    }).filter(r => r.riskScore > 0).sort((a, b) => b.riskScore - a.riskScore);

    return rows;
  });

  // ── Morning briefing (stored signals for today + live counts) ──────────────
  app.get('/morning-briefing', async request => {
    const tenantId = request.auth.tenantId;
    const scope = branchScope(request);
    const dayStart = startOfToday();
    const overnight = new Date(Date.now() - 12 * 36e5);
    const [signals, criticalOpen, missedHigh, offline, abnormalOvernight, unresolvedDeviceAlerts, eligibilityToday, eligibilityFailedToday, rpmReady, reviewPatients] = await Promise.all([
      db.morningBriefingSignal.findMany({ where: { tenantId, forDate: { gte: dayStart } }, orderBy: [{ severity: 'desc' }, { createdAt: 'asc' }] }),
      db.readingAlert.count({ where: { tenantId, ...scope, severity: 'critical', status: { in: OPEN_STATUSES } } }),
      db.readingAlert.count({ where: { tenantId, ...scope, alertType: 'missed_reading', status: { in: OPEN_STATUSES } } }),
      db.device.count({ where: { tenantId, ...scope, active: true, status: { in: ['offline', 'error'] } } }),
      db.readingAlert.count({ where: { tenantId, ...scope, alertType: 'abnormal_reading', createdAt: { gte: overnight } } }),
      db.readingAlert.count({ where: { tenantId, ...scope, status: { in: OPEN_STATUSES } } }),
      db.eligibilityVerification.count({ where: { tenantId, checkedAt: { gte: dayStart } } }),
      db.eligibilityVerification.count({ where: { tenantId, checkedAt: { gte: dayStart }, coverageStatus: { in: ['INACTIVE', 'ERROR'] } } }),
      db.rPMBillingReadiness.count({ where: { tenantId, status: 'READY' } }),
      db.readingAlert.findMany({ where: { tenantId, ...scope, status: { in: OPEN_STATUSES }, severity: { in: ['high', 'critical'] } }, select: { patientId: true }, distinct: ['patientId'] }),
    ]);
    const pNames = await patientNameMap(tenantId, signals.map(s => s.patientId));
    // AI-augmented but evidence-backed: degrades to a deterministic summary if
    // the gateway is blocked/unavailable. Never blocks the briefing.
    const ai = await aiMorningBriefingService.generate(tenantId, request.auth.userId).catch(() => null);
    return {
      generatedAt: new Date(),
      counts: {
        criticalOpen, missedHigh, offlineDevices: offline,
        abnormalOvernight, unresolvedDeviceAlerts,
        insuranceChecksToday: eligibilityToday, eligibilityFailedToday,
        rpmBillingReady: rpmReady, patientsNeedingReview: reviewPatients.filter(r => r.patientId).length,
      },
      ai: ai ? { summary: ai.summary, aiGenerated: ai.aiGenerated, provider: ai.provider, model: ai.model, evidence: ai.evidence } : null,
      signals: signals.map(s => ({ id: s.id, signalType: s.signalType, title: s.title, detail: s.detail, severity: s.severity, metricValue: s.metricValue, patientName: s.patientId ? pNames.get(s.patientId) ?? null : null })),
      disclaimer: 'Operational summary only. Does not provide diagnosis, treatment, or emergency dispatch.',
    };
  });

  // ── Ingest a reading (rate-limited). Backend evaluates severity + alerts. ──
  app.post('/readings/ingest', { preHandler: ingestRoles, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    const body = z.object({
      patientId: uuid.optional(),
      deviceId: uuid.optional(),
      branchId: uuid.optional(),
      readingType: z.enum(READING_TYPES),
      value: z.string().trim().min(1).max(40),
      numericValue: z.number().optional(),
      valueSecondary: z.number().optional(),
      unit: z.string().trim().max(20).optional(),
      capturedAt: z.coerce.date().optional(),
      source: z.enum(['device', 'webhook', 'manual', 'import']).default('manual'),
      rawPayload: z.record(z.string(), z.unknown()).optional(),
    }).parse(request.body);
    const tenantId = request.auth.tenantId;
    if (body.branchId) assertBranchAccess(request, body.branchId);

    let device: { deviceType: string; branchId: string | null } | null = null;
    if (body.deviceId) {
      device = await db.device.findFirst({ where: { id: body.deviceId, tenantId }, select: { deviceType: true, branchId: true } });
      if (!device) throw app.httpErrors.badRequest('Device not found in this workspace');
    }
    const branchId = body.branchId ?? device?.branchId ?? null;

    const reading = await db.deviceReading.create({
      data: {
        tenantId, patientId: body.patientId ?? null, deviceId: body.deviceId ?? null, branchId,
        readingType: body.readingType, value: body.value, numericValue: body.numericValue ?? null,
        valueSecondary: body.valueSecondary ?? null, unit: body.unit ?? DEFAULT_THRESHOLDS[body.readingType]?.unit ?? null,
        capturedAt: body.capturedAt ?? new Date(), source: body.source, validationStatus: 'valid',
        rawPayload: body.rawPayload ? (body.rawPayload as object) : undefined,
      },
      select: { id: true, numericValue: true, readingType: true },
    });

    // Backend decides severity — never the client.
    const rule = await resolveRule(tenantId, { readingType: body.readingType, patientId: body.patientId, deviceType: device?.deviceType, branchId });
    const { severity, reason } = evaluateSeverity(body.readingType, reading.numericValue, rule);

    let alert: { id: string } | null = null;
    if (severity !== 'normal') {
      alert = await db.readingAlert.create({
        data: { tenantId, patientId: body.patientId ?? null, deviceId: body.deviceId ?? null, readingId: reading.id, branchId, severity, alertType: 'abnormal_reading', status: 'open', generatedReason: reason, assignedToUserId: rule?.assignedToUserId ?? null },
        select: { id: true },
      });
      // Queue an in-app staff notification (consent not required for staff).
      const recipientType = severity === 'critical' ? 'doctor' : 'nurse';
      await db.notificationEvent.create({
        data: { tenantId, alertId: alert.id, patientId: body.patientId ?? null, recipientType, recipientUserId: rule?.assignedToUserId ?? null, recipientLabel: rule?.assignedToUserId ? null : `${recipientType} queue`, channel: 'in_app', status: 'sent', attempts: 1, consentChecked: true, consentResult: 'not_required', sentAt: new Date() },
      });
    }

    await audit(request, { action: 'monitoring.reading.ingested', resource: 'deviceReading', resourceId: reading.id, metadata: { readingType: body.readingType, severity } });
    return reply.code(201).send({ readingId: reading.id, severity, reason, alertId: alert?.id ?? null });
  });
};
