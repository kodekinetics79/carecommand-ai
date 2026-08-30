import { describe, expect, it } from 'vitest';

// The server file itself, as text. Reading the source is the point: a hand-
// copied list of keys is exactly the fixture that let `phone_number_bound`
// ship green in two suites.
import campaignReadinessSource from '../../server/lib/receptionist/campaignReadiness.ts?raw';

import {
  READINESS_KEYS, boundNumberOf, formatCount, formatRate, formatSeconds, goLiveRail, goLiveSteps,
  mergeVoicesSection, normalizeCatalog, normalizeDeploymentDiff, normalizeOverviewKpis, serviceStatus, unwrapDeployment,
  type ReadinessResponse,
} from './receptionistDeployment';

/**
 * The client half of three contracts the browser cannot discover at runtime:
 * which readiness keys exist, what shape the deployment routes answer with,
 * and what a metric with no denominator means.
 *
 * Every one of them was broken in a way 387 passing web tests could not see,
 * because every fixture was hand-written to match the client's belief rather
 * than the server's body.
 */
function readinessOf(checks: ReadinessResponse['checks'], overrides: Partial<ReadinessResponse> = {}): ReadinessResponse {
  return {
    campaignId: 'camp-1', status: 'DRAFT', ready: false, checks,
    actions: { activate: { allowed: false, reasons: [] }, pause: { allowed: false, reasons: [] }, archive: { allowed: true, reasons: [] } },
    evaluatedAt: '2026-08-30T09:00:00.000Z',
    ...overrides,
  };
}

describe('READINESS_KEYS ≡ the server’s LABELS keys', () => {
  it('matches server/lib/receptionist/campaignReadiness.ts exactly', () => {
    const block = /const LABELS: Record<ReadinessKey, string> = \{([\s\S]*?)\n\};/.exec(campaignReadinessSource);
    expect(block, 'LABELS block not found — the server file moved or was renamed').not.toBeNull();
    const serverKeys = [...block![1].matchAll(/^\s{2}([a-z_]+):/gm)].map(match => match[1]);

    expect(serverKeys.length).toBeGreaterThan(0);
    // Not a subset check. A key only the server emits is a row the go-live
    // path silently never evaluates; a key only the client knows is a step
    // that can never turn green — which is exactly what `phone_number_bound`
    // was for the one step that proves a caller can reach the line.
    expect([...READINESS_KEYS].sort()).toEqual([...serverKeys].sort());
  });

  it('does not carry the client-only keys the go-live card used to invent', () => {
    // `locale_pack_approved` was invented here once, but Package B now emits it
    // as a real readiness row (the clinic activation blockers became checks), so
    // it belongs to the server union above. These three are still inventions:
    // the server says `number_bound` and `clinic_hours_set`, and nothing says
    // `offer_content`.
    for (const invented of ['phone_number_bound', 'hours_set', 'offer_content']) {
      expect(READINESS_KEYS).not.toContain(invented);
    }
  });
});

describe('goLiveSteps', () => {
  it('reads the number step from `number_bound` and offers the server’s fix link', () => {
    const steps = goLiveSteps(readinessOf([
      { key: 'number_bound', label: 'Bound', status: 'fail', code: 'number_bound', title: 'The number is not bound', detail: 'Deploy again.', fixHref: '/receptionist-studio?tab=deploy' },
    ]), 'DRAFT');
    const forward = steps.find(step => step.key === 'forward')!;

    expect(forward.status).toBe('todo');
    expect(forward.fixHref).toBe('/receptionist-studio?tab=deploy');
    expect(forward.title).toBe('The number is not bound');
  });

  it('says a step is unproven when the server evaluated others but not this one', () => {
    const steps = goLiveSteps(readinessOf([
      { key: 'agent_verified', label: 'Verified', status: 'pass', code: null, detail: 'Verified.', fixHref: null },
    ]), 'DRAFT');

    expect(steps.find(step => step.key === 'forward')!.status).toBe('pending');
    expect(steps.find(step => step.key === 'forward')!.detail).toContain('unproven');
  });
});

