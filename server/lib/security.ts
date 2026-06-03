import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
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
