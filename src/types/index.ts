export type BranchStatus = 'active' | 'inactive' | 'opening';
export type AppointmentStatus = 'confirmed' | 'risky' | 'arrived' | 'no-show' | 'canceled' | 'completed' | 'waitlist';
export type LifecycleStage = 'new' | 'active' | 'at-risk' | 'inactive' | 'lost' | 'retained';
export type CampaignStatus = 'draft' | 'active' | 'paused' | 'completed' | 'scheduled';
export type Channel = 'whatsapp' | 'sms' | 'email' | 'push' | 'call' | 'video';
export type AlertCategory = 'revenue' | 'operations' | 'retention' | 'reputation' | 'staff' | 'inventory';
export type AlertSeverity = 'high' | 'medium' | 'low';

export interface Branch {
  id: string;
  name: string;
  location: string;
  status: BranchStatus;
  doctors: number;
  todayAppointments: number;
  utilization: number; // percent
  revenue: number; // this month
  healthScore: number; // 0-100
  missedCalls: number;
  openSlots: number;
  patientCount: number;
}

export interface Doctor {
  id: string;
  name: string;
  specialty: string;
  branchId: string;
  /** On the booking schedule. A deactivated provider is never bookable. */
  active: boolean;
  /** Recurring weekly windows configured; null when the source did not say. */
  availabilityWindows: number | null;
  avatar?: string;
  utilization: number;
  appointmentsToday: number;
  appointmentsThisMonth: number;
  rating: number;
  reviewCount: number;
  revenueThisMonth: number;
  repeatVisitRate: number;
  followUpRate: number;
}

export interface Patient {
  id: string;
  name: string;
  age: number | null;
  gender: 'male' | 'female' | null;
  branchId: string;
  assignedDoctorId: string | null;
  lastVisit: string | null; // ISO date when known
  nextVisit?: string;
  lifecycleStage: LifecycleStage;
  churnRisk: number; // 0-100
  lifetimeValue: number;
  preferredChannel: Channel | null;
  consentStatus: {
    sms: boolean;
    whatsapp: boolean;
    email: boolean;
    marketing: boolean;
  };
  familyAccountId?: string;
  tags: string[];
  phone: string;
  email: string;
  visitCount: number;
  outstandingBalance: number;
}

export interface Appointment {
  id: string;
  patientId: string;
  patientName: string;
  doctorId: string;
  doctorName: string;
  branchId: string;
  service: string;
  date: string;
  time: string;
  status: AppointmentStatus;
  noShowRisk: number; // 0-100
  channel: Channel;
  value: number;
  notes?: string;
}

export interface Lead {
  id: string;
  name: string;
  phone: string;
  channel: Channel;
  service: string;
  stage: 'new-inquiry' | 'contacted' | 'booked' | 'visited' | 'follow-up' | 'retained' | 'lost';
  source: string;
  createdAt: string;
  assignedTo?: string;
  branchId: string;
  estimatedValue: number;
}

export interface Campaign {
  id: string;
  name: string;
  goal: string;
  status: CampaignStatus;
  channels: Channel[];
  audienceSize: number;
  sent: number;
  opened: number;
  responded: number;
  booked: number;
  revenue: number;
  startDate: string;
  endDate?: string;
  aiGenerated: boolean;
}

export interface RadarAlert {
  id: string;
  category: AlertCategory;
  severity: AlertSeverity;
  title: string;
  description: string;
  action: string;
  estimatedValue?: number;
  branchId?: string;
  createdAt: string;
  dismissed: boolean;
}

export interface StaffMember {
  id: string;
  name: string;
  role: string;
  branchId: string;
  responseTime: number; // minutes
  missedCalls: number;
  followUpRate: number; // percent
  bookingConversionRate: number; // percent
  tasksCompleted: number;
  tasksPending: number;
  patientFeedbackScore: number;
}

export interface InventoryItem {
  id: string;
  name: string;
  category: string;
  branchId: string;
  currentStock: number;
  unit: string;
  reorderLevel: number;
  expiryDate?: string;
  unitCost: number;
  usagePerWeek: number;
  status: 'ok' | 'low' | 'critical' | 'expiring';
  supplier: string;
}

export interface LabOrder {
  id: string;
  patientId: string;
  patientName: string;
  doctorId: string;
  doctorName: string;
  branchId: string;
  testName: string;
  orderedAt: string;
  status: 'ordered' | 'sample-collected' | 'pending-result' | 'result-received' | 'doctor-reviewed';
  lab: string;
  urgency: 'routine' | 'urgent' | 'stat';
  resultSummary?: string;
  reviewedAt?: string;
  reviewedBy?: string;
}

export interface Review {
  id: string;
  patientName: string;
  branchId: string;
  doctorId?: string;
  rating: number;
  text: string;
  platform: 'google' | 'internal';
  date: string;
  responded: boolean;
  aiDraftResponse?: string;
  sentiment: 'positive' | 'neutral' | 'negative';
}

export interface Integration {
  id: string;
  name: string;
  category: string;
  status: 'connected' | 'disconnected' | 'error' | 'coming-soon';
  icon: string;
  description: string;
  lastSync?: string;
}

export interface RevenueData {
  month: string;
  /** Sortable timestamp of the period start — charts sort ascending on this. */
  periodTs?: number;
  revenue: number;
  recovered: number;
  lost: number;
  campaigns: number;
}

