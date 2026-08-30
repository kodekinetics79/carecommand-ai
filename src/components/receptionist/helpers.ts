/**
 * Human label for an enum-ish value.
 *
 *   SCREAMING_SNAKE  -> "Sentence case"   (PENDING_REVIEW -> "Pending review")
 *   snake_case       -> "Sentence case"   (transport_ambiguous -> "Transport ambiguous")
 *   camelCase        -> "Sentence case"   (directBooking -> "Direct booking")
 *   Mixed-case text  -> left as written   ("Warm and professional", "Voice line")
 *
 * The old implementation lower-cased everything, which mangled values that
 * were already human text or carried acronyms (M71).
 */
export function formatEnumLabel(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return 'Unknown';
  const isScreaming = /^[A-Z0-9]+(?:[_\- ][A-Z0-9]+)*$/.test(trimmed);
  const isSnake = /^[a-z0-9]+(?:_[a-z0-9]+)+$/.test(trimmed) || /^[a-z0-9]+$/.test(trimmed);
  const isCamel = /^[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+$/.test(trimmed);
  let words: string;
  if (isScreaming || isSnake) {
    words = trimmed.replaceAll('_', ' ').toLowerCase();
  } else if (isCamel) {
    words = trimmed.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  } else {
    // Already mixed case: only normalise separators, never re-case letters.
    words = trimmed.replaceAll('_', ' ');
  }
  return words[0].toUpperCase() + words.slice(1);
}

export function maskedPhone(value: string | null | undefined): string {
  if (!value) return '—';
  if (value.includes('*')) return value;
  const digits = value.replace(/\D/g, '');
  return digits.length >= 4 ? `***-***-${digits.slice(-4)}` : '***-***-****';
}

export function maskedProviderId(value: string | null | undefined): string {
  if (!value) return 'no provider id';
  if (value.includes('…') || value.includes('*')) return value;
  return value.length > 8 ? `${value.slice(0, 4)}…${value.slice(-4)}` : '********';
}

export const outcomeBadge: Record<string, string> = {
  BOOKED: 'badge badge-emerald', NOT_INTERESTED: 'badge badge-amber', NO_ANSWER: 'badge badge-blue',
  VOICEMAIL: 'badge badge-blue', ESCALATED: 'badge badge-red', OPTED_OUT: 'badge badge-violet',
  FAILED: 'badge badge-red', IN_PROGRESS: 'badge badge-blue',
};
