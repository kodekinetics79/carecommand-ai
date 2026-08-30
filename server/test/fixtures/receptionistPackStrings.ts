import { PLATFORM_LOCALE_PACKS } from '../../lib/receptionist/localePacks/defaults';
import { renderPackMessage } from '../../lib/receptionist/localePacks/render';

// Rendered platform-default wording, so a suite asserts what the pack actually
// says rather than a hard-coded "911" that only holds for one country.

function pack(language: 'en-US' | 'en-GB') {
  const found = PLATFORM_LOCALE_PACKS.find(item => item.language === language);
  if (!found) throw new Error(`No platform locale pack for ${language}`);
  return found;
}

function rendered(language: 'en-US' | 'en-GB') {
  const strings = pack(language).strings;
  return {
    strings,
    emergencyNumber: strings.emergencyNumber,
    emergencyInstruction: renderPackMessage(strings, 'emergency.instruction', { emergency_number: strings.emergencyNumber }),
    toolEmergencyMessage: renderPackMessage(strings, 'tool.emergency.message', { emergency_number: strings.emergencyNumber }),
    dncAcknowledge: renderPackMessage(strings, 'dnc.acknowledge'),
    dncConfirmed: renderPackMessage(strings, 'dnc.confirmed'),
    dncFailed: renderPackMessage(strings, 'dnc.failed'),
    notInterested: renderPackMessage(strings, 'not_interested.line'),
    humanFallback: renderPackMessage(strings, 'human_fallback.line'),
  };
}

export const EN_US = rendered('en-US');
export const EN_GB = rendered('en-GB');
