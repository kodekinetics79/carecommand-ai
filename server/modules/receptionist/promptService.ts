// ===========================================================================
// AI Receptionist — prompt generation service
//
// Pure, dependency-free composition layer. Given a clinic profile, an agent,
// a campaign, its eligible locations, and the ordered intake fields, it
// produces:
//   1. a final voice-agent system prompt (all {{placeholders}} resolved)
//   2. RetellAI-ready dynamic variables
//   3. a booking function (tool) JSON schema
//   4. call-outcome extraction fields
//   5. human-readable samples (greeting, pitch, intake questions, confirmation)
//
// Nothing here is clinic-specific: every value flows in from configuration.
// ===========================================================================

export type ReceptionistFieldType =
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

export interface PromptClinic {
  id: string;
  name: string;
  phone: string;
  website?: string | null;
  addressLine?: string | null;
  timezone: string;
  defaultLanguage: string;
  complianceDisclosure: string;
  humanFallbackNumber?: string | null;
  doNotContactPolicy: string;
  workingHours?: unknown;
}

export interface PromptLocation {
  id: string;
  name: string;
  address: string;
  phone?: string | null;
}

export interface PromptAgent {
  name: string;
  voice: string;
  tone: string;
  language: string;
  persona?: string | null;
  greetingOverride?: string | null;
}

export interface PromptBookingRules {
  leadTimeHours?: number;
  slotDurationMinutes?: number;
  maxPerDay?: number;
  availableDays?: string[];
  hoursStart?: string;
  hoursEnd?: string;
  notes?: string;
}

export interface PromptCampaign {
  id: string;
  name: string;
  campaignType: string;
  offerTitle: string;
  offerDescription: string;
  offerScript: string;
  appointmentType: string;
  bookingRules?: PromptBookingRules | null;
  eligibleLocationIds: string[];
  smsConfirmation: boolean;
  emailConfirmation: boolean;
}

export interface PromptIntakeField {
  fieldType: ReceptionistFieldType;
  label: string;
  aiQuestion: string;
  validationRule?: string | null;
  options?: string[];
  required: boolean;
  confirmationRequired: boolean;
  sortOrder: number;
}

export interface PromptConfig {
  clinic: PromptClinic;
  agent: PromptAgent;
  campaign: PromptCampaign;
  locations: PromptLocation[];
  intakeFields: PromptIntakeField[];
}

// --- Field metadata --------------------------------------------------------

export const FIELD_TYPE_META: Record<
  ReceptionistFieldType,
  { label: string; question: string; validation: string; sensitive?: boolean }
> = {
  FIRST_NAME: { label: 'First name', question: 'Can I start with your first name?', validation: 'non-empty text' },
  LAST_NAME: { label: 'Last name', question: 'And your last name?', validation: 'non-empty text' },
  PHONE: { label: 'Phone number', question: 'What is the best phone number to reach you on?', validation: 'phone number — read back to confirm' },
  EMAIL: { label: 'Email', question: 'What email should we send the confirmation to?', validation: 'email address — read back to confirm' },
  PREFERRED_DATE: { label: 'Preferred date', question: 'What day works best for you?', validation: 'a date within booking rules' },
  PREFERRED_TIME: { label: 'Preferred time', question: 'Do you prefer morning or afternoon?', validation: 'a time within working hours' },
  PREFERRED_LOCATION: { label: 'Preferred location', question: 'Which of our locations is most convenient for you?', validation: 'one of the eligible locations' },
  PATIENT_STATUS: { label: 'New or existing patient', question: 'Have you visited us before, or would this be your first time?', validation: 'new or existing' },
  INSURANCE_PROVIDER: { label: 'Insurance provider', question: 'Which insurance provider do you have, if any?', validation: 'insurance carrier name (do not collect policy/SSN)' },
  REASON_FOR_VISIT: { label: 'Reason for visit', question: 'May I ask the main reason for your visit?', validation: 'short description (no clinical advice)' },
  PREFERRED_PROVIDER: { label: 'Preferred provider', question: 'Is there a specific provider you would like to see?', validation: 'provider name or no preference' },
  LANGUAGE_PREFERENCE: { label: 'Language preference', question: 'What language are you most comfortable speaking?', validation: 'language name' },
  CONSENT: { label: 'SMS/email consent', question: 'Is it okay if we send you appointment reminders by text or email?', validation: 'yes or no' },
  CUSTOM_TEXT: { label: 'Custom field', question: 'Could you tell me a little more?', validation: 'free text' },
  CUSTOM_DROPDOWN: { label: 'Custom selection', question: 'Which option applies to you?', validation: 'one of the provided options' },
  CUSTOM_YES_NO: { label: 'Custom yes/no', question: 'Can you confirm yes or no?', validation: 'yes or no' },
};

