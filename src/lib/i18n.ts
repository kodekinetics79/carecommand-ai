// Fail-closed compatibility shim. Runtime translation of rendered strings is
// intentionally disabled because those strings can contain PHI. Translation
// may return only after the UI adopts curated, static message identifiers.
export function cachedTranslation(text: string, lang: string): string | undefined {
  return lang === 'en' ? text : undefined;
}

export async function ensureTranslations(texts: string[], lang: string): Promise<void> {
  void texts;
  void lang;
  return;
}
