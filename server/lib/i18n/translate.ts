export const SUPPORTED_LANGS = ['en', 'es', 'fr', 'de', 'pt', 'ar'] as const;
export type Lang = typeof SUPPORTED_LANGS[number];

/** Runtime translation is disabled until inputs are curated static message IDs. */
export function activeProvider(): 'off' {
  return 'off';
}
