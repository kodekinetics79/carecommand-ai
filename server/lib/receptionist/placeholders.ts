import type { PromptConfig } from '../../modules/receptionist/promptService';

// ===========================================================================
// Placeholder detection.
//
// A campaign that still carries the values a form pre-filled has not been
// configured — it has been skipped past. Deploying it would put "New offer" or
// a stock agent name in front of a patient, so deploy refuses and readiness
// says which field to fix. Only the literal defaults this product ships are
// flagged: a clinic that genuinely offers a "Consultation" keeps it, because
// the check is for untouched text, not for text somebody dislikes.
// ===========================================================================

export type PlaceholderReason = 'known_default' | 'template_syntax' | 'todo_marker' | 'too_short';

export interface Placeholder {
  field: string;
  label: string;
  value: string;
  reason: PlaceholderReason;
}

/** Literal values this product's own forms pre-fill. Never tenant-authored. */
const KNOWN_DEFAULTS: Record<string, string[]> = {
  'agent.name': ['riley'],
  'agent.voice': ['11labs-adrian'],
  'campaign.offerTitle': ['new offer'],
  'campaign.offerDescription': ['describe the offer here.'],
  'campaign.offerScript': ['introduce the offer warmly and ask if they would like to book.'],
};

const TODO_MARKER = /\b(todo|tbd|lorem ipsum|lorem)\b|\[insert/i;
const TEMPLATE_SYNTAX = /\{\{[^{}]*\}\}|\$\{[^{}]*\}/;

function classify(field: string, value: string): PlaceholderReason | null {
  const trimmed = value.trim();
  if (!trimmed) return 'too_short';
  if (TEMPLATE_SYNTAX.test(trimmed)) return 'template_syntax';
  if (TODO_MARKER.test(trimmed)) return 'todo_marker';
  if ((KNOWN_DEFAULTS[field] ?? []).includes(trimmed.toLowerCase())) return 'known_default';
  return null;
}

export function findPlaceholders(config: PromptConfig): Placeholder[] {
  const candidates: Array<{ field: string; label: string; value: string }> = [
    { field: 'agent.name', label: 'Agent name', value: config.agent.name },
    { field: 'agent.voice', label: 'Agent voice', value: config.agent.voice },
    { field: 'agent.persona', label: 'Agent persona', value: config.agent.persona ?? '' },
    { field: 'agent.greetingOverride', label: 'Greeting', value: config.agent.greetingOverride ?? '' },
    { field: 'campaign.name', label: 'Campaign name', value: config.campaign.name },
    { field: 'campaign.offerTitle', label: 'Offer title', value: config.campaign.offerTitle },
    { field: 'campaign.offerDescription', label: 'Offer description', value: config.campaign.offerDescription },
    { field: 'campaign.offerScript', label: 'Offer script', value: config.campaign.offerScript },
    { field: 'campaign.appointmentType', label: 'Appointment type', value: config.campaign.appointmentType },
    { field: 'clinic.complianceDisclosure', label: 'Compliance disclosure', value: config.clinic.complianceDisclosure ?? '' },
  ];
  const placeholders: Placeholder[] = [];
  for (const candidate of candidates) {
    // Optional free-text fields are allowed to be empty; only the ones the
    // prompt actually speaks are required to say something.
    const optional = ['agent.persona', 'agent.greetingOverride', 'clinic.complianceDisclosure'].includes(candidate.field);
    if (optional && !candidate.value.trim()) continue;
    const reason = classify(candidate.field, candidate.value);
    if (reason) placeholders.push({ field: candidate.field, label: candidate.label, value: candidate.value.trim(), reason });
  }
  for (const field of config.intakeFields) {
    const reason = classify(`intake.${field.fieldType}`, field.aiQuestion);
    if (reason) {
      placeholders.push({ field: `intake.${field.label}`, label: `Intake question — ${field.label}`, value: field.aiQuestion.trim(), reason });
    }
  }
  return placeholders;
}
