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
  age: number;
  gender: 'male' | 'female';
  branchId: string;
  assignedDoctorId: string;
  lastVisit: string; // ISO date
  nextVisit?: string;
  lifecycleStage: LifecycleStage;
  churnRisk: number; // 0-100
  lifetimeValue: number;
  preferredChannel: Channel;
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
  revenue: number;
  recovered: number;
  lost: number;
  campaigns: number;
}
