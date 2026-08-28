import { createHmac, randomBytes } from 'node:crypto';
import { db } from './db';
import { env } from '../config/env';

export type PilotChecklistItem = {
  key: string;
  label: string;
  done: boolean;
  detail: string;
};

function thresholdLabel(value: number, target: number): string {
  if (value >= target) return `${value}/${target} ready`;
  return `${value}/${target} loaded`;
}

export async function buildPilotChecklist(tenantId: string) {
  const [tenant, branches, users, patients, appointments, policies, audits, imports, latestImport] = await Promise.all([
    db.tenant.findUnique({ where: { id: tenantId }, select: { id: true, name: true, slug: true, createdAt: true, updatedAt: true } }),
    db.branch.count({ where: { tenantId } }),
    db.user.count({ where: { tenantId, active: true } }),
    db.patient.count({ where: { tenantId, deletedAt: null } }),
    db.appointment.count({ where: { tenantId, deletedAt: null } }),
    db.patientInsurancePolicy.count({ where: { tenantId, active: true } }),
    db.auditEvent.count({ where: { tenantId } }),
    db.platformAuditEvent.count({ where: { tenantId, action: { startsWith: 'pilot.import.' } } }),
    db.platformAuditEvent.findFirst({ where: { tenantId, action: { startsWith: 'pilot.import.' } }, orderBy: { createdAt: 'desc' } }),
  ]);

  if (!tenant) return null;

  const items: PilotChecklistItem[] = [
    { key: 'tenant', label: 'Tenant provisioned', done: true, detail: `${tenant.name} / ${tenant.slug}` },
    { key: 'owner', label: 'Owner login ready', done: users > 0, detail: users > 0 ? `${users} active user${users === 1 ? '' : 's'}` : 'No active users yet' },
    { key: 'branches', label: 'Branch data loaded', done: branches > 0, detail: branches > 0 ? `${branches} branch${branches === 1 ? '' : 'es'}` : 'No branches yet' },
    { key: 'patients', label: 'Patient data loaded', done: patients > 0, detail: thresholdLabel(patients, 25) },
    { key: 'appointments', label: 'Appointment data loaded', done: appointments > 0, detail: thresholdLabel(appointments, 10) },
    { key: 'insurance', label: 'Insurance data loaded', done: policies > 0, detail: policies > 0 ? `${policies} active policy${policies === 1 ? '' : 'ies'}` : 'No insurance policies yet' },
    { key: 'audit', label: 'Import audit trail present', done: imports > 0, detail: latestImport ? `${latestImport.action} · ${latestImport.createdAt.toISOString()}` : 'No pilot imports recorded yet' },
    { key: 'audit_events', label: 'Platform audit trail active', done: audits > 0, detail: `${audits} tenant audit event${audits === 1 ? '' : 's'}` },
  ];

  const readyCount = items.filter(item => item.done).length;
  return {
    tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug, createdAt: tenant.createdAt.toISOString(), updatedAt: tenant.updatedAt.toISOString() },
    readinessScore: Math.round((readyCount / items.length) * 100),
    readyCount,
    itemCount: items.length,
    items,
    counts: { branches, users, patients, appointments, policies, audits, imports },
    latestImport: latestImport ? {
      action: latestImport.action,
      createdAt: latestImport.createdAt.toISOString(),
      metadata: latestImport.metadata,
    } : null,
  };
}

export function hashPilotShareToken(token: string): string {
  return createHmac('sha256', env.JWT_SECRET).update(`pilot-status:${token}`).digest('hex');
}

export function createPilotShareToken(): { token: string; hash: string } {
  const token = randomBytes(24).toString('hex');
  return { token, hash: hashPilotShareToken(token) };
}
