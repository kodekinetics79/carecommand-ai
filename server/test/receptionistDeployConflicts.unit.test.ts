import 'dotenv/config';
import { describe, expect, it } from 'vitest';
import { Prisma } from '../generated/prisma/client';
import {
  INBOUND_DESTINATION_CONFLICT_MESSAGE,
  PROVIDER_DEPLOYMENT_CONFLICT_MESSAGE,
  isActiveCampaignDeploymentConflict,
  isClinicNameConflict,
  isInboundDestinationConflict,
  isProviderDeploymentConflict,
  isReceptionistDestinationConflict,
} from '../modules/receptionist/shared';
import { mockPhoneNumberBinding } from '../lib/receptionist/retellMock';
import { clinicInboundNumber } from '../lib/receptionist/retellDeploy';

// ===========================================================================
// Which unique constraint actually bit, and what to say about it.
//
// The predicate these replace answered true for ANY P2002, and four call sites
// each turned that into their own confident sentence. So a duplicate clinic
// name, a duplicate call target, a duplicate notification key — anything at all
// — reached the operator as "This active provider deployment is already
// assigned to another agent": a message about something they had not touched,
// pointing at a screen that could not fix it.
// ===========================================================================

function p2002(target: string | string[]): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002', clientVersion: 'test', meta: { target },
  });
}

describe('unique-constraint classification', () => {
  it('names the provider-deployment index and nothing else', () => {
    const error = p2002('ReceptionistAgent_active_provider_deployment_unique');
    expect(isProviderDeploymentConflict(error)).toBe(true);
    expect(isInboundDestinationConflict(error)).toBe(false);
    expect(isActiveCampaignDeploymentConflict(error)).toBe(false);
    expect(isClinicNameConflict(error)).toBe(false);
  });

  it('accepts the field-list spelling Prisma uses for modelled indexes', () => {
    expect(isProviderDeploymentConflict(p2002(['providerAgentId', 'providerVersion']))).toBe(true);
    expect(isClinicNameConflict(p2002(['tenantId', 'name']))).toBe(true);
  });

  it('separates the two ways one clinic can collide', () => {
    expect(isInboundDestinationConflict(p2002('ReceptionistClinic_active_phone_unique'))).toBe(true);
    expect(isInboundDestinationConflict(p2002('ReceptionistClinic_active_inbound_number_unique'))).toBe(true);
    expect(isClinicNameConflict(p2002('ReceptionistClinic_tenantId_name_key'))).toBe(true);
    expect(isInboundDestinationConflict(p2002('ReceptionistClinic_tenantId_name_key'))).toBe(false);
  });

  it('claims nothing about a constraint it does not recognise', () => {
    // The regression in one assertion: an unrelated duplicate anywhere in the
    // verify or clinic path must not be reported as a destination conflict. It
    // has to surface as a real 500 with a real stack, because nobody has
    // written the sentence that would help.
    const unrelated = p2002('NotificationEvent_tenantId_source_idempotencyKey_key');
    expect(isProviderDeploymentConflict(unrelated)).toBe(false);
    expect(isInboundDestinationConflict(unrelated)).toBe(false);
    expect(isActiveCampaignDeploymentConflict(unrelated)).toBe(false);
    expect(isClinicNameConflict(unrelated)).toBe(false);
    expect(isReceptionistDestinationConflict(unrelated)).toBe(false);
  });

  it('ignores errors that are not unique violations at all', () => {
    const notFound = new Prisma.PrismaClientKnownRequestError('No record', { code: 'P2025', clientVersion: 'test' });
    expect(isReceptionistDestinationConflict(notFound)).toBe(false);
    expect(isReceptionistDestinationConflict(new Error('boom'))).toBe(false);
    expect(isReceptionistDestinationConflict(null)).toBe(false);
  });

  it('tells the operator what the cross-tenant index actually means', () => {
    // The index is global on purpose — sharing a live provider version would
    // share its webhook blast radius — so the conflicting row is often one this
    // tenant cannot see. Naming "another agent" sends them hunting for a row
    // that does not exist for them.
    expect(PROVIDER_DEPLOYMENT_CONFLICT_MESSAGE).toMatch(/another CareCommand configuration/i);
    expect(PROVIDER_DEPLOYMENT_CONFLICT_MESSAGE).toMatch(/outside this tenant/i);
    expect(PROVIDER_DEPLOYMENT_CONFLICT_MESSAGE).toMatch(/publish to the line/i);
    expect(INBOUND_DESTINATION_CONFLICT_MESSAGE).toMatch(/one number answers for one clinic/i);
  });
});

describe('which line a clinic answers on', () => {
  it('prefers the assigned inbound line over the advertised number', () => {
    expect(clinicInboundNumber({ inboundNumber: '+15550111111', phone: '+15550122222' })).toBe('+15550111111');
  });

  it('falls back to the clinic’s own published number, never to a shared default', () => {
    expect(clinicInboundNumber({ inboundNumber: null, phone: '+15550122222' })).toBe('+15550122222');
    expect(clinicInboundNumber({ inboundNumber: '   ', phone: '+15550122222' })).toBe('+15550122222');
  });

  it('has nothing to bind when the clinic has no number at all', () => {
    expect(clinicInboundNumber({ inboundNumber: null, phone: '' })).toBeNull();
  });
});

describe('the mock provider answers the binding question honestly', () => {
  const deployed = { boundPhoneNumber: '+15550100001', numberBound: true, providerAgentId: 'mock_agent_1', providerAgentVersion: 2 };

  it('reports the deployment that actually bound the number', () => {
    const answer = mockPhoneNumberBinding('+15550100001', deployed);
    expect(answer).toMatchObject({ ok: true, mock: true, value: { inboundAgentId: 'mock_agent_1', inboundAgentVersion: 2 } });
  });

  it('reports nothing bound when the bind step never succeeded', () => {
    const answer = mockPhoneNumberBinding('+15550100001', { ...deployed, numberBound: false });
    expect(answer).toMatchObject({ ok: true, value: { inboundAgentId: null, inboundAgentVersion: null } });
  });

  it('refuses to answer for a number this deployment never targeted', () => {
    // A mock that answered "yes, that is mine" for any number asked would put
    // the demo straight back to certifying a binding nobody made.
    const answer = mockPhoneNumberBinding('+15550100999', deployed);
    expect(answer).toMatchObject({ ok: true, value: { inboundAgentId: null } });
  });

  it('reports nothing bound when there is no deployment evidence at all', () => {
    expect(mockPhoneNumberBinding('+15550100001', null)).toMatchObject({ ok: true, value: { inboundAgentId: null } });
  });
});
