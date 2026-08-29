export function formatEnumLabel(value: string): string {
  const words = value.trim().replaceAll('_', ' ').toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : 'Unknown';
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
