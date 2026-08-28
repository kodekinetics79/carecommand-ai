import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../../lib/db';
import { requirePermission } from '../../lib/permissions';

const logQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// The audit trail is itself sensitive (who accessed what); gate it behind
// `audit:read` (OWNER/ADMIN/ANALYST/COMPLIANCE_OFFICER/AUDITOR by default)
// rather than leaving it open to any authenticated user.
const canReadAuditLog = requirePermission('audit:read');

const CONSENT_PURPOSES = ['WHATSAPP', 'SMS', 'EMAIL', 'MARKETING'] as const;

export const complianceRoutes: FastifyPluginAsync = async app => {
  // Recent compliance/audit events for the tenant.
  app.get('/audit-log', { preHandler: canReadAuditLog }, async request => {
    const query = logQuery.parse(request.query);
    const rows = await db.auditEvent.findMany({
      where: { tenantId: request.auth.tenantId },
      orderBy: { occurredAt: 'desc' },
      take: query.limit,
      include: { actorUser: { select: { displayName: true } } },
    });

    return rows.map(row => ({
      id: row.id,
      action: row.action,
      resource: row.resource,
      resourceId: row.resourceId,
      actor: row.actorUser?.displayName ?? 'System',
      occurredAt: row.occurredAt.toISOString(),
      metadata: row.metadata ?? null,
    }));
  });

  // Opt-in rates per channel, derived from the latest consent event per patient.
  app.get('/consent-summary', async request => {
    const tenantId = request.auth.tenantId;
    const [totalPatients, events] = await Promise.all([
      db.patient.count({ where: { tenantId, deletedAt: null } }),
      db.consentEvent.findMany({
        where: { tenantId },
        orderBy: { occurredAt: 'desc' },
        select: { patientId: true, purpose: true, granted: true },
      }),
    ]);

    // Keep only the most recent event per (patient, purpose).
    const latest = new Map<string, boolean>();
    for (const event of events) {
      const key = `${event.patientId}:${event.purpose}`;
      if (!latest.has(key)) latest.set(key, event.granted);
    }

    const total = totalPatients || 0;
    const channels = CONSENT_PURPOSES.map(purpose => {
      let opted = 0;
      latest.forEach((granted, key) => {
        if (granted && key.endsWith(`:${purpose}`)) opted += 1;
      });
      return {
        purpose,
        opted,
        total,
        pct: total > 0 ? Math.round((opted / total) * 100) : 0,
      };
    });

    return { totalPatients: total, channels };
  });
};
