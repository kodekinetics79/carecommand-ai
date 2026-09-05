// Static provider catalog. The DB registry (InsuranceProvider / DeviceProvider)
// holds per-tenant config + status; this describes what each provider IS and
// what config it needs. No secrets live here.

export interface ConfigField { key: string; label: string; secret: boolean; required: boolean }

export interface InsuranceProviderDef {
  key: 'stedi' | 'optum' | 'availity';
  displayName: string;
  category: 'INSURANCE';
  supportsSandbox: boolean;
  configFields: ConfigField[];
  note: string;
}

export const INSURANCE_PROVIDERS: InsuranceProviderDef[] = [
  {
    key: 'stedi', displayName: 'Stedi', category: 'INSURANCE', supportsSandbox: true,
    configFields: [{ key: 'apiKey', label: 'Stedi API key', secret: true, required: true }],
    note: 'Real-time 270/271 eligibility. Sandbox available now; production requires a Stedi API key.',
  },
  {
    key: 'optum', displayName: 'Optum', category: 'INSURANCE', supportsSandbox: false,
    configFields: [{ key: 'clientId', label: 'Client ID', secret: false, required: true }, { key: 'clientSecret', label: 'Client secret', secret: true, required: true }],
    note: 'Placeholder — not yet configured. Requires Optum credentials before activation.',
  },
  {
    key: 'availity', displayName: 'Availity', category: 'INSURANCE', supportsSandbox: false,
    configFields: [{ key: 'clientId', label: 'Client ID', secret: false, required: true }, { key: 'clientSecret', label: 'Client secret', secret: true, required: true }],
    note: 'Placeholder — not yet configured. Requires Availity credentials before activation.',
  },
];

export type DeviceProviderCategory = 'DIRECT_API' | 'AGGREGATOR' | 'RPM_VENDOR' | 'MANUAL';

export interface DeviceProviderDef {
  key: 'dexcom' | 'withings' | 'validic' | 'terra' | 'tenovi' | 'manual';
  displayName: string;
  category: DeviceProviderCategory;
  supportsSandbox: boolean;
  supportsWebhook: boolean;
  configFields: ConfigField[];
  note: string;
}

export const DEVICE_PROVIDERS: DeviceProviderDef[] = [
  { key: 'dexcom', displayName: 'Dexcom', category: 'DIRECT_API', supportsSandbox: true, supportsWebhook: true, configFields: [{ key: 'clientId', label: 'Client ID', secret: false, required: true }, { key: 'clientSecret', label: 'Client secret', secret: true, required: true }, { key: 'webhookSecret', label: 'Webhook signing secret', secret: true, required: true }], note: 'Continuous glucose. OAuth sandbox and a signed webhook secret are required before enrolment.' },
  { key: 'withings', displayName: 'Withings', category: 'DIRECT_API', supportsSandbox: true, supportsWebhook: true, configFields: [{ key: 'clientId', label: 'Client ID', secret: false, required: true }, { key: 'clientSecret', label: 'Client secret', secret: true, required: true }, { key: 'webhookSecret', label: 'Webhook signing secret', secret: true, required: true }], note: 'BP / weight / sleep. OAuth sandbox and a signed webhook secret are required before enrolment.' },
  { key: 'validic', displayName: 'Validic', category: 'AGGREGATOR', supportsSandbox: true, supportsWebhook: true, configFields: [{ key: 'apiKey', label: 'API key', secret: true, required: true }, { key: 'orgId', label: 'Organization ID', secret: false, required: true }, { key: 'webhookSecret', label: 'Webhook signing secret', secret: true, required: true }], note: 'Multi-device aggregator. Credentials and a signed webhook secret are required before enrolment.' },
  { key: 'terra', displayName: 'Terra', category: 'AGGREGATOR', supportsSandbox: true, supportsWebhook: true, configFields: [{ key: 'apiKey', label: 'API key', secret: true, required: true }, { key: 'devId', label: 'Dev ID', secret: false, required: true }, { key: 'webhookSecret', label: 'Webhook signing secret', secret: true, required: true }], note: 'Wearable aggregator. Credentials and a signed webhook secret are required before enrolment.' },
  { key: 'tenovi', displayName: 'Tenovi', category: 'RPM_VENDOR', supportsSandbox: true, supportsWebhook: true, configFields: [{ key: 'apiKey', label: 'API key', secret: true, required: true }, { key: 'webhookSecret', label: 'Webhook signing secret', secret: true, required: true }], note: 'Cellular RPM hub vendor. Credentials and a signed webhook secret are required before enrolment.' },
  { key: 'manual', displayName: 'Manual entry', category: 'MANUAL', supportsSandbox: false, supportsWebhook: false, configFields: [], note: 'Controlled fallback for staff-entered readings. Always available.' },
];

export const INSURANCE_KEYS = INSURANCE_PROVIDERS.map(p => p.key);
export const DEVICE_KEYS = DEVICE_PROVIDERS.map(p => p.key);

/** Mask a member ID for any UI/response surface — only the last 4 chars remain. */
export function maskMemberId(memberId: string | null | undefined): string | null {
  if (!memberId) return null;
  const trimmed = memberId.trim();
  if (trimmed.length <= 4) return '••••';
  return '••••' + trimmed.slice(-4);
}
