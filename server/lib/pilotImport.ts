export const PILOT_ENTITY_TYPES = ['patients', 'appointments', 'insurance'] as const;
export type PilotEntityType = typeof PILOT_ENTITY_TYPES[number];

type FieldKey =
  | 'externalRef'
  | 'firstName'
  | 'lastName'
  | 'email'
  | 'phone'
  | 'lifecycleStage'
  | 'branchName'
  | 'tags'
  | 'patientExternalRef'
  | 'service'
  | 'startsAt'
  | 'endsAt'
  | 'status'
  | 'channel'
  | 'providerRef'
  | 'notes'
  | 'value'
  | 'payerName'
  | 'planName'
  | 'memberId'
  | 'groupNumber'
  | 'relationship'
  | 'subscriberName'
  | 'payerReference'
  | 'verificationStatus'
  | 'active';

export interface PilotFieldSpec {
  key: FieldKey;
  label: string;
  required: boolean;
  aliases: string[];
  example?: string;
}

export interface PilotImportRow {
  index: number;
  status: 'ok' | 'warning' | 'error';
  issues: string[];
  values: Record<string, string | null>;
}

export interface PilotImportAnalysis {
  headers: string[];
  mapping: Record<string, string>;
  rows: PilotImportRow[];
  summary: { total: number; valid: number; warnings: number; invalid: number };
}

export const PILOT_ENTITY_SPECS: Record<PilotEntityType, PilotFieldSpec[]> = {
  patients: [
    { key: 'externalRef', label: 'External ref', required: false, aliases: ['external ref', 'external id', 'mrn', 'patient id'], example: 'PAT-1001' },
    { key: 'firstName', label: 'First name', required: true, aliases: ['first name', 'given name', 'firstname'], example: 'Maya' },
    { key: 'lastName', label: 'Last name', required: true, aliases: ['last name', 'surname', 'lastname'], example: 'Lopez' },
    { key: 'email', label: 'Email', required: false, aliases: ['email', 'patient email'], example: 'maya@example.com' },
    { key: 'phone', label: 'Phone', required: false, aliases: ['phone', 'mobile', 'cell'], example: '(555) 555-0134' },
    { key: 'lifecycleStage', label: 'Lifecycle stage', required: false, aliases: ['lifecycle', 'stage', 'status'], example: 'ACTIVE' },
    { key: 'branchName', label: 'Branch name', required: false, aliases: ['branch', 'location', 'site'], example: 'Main Clinic' },
    { key: 'tags', label: 'Tags', required: false, aliases: ['tags', 'labels'], example: 'vip;follow-up' },
  ],
  appointments: [
    { key: 'patientExternalRef', label: 'Patient external ref', required: true, aliases: ['patient external ref', 'patient id', 'mrn', 'external ref'], example: 'PAT-1001' },
    { key: 'service', label: 'Service', required: true, aliases: ['service', 'visit type', 'appointment type'], example: 'Annual exam' },
    { key: 'startsAt', label: 'Start time', required: true, aliases: ['starts at', 'start time', 'start', 'appointment start'], example: '2026-07-01 09:30' },
    { key: 'endsAt', label: 'End time', required: true, aliases: ['ends at', 'end time', 'end', 'appointment end'], example: '2026-07-01 10:00' },
    { key: 'status', label: 'Status', required: false, aliases: ['status', 'appointment status'], example: 'CONFIRMED' },
    { key: 'channel', label: 'Channel', required: false, aliases: ['channel', 'booking channel'], example: 'EMAIL' },
    { key: 'branchName', label: 'Branch name', required: false, aliases: ['branch', 'location', 'site'], example: 'Main Clinic' },
    { key: 'providerRef', label: 'Provider ref', required: false, aliases: ['provider', 'provider ref', 'doctor'], example: 'DR-SMITH' },
    { key: 'notes', label: 'Notes', required: false, aliases: ['notes', 'note', 'comment'], example: 'Follow-up visit' },
    { key: 'value', label: 'Value', required: false, aliases: ['value', 'price', 'charge'], example: '120' },
  ],
  insurance: [
    { key: 'patientExternalRef', label: 'Patient external ref', required: true, aliases: ['patient external ref', 'patient id', 'mrn', 'external ref'], example: 'PAT-1001' },
    { key: 'payerName', label: 'Payer name', required: false, aliases: ['payer', 'payer name', 'insurance company'], example: 'Blue Cross Blue Shield' },
    { key: 'planName', label: 'Plan name', required: true, aliases: ['plan', 'plan name', 'insurance plan'], example: 'PPO Gold' },
    { key: 'memberId', label: 'Member ID', required: true, aliases: ['member id', 'member', 'policy id'], example: 'A123456789' },
    { key: 'groupNumber', label: 'Group number', required: false, aliases: ['group number', 'group'], example: 'GRP-22' },
    { key: 'relationship', label: 'Relationship', required: false, aliases: ['relationship', 'subscriber relationship'], example: 'Self' },
    { key: 'subscriberName', label: 'Subscriber name', required: false, aliases: ['subscriber', 'subscriber name'], example: 'Maya Lopez' },
    { key: 'payerReference', label: 'Payer reference', required: false, aliases: ['payer reference', 'payer id'], example: 'PAYER-123' },
    { key: 'verificationStatus', label: 'Verification status', required: false, aliases: ['verification status', 'status'], example: 'verified' },
    { key: 'branchName', label: 'Branch name', required: false, aliases: ['branch', 'location', 'site'], example: 'Main Clinic' },
    { key: 'active', label: 'Active', required: false, aliases: ['active', 'is active'], example: 'true' },
  ],
};

