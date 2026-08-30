import { describe, expect, it } from 'vitest';
import {
  CRITICAL_PREVIEW_LIMIT, KPI_UNAVAILABLE,
  criticalSignal, formatKpiCount, formatKpiDuration, formatKpiRate,
  normalizeTaskRow, openCountOf, receptionistViewFromMetadata, summarizeNeedsAction,
  type TaskSummary,
} from './frontDesk';

/**
 * These are the derivations every front-desk surface shares, so a defect here
 * is a defect on the sidebar badge, the emergency banner, the header count and
 * the shift report at the same time. Each case below is one of the day-2
 * defects, pinned so it cannot come back.
 */

function summary(overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    openByKind: { message: 2, emergency: 1 },
    overdue: 4,
    unacknowledgedCritical: [],
    mine: 1,
    dueWithin30m: 0,
    generatedAt: '2026-08-30T10:00:00.000Z',
    ...overrides,
  };
}

function criticalRow(id: string, extra: Record<string, unknown> = {}) {
  return { id, title: `Emergency ${id}`, createdAt: '2026-08-30T09:00:00.000Z', clinicName: 'Brightsmile', ...extra };
}

describe('criticalSignal — D7, the capped count', () => {
  it('uses the server count, not the length of the capped preview', () => {
    const signal = criticalSignal(summary({
      unacknowledgedCritical: [1, 2, 3, 4, 5].map(index => criticalRow(`c${index}`, { workflow: 'receptionist_safety' })),
      unacknowledgedCriticalCount: 9,
    }));
    expect(signal.count).toBe(9);
    expect(signal.exact).toBe(true);
    expect(signal.rows).toHaveLength(CRITICAL_PREVIEW_LIMIT);
    expect(signal.hidden).toBe(4);
  });

  it('reports a full preview with no count as a FLOOR, never as the total', () => {
    const signal = criticalSignal(summary({
      unacknowledgedCritical: [1, 2, 3, 4, 5].map(index => criticalRow(`c${index}`)),
    }));
    expect(signal.count).toBe(5);
    expect(signal.exact).toBe(false);
  });

  it('is exact when the preview came back below the cap', () => {
    const signal = criticalSignal(summary({ unacknowledgedCritical: [criticalRow('c1'), criticalRow('c2')] }));
    expect(signal).toMatchObject({ count: 2, exact: true, hidden: 0 });
  });

  it('reports nothing at all when the summary never loaded', () => {
    expect(criticalSignal(null)).toMatchObject({ count: 0, rows: [] });
  });
});

describe('criticalSignal — D8, what may be called an emergency', () => {
  it('drops a critical task that belongs to another workflow', () => {
    const signal = criticalSignal(summary({
      unacknowledgedCritical: [
        criticalRow('c1', { workflow: 'receptionist_safety', kind: 'emergency' }),
        criticalRow('c2', { workflow: 'insurance_reconciliation' }),
      ],
      unacknowledgedCriticalCount: 2,
    }));
    expect(signal.rows.map(row => row.id)).toEqual(['c1']);
    // The count comes down with the row: an ops task is not one of the nine.
    expect(signal.count).toBe(1);
  });

  it('keeps a row that declares no workflow — an unlabelled row may be an emergency', () => {
    const signal = criticalSignal(summary({ unacknowledgedCritical: [criticalRow('c1')], unacknowledgedCriticalCount: 1 }));
    expect(signal.rows.map(row => row.id)).toEqual(['c1']);
  });

  it('never announces a deployment-attention task as a clinical emergency', () => {
    const signal = criticalSignal(summary({
      unacknowledgedCritical: [criticalRow('c1', { workflow: 'receptionist_safety', kind: 'deployment_attention' })],
      unacknowledgedCriticalCount: 1,
    }));
    expect(signal.rows).toHaveLength(0);
  });
});