export interface RevenueLeak {
  id: string;
  branchId: string;
  branchName: string;
  category: string;
  source: string;
  evidence: string;
  estimatedValue: number;
  confidence: number;
  status: string;
  workflowStatus: string;
  suggestedAction: string;
  ownerName?: string;
  patientName?: string;
  createdAt: string;
}

export interface Opportunity {
  id: string;
  branchId: string;
  branchName: string;
  title: string;
  source: string;
  category: string;
  trigger: string;
  automationSteps: string[];
  expectedRevenue: number;
  actualRevenue: number;
  roi: number;
  confidence: number;
  effortLevel: string;
  urgency: string;
  status: string;
  ownerApprovalRequired: boolean;
  recommendedAction: string;
  ownerName?: string;
  patientName?: string;
  createdAt: string;
}

export type AdvisorType = 'revenue' | 'growth' | 'front-desk' | 'competitor' | 'operations';

export interface AdvisoryAction {
  label: string;
  path: string;
  description: string;
  primary?: boolean;
  context?: Record<string, unknown>;
}

export interface AdvisorResponse {
  advisorType: AdvisorType;
  answer: string;
  answerSource: 'model' | 'rule-based';
  methodology: string;
  summary: string;
  diagnosis: string;
  recommendedAction: string;
  expectedImpact: number;
  confidence: number;
  evidence: string[];
  recommendations: string[];
  actions: AdvisoryAction[];
  question?: string;
  clinicId?: string | null;
  generatedAt: string;
}

export interface AdvisoryBriefResponse {
  generatedAt: string;
  clinicId?: string | null;
  clinicName?: string | null;
  advisors: AdvisorResponse[];
}

export interface AdminBranchAccess {
  id: string;
  name: string;
  location: string;
  isPrimary: boolean;
}

export interface AdminUser {
  id: string;
  displayName: string;
  email: string;
  role: string;
  active: boolean;
  branchId?: string | null;
  branch?: { id: string; name: string; location: string } | null;
  accessBranches: AdminBranchAccess[];
  lastLoginAt?: string | null;
  createdAt: string;
  updatedAt: string;
  sessionActive: boolean;
}

export interface AdminRole {
  id: string;
  name: string;
  enumValue: string;
  description: string;
  accent: string;
  userCount: number;
  moduleAccess: string[];
  clinicScope: string;
}

export interface AdminAuditEvent {
  id: string;
  action: string;
  resource: string;
  resourceId?: string | null;
  actor: string;
  role?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  occurredAt: string;
  metadata: unknown;
}

export interface SecurityPosture {
  authMode: string;
  passwordLoginEnabled?: boolean;
  devTokenEnabled?: boolean;
  refreshCookieHttpOnly?: boolean;
  csrfEnabled?: boolean;
  refreshRotationEnabled?: boolean;
  adminRouteProtected?: boolean;
  tenantIsolationEnabled?: boolean;
  clinicScopingEnabled?: boolean;
  refreshCookie: {
    httpOnly: boolean;
    secure: boolean;
    sameSite: string;
    path: string;
  };
  csrf?: {
    enabled: boolean;
    strategy: string;
  };
  rbacEnabled: boolean;
  auditLoggingEnabled: boolean;
  rateLimitingEnabled: boolean;
  devTokenDisabledInProduction: boolean;
  httpsRequired: boolean;
  secrets: {
    jwtSecretConfigured: boolean;
    jwtRefreshSecretConfigured: boolean;
  };
  accessTokenTtlMinutes: number;
  jwtSecretsConfigured?: boolean;
  refreshSecretConfigured?: boolean;
  corsMode?: string;
  environmentMode?: string;
  riskLabel?: string;
  readinessScore?: number;
  paymentRailsStatus?: string;
  insuranceRailsStatus?: string;
  auditEventCount: number;
  loginEventCount: number;
  integrations: Array<{
    key: string;
    name: string;
    status: string;
    lastSyncAt: string | null;
  }>;
  paymentProviders: Array<{
    key: string;
    displayName: string;
    mode: string;
    status: string;
  }>;
  alerts: Array<{
    severity: string;
    title: string;
    message: string;
  }>;
}

export interface SecuritySession {
  id: string;
  user: {
    id: string;
    displayName: string;
    email: string;
    role: string;
    branch: { id: string; name: string; location: string } | null;
  };
  issuedAt: string | null;
  expiresAt: string | null;
  revoked: boolean;
  lastActivityAt: string | null;
  lastLoginAudit: {
    occurredAt: string;
    ipAddress?: string | null;
    userAgent?: string | null;
  } | null;
  accessBranches: AdminBranchAccess[];
}

export interface SecurityLoginHistory {
  id: string;
  status: 'success' | 'failed';
  action: string;
  user: string;
  email: string | null;
  role: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  occurredAt: string;
  metadata: unknown;
}

export interface IntegrationStatus {
  key: string;
  name: string;
  category: string;
  description: string;
  supportedWorkflows: string[];
  mode: 'mock' | 'sandbox' | 'live';
  modeLabel: string;
  configured: boolean;
  health: 'healthy' | 'degraded' | 'disconnected' | 'not_configured';
  lastSyncAt: string | null;
  missingConfigCount: number;
  riskLevel: 'low' | 'medium' | 'high' | string;
  action: string;
  integrationId: string | null;
  providerConnectionId: string | null;
  databaseStatus: string | null;
}
