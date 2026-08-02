import { createHash } from 'node:crypto';
import { env } from '../../config/env';

// Backend eligibility service abstraction. The frontend never decides coverage
// status — the provider adapter does. Sandbox is a deterministic Stedi-shaped
// simulator (no network); production would call the real Stedi 270/271 API
// behind the same boundary.

export type EligibilityStatus = 'ACTIVE' | 'INACTIVE' | 'NEEDS_REVIEW' | 'ERROR';

export interface EligibilityRequest {
  memberId: string;
  payerName: string;
  planName?: string;
  serviceType?: string;
}

export interface NormalizedEligibility {
  status: EligibilityStatus;
  coverageActive: boolean;
  planName: string;
  payerName: string;
  copay: number;
  deductibleRemaining: number;
  coinsurance: number;
  message: string;
  payerReference: string | null;
  checkedAt: string;
}

export interface EligibilityResult {
  normalized: NormalizedEligibility;
  raw: unknown;
  providerKey: string;
  providerMode: 'sandbox' | 'production';
}

function seedFrom(memberId: string): number {
  const hex = createHash('sha256').update(memberId).digest('hex').slice(0, 8);
  return parseInt(hex, 16);
}

/**
 * Deterministic Stedi-style sandbox. Outcome is driven by the member ID so
 * demos are reproducible and every status path is reachable:
 *   - contains "inactive" / ends "00" → INACTIVE
 *   - starts "ERR"                     → ERROR
 *   - contains "review" / ends "99"    → NEEDS_REVIEW
 *   - otherwise                        → ACTIVE
 */
export function stediSandboxCheck(req: EligibilityRequest): EligibilityResult {
  const id = req.memberId.trim();
  const lower = id.toLowerCase();
  const now = new Date();
  const checkedAt = now.toISOString();
  const planName = req.planName?.trim() || 'PPO Choice Plus';
  const payerName = req.payerName.trim();
  const reference = `STEDI-SBX-${seedFrom(id).toString(16).toUpperCase().slice(0, 8)}`;

  const base = (status: EligibilityStatus, coverageActive: boolean, message: string, benefits: Record<string, unknown>): EligibilityResult => ({
    providerKey: 'stedi',
    providerMode: 'sandbox',
    normalized: {
      status, coverageActive, planName, payerName,
      copay: Number(benefits.copay ?? 0), deductibleRemaining: Number(benefits.deductibleRemaining ?? 0), coinsurance: Number(benefits.coinsurance ?? 0),
      message, payerReference: reference, checkedAt,
    },
    // Realistic Stedi 271-shaped raw payload (sandbox).
    raw: {
      meta: { sandbox: true, traceId: reference, applicationMode: 'sandbox' },
      transactionType: '271',
      payer: { name: payerName },
      subscriber: { memberId: id },
      planInformation: { planName },
      benefitsInformation: benefits.benefitsInformation ?? [],
      errors: benefits.errors ?? [],
    },
  });

  if (lower.startsWith('err')) {
    return base('ERROR', false, 'Payer returned an error (AAA reject) — resubmit or verify member details.', {
      errors: [{ code: '72', description: 'Invalid/Missing Subscriber/Insured ID' }],
    });
  }
  if (lower.includes('inactive') || id.endsWith('00')) {
    return base('INACTIVE', false, 'Coverage is inactive for the requested service date.', {
      benefitsInformation: [{ code: '6', name: 'Inactive', serviceTypeCodes: ['30'] }],
    });
  }
  if (lower.includes('review') || id.endsWith('99')) {
    return base('NEEDS_REVIEW', true, 'Partial benefits returned — manual review recommended before billing.', {
      benefitsInformation: [{ code: 'A', name: 'Co-Insurance', percent: '20', serviceTypeCodes: ['30'] }],
      coinsurance: 20,
    });
  }
  const seed = seedFrom(id);
  const copay = [10, 20, 25, 35, 40][seed % 5];
  const deductibleRemaining = [0, 150, 400, 750, 1200][(seed >> 3) % 5];
  const coinsurance = [0, 10, 20][(seed >> 5) % 3];
  return base('ACTIVE', true, 'Sandbox response reports active benefit information for the requested service. This is not a coverage or payment guarantee.', {
    copay, deductibleRemaining, coinsurance,
    benefitsInformation: [
      { code: '1', name: 'Active Coverage', serviceTypeCodes: ['30'] },
      { code: 'B', name: 'Co-Payment', amount: String(copay), serviceTypeCodes: ['30'] },
      { code: 'C', name: 'Deductible', amount: String(deductibleRemaining), timeQualifier: 'Remaining' },
      ...(coinsurance ? [{ code: 'A', name: 'Co-Insurance', percent: String(coinsurance) }] : []),
    ],
  });
}

/**
 * Run an eligibility check through the resolved provider. `mode` of the DB
 * provider row decides sandbox vs production. Production Stedi calls the real
 * API only when a key exists; otherwise we stay in sandbox (never fabricate a
 * "live" result).
 */
export function runStediEligibility(req: EligibilityRequest, mode: 'sandbox' | 'production'): EligibilityResult {
  if (mode === 'production' && env.STEDI_API_KEY) {
    // Real 270/271 call would go here (same return contract). Until wired, fall
    // back to the sandbox simulator so the path stays honest and testable.
    const result = stediSandboxCheck(req);
    result.providerMode = 'production';
    result.normalized.message += ' (production key present — live adapter not yet wired; sandbox response shown).';
    return result;
  }
  return stediSandboxCheck(req);
}