// --- Helpers ---------------------------------------------------------------

function describeBookingRules(rules?: PromptBookingRules | null): string {
  if (!rules) return 'Offer the next available openings from the booking tool.';
  const parts: string[] = [];
  if (rules.availableDays?.length) parts.push(`Available days: ${rules.availableDays.join(', ')}.`);
  if (rules.hoursStart && rules.hoursEnd) parts.push(`Booking hours: ${rules.hoursStart}–${rules.hoursEnd}.`);
  if (rules.slotDurationMinutes) parts.push(`Each appointment is about ${rules.slotDurationMinutes} minutes.`);
  if (rules.leadTimeHours) parts.push(`Book at least ${rules.leadTimeHours} hours ahead.`);
  if (typeof rules.maxPerDay === 'number') parts.push(`Up to ${rules.maxPerDay} of these appointments per day.`);
  if (rules.notes) parts.push(rules.notes);
  return parts.length ? parts.join(' ') : 'Offer the next available openings from the booking tool.';
}

function orderedFields(fields: PromptIntakeField[]): PromptIntakeField[] {
  return [...fields].sort((a, b) => a.sortOrder - b.sortOrder);
}

function intakeFieldLines(fields: PromptIntakeField[]): string {
  return orderedFields(fields)
    .map((field, index) => {
      const meta = FIELD_TYPE_META[field.fieldType];
      const requirement = field.required ? 'REQUIRED' : 'optional';
      const confirm = field.confirmationRequired ? ' Read the answer back to confirm.' : '';
      const opts = field.options?.length ? ` Options: ${field.options.join(', ')}.` : '';
      const validation = field.validationRule || meta.validation;
      return `${index + 1}. ${field.label} (${requirement}) — Ask: "${field.aiQuestion}" Validate as ${validation}.${opts}${confirm}`;
    })
    .join('\n');
}

