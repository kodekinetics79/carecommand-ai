// ===========================================================================
// Subscription catalog (single source of truth for plans, features, add-ons).
// Used by the seed and the entitlement resolver. Stable machine-readable keys.
// ===========================================================================

export const FEATURE_KEYS = [
  'appointments', 'patient_crm', 'basic_reports', 'payments_deposits', 'revenue_protection',
  'campaign_automation', 'ai_receptionist', 'device_integration', 'insurance_eligibility',
  'advanced_reports', 'multi_location', 'compliance_readiness', 'staff_kpis', 'api_access',
  'custom_integrations',
] as const;
export type FeatureKey = typeof FEATURE_KEYS[number];

export const FEATURE_LABELS: Record<string, string> = {
  appointments: 'Appointments & Scheduling',
  patient_crm: 'Patient CRM',
  basic_reports: 'Basic Reports',
  payments_deposits: 'Payments & Deposits',
  revenue_protection: 'Revenue Protection',
  campaign_automation: 'Campaign Automation',
  ai_receptionist: 'AI Receptionist',
  device_integration: 'Device Integration Center',
  insurance_eligibility: 'Insurance Eligibility',
  advanced_reports: 'Advanced Reports',
  multi_location: 'Multi-Location',
  compliance_readiness: 'Compliance Readiness Center',
  staff_kpis: 'Staff KPIs',
  api_access: 'API Access',
  custom_integrations: 'Custom Integrations',
};

export interface PlanFeatureDef { featureKey: FeatureKey; limitValue?: number | null; note?: string }
export interface PlanDef { key: string; name: string; tier: number; description: string; features: PlanFeatureDef[] }

const f = (featureKey: FeatureKey, limitValue?: number | null, note?: string): PlanFeatureDef => ({ featureKey, limitValue: limitValue ?? null, note });

const STARTER: PlanFeatureDef[] = [f('appointments'), f('patient_crm'), f('basic_reports')];
const GROWTH: PlanFeatureDef[] = [
  ...STARTER,
  f('payments_deposits'), f('revenue_protection'), f('campaign_automation'),
  f('multi_location', 2, 'Up to 2 locations'),
];
const COMMAND: PlanFeatureDef[] = [
  ...GROWTH.filter(x => x.featureKey !== 'multi_location'),
  f('multi_location', 5, 'Up to 5 locations'),
  f('ai_receptionist'), f('advanced_reports'), f('staff_kpis'), f('compliance_readiness'),
];
const ENTERPRISE: PlanFeatureDef[] = [
  ...COMMAND.filter(x => x.featureKey !== 'multi_location'),
  f('multi_location', null, 'Unlimited locations'),
  f('device_integration'), f('insurance_eligibility'), f('api_access'), f('custom_integrations'),
];

export const PLANS: PlanDef[] = [
  { key: 'starter', name: 'Starter', tier: 1, description: 'Core scheduling and CRM for a single clinic.', features: STARTER },
  { key: 'growth', name: 'Growth', tier: 2, description: 'Revenue tools and automation for growing clinics.', features: GROWTH },
  { key: 'command', name: 'Command', tier: 3, description: 'AI front desk, advanced reporting, and compliance readiness.', features: COMMAND },
  { key: 'enterprise', name: 'Enterprise', tier: 4, description: 'Full platform with integrations, eligibility, and API access.', features: ENTERPRISE },
];

export interface AddonDef { key: string; name: string; description: string; featureKey: FeatureKey | null }
export const ADDONS: AddonDef[] = [
  { key: 'ai_receptionist', name: 'AI Receptionist', description: 'Voice/SMS AI front desk and receptionist studio.', featureKey: 'ai_receptionist' },
  { key: 'device_integration', name: 'Device Integration Center', description: 'Connect clinical and front-desk devices.', featureKey: 'device_integration' },
  { key: 'insurance_eligibility', name: 'Insurance Eligibility', description: 'Real-time eligibility and benefits checks.', featureKey: 'insurance_eligibility' },
  { key: 'advanced_reports', name: 'Advanced Reports', description: 'Advanced analytics and custom reporting.', featureKey: 'advanced_reports' },
  { key: 'extra_location', name: 'Extra Location', description: 'Add additional clinic locations.', featureKey: 'multi_location' },
  { key: 'extra_users', name: 'Extra Users', description: 'Add additional user seats.', featureKey: null },
  { key: 'campaign_automation', name: 'Campaign Automation', description: 'Automated multi-channel patient campaigns.', featureKey: 'campaign_automation' },
  { key: 'compliance_readiness', name: 'Compliance Readiness Center', description: 'SOC 2 Readiness and HIPAA Alignment tooling.', featureKey: 'compliance_readiness' },
];

// Statuses that grant feature access (past_due keeps a grace window; suspended/
// cancelled lock everything).
export const ENTITLED_STATUSES = ['TRIAL', 'ACTIVE', 'PAST_DUE'];
