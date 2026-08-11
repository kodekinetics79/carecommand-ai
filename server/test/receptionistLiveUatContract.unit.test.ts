import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const outboundSource = readFileSync('server/modules/receptionist/outbound.ts', 'utf8');
const liveUatSource = readFileSync('server/lib/receptionist/liveCallUat.ts', 'utf8');
const retellSource = readFileSync('server/lib/retell.ts', 'utf8');
const studioSource = readFileSync('src/pages/ReceptionistStudio.tsx', 'utf8');
const apiSource = readFileSync('src/lib/receptionist.ts', 'utf8');
const playwrightSource = readFileSync('playwright.config.ts', 'utf8');
const liveE2eSource = readFileSync('tests/e2e/receptionist-live-uat.spec.ts', 'utf8');
const packageSource = readFileSync('package.json', 'utf8');

describe('live AI receptionist UAT production contract', () => {
  it('fences the provider boundary with exact runtime authorization and run-level admission controls', () => {
    expect(outboundSource).toContain('authorizeLiveCallDestination');
    expect(outboundSource).toContain('evaluateLiveCallAdmission');
    expect(liveUatSource).toContain('live_test_destination_not_allowlisted');
    expect(outboundSource).toContain('live_test_single_active_call');
    expect(outboundSource).toContain('live_test_call_cap_reached');
    expect(outboundSource).toContain('live_test_minute_cap_reached');
    expect(outboundSource).toContain('live_test_cost_cap_reached');
    expect(outboundSource).toContain('maxCallDurationMs: liveTest.maxCallMinutes * 60_000');
  });

  it('creates the synthetic recipient from server-held environment authorization rather than browser-supplied phone data', () => {
    expect(outboundSource).toContain("app.post('/outbound-campaigns/:id/live-test-target'");
    expect(outboundSource).toContain('liveCallUatDestination(request.auth.tenantId)');
    expect(liveUatSource).toContain('live_test_tenant_not_authorized');
    expect(outboundSource).toContain('acknowledgeAuthorizedSyntheticRecipient');
    expect(studioSource).toContain('Attach authorized synthetic recipient');
    expect(studioSource).toContain('the browser cannot supply or change the number');
    expect(apiSource).toContain('attachLiveTestTarget');
    expect(apiSource).not.toContain('attachLiveTestTarget: (campaignId: string, body: { phone:');
  });

  it('supports privacy-safe provider polling without exposing transcripts, recordings, or raw destination data', () => {
    expect(retellSource).toContain('/v2/get-call/');
    expect(retellSource).toContain('retell_call_id_mismatch');
    expect(retellSource).not.toContain('transcript: body.transcript');
    expect(retellSource).not.toContain('recordingUrl: body.recording_url');
    expect(outboundSource).toContain("call-logs/:id/provider-sync");
    expect(outboundSource).toContain('providerCallIdMasked');
    expect(outboundSource).toContain('destinationMasked');
    expect(studioSource).toContain('Refresh provider status');
  });

  it('provides an explicit installed-Google-Chrome headed acceptance project and a one-call live harness', () => {
    expect(playwrightSource).toContain("E2E_USE_INSTALLED_CHROME === 'true'");
    expect(playwrightSource).toContain("channel: 'chrome'");
    expect(playwrightSource).toContain("E2E_HEADLESS !== 'true'");
    expect(playwrightSource).toContain("name: 'desktop-installed-chrome'");
    expect(playwrightSource).toContain("name: 'mobile-installed-chrome'");
    expect(packageSource).toContain('test:e2e:live-voice');
    expect(liveE2eSource).toContain("testInfo.project.name !== 'desktop-installed-chrome'");
    expect(liveE2eSource).toContain('LIVE_TEST_MAX_CALLS=1');
    expect(liveE2eSource).toContain('Attach authorized synthetic recipient');
    expect(liveE2eSource).toContain('Refresh provider status');
    expect(liveE2eSource).toContain('AUTHORIZED_TEST_PHONE_E164');
  });

  it('refreshes candidate authority after a server-held synthetic target is attached and masks provider ids at the API boundary', () => {
    expect(studioSource).toContain('[campaign.id, targetIdentityKey]');
    expect(outboundSource).toContain('retellCallId: maskProviderId(row.retellCallId)');
  });
});
