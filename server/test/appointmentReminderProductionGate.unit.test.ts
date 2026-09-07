import 'dotenv/config';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchSpy = vi.spyOn(globalThis, 'fetch');
const { env } = await import('../config/env');
const { __setProviderSnapshotForTests } = await import('../lib/providerCredentials');
const { sendAuthorizedAppointmentConfirmation } = await import('../lib/commsProvider');

const originalNodeEnv = env.NODE_ENV;

describe('appointment reminder provider gate', () => {
  beforeEach(() => {
    fetchSpy.mockClear();
    __setProviderSnapshotForTests({ sms: {
      accountSid: 'mock_appointment_reminders', authToken: 'mock-token', fromNumber: '+15550000000',
    } });
  });

  afterEach(() => {
    env.NODE_ENV = originalNodeEnv;
    __setProviderSnapshotForTests({});
  });

  it('rejects a production reminder before durable claim or provider I/O', async () => {
    env.NODE_ENV = 'production';
    await expect(sendAuthorizedAppointmentConfirmation(
      'sms', '+12125550111', 'Appointment reminder', 'Synthetic reminder', 'synthetic-key',
      { tenantId: '00000000-0000-4000-8000-000000000001', eventId: '00000000-0000-4000-8000-000000000002', attemptNumber: 1, source: 'appointment.reminder' },
    )).resolves.toMatchObject({
      status: 'setup_required', mode: 'setup_required',
      failureReason: 'appointment_reminder_real_egress_not_activated',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects real provider credentials outside production too', async () => {
    env.NODE_ENV = 'test';
    __setProviderSnapshotForTests({ sms: {
      accountSid: 'AC-real-provider', authToken: 'real-token', fromNumber: '+15550000000',
    } });
    await expect(sendAuthorizedAppointmentConfirmation(
      'sms', '+12125550111', 'Appointment reminder', 'Synthetic reminder', 'synthetic-key',
      { tenantId: '00000000-0000-4000-8000-000000000001', eventId: '00000000-0000-4000-8000-000000000002', attemptNumber: 1, source: 'appointment.reminder' },
    )).resolves.toMatchObject({ status: 'setup_required', mode: 'setup_required' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
