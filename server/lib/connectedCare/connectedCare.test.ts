import { describe, it, expect } from 'vitest';
import { stediSandboxCheck } from './eligibilityService';
import { maskMemberId, INSURANCE_PROVIDERS, DEVICE_PROVIDERS } from './catalog';
import { normalizeWebhook, verifyWebhookSignature } from './deviceAdapters';
import { computeRpmReadiness } from './rpmReadiness';
import { evaluateSeverity } from '../monitoring';
import { createHmac } from 'node:crypto';

describe('Stedi sandbox eligibility', () => {
  it('returns ACTIVE with benefits for a normal member id', () => {
    const r = stediSandboxCheck({ memberId: 'AET-110293', payerName: 'Aetna' });
    expect(r.normalized.status).toBe('ACTIVE');
    expect(r.normalized.coverageActive).toBe(true);
    expect(r.normalized.copay).toBeGreaterThanOrEqual(0);
    expect(Array.isArray((r.raw as { benefitsInformation: unknown[] }).benefitsInformation)).toBe(true);
  });
  it('returns INACTIVE for ids ending in 00', () => {
    expect(stediSandboxCheck({ memberId: 'AET-1100', payerName: 'Aetna' }).normalized.status).toBe('INACTIVE');
  });
  it('returns NEEDS_REVIEW for ids ending in 99', () => {
    expect(stediSandboxCheck({ memberId: 'AET-1199', payerName: 'Aetna' }).normalized.status).toBe('NEEDS_REVIEW');
  });
  it('returns ERROR for ids starting ERR', () => {
    expect(stediSandboxCheck({ memberId: 'ERR-0001', payerName: 'Aetna' }).normalized.status).toBe('ERROR');
  });
  it('is deterministic for the same member id', () => {
    const a = stediSandboxCheck({ memberId: 'X-12345', payerName: 'P' }).normalized.copay;
    const b = stediSandboxCheck({ memberId: 'X-12345', payerName: 'P' }).normalized.copay;
    expect(a).toBe(b);
  });
});

describe('member id masking', () => {
  it('masks all but the last 4', () => {
    expect(maskMemberId('AET-110293')).toBe('••••0293');
    expect(maskMemberId('123')).toBe('••••');
    expect(maskMemberId(null)).toBeNull();
  });
});

describe('provider catalog', () => {
  it('lists the insurance providers (stedi sandbox-capable, optum/availity not)', () => {
    const stedi = INSURANCE_PROVIDERS.find(p => p.key === 'stedi');
    expect(stedi?.supportsSandbox).toBe(true);
    expect(INSURANCE_PROVIDERS.find(p => p.key === 'optum')?.supportsSandbox).toBe(false);
    expect(INSURANCE_PROVIDERS.find(p => p.key === 'availity')?.supportsSandbox).toBe(false);
  });
  it('lists device providers across all categories incl. manual fallback', () => {
    const cats = new Set(DEVICE_PROVIDERS.map(p => p.category));
    expect(cats.has('DIRECT_API')).toBe(true);
    expect(cats.has('AGGREGATOR')).toBe(true);
    expect(cats.has('RPM_VENDOR')).toBe(true);
    expect(DEVICE_PROVIDERS.find(p => p.key === 'manual')?.category).toBe('MANUAL');
  });
});

describe('device reading normalization', () => {
  it('normalizes a readings array and keeps valid types', () => {
    const { readings } = normalizeWebhook('withings', { readings: [
      { type: 'blood_pressure', value: '128', unit: 'mmHg' },
      { readingType: 'oxygen', value: 96 },
    ] });
    expect(readings).toHaveLength(2);
    expect(readings[0].readingType).toBe('blood_pressure');
    expect(readings[1].numericValue).toBe(96);
  });
  it('drops unknown reading types and empty values', () => {
    const { readings } = normalizeWebhook('terra', { data: [
      { type: 'sleep', value: '7' },        // unknown type
      { type: 'glucose', value: '' },        // empty value
      { type: 'glucose', value: '110' },     // valid
    ] });
    expect(readings).toHaveLength(1);
    expect(readings[0].value).toBe('110');
  });
  it('accepts a single reading object', () => {
    const { readings } = normalizeWebhook('manual', { type: 'heart_rate', value: 72 });
    expect(readings).toHaveLength(1);
  });
});

describe('webhook signature verification', () => {
  const secret = 'topsecret';
  const body = JSON.stringify({ readings: [{ type: 'glucose', value: '110' }] });
  it('returns null when the provider does not sign', () => {
    expect(verifyWebhookSignature(null, body, null)).toBeNull();
  });
  it('accepts a correct HMAC and rejects a bad one', () => {
    const sig = createHmac('sha256', secret).update(body).digest('hex');
    expect(verifyWebhookSignature(secret, body, sig)).toBe(true);
    expect(verifyWebhookSignature(secret, body, 'deadbeef')).toBe(false);
    expect(verifyWebhookSignature(secret, body, null)).toBe(false);
  });
});

describe('abnormal reading → severity (backend-decided)', () => {
  it('flags a critically high glucose', () => {
    expect(evaluateSeverity('glucose', 320, null).severity).toBe('critical');
  });
  it('flags an out-of-range glucose as high', () => {
    expect(evaluateSeverity('glucose', 210, null).severity).toBe('high');
  });
  it('keeps an in-range glucose normal', () => {
    expect(evaluateSeverity('glucose', 110, null).severity).toBe('normal');
  });
});

describe('RPM billing readiness rules', () => {
  const full = { consentGranted: true, enrollmentActive: true, readingDays: 18, reviewMinutes: 22, communicationFlag: true, providerSignoff: true };
  it('is READY when all requirements + signoff are met', () => {
    expect(computeRpmReadiness(full).status).toBe('READY');
  });
  it('is NEEDS_REVIEW when data is complete but signoff is missing', () => {
    expect(computeRpmReadiness({ ...full, providerSignoff: false }).status).toBe('NEEDS_REVIEW');
  });
  it('is MISSING_REQUIREMENTS without consent', () => {
    const r = computeRpmReadiness({ ...full, consentGranted: false });
    expect(r.status).toBe('MISSING_REQUIREMENTS');
    expect(r.missing).toContain('Active RPM consent');
  });
  it('is MISSING_REQUIREMENTS with too few device-days', () => {
    expect(computeRpmReadiness({ ...full, readingDays: 9, providerSignoff: false }).status).toBe('MISSING_REQUIREMENTS');
  });
});
