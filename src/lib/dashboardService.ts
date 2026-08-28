import { apiRequest } from './api';

// ============================================================================
// Dashboard data service. All page data flows through here (no hardcoded sample
// data in components). Every callable action is backed by a real endpoint.
// ============================================================================

// ---- Summary ----------------------------------------------------------------
export interface DashboardSummary {
  generatedAt: string;
  networkRevenue: number; revenueRecovered: number;
  activeCustomers: number; todaysAppointments: number;
  noShowRisk: number; callsRecovered: number; missedCalls: number;
  activeOpportunities: number; pendingApprovals: number;
  // Optional real period-over-period deltas; the UI hides absent values.
  networkRevenueTrend?: number; revenueRecoveredTrend?: number; activeOpportunitiesTrend?: number;
}

// ---- Branch health (derived from provider aggregation) ----------------------
export interface BranchHealth {
  id: string; name: string; location: string;
  healthScore: number; utilization: number; appointmentsToday: number;
  providers: number; monthlyRevenue: number; avgRating: number;
  // Enrichment not yet in the API — null until backend lands (never faked).
  missedCalls: number | null; noShowRisk: number | null; revenueLeakage: number | null; staffLoad: number | null;
}

// ---- Provider utilization ---------------------------------------------------
export type CapacityBand = 'overbooked' | 'ideal' | 'underutilized';
export interface ProviderUtilization {
  id: string; name: string; specialty: string; branch: string;
  utilization: number; appointmentsToday: number; monthlyRevenue: number; rating: number;
  band: CapacityBand;
}

// ---- Campaign ROI -----------------------------------------------------------
export interface CampaignROI {
  id: string; name: string; status: string;
  audienceSize: number; booked: number; revenue: number; conversionRate: number;
  estimatedAudience: number | null; estimatedRecoverable: number | null; nextAction: string;
}

// ---- Priority actions -------------------------------------------------------
export type ActionCategory = 'revenue' | 'no_shows' | 'missed_calls' | 'insurance' | 'payments' | 'device_alerts' | 'reputation';
export type Severity = 'critical' | 'high' | 'medium' | 'low';
export interface PriorityAction {
  id: string; title: string; description: string;
  category: ActionCategory; severity: Severity;
  revenueImpact: number | null; confidence: number | null; owner: string; dueDate: string | null;
  cta: { label: string; route: string };
}

const bandFor = (u: number): CapacityBand => u >= 88 ? 'overbooked' : u >= 60 ? 'ideal' : 'underutilized';
const num = (v: unknown): number => typeof v === 'string' ? Number(v) || 0 : typeof v === 'number' ? v : 0;
const optionalNum = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
};

export const dashboardService = {
  // [LIVE] GET /v1/dashboard/summary
  getSummary: () => apiRequest<DashboardSummary>('/v1/dashboard/summary'),

  // [LIVE] derived: aggregate /v1/providers/overview by branch, joined with /v1/branches.
  async getBranchHealth(): Promise<BranchHealth[]> {
    const [branchesRes, providersRes] = await Promise.all([
      apiRequest<{ data?: unknown[] } | unknown[]>('/v1/branches'),
      apiRequest<{ data: Array<Record<string, unknown>> }>('/v1/providers/overview'),
    ]);
    const branches = (Array.isArray(branchesRes) ? branchesRes : branchesRes.data ?? []) as Array<{ id: string; name: string; location: string }>;
    const providers = providersRes.data ?? [];
    return branches.map(b => {
      const ps = providers.filter(p => p.branchId === b.id);
      const util = ps.length ? Math.round(ps.reduce((s, p) => s + num(p.utilization), 0) / ps.length) : 0;
      const appts = ps.reduce((s, p) => s + num(p.appointmentsToday), 0);
      const revenue = ps.reduce((s, p) => s + num(p.revenueThisMonth), 0);
      const rating = ps.length ? ps.reduce((s, p) => s + num(p.rating), 0) / ps.length : 0;
      // Unvalidated planning index: fixed 70% utilization + 6 points per rating star.
      const healthScore = Math.max(0, Math.min(100, Math.round(util * 0.7 + rating * 6)));
      return {
        id: b.id, name: b.name, location: b.location,
        healthScore, utilization: util, appointmentsToday: appts, providers: ps.length,
        monthlyRevenue: revenue, avgRating: Math.round(rating * 10) / 10,
        missedCalls: null, noShowRisk: null, revenueLeakage: null, staffLoad: null,
      };
    });
  },

  // [LIVE] GET /v1/providers/overview → ranked utilization
  async getProviderUtilization(): Promise<ProviderUtilization[]> {
    const res = await apiRequest<{ data: Array<Record<string, unknown>> }>('/v1/providers/overview');
    return (res.data ?? []).map(p => ({
      id: String(p.id), name: String((p.user as { displayName?: string })?.displayName ?? 'Provider'),
      specialty: String(p.specialty ?? ''), branch: String((p.branch as { name?: string })?.name ?? ''),
      utilization: num(p.utilization), appointmentsToday: num(p.appointmentsToday),
      monthlyRevenue: num(p.revenueThisMonth), rating: num(p.rating), band: bandFor(num(p.utilization)),
    })).sort((a, b) => b.utilization - a.utilization);
  },

  // [LIVE] GET /v1/campaigns → ROI rows with premium empty-state fields
  async getCampaignROI(limit = 4): Promise<CampaignROI[]> {
    const res = await apiRequest<Array<Record<string, unknown>> | { data: Array<Record<string, unknown>> }>(`/v1/campaigns?limit=${limit}`);
    const rows = (Array.isArray(res) ? res : res.data ?? []);
    return rows.slice(0, limit).map(c => {
      const audienceSize = num(c.audienceSize); const booked = num(c.booked); const revenue = num(c.revenue);
      const status = String(c.status ?? 'DRAFT').toLowerCase();
      const conversionRate = audienceSize > 0 ? Math.round((booked / audienceSize) * 100) : 0;
      const launched = audienceSize > 0 || revenue > 0;
      return {
        id: String(c.id), name: String(c.name ?? 'Campaign'), status,
        audienceSize, booked, revenue, conversionRate,
        estimatedAudience: launched ? null : (num(c.estimatedAudience) || null),
        estimatedRecoverable: launched ? null : (num(c.estimatedRecoverable) || null),
        nextAction: launched ? 'Review performance' : status === 'draft' ? 'Generate & approve' : 'Approve to launch',
      };
    });
  },

  // [LIVE] derived from /v1/opportunities + /v1/revenue-leaks into a unified rail.
  async getPriorityActions(): Promise<PriorityAction[]> {
    const [opps, leaks] = await Promise.all([
      apiRequest<Array<Record<string, unknown>>>('/v1/opportunities'),
      apiRequest<Array<Record<string, unknown>>>('/v1/revenue-leaks'),
    ]);
    return buildPriorityActions(opps, leaks);
  },
};

