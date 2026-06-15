import { db } from './db';

// ============================================================================
// CRM Automation Rules engine. Each rule = trigger + action. `evaluateRule`
// counts real matching records; `executeRule` performs SAFE, idempotent actions
// (creating staff tasks) and returns a preview for actions that belong to
// another module (campaigns/payments/segments) rather than firing side effects
// blindly. Every execution is audited by the caller.
// ============================================================================

export type TriggerType = 'hot_lead_not_booked' | 'patient_inactive' | 'appointment_cancelled' | 'deposit_unpaid' | 'device_reading_missed' | 'lead_lost_no_availability';
export type ActionType = 'assign_callback_task' | 'add_to_reactivation_segment' | 'trigger_slot_fill_campaign' | 'send_payment_reminder' | 'create_follow_up_task' | 'add_to_schedule_gap_analysis';

export interface RuleTemplate {
  key: string; name: string; triggerType: TriggerType; actionType: ActionType;
  config: Record<string, number>; description: string;
}

export const RULE_CATALOG: RuleTemplate[] = [
  { key: 'hot_lead_not_booked', name: 'Hot lead not booked in 2h → assign callback', triggerType: 'hot_lead_not_booked', actionType: 'assign_callback_task', config: { hours: 2 }, description: 'If a high-value lead has not booked within 2 hours, assign a callback task.' },
  { key: 'patient_inactive_90', name: 'Patient inactive 90 days → reactivation segment', triggerType: 'patient_inactive', actionType: 'add_to_reactivation_segment', config: { days: 90 }, description: 'If a patient is inactive for 90 days, add them to the reactivation segment.' },
  { key: 'appointment_cancelled_slotfill', name: 'Appointment cancelled → slot-fill campaign', triggerType: 'appointment_cancelled', actionType: 'trigger_slot_fill_campaign', config: { days: 7 }, description: 'If an appointment is cancelled, trigger a slot-fill campaign.' },
  { key: 'deposit_unpaid_reminder', name: 'Deposit unpaid → payment reminder', triggerType: 'deposit_unpaid', actionType: 'send_payment_reminder', config: {}, description: 'If a deposit is unpaid, send a payment reminder.' },
  { key: 'device_reading_missed_followup', name: 'Device reading missed → follow-up task', triggerType: 'device_reading_missed', actionType: 'create_follow_up_task', config: {}, description: 'If a device reading is missed, create a follow-up task.' },
  { key: 'lead_lost_no_availability', name: 'Lead lost (no availability) → schedule-gap analysis', triggerType: 'lead_lost_no_availability', actionType: 'add_to_schedule_gap_analysis', config: {}, description: 'If a lead is lost due to no availability, add to schedule-gap analysis.' },
];

interface RuleRow { id: string; triggerType: string; actionType: string; config: unknown }
const cfgNum = (config: unknown, key: string, fallback: number): number => {
  const v = (config as Record<string, unknown> | null)?.[key];
  return typeof v === 'number' ? v : fallback;
};

