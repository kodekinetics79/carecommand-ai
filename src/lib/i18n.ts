// Frontend translation client. Calls the public /v1/i18n/translate endpoint,
// caches results per-language in memory + localStorage so repeat strings are
// free and instant. English is identity (no calls).
const base = (import.meta.env.VITE_API_URL as string | undefined) ?? (import.meta.env.PROD ? '' : 'http://localhost:3001');

const mem: Record<string, Record<string, string>> = {};

function cacheFor(lang: string): Record<string, string> {
  if (!mem[lang]) {
    try { mem[lang] = JSON.parse(localStorage.getItem(`cc_i18n_${lang}`) || '{}'); }
    catch { mem[lang] = {}; }
  }
  return mem[lang];
}
function persist(lang: string) {
  try { localStorage.setItem(`cc_i18n_${lang}`, JSON.stringify(mem[lang])); } catch { /* quota */ }
}

export function cachedTranslation(text: string, lang: string): string | undefined {
  if (lang === 'en') return text;
  return cacheFor(lang)[text];
}

let inflight: Promise<void> | null = null;

/** Ensure `texts` are translated to `lang` (cache-first). Resolves when cached. */
export async function ensureTranslations(texts: string[], lang: string): Promise<void> {
  if (lang === 'en') return;
  const cache = cacheFor(lang);
  const misses = [...new Set(texts)].filter(t => t && cache[t] === undefined);
  if (misses.length === 0) return;
  // Serialize requests so concurrent callers don't double-fetch.
  const prev = inflight ?? Promise.resolve();
  inflight = prev.then(async () => {
    const todo = misses.filter(t => cache[t] === undefined);
    for (let i = 0; i < todo.length; i += 150) {
      const chunk = todo.slice(i, i + 150);
      try {
        const res = await fetch(`${base}/v1/i18n/translate`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ targetLang: lang, texts: chunk }),
        });
        if (!res.ok) continue;
        const data = await res.json() as { translations: Record<string, string> };
        Object.assign(cache, data.translations);
      } catch { /* offline — leave untranslated */ }
    }
    persist(lang);
  });
  await inflight;
}
