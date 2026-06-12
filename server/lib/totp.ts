import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env';

// ===========================================================================
// RFC 6238 TOTP using Node's built-in crypto only (no external dependency).
// Real, standards-compliant TOTP — compatible with Google Authenticator, 1Password,
// Authy, etc. Secrets are base32 (RFC 4648) so authenticator apps can import them.
// ===========================================================================

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/g, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** Generate a new base32 TOTP secret (160-bit, the RFC-recommended size). */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

function hotp(secret: Buffer, counter: number): string {
  const buf = Buffer.alloc(8);
  // 64-bit big-endian counter
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac = createHmac('sha1', secret).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24)
    | ((hmac[offset + 1] & 0xff) << 16)
    | ((hmac[offset + 2] & 0xff) << 8)
    | (hmac[offset + 3] & 0xff);
  return (code % 1_000_000).toString().padStart(6, '0');
}

/** Current 6-digit TOTP code for a base32 secret. */
export function generateTotp(base32Secret: string, forTime: number = Date.now(), step = 30): string {
  return hotp(base32Decode(base32Secret), Math.floor(forTime / 1000 / step));
}

/**
 * Verify a submitted code against the secret, allowing +/- `window` steps for
 * clock drift. Uses constant-time comparison. Never logs the code.
 */
export function verifyTotp(base32Secret: string, token: string, window = 1, forTime: number = Date.now(), step = 30): boolean {
  const normalized = String(token ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(normalized)) return false;
  const secret = base32Decode(base32Secret);
  const counter = Math.floor(forTime / 1000 / step);
  for (let errorWindow = -window; errorWindow <= window; errorWindow += 1) {
    const candidate = hotp(secret, counter + errorWindow);
    const a = Buffer.from(candidate);
    const b = Buffer.from(normalized);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  return false;
}

/** otpauth:// provisioning URI for QR-code enrollment in an authenticator app. */
export function totpAuthUri(base32Secret: string, accountLabel: string): string {
  const issuer = encodeURIComponent(env.MFA_ISSUER);
  const label = encodeURIComponent(`${env.MFA_ISSUER}:${accountLabel}`);
  return `otpauth://totp/${label}?secret=${base32Secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
}