// ---- Evaluate: count real matches (no side effects) ------------------------
export async function evaluateRule(tenantId: string, rule: RuleRow): Promise<{ matched: number; sample: string[]; note?: string }> {
  switch (rule.triggerType as TriggerType) {
    case 'hot_lead_not_booked': {
      const cutoff = new Date(Date.now() - cfgNum(rule.config, 'hours', 2) * 3_600_000);
      const rows = await db.lead.findMany({ where: { tenantId, stage: { in: ['new-inquiry', 'contacted'] }, createdAt: { lt: cutoff } }, orderBy: { estimatedValue: 'desc' }, take: 50, select: { name: true } });
      return { matched: rows.length, sample: rows.slice(0, 5).map(r => r.name) };
    }
    case 'patient_inactive': {
      const cutoff = new Date(Date.now() - cfgNum(rule.config, 'days', 90) * 86_400_000);
      const rows = await db.patient.findMany({ where: { tenantId, deletedAt: null, OR: [{ lastVisitAt: { lt: cutoff } }, { lastVisitAt: null }] }, take: 200, select: { firstName: true, lastName: true } });
      return { matched: rows.length, sample: rows.slice(0, 5).map(r => `${r.firstName} ${r.lastName}`) };
    }
    case 'appointment_cancelled': {
      const cutoff = new Date(Date.now() - cfgNum(rule.config, 'days', 7) * 86_400_000);
      const n = await db.appointment.count({ where: { tenantId, status: 'CANCELED', updatedAt: { gte: cutoff } } });
      return { matched: n, sample: [] };
    }
    case 'deposit_unpaid': {
      const rows = await db.depositRequirement.findMany({ where: { tenantId, status: { in: ['required', 'pending', 'unpaid'] } }, take: 100, select: { id: true } }).catch(() => []);
      return { matched: rows.length, sample: [] };
    }
    case 'lead_lost_no_availability': {
      const n = await db.lead.count({ where: { tenantId, stage: 'lost' } });
      return { matched: n, sample: [] };
    }
    case 'device_reading_missed':
      return { matched: 0, sample: [], note: 'No RPM/device integration yet — this trigger activates once device data is connected.' };
    default:
      return { matched: 0, sample: [] };
  }
}

// ---- Execute: perform safe actions; preview the rest -----------------------
export async function executeRule(tenantId: string, rule: RuleRow, actorUserId?: string): Promise<{ matched: number; actionType: string; created: number; preview: boolean; route: string | null; note: string }> {
  const ev = await evaluateRule(tenantId, rule);
  const action = rule.actionType as ActionType;

  // Task-creating actions run for real (idempotent: skip if an OPEN task for the
  // same rule + entity already exists via metadata).
  if (action === 'assign_callback_task' || action === 'create_follow_up_task') {
    let created = 0;
    if (rule.triggerType === 'hot_lead_not_booked') {
      const cutoff = new Date(Date.now() - cfgNum(rule.config, 'hours', 2) * 3_600_000);
      const leads = await db.lead.findMany({ where: { tenantId, stage: { in: ['new-inquiry', 'contacted'] }, createdAt: { lt: cutoff } }, orderBy: { estimatedValue: 'desc' }, take: 25, select: { id: true, name: true } });
      // Idempotent: skip leads that already have an OPEN task from this rule.
      const existing = await db.staffTask.findMany({ where: { tenantId, status: 'OPEN', metadata: { path: ['ruleId'], equals: rule.id } }, select: { metadata: true } }).catch(() => [] as Array<{ metadata: unknown }>);
      const done = new Set(existing.map(e => (e.metadata as { entityId?: string } | null)?.entityId).filter(Boolean));
      for (const l of leads) {
        if (done.has(l.id)) continue;
        await db.staffTask.create({ data: { tenantId, assignedToId: actorUserId, title: `Callback: ${l.name} (hot lead not booked)`, priority: 'high', dueAt: new Date(Date.now() + 2 * 3_600_000), metadata: { ruleId: rule.id, entityId: l.id, source: 'automation' } } });
        created++;
      }
    }
    return { matched: ev.matched, actionType: action, created, preview: false, route: '/staff', note: created ? `Created ${created} task(s).` : 'No new tasks needed.' };
  }

  // Module-owned actions: return a governed preview + route (no blind side effects).
  const ROUTE: Record<ActionType, string> = {
    assign_callback_task: '/staff', create_follow_up_task: '/staff',
    add_to_reactivation_segment: '/crm', trigger_slot_fill_campaign: '/reactivation',
    send_payment_reminder: '/revenue-protection', add_to_schedule_gap_analysis: '/scheduling',
  };
  return {
    matched: ev.matched, actionType: action, created: 0, preview: true, route: ROUTE[action],
    note: ev.note ?? `${ev.matched} record(s) match. This action is executed in its owning module (open it to launch with approval).`,
  };
}
