import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../../lib/db';
import { audit } from '../../lib/audit';
import { requireRoles } from '../../plugins/roles';
import { requireFeature } from '../../lib/entitlements';
import { assertBranchAccess, branchScope } from '../../lib/scope';
import { resolveRule, evaluateSeverity, computeRiskScore, SEVERITY_RANK, DEFAULT_THRESHOLDS, weightBaselines, severityRank, OPEN_ALERT_STATUSES } from '../../lib/monitoring';
import { aiMorningBriefingService } from '../../lib/ai/services';
import { invalidateRpmProviderSignoff, lockRpmEvidence, rpmPeriodBounds } from '../../lib/connectedCare/rpmEvidence';
import { countCurrentReadyRpmPatients } from '../../lib/connectedCare/rpmReadinessService';

const uuid = z.string().uuid();
const readRoles = requireRoles('OWNER', 'ADMIN', 'MANAGER', 'PROVIDER');
const ingestRoles = requireRoles('OWNER', 'ADMIN', 'MANAGER');
const writeRoles = requireRoles('OWNER', 'ADMIN', 'MANAGER');

const OPEN_STATUSES = ['open', 'acknowledged', 'assigned'];
const READING_TYPES = ['glucose', 'blood_pressure', 'oxygen', 'weight', 'temperature', 'heart_rate', 'ecg'] as const;
type TrendReading = { id: string; patientId: string | null; readingType: string; numericValue: number | null; capturedAt: Date };

// Input arrives newest-first. Compare every reading with the next older value,
// then attach the direction to the newer reading (the prior implementation did
// the reverse and could tell staff a rising value was falling).
export function readingTrendMap(rows: TrendReading[]): Map<string, 'up' | 'down' | 'flat'> {
  const ordered = [...rows].sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime());
  const prior = new Map<string, number>();
  const trends = new Map<string, 'up' | 'down' | 'flat'>();
  for (const row of ordered) {
    if (row.numericValue == null) continue;
    const key = `${row.patientId}|${row.readingType}`;
    const previous = prior.get(key);
    trends.set(row.id, previous == null ? 'flat' : row.numericValue > previous ? 'up' : row.numericValue < previous ? 'down' : 'flat');
    prior.set(key, row.numericValue);
  }
  return trends;
}

const CANONICAL_UNITS: Partial<Record<(typeof READING_TYPES)[number], ReadonlyArray<string>>> = {
  glucose: ['mg/dL'], blood_pressure: ['mmHg'], oxygen: ['%'], weight: ['kg', 'lb'],
  temperature: ['°C'], heart_rate: ['bpm'],
};