describe('boundNumberOf', () => {
  it('reads the dialable number only out of a passing number_bound row', () => {
    expect(boundNumberOf(readinessOf([
      { key: 'number_bound', label: 'Bound', status: 'pass', code: null, detail: '+14155550142 answers with version 4.', fixHref: null },
    ]))).toBe('+14155550142');
  });

  it('never reports a number from a failing row, and never from prose without one', () => {
    expect(boundNumberOf(readinessOf([
      { key: 'number_bound', label: 'Bound', status: 'fail', code: 'number_bound', detail: '+14155550142 is bound to another deployment.', fixHref: null },
    ]))).toBeNull();
    expect(boundNumberOf(readinessOf([
      { key: 'number_bound', label: 'Bound', status: 'pass', code: null, detail: 'The clinic line answers with version 4.', fixHref: null },
    ]))).toBeNull();
    expect(boundNumberOf(null)).toBeNull();
  });
});

describe('goLiveRail', () => {
  it('puts a clinic prerequisite ahead of every deployment step', () => {
    const rail = goLiveRail({
      readiness: readinessOf([{ key: 'deployment_current', label: 'Deployed', status: 'pass', code: null, detail: 'Version 4.', fixHref: null }]),
      campaignStatus: 'DRAFT',
      prerequisites: [{ code: 'clinic_hours_missing', label: 'No hours', fixHref: '/receptionist-studio?tab=clinic' }],
    });

    expect(rail.next?.label).toBe('No hours');
    expect(rail.done).toBe(1);
    expect(rail.total).toBe(5);
  });

  it('names no next action once every step is done', () => {
    const rail = goLiveRail({
      readiness: readinessOf([
        { key: 'deployment_current', label: 'Deployed', status: 'pass', code: null, detail: '', fixHref: null },
        { key: 'agent_verified', label: 'Verified', status: 'pass', code: null, detail: '', fixHref: null },
        { key: 'number_bound', label: 'Bound', status: 'pass', code: null, detail: '+14155550142 answers with version 4.', fixHref: null },
        { key: 'test_call_completed', label: 'Test call', status: 'pass', code: null, detail: '', fixHref: null },
      ], { ready: true }),
      campaignStatus: 'ACTIVE',
    });

    expect(rail.next).toBeNull();
    expect(rail.done).toBe(5);
    expect(rail.boundNumber).toBe('+14155550142');
  });
});

describe('serviceStatus', () => {
  const healthy: ReadinessResponse['checks'] = [
    { key: 'agent_linked', label: 'Linked', status: 'pass', code: null, detail: '', fixHref: null },
    { key: 'agent_verified', label: 'Verified', status: 'pass', code: null, detail: '', fixHref: null },
    { key: 'deployment_current', label: 'Current', status: 'pass', code: null, detail: '', fixHref: null },
    { key: 'number_bound', label: 'Bound', status: 'pass', code: null, detail: '+14155550142 answers with version 4.', fixHref: null },
  ];

  it('is unknown, never answering, when readiness was never evaluated', () => {
    expect(serviceStatus({ campaignStatus: 'ACTIVE', readiness: null }).state).toBe('unknown');
  });

  it('is degraded while a deploy is publishing, and says what a caller loses', () => {
    const status = serviceStatus({ campaignStatus: 'ACTIVE', readiness: readinessOf(healthy, { ready: true }), deploying: true });
    expect(status.state).toBe('degraded');
    expect(status.detail).toContain('cannot book');
  });

  it('reports an ACTIVE campaign with an unbound number as not answering, with the fix', () => {
    const status = serviceStatus({
      campaignStatus: 'ACTIVE',
      readiness: readinessOf([
        ...healthy.slice(0, 3),
        { key: 'number_bound', label: 'Bound', status: 'fail', code: 'number_bound', title: 'The number is not bound', detail: 'A caller would not reach this agent.', fixHref: '/receptionist-studio?tab=deploy' },
      ]),
    });

    expect(status.state).toBe('not_answering');
    expect(status.action).toBe('The number is not bound');
    expect(status.fixHref).toBe('/receptionist-studio?tab=deploy');
  });

  it('counts warnings without downgrading a healthy line', () => {
    const status = serviceStatus({
      campaignStatus: 'ACTIVE',
      readiness: readinessOf([...healthy, { key: 'data_storage_setting', label: 'Storage', status: 'warn', code: 'data_storage_setting', detail: '', fixHref: null }], { ready: true }),
    });
    expect(status.state).toBe('answering');
    expect(status.detail).toContain('1 warning');
  });
});