function summaryFieldList(fields: PromptIntakeField[]): string {
  const labels = orderedFields(fields).map(field => field.label.toLowerCase());
  if (!labels.length) return 'the details we discussed';
  if (labels.length === 1) return labels[0];
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

function locationList(locations: PromptLocation[], eligibleIds: string[]): PromptLocation[] {
  if (!eligibleIds.length) return locations;
  const set = new Set(eligibleIds);
  const eligible = locations.filter(location => set.has(location.id));
  return eligible.length ? eligible : locations;
}

// --- System prompt ---------------------------------------------------------

export function generateSystemPrompt(config: PromptConfig): string {
  const { clinic, agent, campaign, intakeFields } = config;
  const locations = locationList(config.locations, campaign.eligibleLocationIds);
  const locationNames = locations.map(location => location.name).join(', ') || clinic.name;
  const primaryLocation = locations[0]?.name ?? clinic.name;
  const confirmationChannels = [campaign.smsConfirmation ? 'SMS' : null, campaign.emailConfirmation ? 'email' : null]
    .filter(Boolean)
    .join(' and ');
  const fallback = clinic.humanFallbackNumber
    ? `Transfer the caller to a human at ${clinic.humanFallbackNumber}.`
    : 'Take a message and let them know a team member will call back shortly.';

  return `You are ${agent.name}, the AI receptionist for ${clinic.name}.

You are calling or answering on behalf of ${clinic.name}. Use only the configuration provided below for this clinic and campaign. Speak in ${agent.language}. Your tone is ${agent.tone}.${agent.persona ? ` ${agent.persona}` : ''}

# Clinic
- Name: ${clinic.name}
- Phone: ${clinic.phone}
- Website: ${clinic.website ?? 'n/a'}
- Locations: ${locationNames}
- Timezone: ${clinic.timezone}

# Campaign: ${campaign.name} (${campaign.campaignType})
- Offer: ${campaign.offerTitle}
- Offer details: ${campaign.offerDescription}
- Appointment type: ${campaign.appointmentType}
- Eligible locations: ${locationNames}
- Booking rules: ${describeBookingRules(campaign.bookingRules)}

# Required disclosure (say at the very start)
"${clinic.complianceDisclosure}"

# Purpose
1. Greet the caller or lead warmly and professionally.
2. Clearly identify yourself as an AI assistant calling on behalf of ${clinic.name}.
3. Explain the offer simply, truthfully, and without pressure.
4. If they are interested, collect only the intake fields listed below, one question at a time.
5. Confirm all collected information before booking.
6. Book the appointment using the booking tool.
7. Trigger ${confirmationChannels || 'a'} confirmation if configured.
8. Escalate to a human if the caller asks for medical advice, complains, is upset, asks about pricing beyond the offer, or requests a person.

# Offer script
${campaign.offerScript}

# Intake — if interested, collect in this exact order
${intakeFieldLines(intakeFields) || '(No intake fields configured — confirm interest and escalate to a human to complete booking.)'}

For each field: ask naturally, validate the answer, repeat back phone numbers and email addresses, and never skip a required field. If the caller refuses an optional field, continue. If they refuse a required field, briefly explain it is needed to book.

# Before booking, summarize
"Perfect. I have ${summaryFieldList(intakeFields)}. Is everything correct?"

# After booking, say
"Great, your appointment is confirmed with ${clinic.name} for {{appointment_date_time}} at ${primaryLocation}. You'll receive a confirmation shortly. Please arrive 10 to 15 minutes early and bring a photo ID and insurance card if applicable."

If no slots are available, offer the next available options from the booking tool.

# If not interested
Say: "No problem at all. Would you like us not to contact you again about this offer?" Then end politely.

# Safety and compliance (always)
- Do not diagnose, give medical advice, recommend treatment, or discuss test results.
- Do not collect detailed medical history unless an intake field above explicitly requires it.
- Never collect Social Security numbers, payment card, or financial details.
- If the person mentions an emergency, tell them to call 911 or go to the nearest emergency room immediately.
- If asked whether you are human, say you are an AI assistant calling on behalf of ${clinic.name}.
- If the person asks not to be contacted again: ${clinic.doNotContactPolicy}
- If a human is requested or escalation is needed: ${fallback}
- Ask one question at a time. Keep responses short, warm, and natural.`;
}

// --- RetellAI configuration -----------------------------------------------

export interface RetellConfig {
  systemPrompt: string;
  voiceId: string;
  language: string;
  beginMessage: string;
  dynamicVariables: Record<string, string>;
  webhookUrl: string;
  bookingFunction: Record<string, unknown>;
  callOutcomeFields: Array<Record<string, unknown>>;
}

export function buildRetellConfig(config: PromptConfig, options: { webhookBaseUrl: string }): RetellConfig {
  const { clinic, agent, campaign } = config;
  const locations = locationList(config.locations, campaign.eligibleLocationIds);
  const systemPrompt = generateSystemPrompt(config);
  const beginMessage = agent.greetingOverride?.trim() || clinic.complianceDisclosure;

  const dynamicVariables: Record<string, string> = {
    clinic_name: clinic.name,
    clinic_phone: clinic.phone,
    clinic_website: clinic.website ?? '',
    clinic_timezone: clinic.timezone,
    agent_name: agent.name,
    campaign_name: campaign.name,
    offer_title: campaign.offerTitle,
    appointment_type: campaign.appointmentType,
    eligible_locations: locations.map(location => location.name).join(', '),
    human_fallback_number: clinic.humanFallbackNumber ?? '',
  };

  // Booking tool — the slots the agent must fill before invoking it.
  const properties: Record<string, unknown> = {
    location_id: {
      type: 'string',
      description: 'The eligible location the patient chose.',
      enum: locations.map(location => location.id),
    },
    appointment_date: { type: 'string', description: 'Requested date (YYYY-MM-DD).' },
    appointment_time: { type: 'string', description: 'Requested time (HH:mm, 24h).' },
  };
  const required: string[] = ['appointment_date', 'appointment_time'];
  for (const field of orderedFields(config.intakeFields)) {
    const key = fieldKey(field);
    properties[key] = {
      type: field.fieldType === 'CONSENT' || field.fieldType === 'CUSTOM_YES_NO' ? 'boolean' : 'string',
      description: field.label,
      ...(field.options?.length ? { enum: field.options } : {}),
    };
    if (field.required) required.push(key);
  }

  const bookingFunction = {
    type: 'function',
    name: 'book_appointment',
    description: `Book a ${campaign.appointmentType} for ${clinic.name} once all required details are collected and confirmed.`,
    speak_during_execution: true,
    speak_after_execution: true,
    parameters: {
      type: 'object',
      properties,
      required: [...new Set(required)],
    },
  };

  const callOutcomeFields = [
    { name: 'outcome', type: 'enum', choices: ['booked', 'not_interested', 'no_answer', 'voicemail', 'escalated', 'opted_out', 'failed'], description: 'Final disposition of the call.' },
    { name: 'appointment_booked', type: 'boolean', description: 'Whether an appointment was successfully booked.' },
    { name: 'requested_date_time', type: 'string', description: 'The date/time the patient requested, if any.' },
    { name: 'opted_out', type: 'boolean', description: 'Whether the caller asked not to be contacted again.' },
    { name: 'escalation_reason', type: 'string', description: 'Why the call was escalated to a human, if applicable.' },
    { name: 'summary', type: 'string', description: 'One-paragraph summary of the conversation.' },
  ];

  return {
    systemPrompt,
    voiceId: agent.voice,
    language: agent.language,
    beginMessage,
    dynamicVariables,
    webhookUrl: `${options.webhookBaseUrl.replace(/\/$/, '')}/v1/receptionist/webhooks/retell?clinicId=${clinic.id}&campaignId=${campaign.id}`,
    bookingFunction,
    callOutcomeFields,
  };
}

export function fieldKey(field: PromptIntakeField): string {
  const base: Partial<Record<ReceptionistFieldType, string>> = {
    FIRST_NAME: 'first_name',
    LAST_NAME: 'last_name',
    PHONE: 'phone',
    EMAIL: 'email',
    PREFERRED_DATE: 'preferred_date',
    PREFERRED_TIME: 'preferred_time',
    PREFERRED_LOCATION: 'preferred_location',
    PATIENT_STATUS: 'patient_status',
    INSURANCE_PROVIDER: 'insurance_provider',
    REASON_FOR_VISIT: 'reason_for_visit',
    PREFERRED_PROVIDER: 'preferred_provider',
    LANGUAGE_PREFERENCE: 'language_preference',
    CONSENT: 'consent',
  };
  if (base[field.fieldType]) return base[field.fieldType] as string;
  return (
    field.label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'custom_field'
  );
}

// --- Samples for the preview screen ----------------------------------------

export interface PromptSamples {
  greeting: string;
  pitch: string;
  intakeQuestions: string[];
  confirmation: string;
}

export function generateSamples(config: PromptConfig): PromptSamples {
  const { clinic, agent, campaign, intakeFields } = config;
  const locations = locationList(config.locations, campaign.eligibleLocationIds);
  const primaryLocation = locations[0]?.name ?? clinic.name;
  const confirmationChannels = [campaign.smsConfirmation ? 'a text' : null, campaign.emailConfirmation ? 'an email' : null]
    .filter(Boolean)
    .join(' and ') || 'a confirmation';

  const greeting = `${agent.greetingOverride?.trim() || clinic.complianceDisclosure} Is now an okay time to talk for a moment?`;
  const pitch = campaign.offerScript?.trim()
    ? campaign.offerScript.trim()
    : `We're reaching out about ${campaign.offerTitle}. ${campaign.offerDescription} Would you like to hear about booking a ${campaign.appointmentType}?`;
  const intakeQuestions = orderedFields(intakeFields).map(field => field.aiQuestion);
  const confirmation = `Great, your appointment is confirmed with ${clinic.name} for Wednesday, June 11 at 10:30 AM at ${primaryLocation}. You'll receive ${confirmationChannels} shortly. Please arrive 10 to 15 minutes early and bring a photo ID and insurance card if applicable.`;

  return { greeting, pitch, intakeQuestions, confirmation };
}
