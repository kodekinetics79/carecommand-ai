import { createHash } from 'node:crypto';

export const INTAKE_CONTRACT_VERSION = 1 as const;
export const MAX_INTAKE_FIELDS = 24;

export type IntakeFieldType =
  | 'FIRST_NAME'
  | 'LAST_NAME'
  | 'PHONE'
  | 'EMAIL'
  | 'PREFERRED_DATE'
  | 'PREFERRED_TIME'
  | 'PREFERRED_LOCATION'
  | 'PATIENT_STATUS'
  | 'INSURANCE_PROVIDER'
  | 'REASON_FOR_VISIT'
  | 'PREFERRED_PROVIDER'
  | 'LANGUAGE_PREFERENCE'
  | 'CONSENT'
  | 'CUSTOM_TEXT'
  | 'CUSTOM_DROPDOWN'
  | 'CUSTOM_YES_NO';

export interface IntakeFieldConfiguration {
  id?: string;
  fieldType: IntakeFieldType;
  label: string;
  aiQuestion: string;
  validationRule?: string | null;
  options?: string[];
  required: boolean;
  confirmationRequired: boolean;
  sortOrder: number;
}

interface IntakeContractInput {
  campaignId: string;
  revision: number;
  appointmentType: string;
  eligibleLocations: Array<{ id: string; name: string }>;
  fields: IntakeFieldConfiguration[];
  toolUrl: string;
  /**
   * Catalogue services the caller may actually choose, in `bookableByVoice`
   * order. A campaign used to pin exactly one service as a JSON-Schema `const`,
   * so a dental line that takes cleanings, emergencies, crowns and whitening
   * could only ever book the one the campaign named; "I need a filling" ended
   * in a message. Omitted (or empty) keeps the historical single-service
   * behaviour by falling back to `appointmentType`.
   */
  bookableServices?: string[];
}

export interface ExecutableBookAppointmentContract {
  type: 'custom';
  name: 'book_appointment';
  url: string;
  method: 'POST';
  args_at_root: false;
  parameters: Record<string, unknown>;
}

export interface IntakeContractSnapshot {
  version: typeof INTAKE_CONTRACT_VERSION;
  campaignId: string;
  revision: number;
  appointmentType: string;
  /**
   * The exact set the deployed `service` enum offers. Runtime validates the
   * caller's choice against this list before it reaches the scheduler, so the
   * spoken menu and the bookable menu can never drift apart.
   */
  bookableServices: string[];
  eligibleLocationIds: string[];
  eligibleLocations: Array<{ id: string; name: string }>;
  /**
   * Hash of the human-facing intake semantics. This value and the monotonic
   * revision are embedded as provider-applied JSON-Schema constants in the
   * executable tool, binding the exact response-engine graph to this prompt.
   */
  semanticFingerprint: string;
  fields: Array<{
    id: string | null;
    key: string;
    fieldType: IntakeFieldType;
    label: string;
    aiQuestion: string;
    validationRule: string | null;
    required: boolean;
    confirmationRequired: boolean;
    sortOrder: number;
    options: string[];
  }>;
  bookAppointmentToolContract: ExecutableBookAppointmentContract;
  bookAppointmentToolFingerprint: string;
}

const STANDARD_FIELD_KEY: Partial<Record<IntakeFieldType, string>> = {
  FIRST_NAME: 'first_name',
  LAST_NAME: 'last_name',
  PHONE: 'phone',
  EMAIL: 'email',
  PREFERRED_DATE: 'appointment_date',
  PREFERRED_TIME: 'appointment_time',
  PREFERRED_LOCATION: 'location_id',
  PATIENT_STATUS: 'patient_status',
  INSURANCE_PROVIDER: 'insurance_provider',
  REASON_FOR_VISIT: 'reason_for_visit',
  PREFERRED_PROVIDER: 'preferred_provider',
  LANGUAGE_PREFERENCE: 'language_preference',
  CONSENT: 'messaging_consent',
};