/** Pure view mapping. It never manufactures confidence or financial values. */
export function buildPriorityActions(opps: Array<Record<string, unknown>>, leaks: Array<Record<string, unknown>>): PriorityAction[] {
    const sevFromScore = (s: number): Severity => s >= 80 ? 'critical' : s >= 60 ? 'high' : s >= 40 ? 'medium' : 'low';
    const catFromSource = (src: string): ActionCategory => {
      const s = src.toLowerCase();
      if (s.includes('no-show') || s.includes('no_show')) return 'no_shows';
      if (s.includes('call')) return 'missed_calls';
      if (s.includes('insurance') || s.includes('eligibility')) return 'insurance';
      if (s.includes('payment') || s.includes('deposit')) return 'payments';
      if (s.includes('review') || s.includes('reputation')) return 'reputation';
      return 'revenue';
    };
    const routeFor = (cat: ActionCategory): string => ({
      revenue: '/opportunities', no_shows: '/scheduling', missed_calls: '/ai-receptionist',
      insurance: '/insurance', payments: '/revenue-protection', device_alerts: '/control-plane', reputation: '/reviews',
    }[cat]);
    const ctaFor = (cat: ActionCategory): PriorityAction['cta'] => ({
      revenue: { label: 'Review opportunity', route: routeFor(cat) },
      no_shows: { label: 'Review schedule', route: routeFor(cat) },
      missed_calls: { label: 'Open AI Front Desk', route: routeFor(cat) },
      insurance: { label: 'Review insurance', route: routeFor(cat) },
      payments: { label: 'Review payment queue', route: routeFor(cat) },
      device_alerts: { label: 'Review device alerts', route: routeFor(cat) },
      reputation: { label: 'Review responses', route: routeFor(cat) },
    }[cat]);
    const actions: PriorityAction[] = [];
    for (const o of opps) {
      const score = optionalNum(o.score ?? o.priority);
      const cat = catFromSource(String(o.source ?? o.type ?? o.category ?? 'revenue'));
      actions.push({
        id: `opp-${String(o.id)}`, title: String(o.title ?? o.name ?? 'Revenue opportunity'),
        description: String(o.description ?? o.summary ?? ''), category: cat, severity: score == null ? 'medium' : sevFromScore(score),
        revenueImpact: num(o.estimatedValue ?? o.value ?? o.impact) || null,
        confidence: optionalNum(o.confidence), owner: String(o.owner ?? 'Unassigned'),
        dueDate: (o.dueAt as string) ?? null, cta: ctaFor(cat),
      });
    }
    for (const l of leaks) {
      const cat = catFromSource(String(l.source ?? l.category ?? 'revenue'));
      const value = num(l.estimatedValue ?? l.amount ?? l.value);
      actions.push({
        id: `leak-${String(l.id)}`, title: String(l.source ?? l.title ?? 'Revenue leak'),
        description: String(l.evidence ?? l.description ?? ''), category: cat,
        severity: value > 10000 ? 'critical' : value > 4000 ? 'high' : 'medium',
        revenueImpact: value || null, confidence: optionalNum(l.confidence), owner: 'Unassigned',
        dueDate: null, cta: ctaFor(cat),
      });
    }
    return actions.sort((a, b) => (b.revenueImpact ?? 0) - (a.revenueImpact ?? 0)).slice(0, 8);
}
