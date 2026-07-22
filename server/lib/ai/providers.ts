import { env } from '../../config/env';

// ── Shared provider contract ────────────────────────────────────────────────
export interface AiMessage { role: 'system' | 'user' | 'assistant'; content: string }
export interface AiGenerateRequest {
  model?: string;
  messages: AiMessage[];
  operation: string; // recommendation | morning_briefing | evaluation | health_check
  jsonMode?: boolean;
}
export interface AiTokenUsage { promptTokens?: number; completionTokens?: number; totalTokens?: number }
export interface AiGenerateResult {
  text: string;
  model: string;
  provider: string;
  mode?: string;
  usage: AiTokenUsage;
  latencyMs: number;
}
export interface AiHealth { healthy: boolean; message: string; model?: string }
export interface AiProviderClient {
  readonly provider: string;
  readonly mode?: string;
  defaultModel(): string;
  generate(req: AiGenerateRequest): Promise<AiGenerateResult>;
  healthCheck(): Promise<AiHealth>;
}

async function fetchWithTimeout(url: string, init: RequestInit, ms = 20_000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...init, signal: ctrl.signal }); }
  finally { clearTimeout(timer); }
}

// ── Ollama (local + cloud) ──────────────────────────────────────────────────
// Local:  OLLAMA_BASE_URL (default http://localhost:11434) → /api/chat
// Cloud:  https://ollama.com/api/chat with Authorization: Bearer OLLAMA_API_KEY
export class OllamaProviderClient implements AiProviderClient {
  readonly provider = 'ollama';
  readonly mode: 'local' | 'cloud';
  private readonly apiBase: string;
  private readonly apiKey?: string;
  private readonly model: string;

  constructor() {
    this.mode = env.OLLAMA_MODE;
    this.apiBase = this.mode === 'cloud' ? 'https://ollama.com/api' : `${env.OLLAMA_BASE_URL.replace(/\/$/, '')}/api`;
    this.apiKey = env.OLLAMA_API_KEY;
    this.model = env.OLLAMA_DEFAULT_MODEL || env.OLLAMA_MODEL;
  }
  defaultModel() { return this.model; }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json' };
    // Cloud requires the key; never logged, never returned to callers.
    if (this.mode === 'cloud' && this.apiKey) h.authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  async generate(req: AiGenerateRequest): Promise<AiGenerateResult> {
    const model = req.model || this.model;
    const started = Date.now();
    const res = await fetchWithTimeout(`${this.apiBase}/chat`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ model, messages: req.messages, stream: false, ...(req.jsonMode ? { format: 'json' } : {}) }),
    });
    const latencyMs = Date.now() - started;
    if (!res.ok) throw new Error(`Ollama ${this.mode} returned ${res.status}`);
    const body = await res.json() as { message?: { content?: string }; prompt_eval_count?: number; eval_count?: number };
    const promptTokens = body.prompt_eval_count;
    const completionTokens = body.eval_count;
    return {
      text: body.message?.content ?? '',
      model, provider: this.provider, mode: this.mode,
      usage: { promptTokens, completionTokens, totalTokens: (promptTokens ?? 0) + (completionTokens ?? 0) || undefined },
      latencyMs,
    };
  }

  async healthCheck(): Promise<AiHealth> {
    try {
      const res = await fetchWithTimeout(`${this.apiBase}/tags`, { method: 'GET', headers: this.headers() }, 6_000);
      if (!res.ok) return { healthy: false, message: `Ollama ${this.mode} unreachable (HTTP ${res.status})`, model: this.model };
      return { healthy: true, message: `Ollama ${this.mode} reachable`, model: this.model };
    } catch (e) {
      return { healthy: false, message: `Ollama ${this.mode} unreachable: ${(e as Error).message}`, model: this.model };
    }
  }
}

// ── OpenAI (hosted, Chat Completions) ───────────────────────────────────────
// Governed path for AI_PROVIDER=openai. Key comes only from backend env, is sent
// as a Bearer header, and never logged or returned. Timed via fetchWithTimeout.
export class OpenAIProviderClient implements AiProviderClient {
  readonly provider = 'openai';
  private readonly model: string;
  private readonly base: string;

  constructor() {
    this.model = env.OPENAI_MODEL;
    this.base = env.OPENAI_BASE_URL.replace(/\/$/, '');
  }
  defaultModel() { return this.model; }