const CUSTOM_TYPES = new Set<IntakeFieldType>(['CUSTOM_TEXT', 'CUSTOM_DROPDOWN', 'CUSTOM_YES_NO']);
const FORBIDDEN_MINIMUM_NECESSARY_TERMS = /\b(?:ssn|social security|credit card|cvv|bank account|medical history|diagnosis)\b/i;
const PROVIDER_TEMPLATE_SYNTAX = /\{\{[^{}]+\}\}|\$\{[^{}]+\}/;

function containsProviderTemplateSyntax(value: unknown): boolean {
  if (typeof value === 'string') return PROVIDER_TEMPLATE_SYNTAX.test(value);
  if (Array.isArray(value)) return value.some(containsProviderTemplateSyntax);
  if (value && typeof value === 'object') return Object.values(value as Record<string, unknown>).some(containsProviderTemplateSyntax);
  return false;
}

function canonicalize(value: unknown, parentKey?: string): unknown {
  if (Array.isArray(value)) {
    const items = value.map(item => canonicalize(item));
    return parentKey === 'required' || parentKey === 'enum'
      ? [...items].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
      : items;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonicalize(child, key)]),
    );
  }
  return value;
}

export function fingerprintJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

export function normalizeBookAppointmentParameters(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const parameters = value as Record<string, unknown>;
  if (parameters.type !== 'object' || !parameters.properties || typeof parameters.properties !== 'object' || Array.isArray(parameters.properties)) return null;
  return canonicalize(parameters) as Record<string, unknown>;
}

export function normalizeBookAppointmentToolContract(value: unknown): ExecutableBookAppointmentContract | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  // Retell expands dynamic variables when a call starts. An attested booking
  // contract must therefore contain no template that can mutate its endpoint,
  // constants, descriptions, enum values, or other schema-critical content.
  if (containsProviderTemplateSyntax(value)) return null;
  const tool = value as Record<string, unknown>;
  const parameters = normalizeBookAppointmentParameters(tool.parameters);
  const url = typeof tool.url === 'string' && tool.url.trim() ? tool.url.trim() : null;
  const method = typeof tool.method === 'string' ? tool.method.toUpperCase() : 'POST';
  // Retell's default is the signed wrapper `{ name, call, args }`. The args-only
  // mode removes trusted call context and is therefore never accepted here.
  const argsAtRoot = tool.args_at_root === true;
  if (!parameters || tool.type !== 'custom' || tool.name !== 'book_appointment' || !url || method !== 'POST' || argsAtRoot) return null;
  return canonicalize({
    type: 'custom',
    name: 'book_appointment',
    url,
    method: 'POST',
    args_at_root: false,
    parameters,
  }) as unknown as ExecutableBookAppointmentContract;
}

export function bookAppointmentToolFingerprint(value: unknown): string | null {
  const normalized = normalizeBookAppointmentToolContract(value);
  return normalized ? fingerprintJson(normalized) : null;
}

export function intakeFieldKey(field: IntakeFieldConfiguration): string {
  const standard = STANDARD_FIELD_KEY[field.fieldType];
  if (standard) return standard;
  const stableId = field.id?.replace(/-/g, '').toLowerCase();
  if (stableId) return `custom_${stableId}`;
  const fallback = field.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `custom_${fallback || 'field'}`;
}

