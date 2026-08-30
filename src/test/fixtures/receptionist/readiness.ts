import type { ReadinessCheck, ReadinessResponse, ReadinessStatus } from '../../../lib/receptionistDeployment';
// The server's own source, as text. `?raw` is how the other fixtures in this
// folder are loaded, and it keeps the browser project free of node globals.
import campaignReadinessSource from '../../../../server/lib/receptionist/campaignReadiness.ts?raw';

// ===========================================================================
// The readiness fixture, derived from the server rather than typed out.
//
// Both jsdom readiness fixtures used to hand-write their check rows, and both
// wrote `phone_number_bound` — a key the server has never emitted. So the
// Go-live card's "Forward the public number to the DID" step was permanently
// "Not evaluated yet.", the card could never reach 5/5, and 387 web tests
// passed on it. That step is the live incident where nobody could reach the
// advertised number.
//
// A fixture whose keys come from `campaignReadiness.ts` cannot encode a key
// the product does not produce. Use this instead of a hand-written array.
// ===========================================================================

/** The readiness keys the server labels and returns, read from its source. */
export function serverReadinessKeys(): string[] {
  const block = campaignReadinessSource.match(/const LABELS: Record<ReadinessKey, string> = \{([\s\S]*?)\n\};/);
  if (!block) throw new Error('Could not read the LABELS record from campaignReadiness.ts');
  const keys = [...block[1].matchAll(/^\s+([a-z_0-9]+):\s*'([^']*)'/gm)].map(match => match[1]);
  if (!keys.length) throw new Error('The LABELS record in campaignReadiness.ts parsed to nothing');
  return keys;
}

export interface ReadinessFixtureOptions {
  /** Per-key status overrides; every other key passes. */
  statuses?: Record<string, ReadinessStatus>;
  campaignId?: string;
  status?: ReadinessResponse['status'];
}

/**
 * A readiness response shaped exactly like one `GET /campaigns/:id/readiness`
 * returns: every key the server emits, `pass` unless overridden, with the
 * code / fix link discipline the real evaluation follows (a pass carries
 * neither; anything else carries both).
 */
export function readinessFixture(options: ReadinessFixtureOptions = {}): ReadinessResponse {
  const statuses = options.statuses ?? {};
  const checks: ReadinessCheck[] = serverReadinessKeys().map(key => {
    const status = statuses[key] ?? 'pass';
    return {
      key,
      label: key.replace(/_/g, ' '),
      status,
      code: status === 'pass' ? null : key,
      detail: status === 'pass' ? `${key} is satisfied.` : `${key} is not satisfied.`,
      fixHref: status === 'pass' ? null : `/receptionist-studio?tab=clinic`,
    };
  });
  const blocking = checks.filter(check => check.status === 'fail' || check.status === 'pending');
  return {
    campaignId: options.campaignId ?? 'campaign-fixture',
    status: options.status ?? 'DRAFT',
    ready: blocking.length === 0,
    checks,
    actions: {
      activate: { allowed: blocking.length === 0, reasons: blocking.map(check => check.code ?? check.key) },
      pause: { allowed: false, reasons: ['campaign_not_active'] },
      archive: { allowed: true, reasons: [] },
    },
    evaluatedAt: '2026-08-30T09:00:00.000Z',
  };
}
