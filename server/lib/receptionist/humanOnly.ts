// ===========================================================================
// "Human only" — the caller who must never be answered by the AI line.
//
// Some people must not meet a voice agent: cognitive impairment, a speech
// difference the line has already failed once, a previous bad experience, a
// safeguarding note. That is a clinical decision, taken by a named person and
// stored on the patient. It is emphatically NOT something the model may infer,
// because a flag a model can set is a flag a model can unset, and because the
// value of this one is that a human can be asked why it is there.
//
// It is honoured in two places, and it needs both:
//
//   · `call_inbound`, so the caller is routed to a person before the
//     receptionist takes a single turn; and
//   · `handleAgentTool`, so that if anything at all goes wrong with the first
//     — a stale prompt, a model that ignores its instructions, a provider that
//     never delivered the routing state — the receptionist still cannot DO
//     anything on this call. A prompt rule is a request. A tool gate is a
//     guarantee, and this flag is only worth having as a guarantee.
//
// The phone canonicalisation lives here once rather than in each caller,
// because two implementations of "is this the same number" is how a flag
// silently stops applying.
// ===========================================================================

import type { Prisma } from '../../generated/prisma/client';
import type { db as DbClient } from '../db';

type Client = typeof DbClient | Prisma.TransactionClient;

export interface CallerPatientMatch {
  firstName: string;
  humanOnly: boolean;
}

/**
 * Patients whose stored phone canonicalises to this E.164 number. At most two
 * are returned: one match names the caller, several mean we do not yet know
 * which member of the household is speaking.
 */
export async function patientsMatchingCallerPhone(
  client: Client,
  tenantId: string,
  canonicalPhone: string,
): Promise<CallerPatientMatch[]> {
  return client.$queryRaw<CallerPatientMatch[]>`
    SELECT "firstName", "humanOnly"
    FROM "Patient"
    WHERE "tenantId" = ${tenantId}::uuid
      AND "deletedAt" IS NULL
      AND "phone" IS NOT NULL
      AND CASE
        WHEN "phone" LIKE '+%' THEN '+' || regexp_replace("phone", '[^0-9]', '', 'g')
        WHEN length(regexp_replace("phone", '[^0-9]', '', 'g')) = 10 THEN '+1' || regexp_replace("phone", '[^0-9]', '', 'g')
        ELSE '+' || regexp_replace("phone", '[^0-9]', '', 'g')
      END = ${canonicalPhone}
    ORDER BY id
    LIMIT 2
  `;
}

/**
 * Does this set of matches mean the call must go to a person?
 *
 * ANY match, not the only match. Two people share a phone; if either of them
 * must never meet an AI line, this call does not meet one, because at the
 * moment the phone rings we cannot tell which of them is holding it. Erring
 * the other way means the flag fails exactly for the households where it is
 * most likely to matter.
 */
export function humanOnlyAmong(matches: CallerPatientMatch[]): boolean {
  return matches.some(match => match.humanOnly);
}

/**
 * The live-call gate: is the caller on THIS call marked Human only?
 *
 * Resolved from the linked patient first (identity was established), then from
 * the call's own caller number. A call we cannot resolve at all is not treated
 * as flagged — a false positive here would route every anonymous caller to a
 * front desk that may not answer, which is its own harm.
 */
export async function callIsHumanOnly(
  client: Client,
  input: { tenantId: string; callId: string | null | undefined },
): Promise<boolean> {
  if (!input.callId) return false;
  const call = await client.receptionistCallLog.findFirst({
    where: { tenantId: input.tenantId, retellCallId: input.callId },
    select: { callerPhone: true, patient: { select: { humanOnly: true } } },
  });
  if (!call) return false;
  if (call.patient?.humanOnly) return true;
  if (!call.callerPhone) return false;
  return humanOnlyAmong(await patientsMatchingCallerPhone(client, input.tenantId, call.callerPhone));
}

/**
 * The tools a Human-only call may still use.
 *
 * Getting the caller to a person, writing down what they need so it is not
 * lost, and an emergency — which outranks every flag on this list, because a
 * person having a stroke does not care what our routing table says.
 */
export const HUMAN_ONLY_PERMITTED_TOOLS: readonly string[] = [
  'request_human_handoff',
  'take_message',
  'report_emergency',
  'report_comprehension_failure',
];
