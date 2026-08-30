import { createHash } from 'node:crypto';
import type { Prisma } from '../generated/prisma/client';
import { db } from './db';

/**
 * Replay-safe handling for a request that carries an Idempotency-Key.
 *
 * The pilot-import routes advertised this - the console sends the header on
 * every preset save and every commit - while commit 2bdffe6 (a revert) removed
 * the handling, so nothing read it. A double-clicked import was protected only
 * by the data keys its upserts happened to use, which is luck rather than
 * design.
 *
 * Three states, and each of the three matters:
 *
 *   first attempt      - no row: claim the key, run the work, store what we
 *                        returned.
 *   repeat, completed  - a stored response: return it verbatim. NOT a re-read
 *                        of the underlying row, which may have changed since;
 *                        a replay must return what the caller was told.
 *   repeat, unfinished - the key was claimed but the attempt never completed
 *                        (it crashed, or its transaction rolled back). Run the
 *                        work again, and tell the caller it is a retry so
 *                        anything already recorded once - a durable intent
 *                        event, say - is not recorded twice.
 */
export type IdempotentOutcome<T> =
  | { status: 'ok'; value: T }
  /** The stored response, returned without doing the work again. */
  | { status: 'replayed'; value: T }
  /** The key was first used for a DIFFERENT request. Answer 409; do no work. */
  | { status: 'conflict'; value?: undefined };

/** Stable digest of a request, so a key reused with different content is caught. */
export function requestFingerprint(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload ?? null)).digest('hex');
}

export interface IdempotentContext {
  /** False when a previous attempt claimed this key but never completed. */
  firstAttempt: boolean;
}

export async function withIdempotency<T>(
  input: { scope: string; key: string | undefined; tenantId?: string; fingerprint?: string },
  run: (context: IdempotentContext) => Promise<T>,
  client: Prisma.TransactionClient | typeof db = db,
): Promise<IdempotentOutcome<T>> {
  // No key means the caller is not asking for replay protection. Do the work.
  if (!input.key) return { status: 'ok', value: await run({ firstAttempt: true }) };

  const where = { scope_key: { scope: input.scope, key: input.key } };
  let firstAttempt = true;
  try {
    await client.idempotencyKey.create({
      data: { scope: input.scope, key: input.key, tenantId: input.tenantId ?? null, fingerprint: input.fingerprint ?? null },
    });
  } catch (error) {
    if ((error as { code?: string }).code !== 'P2002') throw error;
    const existing = await client.idempotencyKey.findUnique({ where });
    // A key bound to a different request is refused before any work happens.
    // Replaying the old receipt would report an import that never covered the
    // rows now being sent.
    if (existing?.fingerprint && input.fingerprint && existing.fingerprint !== input.fingerprint) {
      return { status: 'conflict' };
    }
    if (existing?.response != null) return { status: 'replayed', value: existing.response as T };
    firstAttempt = false;
  }

  const value = await run({ firstAttempt });
  // Stored only on success. A failed attempt leaves the claim without a
  // response, which is what makes the retry above run the work again rather
  // than replaying a failure forever.
  await client.idempotencyKey.updateMany({
    where: { scope: input.scope, key: input.key },
    data: { response: value as Prisma.InputJsonValue },
  });
  return { status: 'ok', value };
}

/** The Idempotency-Key header, if the caller sent a usable one. */
export function idempotencyKeyFrom(headers: Record<string, unknown>): string | undefined {
  const raw = headers['idempotency-key'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim().slice(0, 200) : undefined;
}
