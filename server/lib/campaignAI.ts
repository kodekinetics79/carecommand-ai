import { env } from '../config/env';

// ===========================================================================
// Optional LLM campaign drafting. Only used when a real AI provider is safely
// configured; otherwise callers fall back to rule-based templates. The system
// prompt forbids clinical advice/diagnosis/treatment/emergency/pressure content.
// Output is still a DRAFT that requires human approval. No PHI in prompts.
// ===========================================================================

export function aiProviderConfigured(): boolean {
  if (env.AI_PROVIDER === 'openai') return Boolean(env.OPENAI_API_KEY);
  if (env.AI_PROVIDER === 'claude') return Boolean(env.CLAUDE_API_KEY);
  if (env.AI_PROVIDER === 'ollama') return Boolean(env.OLLAMA_BASE_URL);
  return false; // 'mock' or unset → not configured
}

const SYSTEM_PROMPT = [
  'You write short, friendly patient OUTREACH messages for a dental/medical clinic CRM.',
  'Hard rules: no clinical advice, no diagnosis, no treatment or medication instructions, no emergency guidance,',
  'no pressure/urgency tactics, no guarantees about insurance or outcomes, no PHI.',
  'Use the placeholders {{firstName}} and {{clinicName}} literally. Keep under 300 characters.',
  'Return ONLY the message body text.',
].join(' ');

async function fetchWithTimeout(url: string, init: RequestInit, ms = 9000): Promise<Response> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, { ...init, signal: c.signal }); } finally { clearTimeout(t); }
}

export interface AIDraftResult { body: string; model: string; provider: string }

// Returns null on any failure so the caller falls back to the rule-based draft.
export async function draftWithAI(campaignType: string, channel: string): Promise<AIDraftResult | null> {
  if (!aiProviderConfigured()) return null;
  const user = `Write a ${channel} message for a "${campaignType}" clinic campaign.`;
  try {
    if (env.AI_PROVIDER === 'openai') {
      const res = await fetchWithTimeout(`${env.OPENAI_BASE_URL}/chat/completions`, {
        method: 'POST', headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: env.OPENAI_MODEL, messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: user }], max_tokens: 200, temperature: 0.5 }),
      });
      const j = await res.json().catch(() => null) as { choices?: Array<{ message?: { content?: string } }> } | null;
      const body = j?.choices?.[0]?.message?.content?.trim();
      return body ? { body, model: env.OPENAI_MODEL, provider: 'openai' } : null;
    }
    if (env.AI_PROVIDER === 'claude') {
      const res = await fetchWithTimeout(`${env.CLAUDE_BASE_URL}/v1/messages`, {
        method: 'POST', headers: { 'x-api-key': env.CLAUDE_API_KEY ?? '', 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: env.CLAUDE_MODEL, max_tokens: 200, system: SYSTEM_PROMPT, messages: [{ role: 'user', content: user }] }),
      });
      const j = await res.json().catch(() => null) as { content?: Array<{ text?: string }> } | null;
      const body = j?.content?.[0]?.text?.trim();
      return body ? { body, model: env.CLAUDE_MODEL, provider: 'claude' } : null;
    }
    if (env.AI_PROVIDER === 'ollama') {
      const res = await fetchWithTimeout(new URL('/api/chat', env.OLLAMA_BASE_URL).toString(), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: env.OLLAMA_MODEL, stream: false, messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: user }] }),
      });
      const j = await res.json().catch(() => null) as { message?: { content?: string } } | null;
      const body = j?.message?.content?.trim();
      return body ? { body, model: env.OLLAMA_MODEL, provider: 'ollama' } : null;
    }
  } catch {
    return null;
  }
  return null;
}
