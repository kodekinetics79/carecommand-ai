import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  callFindFirst: vi.fn(),
}));

vi.mock('../lib/db', () => ({
  db: {
    receptionistCallLog: { findFirst: mocks.callFindFirst },
    idempotencyKey: { findUnique: vi.fn() },
    patient: { findFirst: vi.fn() },
    receptionistCampaign: { findFirst: vi.fn() },
    receptionistIntakeField: { findMany: vi.fn() },
    receptionistCallTarget: { findFirst: vi.fn() },
    appointmentRequest: { findFirst: vi.fn() },
    $transaction: vi.fn(),
  },
}));

import { submitConversationalForm } from '../lib/receptionist/conversationalForms';

const BASE_CONTEXT = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  callId: 'call_123',
  callerPhone: '+15714305555',
  providerInvocationId: 'invocation-1',
};

describe('conversational forms fail-closed boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('refuses a form that is not bound to the exact provider call', async () => {
    const result = await submitConversationalForm(
      { ...BASE_CONTEXT, callId: null },
      { answers: { first_name: 'Test' } },
    );

    expect(result).toMatchObject({ saved: false, submitted: false, needs_review: true });
    expect(mocks.callFindFirst).not.toHaveBeenCalled();
  });

  it('refuses a form without one provider invocation id for idempotency', async () => {
    const result = await submitConversationalForm(
      { ...BASE_CONTEXT, providerInvocationId: undefined },
      { answers: { first_name: 'Test' } },
    );

    expect(result).toMatchObject({ saved: false, submitted: false, needs_review: true });
    expect(mocks.callFindFirst).not.toHaveBeenCalled();
  });

  it('rejects malformed answers before touching patient records', async () => {
    const result = await submitConversationalForm(BASE_CONTEXT, {
      answers_json: '{not-valid-json',
    });

    expect(result).toMatchObject({
      saved: false,
      submitted: false,
      invalid_fields: ['form_payload'],
    });
    expect(mocks.callFindFirst).not.toHaveBeenCalled();
  });

  it('rejects an oversized answers payload before touching patient records', async () => {
    const result = await submitConversationalForm(BASE_CONTEXT, {
      answers_json: JSON.stringify({ notes: 'x'.repeat(20_000) }),
    });

    expect(result).toMatchObject({
      saved: false,
      submitted: false,
      invalid_fields: ['form_payload'],
    });
    expect(mocks.callFindFirst).not.toHaveBeenCalled();
  });

  it('refuses an unknown or ended call rather than creating an unbound form', async () => {
    mocks.callFindFirst.mockResolvedValueOnce(null);
    const result = await submitConversationalForm(BASE_CONTEXT, {
      answers: { first_name: 'Test' },
      finalize: true,
    });

    expect(result).toMatchObject({ saved: false, submitted: false, needs_review: true });
    expect(mocks.callFindFirst).toHaveBeenCalledTimes(1);
  });

  it('requires the opening disclosure/recording consent before form PHI can be processed', async () => {
    mocks.callFindFirst.mockResolvedValueOnce({
      id: '00000000-0000-4000-8000-000000000101',
      campaignId: '00000000-0000-4000-8000-000000000201',
      targetId: null,
      patientId: null,
      clinicId: '00000000-0000-4000-8000-000000000301',
      recordingConsentStatus: 'DECLINED',
      startedAt: new Date(),
      createdAt: new Date(),
      endedAt: null,
    });

    const result = await submitConversationalForm(BASE_CONTEXT, {
      answers: { first_name: 'Test' },
      finalize: true,
    });

    expect(result).toMatchObject({ saved: false, submitted: false, needs_review: true });
  });
});