describe('summarizeNeedsAction', () => {
  it('prefers the server total over summing the kind buckets', () => {
    expect(summarizeNeedsAction(summary({ openNeedsAction: 17 })).count).toBe(17);
  });

  it('falls back to the kind buckets when the server sends no total', () => {
    expect(summarizeNeedsAction(summary()).count).toBe(3);
  });

  it('carries the exactness of the critical count so a badge can say "5+"', () => {
    const result = summarizeNeedsAction(summary({
      unacknowledgedCritical: [1, 2, 3, 4, 5].map(index => criticalRow(`c${index}`)),
    }));
    expect(result).toMatchObject({ critical: 5, criticalExact: false });
  });
});

describe('openCountOf', () => {
  it('sums the kinds a lane shows', () => {
    expect(openCountOf(summary(), ['message', 'emergency'])).toBe(3);
  });

  it('is null — not zero — when no summary was read', () => {
    expect(openCountOf(null, ['message'])).toBeNull();
  });
});

describe('deployment-attention tasks — D9, the task the board could not show', () => {
  const remediation = {
    code: 'number_bound',
    title: 'The phone number is not bound to this agent',
    action: 'Re-deploy the campaign.',
    fixHref: '/receptionist-studio?tab=deploy',
  };

  it('reads the pre-D shape: its own workflow, no kind', () => {
    const view = receptionistViewFromMetadata({ workflow: 'receptionist_deployment', clinicId: 'clinic-1', ...remediation }, '2026-08-30T09:00:00.000Z');
    expect(view).toMatchObject({ kind: 'deployment_attention', requiresAcknowledgement: true, remediation, clinicId: 'clinic-1' });
  });

  it('reads the post-D shape: the safety workflow carrying the new kind', () => {
    const view = receptionistViewFromMetadata({ workflow: 'receptionist_safety', kind: 'deployment_attention', ...remediation }, undefined);
    expect(view).toMatchObject({ kind: 'deployment_attention', remediation });
  });

  it('invents no remediation when the task carries none', () => {
    const view = receptionistViewFromMetadata({ workflow: 'receptionist_deployment' }, undefined);
    expect(view).toMatchObject({ kind: 'deployment_attention', remediation: null });
  });

  it('still ignores a task from an unrelated workflow', () => {
    expect(receptionistViewFromMetadata({ workflow: 'insurance_reconciliation', title: 'x' }, undefined)).toBeNull();
  });

  it('surfaces through normalizeTaskRow, which is what every lane reads', () => {
    const row = normalizeTaskRow({
      id: 't1', title: 'AI receptionist deployment needs attention', priority: 'HIGH', status: 'OPEN',
      metadata: { workflow: 'receptionist_deployment', ...remediation },
    });
    expect(row.receptionist).toMatchObject({ kind: 'deployment_attention' });
  });

  it('leaves a caller task with no remediation block', () => {
    const view = receptionistViewFromMetadata({ workflow: 'receptionist_safety', kind: 'message', message: 'call me' }, '2026-08-30T09:00:00.000Z');
    expect(view).toMatchObject({ kind: 'message', remediation: null });
  });
});

describe('kpi-v2 presentation — never a fabricated zero', () => {
  it('renders a rate as a percentage', () => {
    expect(formatKpiRate(0.3333)).toBe('33%');
    expect(formatKpiRate(0)).toBe('0%');
  });

  it('renders a rate with no denominator as UNAVAILABLE, not 0%', () => {
    expect(formatKpiRate(null)).toBe(KPI_UNAVAILABLE);
    expect(formatKpiRate(undefined)).toBe(KPI_UNAVAILABLE);
  });

  it('renders an unknown average duration as UNAVAILABLE, not 0m 00s', () => {
    expect(formatKpiDuration(null)).toBe(KPI_UNAVAILABLE);
    expect(formatKpiDuration(0)).toBe(KPI_UNAVAILABLE);
    expect(formatKpiDuration(74)).toBe('1m 14s');
  });

  it('keeps a genuine zero COUNT, because zero calls is an answer', () => {
    expect(formatKpiCount(0)).toBe('0');
    expect(formatKpiCount(null)).toBe(KPI_UNAVAILABLE);
  });
});
