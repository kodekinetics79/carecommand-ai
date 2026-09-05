import { apiRequest } from './api';

// ---------------------------------------------------------------------------
// Compliance Readiness Center API client + types (Phase C-1C).
// Truthful by construction: report shapes carry `integrated`/`status` flags so
// the UI can render genuine gap states. No certification language anywhere.
// ---------------------------------------------------------------------------

const base = '/v1/compliance';

export const COMPLIANCE_READ_ROLES = ['OWNER', 'ADMIN', 'COMPLIANCE_OFFICER', 'AUDITOR'];
export const COMPLIANCE_WRITE_ROLES = ['OWNER', 'ADMIN', 'COMPLIANCE_OFFICER'];
export const canViewCompliance = (role?: string) => !!role && COMPLIANCE_READ_ROLES.includes(role);
export const canWriteCompliance = (role?: string) => !!role && COMPLIANCE_WRITE_ROLES.includes(role);

export type ControlStatus = 'IMPLEMENTED' | 'IN_PROGRESS' | 'NOT_IMPLEMENTED' | 'NOT_APPLICABLE';
export type ReviewStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';
export type RiskStatus = 'OPEN' | 'MITIGATING' | 'ACCEPTED' | 'CLOSED';

export const CONTROL_STATUS_LABEL: Record<ControlStatus, string> = {
  IMPLEMENTED: 'Implemented',
  IN_PROGRESS: 'In progress',
  NOT_IMPLEMENTED: 'Not implemented',
  NOT_APPLICABLE: 'Not applicable',
};
export const CONTROL_STATUS_BADGE: Record<ControlStatus, string> = {
  IMPLEMENTED: 'badge badge-emerald',
  IN_PROGRESS: 'badge badge-amber',
  NOT_IMPLEMENTED: 'badge badge-red',
  NOT_APPLICABLE: 'badge badge-blue',
};

export interface Dashboard {
  generatedAt: string;
  readinessAvailable: boolean;
  controlCount: number;
  eligibleControlCount: number;
  evidenceLinkedControlCount: number;
  overallReadinessScore: number;
  frameworks: Array<{ key: string; name: string; score: number }>;
  soc2ReadinessPct: number;
  hipaaAlignmentPct: number;
  internalBaselinePct: number;
  openRisks: number;
  notImplementedControls: number;
  missingEvidenceCount: number;
  expiringEvidenceCount: number;
  recentAuditEvents: Array<{ id: string; action: string; resource: string; resourceId: string | null; actor: string; occurredAt: string }>;
  securityIncidents: { total: number; open: number; resolved: number };
  backupStatus: { integrated: boolean; status: string; lastRunAt: string | null };
  mfaStatus: { integrated: boolean; enforced: boolean; adoptionPct: number; note: string };
}

export interface BuyerProof {
  generatedAt: string;
  tenantName: string;
  dataClassification: 'aggregate_only';
  controlStatus: { available: boolean; completionPct: number; eligibleControls: number; evidenceBackedControls: number };
  accessProtection: { mfaEnforced: boolean; adoptionPct: number };
  recoveryEvidence: { latestStatus: string; latestRunAt: string | null; latestVerified: boolean };
  accountability: { auditEventsLast30Days: number };
  openGaps: { risks: number; incidents: number; notImplementedControls: number; controlsWithoutCurrentApprovedEvidence: number };
  limitations: string[];
}

export interface Control {
  id: string;
  frameworkId: string;
  categoryKey: string;
  controlKey: string;
  title: string;
  description: string;
  status: ControlStatus;
  ownerUserId: string | null;
  lastReviewedAt: string | null;
  notes: string | null;
  framework: { key: string; name: string };
}

export interface Evidence {
  id: string;
  title: string;
  description: string | null;
  ownerUserId: string | null;
  reviewStatus: ReviewStatus;
  sourceType: string;
  externalUrl: string | null;
  contentHash: string | null;
  auditorNotes: string | null;
  expiresAt: string | null;
  reviewedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  controlEvidence: Array<{ controlId: string }>;
  _count?: { versions: number };
}

export interface EvidenceVersion {
  id: string;
  version: number;
  changeType: string;
  contentHash: string;
  prevHash: string | null;
  rowHash: string;
  actorUserId: string | null;
  createdAt: string;
}

export interface Risk {
  id: string;
  title: string;
  description: string | null;
  categoryKey: string;
  likelihood: string;
  impact: string;
  score: number;
  status: RiskStatus;
  ownerUserId: string | null;
  mitigationPlan: string | null;
  createdAt: string;
}

export interface Vendor {
  id: string;
  vendorName: string;
  category: string | null;
  dataAccessLevel: string | null;
  baaStatus: string;
  riskTier: string;
  lastReviewedAt: string | null;
  nextReviewAt: string | null;
  status: string;
  notes: string | null;
}

