import { describe, expect, it } from 'vitest';

import {
  APPOINTMENT_DYNAMIC_VARIABLE_NAMES,
  buildAppointmentDynamicVariables,
} from '../lib/receptionist/appointmentContext';
import { RUNTIME_DYNAMIC_VARIABLES } from '../lib/receptionist/runtimeVariables';
import { LOCALE_PACK_MESSAGE_KEYS } from '../lib/receptionist/localePacks/types';
import { PLATFORM_LOCALE_PACKS } from '../lib/receptionist/localePacks/defaults';
import { renderPackMessage } from '../lib/receptionist/localePacks/render';
import type { LocaleFormat } from '../lib/receptionist/localePacks/types';

// ===========================================================================
// The appointment a reminder call is about, rendered for the person hearing it.
//
// The pilot's reminder campaign stated one clinician, day and time — written
// once into the campaign script — to everybody on the list. These variables are
// the replacement, so what matters is that they are the PATIENT's own values,
// in the BRANCH's timezone and the CALL's locale, and that an absent one is
// silence rather than something the agent could say.
// ===========================================================================

const US: LocaleFormat = { language: 'en-US', timeStyle: '12h', dateStyle: 'weekday-month-day' };
const GB: LocaleFormat = { language: 'en-GB', timeStyle: '24h', dateStyle: 'weekday-day-month' };

const APPOINTMENT = {
  id: '11111111-2222-4333-8444-555555555555',
  // 08:15 in New York, 13:15 in London, on two different calendar hours of the
  // same instant. Whichever the caller hears has to come from their branch.
  startsAt: new Date('2126-06-17T12:15:00.000Z'),
  service: 'Six-month check-up',
  timezone: 'America/New_York',
  locationName: 'Main branch',
  clinicianName: 'Dr Amara Osei',
};

describe('the appointment a call is about', () => {
  it('speaks the branch timezone and the call locale, not the server clock', () => {
    const us = buildAppointmentDynamicVariables({ appointment: APPOINTMENT, locale: US });
    expect(us.appointment_date).toBe('Monday, June 17');
    expect(us.appointment_time).toBe('8:15 AM');

    // The same instant, the same appointment, a London branch and a GB pack.
    const gb = buildAppointmentDynamicVariables({
      appointment: { ...APPOINTMENT, timezone: 'Europe/London' },
      locale: GB,
    });
    expect(gb.appointment_date).toBe('Monday 17 June');
    expect(gb.appointment_time).toBe('13:15');
  });

  it('carries the identity and the facts the agent may state, and nothing else', () => {
    const variables = buildAppointmentDynamicVariables({ appointment: APPOINTMENT, locale: US });
    expect(variables.appointment_id).toBe(APPOINTMENT.id);
    expect(variables.appointment_service).toBe('Six-month check-up');
    expect(variables.appointment_location).toBe('Main branch');
    expect(variables.appointment_clinician).toBe('Dr Amara Osei');
    expect(Object.keys(variables).sort()).toEqual([...APPOINTMENT_DYNAMIC_VARIABLE_NAMES].sort());
  });

  it('sends an unrecorded clinician as silence, never as a stand-in', () => {
    const variables = buildAppointmentDynamicVariables({
      appointment: { ...APPOINTMENT, clinicianName: null },
      locale: US,
    });
    expect(variables.appointment_clinician).toBe('');
    // The rest of the appointment is still true and still spoken.
    expect(variables.appointment_service).toBe('Six-month check-up');
  });

  it('sends every key empty when no appointment is bound', () => {
    const variables = buildAppointmentDynamicVariables({ appointment: null, locale: US });
    for (const name of APPOINTMENT_DYNAMIC_VARIABLE_NAMES) {
      // Present-and-empty, so the provider substitutes nothing. A MISSING key
      // leaves the literal token in the prompt for the agent to read aloud.
      expect(variables, name).toHaveProperty(name);
      expect(variables[name], name).toBe('');
    }
    // And not one of them is a sentence: no "your appointment", no "soon".
    expect(Object.values(variables).join('')).toBe('');
  });

  it('is declared as a runtime variable, so a prompt may reference it', () => {
    const runtime = RUNTIME_DYNAMIC_VARIABLES.map(item => item.name);
    for (const name of APPOINTMENT_DYNAMIC_VARIABLE_NAMES) {
      // Not merely tidiness: `containsProviderTemplateSyntax` rejects a
      // deployed prompt containing any {{token}} outside this list.
      expect(runtime, name).toContain(name);
      expect(RUNTIME_DYNAMIC_VARIABLES.find(item => item.name === name)?.default, name).toBe('');
    }
  });

  it('renders the caller-facing reminder from the pack, in both shipped locales', () => {
    // The words belong to the clinic's pack; only the holes come from here.
    expect(LOCALE_PACK_MESSAGE_KEYS['reminder.appointment.line'].mustContain)
      .toEqual(['appointment_date', 'appointment_time']);
    for (const pack of PLATFORM_LOCALE_PACKS) {
      const variables = buildAppointmentDynamicVariables({
        appointment: APPOINTMENT,
        locale: { language: pack.language, timeStyle: pack.strings.timeStyle, dateStyle: pack.strings.dateStyle },
      });
      const line = renderPackMessage(pack.strings, 'reminder.appointment.line', variables);
      expect(line, pack.language).toContain(variables.appointment_date);
      expect(line, pack.language).toContain(variables.appointment_time);
      expect(line, pack.language).not.toContain('{{');
      const clinician = renderPackMessage(pack.strings, 'reminder.appointment.clinician', variables);
      expect(clinician, pack.language).toContain('Dr Amara Osei');
    }
  });
});