export function validateIntakeFieldConfiguration(fields: IntakeFieldConfiguration[]): string[] {
  const issues: string[] = [];
  if (fields.length > MAX_INTAKE_FIELDS) issues.push(`At most ${MAX_INTAKE_FIELDS} intake fields may be configured.`);
  const ids = new Set<string>();
  const keys = new Set<string>();
  const semanticTypes = new Set<IntakeFieldType>();
  const orders = new Set<number>();

  for (const field of fields) {
    if (!field.label.trim() || field.label.length > 160) issues.push('Intake field labels must contain 1 to 160 characters.');
    if (field.aiQuestion.trim().length < 2 || field.aiQuestion.length > 500) issues.push('Intake questions must contain 2 to 500 characters.');
    if (field.validationRule && field.validationRule.length > 200) issues.push('Intake validation rules may not exceed 200 characters.');
    if (!Number.isSafeInteger(field.sortOrder) || field.sortOrder < 0) issues.push('Intake field sort orders must be non-negative integers.');
    if (field.id) {
      if (ids.has(field.id)) issues.push('Intake field identifiers must be unique.');
      ids.add(field.id);
    }
    const key = intakeFieldKey(field);
    if (keys.has(key)) issues.push(`Intake field key ${key} is duplicated.`);
    keys.add(key);
    if (!CUSTOM_TYPES.has(field.fieldType)) {
      if (semanticTypes.has(field.fieldType)) issues.push(`Only one ${field.fieldType} intake field may be configured.`);
      semanticTypes.add(field.fieldType);
    }
    if (orders.has(field.sortOrder)) issues.push('Intake field sort orders must be unique.');
    orders.add(field.sortOrder);
    if (FORBIDDEN_MINIMUM_NECESSARY_TERMS.test(`${field.label} ${field.aiQuestion} ${field.validationRule ?? ''} ${(field.options ?? []).join(' ')}`)) {
      issues.push('Intake fields may not collect high-risk identifiers, payment credentials, diagnoses, or detailed medical history.');
    }
    if (containsProviderTemplateSyntax([field.label, field.aiQuestion, field.validationRule, field.options])) {
      issues.push('Intake field content may not contain provider dynamic-variable templates.');
    }
    const options = field.options ?? [];
    if (options.some(option => !option.trim() || option.length > 120)) issues.push(`Options for ${field.label} must contain 1 to 120 characters.`);
    const normalizedOptions = new Set(options.map(option => option.trim().toLocaleLowerCase('en-US')));
    if (normalizedOptions.size !== options.length) issues.push(`Options for ${field.label} must be unique.`);
    if (field.fieldType === 'CUSTOM_DROPDOWN') {
      if (options.length < 2 || options.length > 20) issues.push('Custom dropdowns require between 2 and 20 options.');
    } else if (options.length > 0) {
      issues.push(`Options are permitted only for CUSTOM_DROPDOWN fields (${field.label}).`);
    }
  }
  return [...new Set(issues)];
}

function stringProperty(description: string, maxLength: number, extra: Record<string, unknown> = {}) {
  return { type: 'string', description, minLength: 1, maxLength, ...extra };
}

function propertyFor(field: IntakeFieldConfiguration, locationIds: string[]): Record<string, unknown> {
  switch (field.fieldType) {
    case 'FIRST_NAME':
    case 'LAST_NAME': return stringProperty(field.label, 80);
    case 'PHONE': return stringProperty('Provider-observed call identity; never supplied by model arguments.', 16, { pattern: '^\\+[1-9]\\d{7,14}$', readOnly: true });
    case 'EMAIL': return stringProperty(field.label, 160, { format: 'email' });
    case 'PREFERRED_DATE': return stringProperty(field.label, 10, { pattern: '^\\d{4}-\\d{2}-\\d{2}$' });
    case 'PREFERRED_TIME': return stringProperty(field.label, 5, { pattern: '^(?:[01]\\d|2[0-3]):[0-5]\\d$' });
    case 'PREFERRED_LOCATION': return stringProperty(field.label, 36, { enum: locationIds });
    case 'PATIENT_STATUS': return stringProperty(field.label, 8, { enum: ['new', 'existing'] });
    case 'INSURANCE_PROVIDER':
    case 'PREFERRED_PROVIDER': return stringProperty(field.label, 120);
    case 'REASON_FOR_VISIT':
    case 'CUSTOM_TEXT': return stringProperty(field.label, 300);
    case 'LANGUAGE_PREFERENCE': return stringProperty(field.label, 80);
    case 'CONSENT': return {
      type: 'boolean',
      description: `${field.label}. Non-authorizing appointment-notification preference only; never marketing consent.`,
    };
    case 'CUSTOM_YES_NO': return { type: 'boolean', description: field.label };
    case 'CUSTOM_DROPDOWN': return stringProperty(field.label, 120, { enum: field.options ?? [] });
  }
}