export interface Incident {
  id: string;
  title: string;
  severity: string;
  status: string;
  detectedAt: string;
  resolvedAt: string | null;
  summary: string | null;
  affectedScope: string | null;
}

export interface AuditLogEntry {
  id: string;
  action: string;
  resource: string;
  resourceId: string | null;
  actor: string;
  actorRole: string | null;
  ipAddress: string | null;
  occurredAt: string;
  metadata: unknown;
}

export interface AuditLogResponse {
  total: number;
  limit: number;
  items: AuditLogEntry[];
}

export interface SecurityPolicy {
  id?: string;
  requireMfa: boolean;
  passwordExpiryDays: number | null;
  sessionTimeoutMinutes: number;
  failedLoginLockout: boolean;
  allowedIpRanges: string[];
  dataRetentionDays: number;
  backupFrequency: string;
  evidenceReviewFrequency: string;
}

// Reports are intentionally loosely typed: each carries `integrated`/`status`
// plus report-specific fields. The UI renders gap state from these flags.
export interface ReportBase {
  integrated?: boolean;
  status?: string;
  note?: string;
  [key: string]: unknown;
}

export const REPORT_KEYS = [
  'mfa', 'password-policy', 'access-review', 'role-changes', 'login-activity',
  'backup-status', 'deployment-history', 'security-scans', 'incident-response',
] as const;
export type ReportKey = typeof REPORT_KEYS[number];

export const REPORT_LABELS: Record<ReportKey, string> = {
  'mfa': 'MFA adoption',
  'password-policy': 'Password policy',
  'access-review': 'User access review',
  'role-changes': 'Role / permission changes',
  'login-activity': 'Login activity',
  'backup-status': 'Backup verification',
  'deployment-history': 'Deployment history',
  'security-scans': 'Security scans',
  'incident-response': 'Incident response',
};

export const complianceApi = {
  buyerProof: () => apiRequest<BuyerProof>(`${base}/buyer-proof`),
  dashboard: () => apiRequest<Dashboard>(`${base}/dashboard`),

  listControls: () => apiRequest<Control[]>(`${base}/controls`),
  updateControl: (id: string, body: Partial<Pick<Control, 'status' | 'ownerUserId' | 'notes' | 'lastReviewedAt'>>) =>
    apiRequest<Control>(`${base}/controls/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),

  listEvidence: (includeDeleted = false) => apiRequest<Evidence[]>(`${base}/evidence${includeDeleted ? '?includeDeleted=true' : ''}`),
  createEvidence: (body: Record<string, unknown>) => apiRequest<Evidence>(`${base}/evidence`, { method: 'POST', body: JSON.stringify(body) }),
  updateEvidence: (id: string, body: Record<string, unknown>) => apiRequest<Evidence>(`${base}/evidence/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteEvidence: (id: string) => apiRequest<void>(`${base}/evidence/${id}`, { method: 'DELETE' }),
  listEvidenceVersions: (id: string) => apiRequest<EvidenceVersion[]>(`${base}/evidence/${id}/versions`),

  listRisks: () => apiRequest<Risk[]>(`${base}/risks`),
  createRisk: (body: Record<string, unknown>) => apiRequest<Risk>(`${base}/risks`, { method: 'POST', body: JSON.stringify(body) }),
  updateRisk: (id: string, body: Record<string, unknown>) => apiRequest<Risk>(`${base}/risks/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),

  listVendors: () => apiRequest<Vendor[]>(`${base}/vendors`),
  createVendor: (body: Record<string, unknown>) => apiRequest<Vendor>(`${base}/vendors`, { method: 'POST', body: JSON.stringify(body) }),
  updateVendor: (id: string, body: Record<string, unknown>) => apiRequest<Vendor>(`${base}/vendors/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),

  listIncidents: () => apiRequest<Incident[]>(`${base}/incidents`),
  createIncident: (body: Record<string, unknown>) => apiRequest<Incident>(`${base}/incidents`, { method: 'POST', body: JSON.stringify(body) }),
  updateIncident: (id: string, body: Record<string, unknown>) => apiRequest<Incident>(`${base}/incidents/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),

  auditLogs: (params: Record<string, string>) => {
    const qs = new URLSearchParams([...Object.entries(params).filter(([, v]) => v), ['limit', '100']]).toString();
    return apiRequest<AuditLogResponse>(`${base}/audit-logs?${qs}`);
  },

  getSecurityPolicy: () => apiRequest<SecurityPolicy>(`${base}/security-policy`),
  updateSecurityPolicy: (body: Partial<SecurityPolicy>) => apiRequest<SecurityPolicy>(`${base}/security-policy`, { method: 'PUT', body: JSON.stringify(body) }),

  report: (key: ReportKey) => apiRequest<ReportBase>(`${base}/reports/${key}`),
};
