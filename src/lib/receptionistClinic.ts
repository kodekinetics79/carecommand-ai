import { apiRequest } from './api';
import type { Clinic, HoursWindow, Location, WeeklyHours } from './receptionist';
import type { ServiceCatalogItem } from './services';

// ===========================================================================
// C2 clinic knowledge / hours / locale packs — client contract.
//
// Every route added or extended by the C2 backend is called from THIS file and
// nowhere else, so a field-name delta between the two halves (built in
// parallel against docs/receptionist phase2-contracts §2, §4, §7, §10 and the
// C2 design §4) is a one-file reconciliation. Types mirror the server response
// shapes; nothing here invents a default the server did not send.
// ===========================================================================

// --- Clinic readiness (GET /clinics, PATCH /clinics/:id) -------------------

export type ReadinessBlocker =
  | 'clinic_country_missing'
  | 'locale_pack_unapproved'
  | 'clinic_hours_missing'
  | 'no_active_agent'
  | 'agent_language_unsupported'
  | 'transfer_loops_to_agent';

export type TransferReason = 'missing' | 'not_e164' | 'loops_to_agent';

export interface ClinicReadiness {
  transferReady: boolean;
  transferReason: TransferReason | null;
  country: string | null;
  countryConfirmed: boolean;
  hoursConfigured: boolean;
  localePack: { language: string; country: string | null; status: 'APPROVED' | 'DRAFT' | 'MISSING'; packId: string | null; evidenceHash: string | null } | null;
  knowledge: { status: 'APPROVED' | 'DRAFT' | 'MISSING'; approvedRevision: number | null; dirty: boolean } | null;
  blockers: ReadinessBlocker[];
}

/** A location row as the C2 API returns it: timezone derived from the branch, plus access notes. */
export interface LocationRow extends Location {
  accessNotes?: string | null;
  /** Where `timezone` came from: the linked branch, or the clinic for a branchless row. */
  timezoneSource?: { kind: 'branch' | 'clinic'; name: string | null };
}

/**
 * A clinic row as the C2 API returns it. `country` is nullable and never
 * inferred; `readiness` is absent only when talking to a pre-C2 server, and
 * every consumer treats that as "unknown", never as "ready".
 */
export interface ClinicRow extends Omit<Clinic, 'locations'> {
  country?: string | null;
  updatedAt?: string;
  readiness?: ClinicReadiness;
  locations?: LocationRow[];
}

export const BLOCKER_LABELS: Record<ReadinessBlocker, string> = {
  clinic_country_missing: 'Country missing',
  locale_pack_unapproved: 'Pack unapproved',
  clinic_hours_missing: 'No hours',
  no_active_agent: 'No active agent',
  agent_language_unsupported: 'Language unsupported',
  transfer_loops_to_agent: 'Transfer loops',
};

export function blockerLabel(blocker: string): string {
  return (BLOCKER_LABELS as Record<string, string>)[blocker] ?? blocker.replaceAll('_', ' ');
}

export interface ClinicCreateInput {
  name: string;
  phone: string;
  inboundNumber?: string | null;
  country: string;
  timezone: string;
  defaultLanguage: string;
  logoUrl?: string | null;
  website?: string | null;
  addressLine?: string | null;
  complianceDisclosure?: string | null;
  humanFallbackNumber?: string | null;
  doNotContactPolicy?: string | null;
  workingHours?: WeeklyHours | null;
  active?: boolean;
}

/**
 * PATCH sends only the keys that changed, plus the revision it was edited
 * from. `country` is nullable here only because an unset clinic's draft holds
 * null; the server never accepts clearing a country that was set.
 */
export type ClinicPatchInput = Partial<Omit<ClinicCreateInput, 'country'>> & { country?: string | null; expectedUpdatedAt?: string };

export interface LocationInput {
  name: string;
  address: string;
  phone: string | null;
  branchId: string;
  active: boolean;
  accessNotes?: string | null;
  /** Per-day override; `null` = inherit clinic hours. Omitted = unchanged. */
  workingHours?: WeeklyHours | null;
}

// --- Weekly hours helpers --------------------------------------------------

export const WEEK_DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
export type WeekDay = typeof WEEK_DAYS[number];

export function standardWeek(): WeeklyHours {
  const window: HoursWindow = { open: true, start: '09:00', end: '17:00' };
  return { monday: window, tuesday: window, wednesday: window, thursday: window, friday: window, saturday: { open: false }, sunday: { open: false } };
}

/**
 * True when two stored hours objects say the same thing, whatever their key
 * order and however a closed day is spelled. The Save bar is driven by this
 * rather than by JSON identity, so re-serialising an unchanged week does not
 * light it up.
 */