const enumSet = (values: readonly string[]) => new Set(values.map(v => v.toUpperCase()));
const patientStages = enumSet(['NEW', 'ACTIVE', 'AT_RISK', 'INACTIVE', 'LOST', 'RETAINED']);
const apptStatuses = enumSet(['CONFIRMED', 'RISKY', 'ARRIVED', 'NO_SHOW', 'CANCELED', 'COMPLETED', 'WAITLIST']);
const apptChannels = enumSet(['WHATSAPP', 'SMS', 'EMAIL', 'PUSH', 'CALL', 'VIDEO']);

export function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function parseCsv(text: string): string[][] {
  const source = text.replace(/^\ufeff/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quote = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quote = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      quote = true;
      continue;
    }
    if (ch === ',') {
      row.push(cell);
      cell = '';
      continue;
    }
    if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      continue;
    }
    if (ch === '\r') {
      continue;
    }
    cell += ch;
  }
  row.push(cell);
  if (row.length > 1 || row[0].trim() !== '') rows.push(row);
  return rows.map(r => r.map(v => v.trim()));
}

export function suggestMapping(entityType: PilotEntityType, headers: string[]): Record<string, string> {
  const normalizedHeaders = new Map(headers.map(header => [normalizeHeader(header), header]));
  const mapping: Record<string, string> = {};
  for (const field of PILOT_ENTITY_SPECS[entityType]) {
    const direct = normalizedHeaders.get(normalizeHeader(field.label));
    const match = direct ?? field.aliases.map(alias => normalizedHeaders.get(normalizeHeader(alias))).find(Boolean);
    if (match) mapping[field.key] = match;
  }
  return mapping;
}

function parseBool(value: string | null): boolean | null {
  if (value == null || value.trim() === '') return null;
  const v = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'active'].includes(v)) return true;
  if (['false', '0', 'no', 'n', 'inactive'].includes(v)) return false;
  return null;
}

