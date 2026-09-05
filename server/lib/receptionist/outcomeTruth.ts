/** These messages describe requests, before any human response is confirmed. */
const REQUEST_ONLY_KEYS = new Set([
  'consent.declined.route', 'handoff.no_transfer', 'tool.message.recorded',
  'tool.message.appended', 'comprehension.bail_out.callback',
  'emergency.instruction', 'tool.emergency.message',
  'emergency.transfer.line', 'emergency.callback.line',
]);

/** Guard known unsafe English wording in the currently supported locale packs. */
export function unconfirmedOutcomeClaims(key: string, text: string): string[] {
  if (!REQUEST_ONLY_KEYS.has(key)) return [];
  const issues: string[] = [];
  if (/\b(?:someone|somebody|a person|a staff member|staff|the (?:practice|team|office))\s+will\s+(?:call|ring|respond|get back|pick it up)/i.test(text)
    || /\b(?:call|ring)\s+you\s+(?:(?:straight|right)\s+back|back\s+(?:immediately|right away|shortly))/i.test(text)) {
    issues.push('unconfirmed_callback');
  }
  if ((key.startsWith('emergency.') || key === 'tool.emergency.message')
    && /\b(?:stay|wait|hold|remain)\s+(?:with (?:me|us)|on (?:the |this )?(?:line|phone))|\b(?:connecting|transferring|putting)\s+you\b/i.test(text)) {
    issues.push('emergency_exit_delayed');
  }
  return issues;
}

export function hasUnconfirmedOutcomeClaims(messages: Record<string, string>): boolean {
  return Object.entries(messages).some(([key, text]) => unconfirmedOutcomeClaims(key, text).length > 0);
}