describe('the deployment routes answer with envelopes, not rows', () => {
  it('unwraps `{ deployment }` from /deployments/latest and the bare row alike', () => {
    const row = { id: 'dep-1', status: 'VERIFIED', steps: [] };
    expect(unwrapDeployment({ deployment: row })?.status).toBe('VERIFIED');
    expect(unwrapDeployment(row)?.status).toBe('VERIFIED');
    expect(unwrapDeployment({ deployment: null })).toBeNull();
    expect(unwrapDeployment(null)).toBeNull();
  });

  it('normalises the missing toolsDiff the diff route never sends', () => {
    const diff = normalizeDeploymentDiff({ deployment: null, draft: {}, changed: ['prompt'], placeholders: [] });
    expect(diff.toolsDiff).toEqual({ added: [], removed: [], changed: [] });
    expect(diff.changed).toEqual(['prompt']);
  });
});

describe('the voice catalogue (E9)', () => {
  it('is empty from /catalog alone, and filled by the /voices section', () => {
    const catalog = normalizeCatalog({ languages: [{ id: 'en-US', label: 'English (US)' }], tones: [] });
    expect(catalog.voices).toHaveLength(0);
    expect(catalog.voicesUnavailable).toBeNull();

    const merged = mergeVoicesSection(catalog, {
      providerMode: 'mock', source: 'provider', error: null,
      voices: [{ voiceId: '11labs-Anna', name: 'Anna', provider: 'elevenlabs', gender: 'female', accent: 'American', previewUrl: null }],
    });
    expect(merged.voices.map(voice => voice.voiceId)).toEqual(['11labs-Anna']);
    expect(merged.providerMode).toBe('mock');
    expect(merged.voicesUnavailable).toBeNull();
  });

  it('states the provider’s reason rather than leaving the picker silently empty', () => {
    const merged = mergeVoicesSection(normalizeCatalog({}), { providerMode: 'live', voices: [], source: 'unavailable', error: 'provider_unavailable' });
    expect(merged.voicesUnavailable).toContain('provider_unavailable');

    const unconfigured = mergeVoicesSection(normalizeCatalog({}), { providerMode: 'unconfigured', voices: [], source: 'unavailable', error: null });
    expect(unconfigured.voicesUnavailable).toContain('not configured');
  });
});

describe('the kpi-v2 block (SF-2)', () => {
  const body = {
    counts: { inbound: 14, outbound: 3, answeredInbound: 0, booked: 0, escalated: 0, optedOut: 1, pendingRequests: 2, openHandoffs: 0, activeCampaigns: 0, clinics: 1 },
    rates: { bookingRate: null, containedPct: null, afterHoursPct: null, callbacksWithinSlaPct: null },
    aht: null,
    definitions: { bookingRate: 'Inbound BOOKED / answered inbound. Null when nothing was answered.' },
    // The legacy scalars Package D deletes. Reading them is what produced
    // "14% booking rate" and "0m 0s" as claims about receptionist capability.
    totalCalls: 7, bookingRate: 14, avgDurationSeconds: 0,
  };

  it('keeps an uncomputable rate null instead of collapsing it to zero', () => {
    const kpis = normalizeOverviewKpis(body)!;
    expect(kpis.rates.bookingRate).toBeNull();
    expect(kpis.aht).toBeNull();
    expect(kpis.counts.answeredInbound).toBe(0);
    expect(kpis.definitions.bookingRate).toContain('Null when nothing was answered');
  });

  it('renders an unknown value as an em dash and a real one as itself', () => {
    expect(formatRate(null)).toBe('—');
    expect(formatRate(0)).toBe('0%');
    expect(formatRate(0.42)).toBe('42%');
    expect(formatCount(null)).toBe('—');
    expect(formatCount(0)).toBe('0');
    expect(formatSeconds(null)).toBe('—');
    expect(formatSeconds(54)).toBe('0m 54s');
  });

  it('returns null for a body that carries no kpi-v2 block at all', () => {
    expect(normalizeOverviewKpis({ totalCalls: 7, bookingRate: 14 })).toBeNull();
    expect(normalizeOverviewKpis(null)).toBeNull();
  });
});