  async generate(req: AiGenerateRequest): Promise<AiGenerateResult> {
    if (!env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set');
    const model = req.model || this.model;
    const started = Date.now();
    const res = await fetchWithTimeout(`${this.base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: JSON.stringify({ model, temperature: 0.2, messages: req.messages, ...(req.jsonMode ? { response_format: { type: 'json_object' } } : {}) }),
    });
    const latencyMs = Date.now() - started;
    if (!res.ok) throw new Error(`OpenAI returned ${res.status}`);
    const body = await res.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } };
    return {
      text: body.choices?.[0]?.message?.content ?? '',
      model, provider: this.provider,
      usage: { promptTokens: body.usage?.prompt_tokens, completionTokens: body.usage?.completion_tokens, totalTokens: body.usage?.total_tokens },
      latencyMs,
    };
  }

  async healthCheck(): Promise<AiHealth> {
    if (!env.OPENAI_API_KEY) return { healthy: false, message: 'OPENAI_API_KEY not set', model: this.model };
    try {
      const res = await fetchWithTimeout(`${this.base}/models`, { method: 'GET', headers: { authorization: `Bearer ${env.OPENAI_API_KEY}` } }, 6_000);
      if (!res.ok) return { healthy: false, message: `OpenAI unreachable (HTTP ${res.status})`, model: this.model };
      return { healthy: true, message: 'OpenAI reachable', model: this.model };
    } catch (e) {
      return { healthy: false, message: `OpenAI unreachable: ${(e as Error).message}`, model: this.model };
    }
  }
}

// ── Claude (hosted, Anthropic Messages API) ─────────────────────────────────
// Governed path for AI_PROVIDER=claude. System messages are hoisted to the
// top-level `system` field (Anthropic requires user/assistant roles in messages)
// and max_tokens is always set. Key never logged or returned. Timed.
export class ClaudeProviderClient implements AiProviderClient {
  readonly provider = 'claude';
  private readonly model: string;
  private readonly base: string;

  constructor() {
    this.model = env.CLAUDE_MODEL;
    this.base = env.CLAUDE_BASE_URL.replace(/\/$/, '');
  }
  defaultModel() { return this.model; }

  async generate(req: AiGenerateRequest): Promise<AiGenerateResult> {
    if (!env.CLAUDE_API_KEY) throw new Error('CLAUDE_API_KEY is not set');
    const model = req.model || this.model;
    const system = req.messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n') || undefined;
    const messages = req.messages.filter(m => m.role !== 'system').map(m => ({ role: m.role, content: m.content }));
    const started = Date.now();
    const res = await fetchWithTimeout(`${this.base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': env.CLAUDE_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 1024, temperature: 0.2, ...(system ? { system } : {}), messages }),
    });
    const latencyMs = Date.now() - started;
    if (!res.ok) throw new Error(`Claude returned ${res.status}`);
    const body = await res.json() as { content?: Array<{ text?: string }>; usage?: { input_tokens?: number; output_tokens?: number } };
    const promptTokens = body.usage?.input_tokens;
    const completionTokens = body.usage?.output_tokens;
    return {
      text: body.content?.map(c => c.text ?? '').join('') ?? '',
      model, provider: this.provider,
      usage: { promptTokens, completionTokens, totalTokens: (promptTokens ?? 0) + (completionTokens ?? 0) || undefined },
      latencyMs,
    };
  }

  async healthCheck(): Promise<AiHealth> {
    // Anthropic has no free/cheap ping endpoint; a real call would spend budget.
    // Report configuration truthfully (key present) without a live token spend.
    return env.CLAUDE_API_KEY
      ? { healthy: true, message: 'Claude API key configured (config check only, no live ping)', model: this.model }
      : { healthy: false, message: 'CLAUDE_API_KEY not set', model: this.model };
  }
}

// ── Mock (deterministic, no network) ────────────────────────────────────────
// Default provider so the gateway works without a model server, and tests are
// hermetic. Returns evidence-aware JSON for the recommendation operation.
export class MockProviderClient implements AiProviderClient {
  readonly provider = 'mock';
  defaultModel() { return 'mock-1'; }

  async generate(req: AiGenerateRequest): Promise<AiGenerateResult> {
    const started = Date.now();
    const last = req.messages[req.messages.length - 1]?.content ?? '';
    let text: string;
    if (req.operation === 'recommendation') {
      // Surface up to 3 grounded recommendations from the de-identified snapshot.
      const matches = [...last.matchAll(/"metric":\s*"([a-z_]+)",\s*"value":\s*(\d+)/g)].slice(0, 3);
      const recs = matches.filter(m => Number(m[2]) > 0).map(m => ({
        title: `Act on ${m[1].replace(/_/g, ' ')}`,
        recommendationType: m[1],
        reason: `Backend data shows ${m[2]} for ${m[1].replace(/_/g, ' ')}; prioritize operational follow-up.`,
        confidence: 70,
        evidenceMetric: m[1],
      }));
      text = JSON.stringify({ recommendations: recs.length ? recs : [] });
    } else if (req.operation === 'morning_briefing') {
      text = 'Operational summary: review open critical alerts, clear missed readings, and reconnect offline devices. All figures are evidence-backed by the attached snapshot.';
    } else {
      text = 'ok';
    }
    const totalTokens = Math.ceil((last.length + text.length) / 4);
    return { text, model: 'mock-1', provider: this.provider, usage: { totalTokens, promptTokens: Math.ceil(last.length / 4), completionTokens: Math.ceil(text.length / 4) }, latencyMs: Date.now() - started };
  }
  async healthCheck(): Promise<AiHealth> { return { healthy: true, message: 'Mock provider always available', model: 'mock-1' }; }
}
