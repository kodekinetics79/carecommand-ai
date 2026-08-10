import { ApiError } from './api';

export function createEligibilityIdempotencyKey(): string {
  return `elig_${globalThis.crypto.randomUUID()}`;
}

export function eligibilityRequestHeaders(idempotencyKey = createEligibilityIdempotencyKey()): HeadersInit {
  return { 'Idempotency-Key': idempotencyKey };
}

const pendingEligibilityActions = new Map<string, string>();

function stableSignature(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSignature).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableSignature(record[key])}`).join(',')}}`;
}

export async function runEligibilityAction<T>(contract: string, input: unknown, request: (idempotencyKey: string) => Promise<T>): Promise<T> {
  const signature = `${contract}:${stableSignature(input)}`;
  const key = pendingEligibilityActions.get(signature) ?? createEligibilityIdempotencyKey();
  pendingEligibilityActions.set(signature, key);
  try {
    const result = await request(key);
    pendingEligibilityActions.delete(signature);
    return result;
  } catch (error) {
    if (error instanceof ApiError) {
      const state = String(error.code ?? error.details?.status ?? error.details?.error ?? '');
      const ambiguousConflict = error.status === 409 && ['reconciliation_required', 'execution_in_progress'].includes(state);
      const ambiguousTransport = error.status >= 500 || error.status === 408 || error.status === 429;
      if (!ambiguousConflict && !ambiguousTransport) pendingEligibilityActions.delete(signature);
    }
    throw error;
  }
}
