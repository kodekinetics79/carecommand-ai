import {
  createCipheriv, createDecipheriv, createHmac, randomBytes,
  scrypt as scryptCallback, scryptSync, timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
import { env } from '../config/env';

const scrypt = promisify(scryptCallback);

export function createPasswordHash(password: string) {
  return generatePasswordHash(password);
}

export async function generatePasswordHash(password: string) {
  const salt = randomBytes(16).toString('hex');
  const derived = await scrypt(password, salt, 64) as Buffer;
  return `scrypt$${salt}$${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, storedHash?: string | null) {
  if (!storedHash) return false;
  const [scheme, salt, derivedHex] = storedHash.split('$');
  if (scheme !== 'scrypt' || !salt || !derivedHex) return false;
  const expected = Buffer.from(derivedHex, 'hex');
  const actual = await scrypt(password, salt, expected.length) as Buffer;
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

export function createRefreshToken() {
  return randomBytes(48).toString('base64url');
}

export function createCsrfToken() {
  return randomBytes(24).toString('base64url');
}

export function hashRefreshToken(token: string) {
  return createHmac('sha256', env.JWT_REFRESH_SECRET).update(token).digest('hex');
}

// --- Password policy -------------------------------------------------------
export interface PasswordPolicyResult { ok: boolean; message?: string }

/**
 * Validate a password against the configured minimum length (and room for
 * stronger rules later). Returns a safe, non-sensitive message on failure.
 */
export function validatePassword(password: string, minLength = env.PASSWORD_MIN_LENGTH): PasswordPolicyResult {
  if (typeof password !== 'string' || password.length < minLength) {
    return { ok: false, message: `Password must be at least ${minLength} characters.` };
  }
  if (password.length > 200) {
    return { ok: false, message: 'Password is too long.' };
  }
  return { ok: true };
}

// --- Single-use, hashed-at-rest reset tokens -------------------------------
/** A high-entropy reset token (returned to the user once; never stored raw). */
export function createResetToken() {
  return randomBytes(32).toString('base64url');
}
/** HMAC of a reset token for storage/lookup — the raw token is never persisted. */
export function hashResetToken(token: string) {
  return createHmac('sha256', env.JWT_SECRET).update(`reset:${token}`).digest('hex');
}

// --- AES-256-GCM secret encryption (for MFA secrets at rest) ---------------
// Key: dedicated AUTH_ENCRYPTION_KEY if provided, else derived from JWT_SECRET.
// Stored format: gcm$<iv hex>$<authTag hex>$<ciphertext hex>.
//
// Derived ON FIRST USE, not at import. `scryptSync` is a deliberately slow KDF
// and it THROWS when handed undefined, so deriving at module scope made merely
// importing this file expensive and, in any process whose env carries neither
// key, fatal. That reached well beyond the code that encrypts anything: the
// reconciliation worker imports `retell` for one API call, `retell` imports
// `providerCredentials`, and that imported this — so the worker could not boot
// because of a key it never uses. A module should not fail to load over
// configuration it may never touch.
//
// Memoised, so the cost is still paid exactly once per process.
let encryptionKeyCache: Buffer | null = null;
function encryptionKey(): Buffer {
  if (encryptionKeyCache) return encryptionKeyCache;
  const material = env.AUTH_ENCRYPTION_KEY ?? env.JWT_SECRET;
  if (!material) throw new Error('security: AUTH_ENCRYPTION_KEY or JWT_SECRET is required to encrypt or decrypt secrets');
  encryptionKeyCache = scryptSync(material, 'carecommand-auth-enc', 32);
  return encryptionKeyCache;
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `gcm$${iv.toString('hex')}$${tag.toString('hex')}$${ciphertext.toString('hex')}`;
}

export function decryptSecret(stored: string): string | null {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'gcm') return null;
  try {
    const [, ivHex, tagHex, dataHex] = parts;
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** Constant-time string compare for non-hash equality checks. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
