import { db } from '../db';
import { env } from '../../config/env';

// A single evidence reference grounding an AI output in real backend data.
export interface EvidenceRef { source: string; metric: string; value: number; label: string }

export interface OperationalSnapshot {
  phiEnabled: boolean;
  generatedAt: string;
  metrics: EvidenceRef[];
}

const OPEN = ['open', 'acknowledged', 'assigned'];

/**
 * AIContextBuilder — assembles a DE-IDENTIFIED operational snapshot from backend
 * data. No patient names, IDs, or free-text PHI: only aggregate counts, each of
 * which is also an evidence reference the recommendation must cite.
 */
export const aiContextBuilder = {
  async buildOperationalSnapshot(tenantId: string): Promise<OperationalSnapshot> {
    const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
    const [criticalOpen, highOpen, missedReadings, offlineDevices, eligibilityFailedToday, rpmReady, openDeviceAlerts] = await Promise.all([
      db.readingAlert.count({ where: { tenantId, severity: 'critical', status: { in: OPEN } } }),
      db.readingAlert.count({ where: { tenantId, severity: 'high', status: { in: OPEN } } }),
      db.readingAlert.count({ where: { tenantId, alertType: 'missed_reading', status: { in: OPEN } } }),
      db.device.count({ where: { tenantId, active: true, status: { in: ['offline', 'error'] } } }),
      db.eligibilityVerification.count({ where: { tenantId, checkedAt: { gte: dayStart }, coverageStatus: { in: ['INACTIVE', 'ERROR'] } } }),
      db.rPMBillingReadiness.count({ where: { tenantId, status: 'READY' } }),
      db.readingAlert.count({ where: { tenantId, status: { in: OPEN } } }),
    ]);
    const metrics: EvidenceRef[] = [
      { source: 'readingAlert', metric: 'open_critical_alerts', value: criticalOpen, label: 'Open critical monitoring alerts' },
      { source: 'readingAlert', metric: 'open_high_alerts', value: highOpen, label: 'Open high-severity alerts' },
      { source: 'readingAlert', metric: 'missed_readings', value: missedReadings, label: 'Open missed-reading alerts' },
      { source: 'device', metric: 'offline_devices', value: offlineDevices, label: 'Devices offline or in error' },
      { source: 'eligibilityVerification', metric: 'failed_eligibility_today', value: eligibilityFailedToday, label: 'Failed/inactive eligibility checks today' },
      { source: 'rpmBillingReadiness', metric: 'rpm_billing_ready', value: rpmReady, label: 'RPM patients billing-ready' },
      { source: 'readingAlert', metric: 'open_device_alerts', value: openDeviceAlerts, label: 'Total unresolved device alerts' },
    ];
    return { phiEnabled: env.AI_ENABLE_PHI, generatedAt: new Date().toISOString(), metrics };
  },

  /** Build the messages for an operation. The snapshot is the only data sent. */
  recommendationMessages(snapshot: OperationalSnapshot) {
    const system = 'You are an operations assistant for a clinic platform. Recommend operational follow-up actions ONLY from the provided de-identified metrics. Never invent patient data. Respond as JSON: {"recommendations":[{"title","recommendationType","reason","confidence","evidenceMetric"}]}.';
    const user = `Operational metrics snapshot (de-identified):\n${JSON.stringify(snapshot.metrics)}`;
    return [{ role: 'system' as const, content: system }, { role: 'user' as const, content: user }];
  },
  briefingMessages(snapshot: OperationalSnapshot) {
    const system = 'You are an operations assistant. Write a short morning operational briefing from the de-identified metrics only. Be concise and evidence-backed. Do not invent data.';
    const user = `Metrics: ${JSON.stringify(snapshot.metrics)}`;
    return [{ role: 'system' as const, content: system }, { role: 'user' as const, content: user }];
  },
};