function parseDate(value: string | null): Date | null {
  if (value == null || value.trim() === '') return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseNumber(value: string | null): number | null {
  if (value == null || value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function splitTags(value: string | null): string[] {
  if (!value) return [];
  return value.split(/[;,|]/).map(v => v.trim()).filter(Boolean);
}

export function analyzePilotImport(entityType: PilotEntityType, csvText: string, mappingInput: Record<string, string>): PilotImportAnalysis {
  const rows = parseCsv(csvText);
  if (rows.length === 0) {
    return { headers: [], mapping: {}, rows: [], summary: { total: 0, valid: 0, warnings: 0, invalid: 0 } };
  }

  const [headers, ...dataRows] = rows;
  const mapping = { ...suggestMapping(entityType, headers), ...mappingInput };
  const analyzedRows: PilotImportRow[] = dataRows.map((columns, index) => {
    const source: Record<string, string> = {};
    const values: Record<string, string | null> = {};
    const issues: string[] = [];
    const byHeader = new Map(headers.map((header, i) => [header, columns[i] ?? '']));

    for (const field of PILOT_ENTITY_SPECS[entityType]) {
      const header = mapping[field.key];
      const raw = header ? (byHeader.get(header) ?? '') : '';
      source[field.key] = raw;
      values[field.key] = raw.trim() || null;
      if (field.required && !values[field.key]) issues.push(`Missing required field: ${field.label}`);
    }

    if (entityType === 'patients') {
      if (values.email && !/^\S+@\S+\.\S+$/.test(values.email)) issues.push('Email looks invalid');
      if (values.lifecycleStage && !patientStages.has(values.lifecycleStage.toUpperCase())) issues.push('Unknown lifecycle stage');
      if (!values.externalRef) issues.push('No external ref supplied; repeat imports may create duplicates');
    }

    if (entityType === 'appointments') {
      if (!values.patientExternalRef) issues.push('Missing patient reference');
      if (!parseDate(values.startsAt)) issues.push('Start time is not a valid date/time');
      if (!parseDate(values.endsAt)) issues.push('End time is not a valid date/time');
      if (values.status && !apptStatuses.has(values.status.toUpperCase())) issues.push('Unknown appointment status');
      if (values.channel && !apptChannels.has(values.channel.toUpperCase())) issues.push('Unknown channel');
      if (values.value != null && parseNumber(values.value) == null) issues.push('Value must be numeric');
    }

    if (entityType === 'insurance') {
      if (!values.patientExternalRef) issues.push('Missing patient reference');
      if (values.active != null && parseBool(values.active) == null) issues.push('Active must be true/false');
    }

    const status: PilotImportRow['status'] = issues.some(issue => issue.startsWith('Missing required field') || issue.includes('valid date') || issue.includes('Missing patient reference')) ? 'error' : (issues.length > 0 ? 'warning' : 'ok');
    return { index, status, issues, values };
  });

  const summary = analyzedRows.reduce((acc, row) => {
    acc.total++;
    if (row.status === 'ok') acc.valid++;
    if (row.status === 'warning') { acc.valid++; acc.warnings++; }
    if (row.status === 'error') acc.invalid++;
    return acc;
  }, { total: 0, valid: 0, warnings: 0, invalid: 0 });

  return { headers, mapping, rows: analyzedRows, summary };
}

export function normalizeImportValue(entityType: PilotEntityType, field: string, value: string | null): string | number | boolean | Date | string[] | null {
  if (value == null || value.trim() === '') return null;
  switch (field) {
    case 'firstName':
    case 'lastName':
    case 'externalRef':
    case 'email':
    case 'phone':
    case 'lifecycleStage':
    case 'branchName':
    case 'patientExternalRef':
    case 'service':
    case 'status':
    case 'channel':
    case 'providerRef':
    case 'notes':
    case 'payerName':
    case 'planName':
    case 'memberId':
    case 'groupNumber':
    case 'relationship':
    case 'subscriberName':
    case 'payerReference':
    case 'verificationStatus':
      return value.trim();
    case 'startsAt':
    case 'endsAt': {
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    case 'value':
      return parseNumber(value);
    case 'active':
      return parseBool(value);
    case 'tags':
      return splitTags(value);
    default:
      return null;
  }
}

export function buildPreviewSample(row: PilotImportRow, limit = 6): Record<string, unknown> {
  const sample: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row.values).slice(0, limit)) sample[k] = v;
  return sample;
}

export function buildPilotTemplateCsv(entityType: PilotEntityType): { csv: string; headers: string[] } {
  const headers = PILOT_ENTITY_SPECS[entityType].map(field => field.key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase());
  const sample = PILOT_ENTITY_SPECS[entityType].map(field => {
    if (field.example) return field.example;
    if (field.required) return `Sample ${field.label}`;
    return '';
  });
  const escape = (value: string) => {
    if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
    return value;
  };
  const csv = [headers, sample].map(row => row.map(value => escape(String(value ?? ''))).join(',')).join('\n');
  return { csv, headers };
}
