import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mutable env stand-in so each test can pick local vs cloud before constructing.
const cfg: Record<string, unknown> = {};
vi.mock('../../config/env', () => ({ env: cfg }));
const { OllamaProviderClient } = await import('./providers');

beforeEach(() => { vi.restoreAllMocks(); });

function mockFetch(body: unknown, status = 200) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
}

describe('Ollama local', () => {
  it('targets http://localhost:11434/api/chat with no auth header', async () => {
    Object.assign(cfg, { OLLAMA_MODE: 'local', OLLAMA_BASE_URL: 'http://localhost:11434', OLLAMA_API_KEY: undefined, OLLAMA_MODEL: 'llama3.1', OLLAMA_DEFAULT_MODEL: 'llama3.1' });
    const f = mockFetch({ message: { content: 'hi' }, prompt_eval_count: 5, eval_count: 7 });
    const client = new OllamaProviderClient();
    const r = await client.generate({ messages: [{ role: 'user', content: 'x' }], operation: 'recommendation' });
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:11434/api/chat');
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
    expect(r.mode).toBe('local');
    expect(r.text).toBe('hi');
    expect(r.usage.totalTokens).toBe(12);
  });
});

describe('Ollama cloud', () => {
  it('targets https://ollama.com/api/chat with a Bearer key that never leaks into the result', async () => {
    Object.assign(cfg, { OLLAMA_MODE: 'cloud', OLLAMA_BASE_URL: 'http://localhost:11434', OLLAMA_API_KEY: 'sk-secret-XYZ', OLLAMA_MODEL: 'llama3.1', OLLAMA_DEFAULT_MODEL: 'gpt-oss:20b' });
    const f = mockFetch({ message: { content: 'cloud-reply' } });
    const client = new OllamaProviderClient();
    const r = await client.generate({ messages: [{ role: 'user', content: 'x' }], operation: 'recommendation' });
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://ollama.com/api/chat');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-secret-XYZ');
    expect(r.mode).toBe('cloud');
    expect(r.model).toBe('gpt-oss:20b');
    // The API key must never appear in any value the gateway/callers receive.
    expect(JSON.stringify(r)).not.toContain('sk-secret-XYZ');
  });

  it('surfaces a clear error on a non-200 response', async () => {
    Object.assign(cfg, { OLLAMA_MODE: 'cloud', OLLAMA_BASE_URL: 'http://localhost:11434', OLLAMA_API_KEY: 'sk', OLLAMA_MODEL: 'm', OLLAMA_DEFAULT_MODEL: 'm' });
    mockFetch({ error: 'nope' }, 401);
    const client = new OllamaProviderClient();
    await expect(client.generate({ messages: [], operation: 'recommendation' })).rejects.toThrow(/401/);
  });
});
