import { describe, it, expect } from 'vitest';
import { booleanString } from '../lib/booleanString';
import { scrubUrlAttribute } from '../lib/spanRedaction';

describe('booleanString — env/query boolean parsing', () => {
  // The bug this replaces: z.coerce.boolean() runs Boolean(value), so the
  // string "false" coerced to true — OTEL_ENABLED=false enabled tracing and
  // render.yaml's RLS_ENFORCE_RUNTIME_ROLE:"false" failed production boot closed.
  it('parses the words people actually write', () => {
    const flag = booleanString(true);
    expect(flag.parse('false')).toBe(false);
    expect(flag.parse('FALSE')).toBe(false);
    expect(flag.parse('0')).toBe(false);
    expect(flag.parse('no')).toBe(false);
    expect(flag.parse('off')).toBe(false);
    expect(flag.parse('true')).toBe(true);
    expect(flag.parse('1')).toBe(true);
    expect(flag.parse('yes')).toBe(true);
    expect(flag.parse('on')).toBe(true);
  });

  it('empty/unset take the default; garbage fails loudly', () => {
    expect(booleanString(true).parse('')).toBe(true);
    expect(booleanString(false).parse(undefined)).toBe(false);
    expect(() => booleanString(false).parse('banana')).toThrow();
  });
});

describe('scrubUrlAttribute — no tokens/ids/queries reach the tracing backend', () => {
  it('redacts public-route tokens in the path', () => {
    expect(scrubUrlAttribute('http.target', '/v1/intake/public/a1b2c3d4e5f6a7b8c9d0/sections'))
      .toBe('/v1/intake/public/REDACTED/sections');
    expect(scrubUrlAttribute('url.path', '/v1/payments/public/checkout/AbCdEf123456_-XyZ9'))
      .toBe('/v1/payments/public/checkout/REDACTED');
  });

  it('redacts uuids (resource ids) while keeping named segments', () => {
    expect(scrubUrlAttribute('http.target', '/v1/patients/550e8400-e29b-41d4-a716-446655440000'))
      .toBe('/v1/patients/REDACTED');
    expect(scrubUrlAttribute('http.target', '/v1/scheduling/slots'))
      .toBe('/v1/scheduling/slots');
  });

  it('redacts query strings wholesale and preserves scheme/host on full urls', () => {
    expect(scrubUrlAttribute('http.url', 'https://api.example.com/v1/pilot/share/tok_abcdef0123456789?sig=s3cr3t'))
      .toBe('https://api.example.com/v1/pilot/share/REDACTED?REDACTED');
    expect(scrubUrlAttribute('http.url', 'http://localhost:3001/health'))
      .toBe('http://localhost:3001/health');
  });

  it('treats url.query as bare query content', () => {
    expect(scrubUrlAttribute('url.query', 'token=abc&dob=1990-01-01')).toBe('REDACTED');
    expect(scrubUrlAttribute('url.query', '')).toBe('');
  });
});
