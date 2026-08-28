import { env } from '../../config/env';
import type { AdvisorPromptInput } from './types';

export interface AIProvider {
  name: string;
  generateAnswer(input: AdvisorPromptInput): Promise<string>;
}

// Every outbound provider call is bounded by an AbortController timeout, matching
// the rest of the repo's outbound wrappers (commsProvider/retell ~8s). Without it
// a hung model server would stall an advisory request indefinitely.
async function fetchWithTimeout(url: string | URL, init: RequestInit, timeoutMs = 8000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...init, signal: controller.signal }); } finally { clearTimeout(timer); }
}

function toSentenceCase(value: string) {
  return value.replace(/-/g, ' ').replace(/\b\w/g, character => character.toUpperCase());
}

function formatEvidence(input: AdvisorPromptInput) {
  const lines = input.analysis.evidence.map(item => `- ${item}`).join('\n');
  return [
    `Advisor: ${toSentenceCase(input.advisorType)}`,
    `Summary: ${input.analysis.summary}`,
    `Diagnosis: ${input.analysis.diagnosis}`,
    `Recommended action: ${input.analysis.recommendedAction}`,
    // HONEST framing: these two numbers are templated rule-based arithmetic over
    // real backend counts — NOT AI-model confidence or a model-predicted dollar
    // figure. Labelled as such so the model (and any downstream reader) never
    // presents them as model reasoning.
    `Rule-based expected-impact estimate: $${Math.round(input.analysis.expectedImpact).toLocaleString('en-US')}`,
    `Heuristic confidence (rule-based, not model-derived): ${input.analysis.confidence}%`,
    'Evidence:',
    lines,
    'Actions:',
    ...input.analysis.actions.map(action => `- ${action.label} (${action.path})`),
  ].join('\n');
}

export class MockAdvisorProvider implements AIProvider {
  name = 'mock';

  async generateAnswer(input: AdvisorPromptInput) {
    const questionLine = input.question ? `Question: ${input.question}\n\n` : '';
    return `${questionLine}${formatEvidence(input)}`;
  }
}

class OllamaProvider implements AIProvider {
  name = 'ollama';

  constructor(private readonly fallback: AIProvider) {}

  async generateAnswer(input: AdvisorPromptInput) {
    try {
      const response = await fetchWithTimeout(new URL('/api/chat', env.OLLAMA_BASE_URL), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: env.OLLAMA_MODEL,
          stream: false,
          messages: [
            {
              role: 'system',
              content: 'You are a clinic operations advisor. Business operations only. No medical advice, no diagnosis, no treatment. Write a concise owner-facing advisory response.',
            },
            {
              role: 'user',
              content: formatEvidence(input),
            },
          ],
        }),
      });
      if (!response.ok) throw new Error('Ollama request failed');
      const payload = await response.json() as { message?: { content?: string } };
      const text = payload.message?.content?.trim();
      return text || this.fallback.generateAnswer(input);
    } catch {
      return this.fallback.generateAnswer(input);
    }
  }
}

class OpenAIProvider implements AIProvider {
  name = 'openai';

  constructor(private readonly fallback: AIProvider) {}

  async generateAnswer(input: AdvisorPromptInput) {
    if (!env.OPENAI_API_KEY) return this.fallback.generateAnswer(input);
    try {
      const response = await fetchWithTimeout(new URL('/v1/chat/completions', env.OPENAI_BASE_URL), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: env.OPENAI_MODEL,
          temperature: 0.2,
          messages: [
            {
              role: 'system',
              content: 'You are a clinic operations advisor. Business operations only. No medical advice, no diagnosis, no treatment. Write a concise owner-facing advisory response.',
            },
            {
              role: 'user',
              content: formatEvidence(input),
            },
          ],
        }),
      });
      if (!response.ok) throw new Error('OpenAI request failed');
      const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const text = payload.choices?.[0]?.message?.content?.trim();
      return text || this.fallback.generateAnswer(input);
    } catch {
      return this.fallback.generateAnswer(input);
    }
  }
}

class ClaudeProvider implements AIProvider {
  name = 'claude';

  constructor(private readonly fallback: AIProvider) {}

  async generateAnswer(input: AdvisorPromptInput) {
    if (!env.CLAUDE_API_KEY) return this.fallback.generateAnswer(input);
    try {
      const response = await fetchWithTimeout(new URL('/v1/messages', env.CLAUDE_BASE_URL), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.CLAUDE_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: env.CLAUDE_MODEL,
          max_tokens: 700,
          temperature: 0.2,
          messages: [
            {
              role: 'user',
              content: formatEvidence(input),
            },
          ],
          system: 'You are a clinic operations advisor. Business operations only. No medical advice, no diagnosis, no treatment. Write a concise owner-facing advisory response.',
        }),
      });
      if (!response.ok) throw new Error('Claude request failed');
      const payload = await response.json() as { content?: Array<{ text?: string }> };
      const text = payload.content?.[0]?.text?.trim();
      return text || this.fallback.generateAnswer(input);
    } catch {
      return this.fallback.generateAnswer(input);
    }
  }
}

export function createAIProvider(): AIProvider {
  const fallback = new MockAdvisorProvider();
  switch (env.AI_PROVIDER) {
    case 'ollama':
      return new OllamaProvider(fallback);
    case 'openai':
      return new OpenAIProvider(fallback);
    case 'claude':
      return new ClaudeProvider(fallback);
    default:
      return fallback;
  }
}
