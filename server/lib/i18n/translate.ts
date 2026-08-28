import { createHash } from 'node:crypto';
import { db } from '../db';
import { env } from '../../config/env';

// Provider-agnostic UI translation. Source language is English. Results are
// cached globally (TranslationCache) so identical strings are translated once.

export const SUPPORTED_LANGS = ['en', 'es', 'fr', 'de', 'pt', 'ar'] as const;
export type Lang = typeof SUPPORTED_LANGS[number];

function hash(text: string): string { return createHash('sha256').update(text).digest('hex'); }

async function fetchJson(url: string, init: RequestInit, ms = 12_000): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...init, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

export function activeProvider(): 'deepl' | 'google' | 'mymemory' | 'off' {
  const p = env.TRANSLATION_PROVIDER;
  if (p === 'off') return 'off';
  if (p === 'deepl') return env.DEEPL_API_KEY ? 'deepl' : 'off';
  if (p === 'google') return env.GOOGLE_TRANSLATE_API_KEY ? 'google' : 'off';
  if (p === 'mymemory') return 'mymemory';
  // auto: best available, falling back to the keyless MyMemory.
  if (env.DEEPL_API_KEY) return 'deepl';
  if (env.GOOGLE_TRANSLATE_API_KEY) return 'google';
  return 'mymemory';
}

// ── Providers (each translates a batch; returns same-length array) ──────────
async function deepl(texts: string[], target: Lang): Promise<string[]> {
  const body = new URLSearchParams();
  for (const t of texts) body.append('text', t);
  body.append('target_lang', target.toUpperCase());
  body.append('source_lang', 'EN');
  const res = await fetchJson(`${env.DEEPL_API_URL}/v2/translate`, {
    method: 'POST',
    headers: { Authorization: `DeepL-Auth-Key ${env.DEEPL_API_KEY}`, 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`DeepL ${res.status}`);
  const json = await res.json() as { translations: { text: string }[] };
  return json.translations.map(t => t.text);
}

async function google(texts: string[], target: Lang): Promise<string[]> {
  const res = await fetchJson(`https://translation.googleapis.com/language/translate/v2?key=${env.GOOGLE_TRANSLATE_API_KEY}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ q: texts, source: 'en', target, format: 'text' }),
  });
  if (!res.ok) throw new Error(`Google ${res.status}`);
  const json = await res.json() as { data: { translations: { translatedText: string }[] } };
  return json.data.translations.map(t => t.translatedText);
}

async function mymemory(texts: string[], target: Lang): Promise<string[]> {
  // No batch endpoint — translate sequentially (cache makes repeats free).
  const out: string[] = [];
  for (const text of texts) {
    try {
      const email = env.MYMEMORY_EMAIL ? `&de=${encodeURIComponent(env.MYMEMORY_EMAIL)}` : '';
      const res = await fetchJson(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|${target}${email}`, { method: 'GET' }, 8_000);
      if (!res.ok) { out.push(text); continue; }
      const json = await res.json() as { responseData?: { translatedText?: string } };
      out.push(json.responseData?.translatedText || text);
    } catch { out.push(text); }
  }
  return out;
}

async function callProvider(provider: string, texts: string[], target: Lang): Promise<string[]> {
  if (provider === 'deepl') return deepl(texts, target);
  if (provider === 'google') return google(texts, target);
  if (provider === 'mymemory') return mymemory(texts, target);
  return texts; // 'off' → identity
}

/**
 * Translate a batch of strings to `target`. Returns a source→translated map.
 * Cache-first; only uncached strings hit the provider, and new results are
 * persisted. Failures degrade to the source string (never throws per-string).
 */
export async function translateBatch(texts: string[], target: Lang): Promise<Record<string, string>> {
  const unique = [...new Set(texts.map(t => t.trim()).filter(t => t.length > 0))];
  const result: Record<string, string> = {};
  if (target === 'en' || !SUPPORTED_LANGS.includes(target)) {
    for (const t of unique) result[t] = t;
    return result;
  }

  const provider = activeProvider();
  const hashes = unique.map(hash);
  const cached = await db.translationCache.findMany({ where: { targetLang: target, sourceHash: { in: hashes } }, select: { sourceHash: true, translatedText: true } });
  const cacheMap = new Map(cached.map(c => [c.sourceHash, c.translatedText]));

  const misses: string[] = [];
  unique.forEach((t, i) => {
    const hit = cacheMap.get(hashes[i]);
    if (hit !== undefined) result[t] = hit;
    else misses.push(t);
  });

  if (misses.length > 0 && provider !== 'off') {
    const translated = await callProvider(provider, misses, target).catch(() => misses);
    await Promise.all(misses.map(async (src, i) => {
      const tx = translated[i] ?? src;
      result[src] = tx;
      if (tx !== src) {
        await db.translationCache.upsert({
          where: { targetLang_sourceHash: { targetLang: target, sourceHash: hash(src) } },
          create: { targetLang: target, sourceHash: hash(src), sourceText: src.slice(0, 1000), translatedText: tx, provider },
          update: { translatedText: tx, provider },
        }).catch(() => {});
      }
    }));
  } else {
    for (const m of misses) result[m] = m; // provider off → identity
  }
  return result;
}