export function sameWeeklyHours(a: WeeklyHours | null | undefined, b: WeeklyHours | null | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return WEEK_DAYS.every(day => {
    const left = a[day];
    const right = b[day];
    const leftOpen = Boolean(left?.open);
    const rightOpen = Boolean(right?.open);
    if (leftOpen !== rightOpen) return false;
    if (!leftOpen) return true;
    return left?.start === right?.start && left?.end === right?.end;
  });
}

// --- Closures (GET/POST /clinics/:id/closures, PATCH/DELETE /closures/:id) --

export interface Closure {
  id: string;
  clinicId: string;
  locationId: string | null;
  startsOn: string; // YYYY-MM-DD, clinic-local
  endsOn: string;   // YYYY-MM-DD, inclusive
  startTime: string | null;
  endTime: string | null;
  reason: string;
  internalNote: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ClosureInput {
  locationId?: string | null;
  startsOn: string;
  endsOn: string;
  reason: string;
  internalNote?: string | null;
}

// --- Knowledge (GET/PUT /clinics/:id/knowledge, POST …/knowledge/approve) ----

export interface KnowledgePayer {
  id: string;
  name: string;
  plans?: string[];
  note?: string;
  source: 'manual';
  verifiedAt?: string;
}

export interface KnowledgeFaq {
  id: string;
  question: string;
  answer: string;
  approvedByUserId?: string;
  approvedAt?: string;
}

/** Contract §10: urgent (clinical, same-day) is distinct from emergency (pack emergency number). */
export interface UrgentCare {
  whatCountsAsUrgent: string;
  sameDayPolicy: string;
  onCallNumber: string | null;
}

/** Contract §4: services are NOT here — they are ServiceCatalogItem columns. */
export interface KnowledgeDocument {
  acceptedPayers: KnowledgePayer[];
  paymentPolicy: string;
  newPatientPolicy: string;
  urgentCare: UrgentCare;
  faq: KnowledgeFaq[];
}

export interface KnowledgeIssue { path: string; message: string }

export interface KnowledgeView {
  clinicId: string;
  draft: KnowledgeDocument;
  draftRevision: number;
  approved: KnowledgeDocument | null;
  approvedRevision: number | null;
  approvedHash: string | null;
  approvedAt: string | null;
  approvedBy: { id: string; displayName: string } | null;
  dirty: boolean;
  validation: { ok: boolean; issues: KnowledgeIssue[] };
}

export function emptyKnowledgeDocument(): KnowledgeDocument {
  return {
    acceptedPayers: [],
    paymentPolicy: '',
    newPatientPolicy: '',
    urgentCare: { whatCountsAsUrgent: '', sameDayPolicy: '', onCallNumber: null },
    faq: [],
  };
}

/** A pre-C2 or partial server document still renders every section. */
export function normalizeKnowledgeDocument(input: Partial<KnowledgeDocument> | null | undefined): KnowledgeDocument {
  const base = emptyKnowledgeDocument();
  if (!input) return base;
  return {
    acceptedPayers: Array.isArray(input.acceptedPayers) ? input.acceptedPayers : base.acceptedPayers,
    paymentPolicy: typeof input.paymentPolicy === 'string' ? input.paymentPolicy : base.paymentPolicy,
    newPatientPolicy: typeof input.newPatientPolicy === 'string' ? input.newPatientPolicy : base.newPatientPolicy,
    urgentCare: {
      whatCountsAsUrgent: input.urgentCare?.whatCountsAsUrgent ?? '',
      sameDayPolicy: input.urgentCare?.sameDayPolicy ?? '',
      onCallNumber: input.urgentCare?.onCallNumber ?? null,
    },
    faq: Array.isArray(input.faq) ? input.faq : base.faq,
  };
}

// --- Voice-bookable services (ServiceCatalogItem columns, contract §4) ------

/** The four C2 columns on ServiceCatalogItem. Absent on a pre-C2 server. */
export interface ServiceVoiceFields {
  spokenDescription: string | null;
  bookableByVoice: boolean;
  voiceDurationMinutes: number | null;
  priceFrom: number | null;
}

export type VoiceServiceRow = ServiceCatalogItem & Partial<ServiceVoiceFields>;

// --- Locale packs (GET/POST /locale-packs, PATCH /locale-packs/:id, …) ------

export type LocalePackStatus = 'DRAFT' | 'APPROVED' | 'RETIRED';

/** Contract §2 pack shape. `messages` keys are C3's dotted namespace. */
export interface LocalePackStrings {
  emergencyNumber: string;
  timeStyle: '12h' | '24h';
  dateStyle: 'weekday-month-day' | 'weekday-day-month';
  messages: Record<string, string>;
}

export interface LocalePackView {
  id: string;
  language: string;
  country: string;
  version: number;
  status: LocalePackStatus;
  source: 'platform_default' | 'tenant' | string;
  baseDefaultVersion: number | null;
  strings: LocalePackStrings;
  evidenceHash: string;
  approvedAt: string | null;
  approvedBy: { id: string; displayName: string } | null;
  retiredAt: string | null;
  createdAt: string;
  updatedAt: string;
  boundActiveCampaigns: number;
}

export interface LocalePackDefault {
  language: string;
  country: string;
  version: number;
  strings: LocalePackStrings;
  evidenceHash: string;
}

export interface LocalePacksResponse {
  packs: LocalePackView[];
  defaults: LocalePackDefault[];
}

export type LocalePackCreateInput = {
  language: string;
  country: string;
  from: { kind: 'platform_default' } | { kind: 'pack'; packId: string };
  strings?: Partial<LocalePackStrings>;
};

// --- Hours status (GET /hours-status?at=) ----------------------------------

export type DayKey = 'sunday' | 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday';

/**
 * One resolved day from the hours engine. `source` says which layer decided
 * it, and `unconfigured` is NOT "closed": it means the clinic has no hours,
 * which is why the card refuses to count after-hours calls for it.
 */
export interface EffectiveDay {
  date: string;
  dayKey: DayKey;
  timezone: string;
  open: boolean;
  windows: Array<{ start: string; end: string }>;
  closure: { id: string; reason: string; allDay: boolean } | null;
  source: 'location' | 'clinic' | 'unconfigured';
}

export interface HoursStatusLocation {
  id: string;
  name: string;
  timezone: string;
  configured: boolean;
  isOpenNow: boolean;
  /** Always a sentence — 'hours not configured' rather than null. */
  todayHoursSpoken: string;
}

export interface HoursStatusClinic {
  clinicId: string;
  name: string;
  timezone: string;
  country: string | null;
  configured: boolean;
  blockers: string[];
  isOpenNow: boolean;
  today: EffectiveDay | null;
  /** Always a sentence — 'hours not configured' rather than null. */
  todayHoursSpoken: string;
  nextOpening: { date: string; start: string; startsAt: string; spoken: string | null } | null;
  closureReason: string | null;
  afterHoursCalls: { last24Hours: number; last7Days: number; lastAt: string | null };
  locations: HoursStatusLocation[];
  /** True when the clinic has no approved pack and the server formatted with a fallback locale. */
  formatFallback: boolean;
}

export interface HoursStatusView {
  at: string;
  clinics: HoursStatusClinic[];
}

// --- Catalog (GET /catalog) ------------------------------------------------

export interface CatalogFieldType {
  type: string;
  label: string;
  question: string;
  validation: string;
  group: string;
  hasOptions: boolean;
  sensitive: boolean;
}

export interface CatalogCountry {
  code: string;
  name: string;
  callingCode: string;
  defaultEmergencyNumber: string;
  defaultLanguages: string[];
  currency: string;
}

export interface CatalogLanguage { id: string; label: string; provider: string }

export interface CatalogLocalePackStatus {
  language: string;
  country: string;
  status: 'APPROVED' | 'DRAFT' | 'MISSING';
  packId: string | null;
  hasPlatformDefault: boolean;
  /** Version of the platform default behind this pair; null when there is none. */
  platformDefaultVersion: number | null;
}

export interface CatalogVoices {
  source: 'service' | 'mock' | 'unavailable';
  fetchedAt: string | null;
  error: null | 'unauthorized' | 'provider_unavailable' | 'invalid_response';
  items: Array<{ id: string; name: string; gender: string | null; accent: string | null; age: string | null; previewUrl: string | null }>;
}

export interface Catalog {
  generatedAt: string;
  fieldTypes: CatalogFieldType[];
  timezones: { groups: Array<{ region: string; zones: string[] }>; recommended: string[] };
  countries: CatalogCountry[];
  languages: CatalogLanguage[];
  /** Contributed by C5; optional until it lands. */
  voices?: CatalogVoices;
  tones: string[];
  campaignTypes: string[];
  localePacks: CatalogLocalePackStatus[];
  limits: { maxIntakeFields: number; faqMax: number; payersMax: number; closureMaxDays: number; knowledgeTextMax: number; closureReasonMax: number; accessNotesMax: number };
}

// --- API -------------------------------------------------------------------

const base = '/v1/receptionist';
const servicesBase = '/v1/services';

export const receptionistClinicApi = {
  // Clinics (existing routes, extended with country/readiness/expectedUpdatedAt)
  listClinics: () => apiRequest<ClinicRow[]>(`${base}/clinics`),
  createClinic: (body: ClinicCreateInput) => apiRequest<ClinicRow>(`${base}/clinics`, { method: 'POST', body: JSON.stringify(body) }),
  updateClinic: (id: string, body: ClinicPatchInput) => apiRequest<ClinicRow>(`${base}/clinics/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),

  // Locations (timezone no longer accepted; accessNotes added)
  createLocation: (body: LocationInput & { clinicId: string }) => apiRequest<LocationRow>(`${base}/locations`, { method: 'POST', body: JSON.stringify(body) }),
  updateLocation: (id: string, body: Partial<LocationInput>) => apiRequest<LocationRow>(`${base}/locations/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),

  // Closures
  listClosures: (clinicId: string, range?: { from?: string; to?: string }) => {
    const query = new URLSearchParams();
    if (range?.from) query.set('from', range.from);
    if (range?.to) query.set('to', range.to);
    const suffix = query.toString();
    return apiRequest<Closure[]>(`${base}/clinics/${clinicId}/closures${suffix ? `?${suffix}` : ''}`);
  },
  createClosure: (clinicId: string, body: ClosureInput) => apiRequest<Closure>(`${base}/clinics/${clinicId}/closures`, { method: 'POST', body: JSON.stringify(body) }),
  updateClosure: (id: string, body: Partial<ClosureInput>) => apiRequest<Closure>(`${base}/closures/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteClosure: (id: string) => apiRequest<void>(`${base}/closures/${id}`, { method: 'DELETE' }),

  // Knowledge
  getKnowledge: (clinicId: string) => apiRequest<KnowledgeView>(`${base}/clinics/${clinicId}/knowledge`),
  saveKnowledge: (clinicId: string, body: { expectedRevision: number; draft: KnowledgeDocument }) =>
    apiRequest<KnowledgeView>(`${base}/clinics/${clinicId}/knowledge`, { method: 'PUT', body: JSON.stringify(body) }),
  approveKnowledge: (clinicId: string, body: { expectedRevision: number }) =>
    apiRequest<KnowledgeView>(`${base}/clinics/${clinicId}/knowledge/approve`, { method: 'POST', body: JSON.stringify(body) }),

  // Voice-bookable services live on ServiceCatalogItem (contract §4). The list
  // is the existing services route; the PATCH carries only the four C2 columns.
  listServices: () => apiRequest<VoiceServiceRow[]>(servicesBase),
  updateServiceVoiceFields: (id: string, body: Partial<ServiceVoiceFields>) =>
    apiRequest<VoiceServiceRow>(`${servicesBase}/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),

  // Locale packs
  listLocalePacks: () => apiRequest<LocalePacksResponse>(`${base}/locale-packs`),
  createLocalePack: (body: LocalePackCreateInput) => apiRequest<LocalePackView>(`${base}/locale-packs`, { method: 'POST', body: JSON.stringify(body) }),
  updateLocalePack: (id: string, body: { expectedUpdatedAt: string; strings: Partial<LocalePackStrings> }) =>
    apiRequest<LocalePackView>(`${base}/locale-packs/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  approveLocalePack: (id: string, body: { acknowledgedEvidenceHash: string }) =>
    apiRequest<LocalePackView>(`${base}/locale-packs/${id}/approve`, { method: 'POST', body: JSON.stringify(body) }),
  /** Contract §2: retire is a status change through PATCH, not a separate route. */
  retireLocalePack: (id: string, body: { expectedUpdatedAt: string }) =>
    apiRequest<LocalePackView>(`${base}/locale-packs/${id}`, { method: 'PATCH', body: JSON.stringify({ ...body, status: 'RETIRED' }) }),

  // Hours status + catalog (read gate: receptionist:read, contract §9)
  hoursStatus: (at?: string) => apiRequest<HoursStatusView>(`${base}/hours-status${at ? `?at=${encodeURIComponent(at)}` : ''}`),
  catalog: () => apiRequest<Catalog>(`${base}/catalog`),
};

export const CATALOG_PATH = `${base}/catalog`;
export const HOURS_STATUS_PATH = `${base}/hours-status`;

// --- Pure helpers shared by the panels ------------------------------------

const E164 = /^\+[1-9]\d{7,14}$/;

export function isE164(value: string | null | undefined): boolean {
  return Boolean(value && E164.test(value.trim()));
}

/**
 * Transfer readiness as the badge shows it. The server's `readiness` wins when
 * present; a pre-C2 server gets the same local E.164 rule the server applies,
 * so the badge never claims "ready" for a number the server would refuse.
 */
export function transferReadinessOf(readiness: ClinicReadiness | undefined, fallbackNumber: string | null | undefined): { ready: boolean; reason: TransferReason | null } {
  if (readiness) return { ready: readiness.transferReady, reason: readiness.transferReady ? null : readiness.transferReason ?? (fallbackNumber ? 'not_e164' : 'missing') };
  const trimmed = fallbackNumber?.trim() ?? '';
  if (!trimmed) return { ready: false, reason: 'missing' };
  return isE164(trimmed) ? { ready: true, reason: null } : { ready: false, reason: 'not_e164' };
}

export const TRANSFER_REASON_COPY: Record<TransferReason, string> = {
  missing: 'Not set — callers will be offered a message instead of a transfer',
  not_e164: 'Not E.164 — transfer disabled',
  loops_to_agent: 'Same as a line the agent answers — a transfer would loop back to the agent',
};

/** Placeholders the pack renderer knows. Unknown ones are a server validation error. */
export const PACK_PLACEHOLDERS = [
  'agent_name', 'clinic_name', 'clinic_phone', 'clinic_disclosure', 'emergency_number',
  'next_opening', 'hours_today', 'human_fallback_number', 'location_name', 'fields',
] as const;

export type PackPlaceholder = typeof PACK_PLACEHOLDERS[number];

const PLACEHOLDER_PATTERN = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

export function placeholdersIn(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER_PATTERN)].map(match => match[1]);
}

export function unknownPlaceholdersIn(template: string): string[] {
  const known = new Set<string>(PACK_PLACEHOLDERS);
  return [...new Set(placeholdersIn(template).filter(name => !known.has(name)))];
}

/**
 * Client-side pack preview (contract §13 dropped the preview endpoint). The
 * output must contain no `{{` for the sample values; an unknown placeholder is
 * left in place so the reviewer sees exactly what would fail validation.
 */
export function renderPackTemplate(template: string, values: Partial<Record<PackPlaceholder, string>>): string {
  return template.replace(PLACEHOLDER_PATTERN, (whole, name: string) => {
    const value = values[name as PackPlaceholder];
    return value === undefined ? whole : value;
  });
}

export function previewValuesFor(clinic: Pick<ClinicRow, 'name' | 'phone' | 'complianceDisclosure' | 'humanFallbackNumber'>, strings: LocalePackStrings, agentName = 'Riley'): Record<PackPlaceholder, string> {
  return {
    agent_name: agentName,
    clinic_name: clinic.name,
    clinic_phone: clinic.phone,
    clinic_disclosure: clinic.complianceDisclosure ? ` ${clinic.complianceDisclosure}` : '',
    emergency_number: strings.emergencyNumber,
    next_opening: strings.dateStyle === 'weekday-day-month' ? 'Monday 31 August at 09:00' : 'Monday, August 31 at 9 AM',
    hours_today: strings.timeStyle === '24h' ? '09:00 to 17:00' : '9 AM to 5 PM',
    human_fallback_number: clinic.humanFallbackNumber ?? '',
    location_name: 'Main location',
    fields: 'name, phone number and preferred date',
  };
}

/** Packs listed by (language, country), newest version first inside each group. */
export function groupPacks(packs: LocalePackView[]): Array<{ key: string; language: string; country: string; packs: LocalePackView[] }> {
  const groups = new Map<string, { key: string; language: string; country: string; packs: LocalePackView[] }>();
  for (const pack of packs) {
    const key = `${pack.language}/${pack.country}`;
    const group = groups.get(key) ?? { key, language: pack.language, country: pack.country, packs: [] };
    group.packs.push(pack);
    groups.set(key, group);
  }
  return [...groups.values()].map(group => ({ ...group, packs: [...group.packs].sort((a, b) => b.version - a.version) }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

export const OWNER_ADMIN_ROLES = new Set(['OWNER', 'ADMIN']);

export function canApproveLocalePack(role: string | null | undefined): boolean {
  return Boolean(role && OWNER_ADMIN_ROLES.has(role));
}

/** Only the keys whose value differs from the stored row. `undefined` → not sent. */
export function changedKeys<T extends object>(stored: T, draft: T, keys: Array<keyof T>): Partial<T> {
  const out: Partial<T> = {};
  for (const key of keys) {
    if (JSON.stringify(stored[key] ?? null) !== JSON.stringify(draft[key] ?? null)) out[key] = draft[key];
  }
  return out;
}