export function compileIntakeContract(input: IntakeContractInput): { snapshot: IntakeContractSnapshot; fingerprint: string } {
  const issues = validateIntakeFieldConfiguration(input.fields);
  if (!Number.isSafeInteger(input.revision) || input.revision < 1) issues.push('The intake schema revision must be a positive integer.');
  if (input.appointmentType.trim().length < 2 || input.appointmentType.length > 120) issues.push('The configured appointment type must contain 2 to 120 characters.');
  if (!input.toolUrl.trim()) issues.push('The executable booking tool URL is required.');
  if (containsProviderTemplateSyntax(input.appointmentType)) issues.push('The configured appointment type may not contain provider dynamic-variable templates.');
  if (containsProviderTemplateSyntax(input.toolUrl)) issues.push('The executable booking tool URL may not contain provider dynamic-variable templates.');
  const fields = [...input.fields].sort((a, b) => a.sortOrder - b.sortOrder || (a.id ?? '').localeCompare(b.id ?? ''));
  if (new Set(input.eligibleLocations.map(location => location.id)).size !== input.eligibleLocations.length) issues.push('Eligible location identifiers must be unique.');
  if (input.eligibleLocations.some(location => !location.id.trim() || !location.name.trim())) issues.push('Eligible locations require stable identifiers and names.');
  if (containsProviderTemplateSyntax(input.eligibleLocations)) issues.push('Eligible location content may not contain provider dynamic-variable templates.');
  // The bookable menu. `appointmentType` is always offerable (it is what the
  // campaign advertises); the catalogue's other voice-bookable services join
  // it, deduplicated and ordered so the fingerprint is stable across reads.
  const bookableServices = [...new Set([
    input.appointmentType.trim(),
    ...(input.bookableServices ?? []).map(name => name.trim()).filter(Boolean),
  ])].sort();
  if (bookableServices.some(name => name.length < 2 || name.length > 120)) {
    issues.push('Every voice-bookable service name must contain 2 to 120 characters.');
  }
  if (containsProviderTemplateSyntax(bookableServices)) {
    issues.push('Voice-bookable service names may not contain provider dynamic-variable templates.');
  }
  const locationIds = [...new Set(input.eligibleLocations.map(location => location.id))].sort();
  const eligibleLocations = [...input.eligibleLocations]
    .map(location => ({ id: location.id, name: location.name }))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (!locationIds.length && fields.some(field => field.fieldType === 'PREFERRED_LOCATION')) {
    issues.push('A preferred-location intake field requires at least one eligible active mapped location.');
  }
  if (issues.length) throw new Error(`invalid_intake_configuration:${issues.join('|')}`);

  const semanticFields = fields.map(field => ({
    id: field.id ?? null,
    key: intakeFieldKey(field),
    fieldType: field.fieldType,
    label: field.label,
    aiQuestion: field.aiQuestion,
    validationRule: field.validationRule ?? null,
    required: field.required,
    confirmationRequired: field.confirmationRequired,
    sortOrder: field.sortOrder,
    options: [...(field.options ?? [])],
  }));
  const semanticFingerprint = fingerprintJson({
    version: INTAKE_CONTRACT_VERSION,
    campaignId: input.campaignId,
    revision: input.revision,
    appointmentType: input.appointmentType,
    bookableServices,
    eligibleLocations,
    fields: semanticFields,
  });
  const properties: Record<string, unknown> = {
    first_name: stringProperty('Caller first name.', 80),
    last_name: stringProperty('Caller last name.', 80),
    appointment_date: stringProperty('Chosen appointment date (YYYY-MM-DD).', 10, { pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
    appointment_time: stringProperty('Chosen appointment time (HH:mm, 24-hour).', 5, { pattern: '^(?:[01]\\d|2[0-3]):[0-5]\\d$' }),
    // `service` is the one value here the CALLER chooses: an enum over the
    // clinic's voice-bookable catalogue rather than a single pinned const.
    // Runtime re-validates the choice against `bookableServices` on the
    // persisted snapshot before it reaches the scheduler.
    service: { type: 'string', enum: bookableServices, description: 'The service the caller asked for. Choose only from this list.' },
    // These values are applied by Retell's schema rather than selected by the
    // model. Runtime re-derives them from persisted call/campaign authority and
    // treats the supplied constants only as a deployment-drift cross-check.
    intake_contract_fingerprint: { type: 'string', const: semanticFingerprint, description: 'Provider-deployed immutable intake contract fingerprint.' },
    intake_schema_revision: { type: 'integer', const: input.revision, description: 'Provider-deployed immutable intake schema revision.' },
    booking_confirmed: {
      type: 'boolean',
      const: true,
      description: 'Provider-reported final caller confirmation of the complete appointment selection.',
    },
  };
  if (locationIds.length) properties.location_id = stringProperty('Chosen eligible clinic location.', 36, { enum: locationIds });
  const required = new Set([
    'first_name', 'last_name', 'appointment_date', 'appointment_time', 'service',
    'intake_contract_fingerprint', 'intake_schema_revision', 'booking_confirmed',
  ]);
  for (const field of fields) {
    const key = intakeFieldKey(field);
    // Phone identity comes from the signed provider call envelope and persisted
    // call context. The model cannot provide or override it.
    if (field.fieldType !== 'PHONE') {
      properties[key] = propertyFor(field, locationIds);
      if (field.required) required.add(key);
    }
    if (field.confirmationRequired) {
      const confirmationKey = `${key}_confirmed`;
      properties[confirmationKey] = {
        type: 'boolean',
        const: true,
        description: `Provider-reported read-back confirmation for ${field.label}.`,
      };
      required.add(confirmationKey);
    }
  }
  const parameters = normalizeBookAppointmentParameters({
    type: 'object',
    additionalProperties: false,
    properties,
    required: [...required],
  })!;
  const bookAppointmentToolContract = normalizeBookAppointmentToolContract({
    type: 'custom',
    name: 'book_appointment',
    url: input.toolUrl,
    method: 'POST',
    args_at_root: false,
    parameters,
  })!;
  const bookFingerprint = fingerprintJson(bookAppointmentToolContract);
  const snapshot: IntakeContractSnapshot = {
    version: INTAKE_CONTRACT_VERSION,
    campaignId: input.campaignId,
    revision: input.revision,
    appointmentType: input.appointmentType,
    bookableServices,
    eligibleLocationIds: locationIds,
    eligibleLocations,
    semanticFingerprint,
    fields: semanticFields,
    bookAppointmentToolContract,
    bookAppointmentToolFingerprint: bookFingerprint,
  };
  return { snapshot, fingerprint: fingerprintJson(snapshot) };
}

/**
 * The menu a deployed agent may offer, tolerant of snapshots persisted before
 * `bookableServices` existed (those campaigns keep their single service).
 */
export function bookableServicesOf(
  snapshot: Pick<IntakeContractSnapshot, 'appointmentType' | 'bookableServices'>,
): string[] {
  const configured = Array.isArray(snapshot.bookableServices)
    ? snapshot.bookableServices.filter((name): name is string => typeof name === 'string' && name.trim().length > 0)
    : [];
  return configured.length ? configured : [snapshot.appointmentType];
}

/**
 * Resolve a caller-chosen service name back to the exact attested spelling, or
 * null when it is not on this deployment's menu. Case-insensitive because the
 * model echoes what it heard; the returned value is always the catalogue's own
 * casing so the scheduler matches on it.
 */
export function resolveBookableService(
  snapshot: Pick<IntakeContractSnapshot, 'appointmentType' | 'bookableServices'>,
  requested: unknown,
): string | null {
  const wanted = typeof requested === 'string' ? requested.trim().toLocaleLowerCase() : '';
  if (!wanted) return null;
  return bookableServicesOf(snapshot).find(name => name.trim().toLocaleLowerCase() === wanted) ?? null;
}

export function buildBookAppointmentTool(input: {
  snapshot: IntakeContractSnapshot;
  clinicName: string;
}): Record<string, unknown> {
  return {
    ...input.snapshot.bookAppointmentToolContract,
    description: `Book an appointment for ${input.clinicName} only after all required details are collected and confirmed.`,
    speak_during_execution: true,
    speak_after_execution: true,
  };
}