export function normalizeManualReading(body: {
  readingType: (typeof READING_TYPES)[number]; value: string; numericValue?: number;
  valueSecondary?: number; unit?: string;
}): { numericValue: number | null; valueSecondary: number | null; unit: string | null } | null {
  if (body.readingType === 'ecg') return { numericValue: null, valueSecondary: null, unit: body.unit ?? null };
  const allowedUnits = CANONICAL_UNITS[body.readingType] ?? [];
  const unit = body.unit ?? DEFAULT_THRESHOLDS[body.readingType]?.unit ?? (body.readingType === 'weight' ? 'kg' : null);
  if (unit && !allowedUnits.includes(unit)) return null;

  if (body.readingType === 'blood_pressure') {
    const match = body.value.trim().match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
    if (!match) return null;
    const systolic = Number(match[1]); const diastolic = Number(match[2]);
    if (systolic < 40 || systolic > 300 || diastolic < 20 || diastolic > 200 || systolic <= diastolic) return null;
    if ((body.numericValue != null && body.numericValue !== systolic) || (body.valueSecondary != null && body.valueSecondary !== diastolic)) return null;
    return { numericValue: systolic, valueSecondary: diastolic, unit };
  }

  const numeric = Number(body.value.trim());
  if (!Number.isFinite(numeric) || (body.numericValue != null && body.numericValue !== numeric)) return null;
  const plausible = body.readingType === 'glucose' ? numeric >= 10 && numeric <= 1000
    : body.readingType === 'oxygen' ? numeric >= 50 && numeric <= 100
    : body.readingType === 'weight' ? (unit === 'lb' ? numeric >= 2 && numeric <= 1100 : numeric >= 1 && numeric <= 500)
    : body.readingType === 'temperature' ? numeric >= 25 && numeric <= 45
    : body.readingType === 'heart_rate' ? numeric >= 20 && numeric <= 300
    : true;
  if (!plausible) return null;
  return { numericValue: numeric, valueSecondary: null, unit };
}

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
    const branchPatientIds = request.auth.branchId
      ? (await db.patient.findMany({ where: { tenantId, branchId: request.auth.branchId, deletedAt: null }, select: { id: true } })).map(p => p.id)
      : null;
    const notificationScope = branchPatientIds
      ? { OR: [{ patientId: { in: branchPatientIds } }, { patientId: null, recipientUserId: request.auth.userId }] }
      : {};

    const [readingsToday, openAlerts, criticalAlerts, missedReadings, offlineDevices, atRiskPatients, recentRaw, offlineRaw, notifRaw, assignableUsers] = await Promise.all([
      db.deviceReading.count({ where: { tenantId, ...scope, capturedAt: { gte: todayStart } } }),
      db.readingAlert.count({ where: { tenantId, ...scope, status: { in: OPEN_STATUSES } } }),
      db.readingAlert.count({ where: { tenantId, ...scope, severity: 'critical', status: { in: OPEN_STATUSES } } }),
      db.readingAlert.count({ where: { tenantId, ...scope, alertType: 'missed_reading', status: { in: OPEN_STATUSES } } }),
      db.device.count({ where: { tenantId, ...scope, active: true, status: { in: ['offline', 'error'] } } }),
      db.readingAlert.findMany({ where: { tenantId, ...scope, status: { in: OPEN_STATUSES }, severity: { in: ['high', 'critical'] } }, select: { patientId: true }, distinct: ['patientId'] }),
      db.deviceReading.findMany({ where: { tenantId, ...scope }, orderBy: { capturedAt: 'desc' }, take: 40 }),
      db.device.findMany({ where: { tenantId, ...scope, active: true, status: { in: ['offline', 'error'] } }, select: { id: true, name: true, deviceType: true, status: true, branchId: true, location: true, lastSeenAt: true } }),
      db.notificationEvent.findMany({ where: { tenantId, ...notificationScope }, orderBy: { createdAt: 'desc' }, take: 10 }),
      db.user.findMany({ where: { tenantId, active: true, ...(request.auth.branchId ? { branchId: request.auth.branchId } : {}), role: { in: ['OWNER', 'ADMIN', 'MANAGER', 'PROVIDER'] } }, select: { id: true, displayName: true, role: true }, orderBy: { displayName: 'asc' }, take: 50 }),
    ]);

    const pNames = await patientNameMap(tenantId, [...recentRaw.map(r => r.patientId), ...notifRaw.map(n => n.patientId)]);
    const dNames = await deviceNameMap(tenantId, recentRaw.map(r => r.deviceId));
    const uNames = await userNameMap(tenantId, notifRaw.map(n => n.recipientUserId));

    // Trend vs the next older same-patient/type reading within the batch.
    const trends = readingTrendMap(recentRaw);
    const recentReadings = recentRaw.slice(0, 12).map(r => {
      return {
        id: r.id, patientName: r.patientId ? pNames.get(r.patientId) ?? 'Unknown' : 'Unassigned',
        deviceName: r.deviceId ? dNames.get(r.deviceId)?.name ?? 'Unknown device' : 'Manual entry',
        readingType: r.readingType, value: r.value, unit: r.unit, capturedAt: r.capturedAt,
        validationStatus: r.validationStatus, source: r.source, trend: trends.get(r.id) ?? 'flat',
      };
    });

    const offlinePatientCounts = await Promise.all(offlineRaw.map(async d => ({
      id: d.id,
      patients: (await db.deviceReading.findMany({ where: { tenantId, deviceId: d.id }, select: { patientId: true }, distinct: ['patientId'] })).filter(x => x.patientId).length,
    })));
    const offMap = new Map(offlinePatientCounts.map(o => [o.id, o.patients]));

    // HIPAA access accounting — this view surfaces patient names + readings. Id-only.
    await audit(request, { action: 'monitoring.read', resource: 'monitoring', metadata: { view: 'overview' } });
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
    // HIPAA access accounting — patient names + clinical readings. Id-only.
    await audit(request, { action: 'monitoring.read', resource: 'monitoring', metadata: { view: 'readings', count: rows.length } });
    return rows.map(r => ({
      id: r.id, patientName: r.patientId ? pNames.get(r.patientId) ?? 'Unknown' : 'Unassigned',
      deviceName: r.deviceId ? dNames.get(r.deviceId)?.name ?? 'Unknown device' : 'Manual entry',
      readingType: r.readingType, value: r.value, unit: r.unit, capturedAt: r.capturedAt, receivedAt: r.receivedAt,
      source: r.source, validationStatus: r.validationStatus,
    }));
  });

  // ── Alert queue ────────────────────────────────────────────────────────────
  app.get('/alerts', async request => {
    const q = z.object({
      status: z.enum(['open', 'acknowledged', 'assigned', 'resolved']).optional(),
      severity: z.enum(['normal', 'warning', 'high', 'critical']).optional(),
      // Default to outstanding work. The queue previously fetched the 100 most
      // RECENT alerts of ANY status and sorted by severity only AFTER
      // truncating, while the client filtered resolved ones out in the browser.
      // A tenant with 100+ recent resolved alerts therefore rendered "no open
      // alerts" while genuinely open criticals sat just outside the window — a
      // false all-clear in a patient-monitoring queue.
      includeResolved: z.coerce.boolean().default(false),
      limit: z.coerce.number().min(1).max(200).default(100),
    }).parse(request.query);
    const tenantId = request.auth.tenantId;
    const where = {
      tenantId,
      ...branchScope(request),
      ...(q.status ? { status: q.status } : q.includeResolved ? {} : { status: { in: [...OPEN_ALERT_STATUSES] } }),
      ...(q.severity ? { severity: q.severity } : {}),
    };
    // Acuity ordering is applied by the DATABASE, before the row limit, so the
    // most severe alerts can never be truncated away by newer trivial ones.
    const [rows, matching] = await Promise.all([
      db.readingAlert.findMany({
        where,
        orderBy: [{ severityRank: 'desc' }, { createdAt: 'desc' }],
        take: q.limit,
      }),
      db.readingAlert.count({ where }),
    ]);
    const pNames = await patientNameMap(tenantId, rows.map(r => r.patientId));
    const uNames = await userNameMap(tenantId, rows.map(r => r.assignedToUserId));
    const readingIds = rows.map(r => r.readingId).filter((v): v is string => !!v);
    const readings = readingIds.length ? await db.deviceReading.findMany({ where: { id: { in: readingIds }, tenantId }, select: { id: true, readingType: true, value: true, unit: true } }) : [];
    const rMap = new Map(readings.map(r => [r.id, r]));
    // HIPAA access accounting — alert queue surfaces patient names. Id-only.
    await audit(request, { action: 'monitoring.read', resource: 'monitoring', metadata: { view: 'alerts', count: rows.length } });
    const items = rows
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
    // `truncated` lets the UI say "showing 100 of 143" instead of silently
    // implying the list is the whole queue.
    return { items, total: matching, limit: q.limit, truncated: matching > items.length };
  });

  // ── Monitoring rules (thresholds, cadence, routing) ────────────────────────
  //
  // Until now MonitoringRule had NO write path anywhere in the product: no
  // route, no screen, no seeder. Only the test suite ever created one. Two
  // consequences followed from that, and both are bigger than they look.
  //
  // First, every tenant ran on the hardcoded DEFAULT_THRESHOLDS bands. A clinic
  // could not widen a band for a patient on a protocol that makes the default
  // wrong, so the product either cried wolf or stayed silent, and the clinic had
  // no recourse either way.
  //
  // Second — and worse — `missedAfterHours` lives only on this model. The
  // missed-reading detector skips any patient whose resolved cadence is null, so
  // with no rules in existence it checked nothing, created nothing, and the
  // "Missed Readings" figure was structurally zero forever. A monitoring product
  // silently not looking for missed readings is a safety problem, not a gap.

  const ruleInput = z.object({
    scope: z.enum(['organization', 'branch', 'patient', 'device_type']).default('organization'),
    branchId: uuid.nullish(),
    patientId: uuid.nullish(),
    deviceType: z.string().trim().max(60).nullish(),
    readingType: z.enum(READING_TYPES),
    minValue: z.number().nullish(),
    maxValue: z.number().nullish(),
    criticalMin: z.number().nullish(),
    criticalMax: z.number().nullish(),
    missedAfterHours: z.number().int().min(1).max(24 * 30).nullish(),
    assignedToUserId: uuid.nullish(),
    priority: z.number().int().min(0).max(1000).default(0),
    active: z.boolean().default(true),
  });

  /** A band must be orderable, or it silently never fires the severity it names. */
  function assertCoherentBand(input: z.infer<typeof ruleInput>) {
    const { minValue, maxValue, criticalMin, criticalMax } = input;
    if (minValue != null && maxValue != null && minValue >= maxValue) {
      throw app.httpErrors.badRequest('The safe range is inverted: the minimum must be below the maximum.');
    }
    if (criticalMin != null && minValue != null && criticalMin > minValue) {
      throw app.httpErrors.badRequest('The critical low must be at or below the safe minimum, otherwise the safe range sits inside the critical range.');
    }
    if (criticalMax != null && maxValue != null && criticalMax < maxValue) {
      throw app.httpErrors.badRequest('The critical high must be at or above the safe maximum, otherwise the safe range sits inside the critical range.');
    }
    if (input.scope === 'patient' && !input.patientId) throw app.httpErrors.badRequest('A patient-scoped rule needs a patient.');
    if (input.scope === 'branch' && !input.branchId) throw app.httpErrors.badRequest('A branch-scoped rule needs a branch.');
    if (input.scope === 'device_type' && !input.deviceType) throw app.httpErrors.badRequest('A device-type rule needs a device type.');
  }

  app.get('/rules', async request => {
    const tenantId = request.auth.tenantId;
    const rows = await db.monitoringRule.findMany({
      where: { tenantId, ...branchScope(request) },
      orderBy: [{ readingType: 'asc' }, { priority: 'desc' }, { createdAt: 'asc' }],
      take: 200,
    });
    await audit(request, { action: 'monitoring.rule.list_read', resource: 'monitoringRule', metadata: { count: rows.length } });
    return {
      rules: rows,
      // The bands in force when no rule matches. Sent so the screen can show a
      // clinic what it is actually running on instead of an empty list that
      // reads as "nothing is being monitored".
      defaults: DEFAULT_THRESHOLDS,
      readingTypes: READING_TYPES,
    };
  });

  app.post('/rules', { preHandler: writeRoles }, async (request, reply) => {
    const input = ruleInput.parse(request.body);
    assertCoherentBand(input);
    const tenantId = request.auth.tenantId;
    if (input.branchId) assertBranchAccess(request, input.branchId);
    if (input.patientId) {
      const patient = await db.patient.findFirst({ where: { id: input.patientId, tenantId, deletedAt: null }, select: { branchId: true } });
      if (!patient) throw app.httpErrors.notFound('Patient not found');
      assertBranchAccess(request, patient.branchId);
    }
    const row = await db.monitoringRule.create({ data: { ...input, tenantId } });
    await audit(request, { action: 'monitoring.rule.created', resource: 'monitoringRule', resourceId: row.id, metadata: { readingType: row.readingType, scope: row.scope } });
    return reply.code(201).send(row);
  });

  app.patch('/rules/:id', { preHandler: writeRoles }, async request => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const input = ruleInput.partial().parse(request.body);
    const tenantId = request.auth.tenantId;
    const existing = await db.monitoringRule.findFirst({ where: { id, tenantId } });
    if (!existing) throw app.httpErrors.notFound('Rule not found');
    if (existing.branchId) assertBranchAccess(request, existing.branchId);
    const merged = { ...existing, ...input } as z.infer<typeof ruleInput>;
    assertCoherentBand(merged);
    const row = await db.monitoringRule.update({ where: { id: existing.id }, data: input });
    await audit(request, { action: 'monitoring.rule.updated', resource: 'monitoringRule', resourceId: id, metadata: { readingType: row.readingType, active: row.active } });
    return row;
  });

  app.delete('/rules/:id', { preHandler: writeRoles }, async (request, reply) => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const tenantId = request.auth.tenantId;
    const existing = await db.monitoringRule.findFirst({ where: { id, tenantId } });
    if (!existing) throw app.httpErrors.notFound('Rule not found');
    if (existing.branchId) assertBranchAccess(request, existing.branchId);
    // Deactivate rather than delete: a rule is the reason an alert did or did
    // not fire, so removing the row destroys the explanation for past alerts.
    await db.monitoringRule.update({ where: { id: existing.id }, data: { active: false } });
    await audit(request, { action: 'monitoring.rule.deactivated', resource: 'monitoringRule', resourceId: id, metadata: { readingType: existing.readingType } });
    return reply.code(204).send();
  });

  // ── Alert actions (acknowledge / assign / resolve) ─────────────────────────
  async function loadAlert(request: { auth: { tenantId: string } }, id: string) {
    const alert = await db.readingAlert.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!alert) throw app.httpErrors.notFound('Alert not found');
    return alert;
  }

  app.patch('/alerts/:id/acknowledge', { preHandler: writeRoles }, async request => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const alert = await loadAlert(request, id);
    if (alert.branchId) assertBranchAccess(request, alert.branchId);
    if (alert.status === 'resolved') throw app.httpErrors.conflict('A resolved alert cannot be acknowledged');
    if (alert.status !== 'open') return { id: alert.id, status: alert.status, acknowledgedAt: alert.acknowledgedAt, deduped: true };
    const changed = await db.readingAlert.updateMany({ where: { id, tenantId: request.auth.tenantId, status: 'open' }, data: { status: 'acknowledged', acknowledgedAt: alert.acknowledgedAt ?? new Date() } });
    if (changed.count !== 1) throw app.httpErrors.conflict('Alert changed concurrently; refresh and retry');
    const updated = await db.readingAlert.findUniqueOrThrow({ where: { id }, select: { id: true, status: true, acknowledgedAt: true } });
    await audit(request, { action: 'monitoring.alert.acknowledged', resource: 'readingAlert', resourceId: id });
    return updated;
  });

  app.patch('/alerts/:id/assign', { preHandler: writeRoles }, async request => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const { assignedToUserId } = z.object({ assignedToUserId: uuid }).parse(request.body);
    const alert = await loadAlert(request, id);
    if (alert.branchId) assertBranchAccess(request, alert.branchId);
    if (alert.status === 'resolved') throw app.httpErrors.conflict('A resolved alert cannot be reassigned');
    const assignee = await db.user.findFirst({ where: { id: assignedToUserId, tenantId: request.auth.tenantId, active: true }, select: { id: true, displayName: true } });
    if (!assignee) throw app.httpErrors.badRequest('Assignee not found in this workspace');
    const changed = await db.readingAlert.updateMany({ where: { id, tenantId: request.auth.tenantId, status: alert.status }, data: { assignedToUserId, status: 'assigned', acknowledgedAt: alert.acknowledgedAt ?? new Date() } });
    if (changed.count !== 1) throw app.httpErrors.conflict('Alert changed concurrently; refresh and retry');
    const updated = await db.readingAlert.findUniqueOrThrow({ where: { id }, select: { id: true, status: true, assignedToUserId: true } });
    await audit(request, { action: 'monitoring.alert.assigned', resource: 'readingAlert', resourceId: id, metadata: { assignedTo: assignee.displayName } });
    return { ...updated, assignedToName: assignee.displayName };
  });

  app.patch('/alerts/:id/resolve', { preHandler: writeRoles }, async request => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const { note } = z.object({ note: z.string().trim().max(500).optional() }).parse(request.body ?? {});
    const alert = await loadAlert(request, id);
    if (alert.branchId) assertBranchAccess(request, alert.branchId);
    if (alert.status === 'resolved') return { id: alert.id, status: alert.status, resolvedAt: alert.resolvedAt, deduped: true };
    const changed = await db.readingAlert.updateMany({ where: { id, tenantId: request.auth.tenantId, status: alert.status }, data: { status: 'resolved', resolvedAt: new Date() } });
    if (changed.count !== 1) throw app.httpErrors.conflict('Alert changed concurrently; refresh and retry');
    const updated = await db.readingAlert.findUniqueOrThrow({ where: { id }, select: { id: true, status: true, resolvedAt: true } });
    await audit(request, { action: 'monitoring.alert.resolved', resource: 'readingAlert', resourceId: id, metadata: note ? { note } : undefined });
    return updated;
  });

  // ── Patients at risk (operational urgency summary, not diagnosis) ──────────
  app.get('/patients-at-risk', async request => {
    const tenantId = request.auth.tenantId;
    const scope = branchScope(request);
    const since = new Date(Date.now() - 24 * 36e5);
    const [openAlerts, recentAbnormalAlerts, missed] = await Promise.all([
      db.readingAlert.findMany({ where: { tenantId, ...scope, status: { in: OPEN_STATUSES } }, select: { patientId: true, severity: true, assignedToUserId: true, createdAt: true } }),
      // Only alerts produced by abnormal-reading evaluation count as abnormal.
      // Counting every valid reading here inflated operational risk scores.
      db.readingAlert.findMany({ where: { tenantId, ...scope, alertType: 'abnormal_reading', createdAt: { gte: since } }, select: { patientId: true, readingId: true, createdAt: true } }),
      db.readingAlert.findMany({ where: { tenantId, ...scope, alertType: 'missed_reading', status: { in: OPEN_STATUSES } }, select: { patientId: true } }),
    ]);

    const abnormalReadingIds = recentAbnormalAlerts.map(a => a.readingId).filter((v): v is string => !!v);
    const abnormalReadings = abnormalReadingIds.length ? await db.deviceReading.findMany({
      where: { tenantId, id: { in: abnormalReadingIds } }, select: { id: true, readingType: true, capturedAt: true },
    }) : [];
    const abnormalReadingMap = new Map(abnormalReadings.map(r => [r.id, r]));

    const patientIds = [...new Set([...openAlerts, ...missed].map(a => a.patientId).filter((v): v is string => !!v))];
    const pNames = await patientNameMap(tenantId, patientIds);
    const uNames = await userNameMap(tenantId, openAlerts.map(a => a.assignedToUserId));

    const rows = patientIds.map(pid => {
      const alerts = openAlerts.filter(a => a.patientId === pid);
      const abn = recentAbnormalAlerts.filter(r => r.patientId === pid);
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
      const lastAlert = [...abn].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
      const lastReading = lastAlert?.readingId ? abnormalReadingMap.get(lastAlert.readingId) : null;
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

    // HIPAA access accounting — surfaces at-risk patient names. Id-only.
    await audit(request, { action: 'monitoring.read', resource: 'monitoring', metadata: { view: 'patients_at_risk', count: rows.length } });
    return rows;
  });

  // ── Morning briefing (stored signals for today + live counts) ──────────────
  app.get('/morning-briefing', async request => {
    const tenantId = request.auth.tenantId;
    const scope = branchScope(request);
    const dayStart = startOfToday();
    const overnight = new Date(Date.now() - 12 * 36e5);
    const branchPatientIds = request.auth.branchId
      ? (await db.patient.findMany({ where: { tenantId, branchId: request.auth.branchId, deletedAt: null }, select: { id: true } })).map(p => p.id)
      : null;
    const [signals, criticalOpen, missedHigh, offline, abnormalOvernight, unresolvedDeviceAlerts, eligibilityToday, eligibilityFailedToday, rpmReady, reviewPatients] = await Promise.all([
      db.morningBriefingSignal.findMany({ where: { tenantId, ...scope, forDate: { gte: dayStart } }, orderBy: [{ severity: 'desc' }, { createdAt: 'asc' }] }),
      db.readingAlert.count({ where: { tenantId, ...scope, severity: 'critical', status: { in: OPEN_STATUSES } } }),
      db.readingAlert.count({ where: { tenantId, ...scope, alertType: 'missed_reading', status: { in: OPEN_STATUSES } } }),
      db.device.count({ where: { tenantId, ...scope, active: true, status: { in: ['offline', 'error'] } } }),
      db.readingAlert.count({ where: { tenantId, ...scope, alertType: 'abnormal_reading', createdAt: { gte: overnight } } }),
      db.readingAlert.count({ where: { tenantId, ...scope, status: { in: OPEN_STATUSES } } }),
      db.eligibilityVerification.count({ where: { tenantId, ...scope, checkedAt: { gte: dayStart } } }),
      db.eligibilityVerification.count({ where: { tenantId, ...scope, checkedAt: { gte: dayStart }, coverageStatus: { in: ['INACTIVE', 'ERROR'] } } }),
      countCurrentReadyRpmPatients(tenantId, branchPatientIds),
      db.readingAlert.findMany({ where: { tenantId, ...scope, status: { in: OPEN_STATUSES }, severity: { in: ['high', 'critical'] } }, select: { patientId: true }, distinct: ['patientId'] }),
    ]);
    const pNames = await patientNameMap(tenantId, signals.map(s => s.patientId));
    // AI-augmented but evidence-backed: degrades to a deterministic summary if
    // the gateway is blocked/unavailable. Never blocks the briefing.
    // The current AI briefing service is tenant-wide. Until it accepts an
    // enforced branch filter, do not expose its summary to branch-restricted users.
    const ai = request.auth.branchId ? null : await aiMorningBriefingService.generate(tenantId, request.auth.userId).catch(() => null);
    // HIPAA access accounting — briefing signals surface patient names. Id-only.
    await audit(request, { action: 'monitoring.read', resource: 'monitoring', metadata: { view: 'morning_briefing' } });
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

  // ── Morning briefing signal CRUD ──────────────────────────────────────────
  async function loadBriefingSignal(request: { auth: { tenantId: string } }, id: string) {
    const signal = await db.morningBriefingSignal.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!signal) throw app.httpErrors.notFound('Morning briefing signal not found');
    return signal;
  }

  app.get('/morning-briefing/signals', async request => {
    const q = z.object({
      forDate: z.coerce.date().optional(),
      signalType: z.string().trim().max(120).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(100),
    }).parse(request.query);
    const forDateFilter = q.forDate ? (() => {
      const start = new Date(q.forDate);
      start.setHours(0, 0, 0, 0);
      const end = new Date(start);
      end.setDate(end.getDate() + 1);
      return { gte: start, lt: end };
    })() : undefined;
    const rows = await db.morningBriefingSignal.findMany({
      where: {
        tenantId: request.auth.tenantId,
        ...branchScope(request),
        ...(forDateFilter ? { forDate: forDateFilter } : {}),
        ...(q.signalType ? { signalType: q.signalType } : {}),
      },
      orderBy: [{ forDate: 'desc' }, { severity: 'desc' }, { createdAt: 'asc' }],
      take: q.limit,
    });
    return rows;
  });

  app.post('/morning-briefing/signals', { preHandler: writeRoles }, async request => {
    const body = z.object({
      branchId: uuid.optional(),
      signalType: z.string().trim().min(2).max(120),
      title: z.string().trim().min(2).max(200),
      detail: z.string().trim().max(500).optional(),
      severity: z.enum(['info', 'warning', 'critical']).default('info'),
      metricValue: z.coerce.number().int().optional(),
      patientId: uuid.optional(),
      forDate: z.coerce.date().optional(),
    }).parse(request.body);
    if (body.branchId) assertBranchAccess(request, body.branchId);
    let patientBranchId: string | null = null;
    if (body.patientId) {
      const patient = await db.patient.findFirst({ where: { id: body.patientId, tenantId: request.auth.tenantId, deletedAt: null }, select: { id: true, branchId: true } });
      if (!patient) throw app.httpErrors.badRequest('Patient not found in this workspace');
      assertBranchAccess(request, patient.branchId);
      if (body.branchId && body.branchId !== patient.branchId) throw app.httpErrors.badRequest('Signal branch must match the patient branch');
      patientBranchId = patient.branchId;
    }
    const row = await db.morningBriefingSignal.create({
      data: {
        tenantId: request.auth.tenantId,
        branchId: body.branchId ?? patientBranchId,
        signalType: body.signalType,
        title: body.title,
        detail: body.detail ?? null,
        severity: body.severity,
        metricValue: body.metricValue ?? null,
        patientId: body.patientId ?? null,
        forDate: body.forDate ?? new Date(),
      },
    });
    await audit(request, { action: 'monitoring.morning_briefing_signal.created', resource: 'morningBriefingSignal', resourceId: row.id, metadata: { signalType: row.signalType, severity: row.severity } });
    return row;
  });

  app.patch('/morning-briefing/signals/:id', { preHandler: writeRoles }, async request => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const body = z.object({
      branchId: uuid.nullish(),
      signalType: z.string().trim().min(2).max(120).optional(),
      title: z.string().trim().min(2).max(200).optional(),
      detail: z.string().trim().max(500).nullable().optional(),
      severity: z.enum(['info', 'warning', 'critical']).optional(),
      metricValue: z.coerce.number().int().nullable().optional(),
      patientId: uuid.nullish(),
      forDate: z.coerce.date().optional(),
    }).parse(request.body ?? {});
    const current = await loadBriefingSignal(request, id);
    if (current.branchId) assertBranchAccess(request, current.branchId);
    const nextBranchId = body.branchId === undefined ? current.branchId : body.branchId;
    if (nextBranchId) assertBranchAccess(request, nextBranchId);
    const nextPatientId = body.patientId === undefined ? current.patientId : body.patientId;
    if (nextPatientId) {
      const patient = await db.patient.findFirst({ where: { id: nextPatientId, tenantId: request.auth.tenantId, deletedAt: null }, select: { id: true, branchId: true } });
      if (!patient) throw app.httpErrors.badRequest('Patient not found in this workspace');
      assertBranchAccess(request, patient.branchId);
      if (nextBranchId && nextBranchId !== patient.branchId) throw app.httpErrors.badRequest('Signal branch must match the patient branch');
    }
    const row = await db.morningBriefingSignal.update({
      where: { id },
      data: {
        branchId: body.branchId !== undefined ? body.branchId : undefined,
        signalType: body.signalType,
        title: body.title,
        detail: body.detail,
        severity: body.severity,
        metricValue: body.metricValue,
        patientId: body.patientId !== undefined ? body.patientId : undefined,
        forDate: body.forDate,
      },
    });
    await audit(request, { action: 'monitoring.morning_briefing_signal.updated', resource: 'morningBriefingSignal', resourceId: id, metadata: { signalType: row.signalType, severity: row.severity } });
    return row;
  });

  app.delete('/morning-briefing/signals/:id', { preHandler: writeRoles }, async request => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const current = await loadBriefingSignal(request, id);
    if (current.branchId) assertBranchAccess(request, current.branchId);
    await db.morningBriefingSignal.delete({ where: { id } });
    await audit(request, { action: 'monitoring.morning_briefing_signal.deleted', resource: 'morningBriefingSignal', resourceId: id, metadata: { signalType: current.signalType, severity: current.severity } });
    return { deleted: true };
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
      // Provider/device payloads use the separately authenticated connected-care
      // webhook route. Staff cannot spoof that provenance here.
      source: z.enum(['manual', 'import']).default('manual'),
    }).parse(request.body);
    const tenantId = request.auth.tenantId;
    if (body.branchId) assertBranchAccess(request, body.branchId);
    if (body.capturedAt && body.capturedAt.getTime() > Date.now() + 5 * 60_000) throw app.httpErrors.badRequest('capturedAt cannot be in the future');

    const normalized = normalizeManualReading(body);
    if (!normalized) throw app.httpErrors.badRequest('Reading value and unit must be canonical and internally consistent');

    let device: { deviceType: string; branchId: string | null } | null = null;
    if (body.deviceId) {
      device = await db.device.findFirst({ where: { id: body.deviceId, tenantId }, select: { deviceType: true, branchId: true } });
      if (!device) throw app.httpErrors.badRequest('Device not found in this workspace');
    }
    let patient: { branchId: string } | null = null;
    if (body.patientId) {
      patient = await db.patient.findFirst({ where: { id: body.patientId, tenantId, deletedAt: null }, select: { branchId: true } });
      if (!patient) throw app.httpErrors.badRequest('Patient not found in this workspace');
      assertBranchAccess(request, patient.branchId);
    }
    if (patient && body.branchId && body.branchId !== patient.branchId) throw app.httpErrors.badRequest('Reading branch must match the patient branch');
    if (patient && device?.branchId && device.branchId !== patient.branchId) throw app.httpErrors.badRequest('Device and patient must belong to the same branch');
    const branchId = patient?.branchId ?? body.branchId ?? device?.branchId ?? null;

    // Backend decides severity — never the client.
    const rule = await resolveRule(tenantId, { readingType: body.readingType, patientId: body.patientId, deviceType: device?.deviceType, branchId });
    // Weight severity is a delta vs the patient's own recent baseline (CHF signal),
    // so it needs prior readings; BP needs the diastolic half; ECG needs the rhythm label.
    const capturedAt = body.capturedAt ?? new Date();
    const evidencePeriod = rpmPeriodBounds(capturedAt);
    const weight = body.readingType === 'weight' && body.patientId
      ? await weightBaselines(tenantId, body.patientId, capturedAt)
      : null;
    const { severity, reason } = evaluateSeverity(body.readingType, normalized.numericValue, rule, {
      valueSecondary: normalized.valueSecondary,
      ecgClassification: body.readingType === 'ecg' ? body.value : null,
      unit: normalized.unit,
      weight,
    });

    // Persist the reading, derived safety alert/notification, and access audit as
    // one unit. A failure can no longer leave an abnormal reading silently stored
    // without its operational alert.
    const persisted = await db.$transaction(async tx => {
      if (body.patientId) {
        await lockRpmEvidence(tx, tenantId, body.patientId, evidencePeriod.start);
      }
      const reading = await tx.deviceReading.create({
        data: {
          tenantId, patientId: body.patientId ?? null, deviceId: body.deviceId ?? null, branchId,
          readingType: body.readingType, value: body.value, numericValue: normalized.numericValue,
          valueSecondary: normalized.valueSecondary, unit: normalized.unit,
          capturedAt, source: body.source, validationStatus: 'valid',
        },
        select: { id: true },
      });
      let alertId: string | null = null;
      if (severity !== 'normal') {
        const alert = await tx.readingAlert.create({
          data: { tenantId, patientId: body.patientId ?? null, deviceId: body.deviceId ?? null, readingId: reading.id, branchId, severity, severityRank: severityRank(severity), alertType: 'abnormal_reading', status: 'open', generatedReason: reason, assignedToUserId: rule?.assignedToUserId ?? null },
          select: { id: true },
        });
        alertId = alert.id;
        // Queue an in-app staff notification (consent not required for staff).
        const recipient = rule?.assignedToUserId
          ? await tx.user.findFirst({ where: { id: rule.assignedToUserId, tenantId, active: true }, select: { id: true, displayName: true, role: true } })
          : await tx.user.findFirst({ where: { tenantId, active: true, role: { in: ['PROVIDER', 'MANAGER', 'ADMIN', 'OWNER'] }, ...(branchId ? { OR: [{ branchId }, { role: { in: ['ADMIN', 'OWNER'] } }] } : {}) }, orderBy: { createdAt: 'asc' }, select: { id: true, displayName: true, role: true } });
        await tx.notificationEvent.create({
          data: { tenantId, alertId, patientId: body.patientId ?? null, recipientType: recipient?.role.toLowerCase() ?? 'unassigned_staff', recipientUserId: recipient?.id ?? null, recipientLabel: recipient?.displayName ?? 'unassigned clinical safety queue', channel: 'in_app', status: 'queued', attempts: 0, consentChecked: true, consentResult: 'not_required' },
        });
      }
      if (body.patientId) {
        await invalidateRpmProviderSignoff(tx, {
          tenantId, patientId: body.patientId, periodStart: evidencePeriod.start,
          reason: 'device_reading_evidence_mutated', actorUserId: request.auth.userId,
          requestId: request.id, ipAddress: request.ip,
          userAgent: request.headers['user-agent'], mutationResourceId: reading.id,
        });
      }
      await tx.auditEvent.create({
        data: {
          tenantId, actorUserId: request.auth.userId, action: 'monitoring.reading.ingested',
          resource: 'deviceReading', resourceId: reading.id, requestId: request.id,
          ipAddress: request.ip, userAgent: request.headers['user-agent'], metadata: { readingType: body.readingType, severity },
        },
      });
      return { readingId: reading.id, alertId };
    });
    return reply.code(201).send({ readingId: persisted.readingId, severity, reason, alertId: persisted.alertId });
  });
};
