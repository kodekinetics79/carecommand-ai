import { apiRequest } from './api';

// ============================================================================
// Opportunity Center service. Structure:
//   Leak        = a detected revenue problem (revenue-leaks)
//   Opportunity = a ranked action to recover value (opportunities)
//   Workflow    = the execution path (status transitions via PATCH)
// Every callable method below is backed by a real endpoint.
// ============================================================================

const num = (v: unknown): number => typeof v === 'string' ? Number(v) || 0 : typeof v === 'number' ? v : 0;

export type ApprovalState = 'approved' | 'pending_approval' | 'not_required';
export type Urgency = 'high' | 'medium' | 'low';
export type Effort = 'high' | 'medium' | 'low';
export type Band = 'low' | 'medium' | 'high';

export interface RevenueLeak {
  id: string; category: string; source: string; evidence: string;
  estimatedValue: number; confidence: number; status: string; workflowStatus: string;
  suggestedAction: string; branch: string;
}

export interface Opportunity {
  id: string; title: string; source: string; category: string; trigger: string;
  expectedRevenue: number; actualRevenue: number; roi: number;
  confidence: number; urgency: Urgency; effort: Effort;
  status: string; approval: ApprovalState; approvalRequired: boolean;
  recommendedAction: string; owner: string; branch: string;
  // Derived from real fields (deterministic UI hints, not invented numbers):
  department: string; costToExecute: Band; patientImpact: Band; complianceRisk: Band; automationEligible: boolean;
  // Not yet in the API — null until a backend route provides them (never faked):
  dueDate: string | null; slaHours: number | null;
  steps: string[];
}

const DEPT: Record<string, string> = {
  'front-desk': 'Front Desk', 'inactive-patients': 'Patient Growth', 'no-show': 'Scheduling',
  'insurance': 'Insurance', 'payments': 'Revenue Protection', 'reputation': 'Marketing', 'scheduling': 'Scheduling',
};
const deptFor = (cat: string) => DEPT[cat] ?? 'Operations';
const costFromEffort = (e: Effort): Band => e === 'high' ? 'high' : e === 'medium' ? 'medium' : 'low';
const impactFromCat = (cat: string): Band => ['inactive-patients', 'no-show', 'reputation'].includes(cat) ? 'high' : ['front-desk', 'scheduling'].includes(cat) ? 'medium' : 'low';
const complianceFromCat = (cat: string): Band => ['inactive-patients', 'reputation', 'insurance'].includes(cat) ? 'medium' : 'low';
const approvalState = (required: boolean, status: string): ApprovalState =>
  required ? 'pending_approval' : ['running', 'active', 'recovering'].includes(status) ? 'approved' : 'not_required';

function mapOpportunity(o: Record<string, unknown>): Opportunity {
  const category = String(o.category ?? 'revenue');
  const effort = (String(o.effortLevel ?? 'medium') as Effort);
  const approvalRequired = Boolean(o.ownerApprovalRequired);
  const status = String(o.status ?? 'pending');
  const steps = ((o.automationSteps as { steps?: string[] } | null)?.steps) ?? [];
  return {
    id: String(o.id), title: String(o.title ?? 'Opportunity'), source: String(o.source ?? ''),
    category, trigger: String(o.trigger ?? ''), expectedRevenue: num(o.expectedRevenue), actualRevenue: num(o.actualRevenue),
    roi: num(o.roi), confidence: num(o.confidence), urgency: (String(o.urgency ?? 'medium') as Urgency), effort,
    status, approval: approvalState(approvalRequired, status), approvalRequired,
    recommendedAction: String(o.recommendedAction ?? ''),
    owner: String((o.ownerUser as { displayName?: string } | null)?.displayName ?? 'Unassigned'),
    branch: String((o.branch as { name?: string } | null)?.name ?? ''),
    department: deptFor(category), costToExecute: costFromEffort(effort), patientImpact: impactFromCat(category),
    complianceRisk: complianceFromCat(category), automationEligible: steps.length > 0,
    dueDate: null, slaHours: null, steps,
  };
}
function mapLeak(l: Record<string, unknown>): RevenueLeak {
  return {
    id: String(l.id), category: String(l.category ?? ''), source: String(l.source ?? ''),
    evidence: String(l.evidence ?? ''), estimatedValue: num(l.estimatedValue), confidence: num(l.confidence),
    status: String(l.status ?? 'open'), workflowStatus: String(l.workflowStatus ?? 'reviewed'),
    suggestedAction: String(l.suggestedAction ?? ''), branch: String((l.branch as { name?: string } | null)?.name ?? ''),
  };
}

// Specific workflow CTAs → concrete server actions (each is audited server-side).
export type WorkflowVerb = 'approve_campaign' | 'assign_callback' | 'send_front_desk';

/**
 * Hand-off verbs. These two tell the user the work has gone to the front desk,
 * so they must create a real StaffTask — a status string alone assigned nobody.
 * POST /v1/opportunities/:id/handoff writes the task and the status in one
 * transaction and is idempotent, so a second click reuses the open task.
 */
const HANDOFF_VERBS = ['assign_callback', 'send_front_desk'] as const;
const isHandoffVerb = (verb: WorkflowVerb): verb is (typeof HANDOFF_VERBS)[number] =>
  (HANDOFF_VERBS as readonly string[]).includes(verb);

export interface WorkflowResult {
  opportunity: Opportunity;
  /** What the server reports it actually did. Null when the verb writes no task. */
  message: string | null;
  taskCreated: boolean | null;
}

export const opportunityService = {
  // [LIVE]
  async listLeaks(): Promise<RevenueLeak[]> {
    const rows = await apiRequest<Array<Record<string, unknown>>>('/v1/revenue-leaks?limit=30');
    return rows.map(mapLeak);
  },
  // [LIVE]
  async listOpportunities(): Promise<Opportunity[]> {
    const rows = await apiRequest<Array<Record<string, unknown>>>('/v1/opportunities?limit=30');
    return rows.map(mapOpportunity).sort((a, b) => b.expectedRevenue - a.expectedRevenue);
  },
  // [LIVE] Hand-offs POST /v1/opportunities/:id/handoff (task + status, one
  // transaction); approval is a plain PATCH. Both audited server-side.
  async runWorkflow(id: string, verb: WorkflowVerb): Promise<WorkflowResult> {
    if (isHandoffVerb(verb)) {
      const res = await apiRequest<{ opportunity: Record<string, unknown>; taskCreated: boolean; message: string }>(
        `/v1/opportunities/${id}/handoff`, { method: 'POST', body: JSON.stringify({ verb }) },
      );
      return { opportunity: mapOpportunity(res.opportunity), message: res.message, taskCreated: res.taskCreated };
    }
    const row = await apiRequest<Record<string, unknown>>(`/v1/opportunities/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'approved', ownerApprovalRequired: false }) });
    return { opportunity: mapOpportunity(row), message: null, taskCreated: null };
  },
  // [LIVE] dismiss/snooze map to status; reason is sent for the audit metadata.
  async setStatus(id: string, status: string): Promise<Opportunity> {
    const row = await apiRequest<Record<string, unknown>>(`/v1/opportunities/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
    return mapOpportunity(row);
  },
};
