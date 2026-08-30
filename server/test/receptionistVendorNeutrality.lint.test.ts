import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

// ===========================================================================
// A tenant sees CareCommand, not our suppliers.
//
// `src/` is the browser bundle. Everything in it is, sooner or later, on a
// clinic's screen — as copy, as a field name in a network response, as a tab
// id in the address bar, or as a string in shipped JavaScript. Before this
// ratchet it contained 200 mentions of one voice supplier, 33 of a speech
// vendor, and named identifiers down to agent ids and dynamic-variable tags,
// across 33 tenant-facing files.
//
// Two reasons that is a defect and not a matter of taste:
//
//   · commercially, a clinic that can read the stack off its own screen can
//     price us against going direct;
//   · operationally, none of it is actionable by the reader. A clinic owner
//     cannot open a supplier's console, rotate a supplier's key, or assign a
//     version tag. Printing those instructions turned a support ticket into a
//     dead end with our supplier's name on it.
//
// This is the same shape as `receptionistPackStrings.lint.test.ts` and for the
// same reason: without a ONE-WAY ratchet it silently regresses. That is
// precisely how the hardcoded caller strings reached 51.
//
//   · a banned word in `src/` outside the allowlist fails the suite;
//   · the allowlist is a CEILING, asserted below — entries may be deleted,
//     never added;
//   · a line that genuinely must keep a vendor token carries an inline
//     `vendor-neutral-exempt` marker, and the NUMBER of those may only fall.
//
// WHAT MAY KEEP A VENDOR NAME (and therefore is not scanned here at all):
// `server/` — audit copy, log lines, provider adapters, webhook routes and
// migration comments. Compliance evidence has to stay precise, and a log line
// that will not say which API returned a 429 is a worse log line. The rule is
// about what a TENANT reads, and the tenant reads `src/`.
// ===========================================================================

const SRC = resolve(process.cwd(), 'src');

/**
 * Vendor names. Lower-cased comparison, so `RetellAI`, `Retell` and
 * `retell_call_id` all match the same entry.
 */
const VENDOR_WORDS = ['retell', 'retellai', 'twilio', '11labs', 'elevenlabs', 'stedi', 'sendgrid'] as const;

/**
 * Provider identifier SHAPES. A file can be scrubbed of vendor names and still
 * hand a clinic the supplier's data model — `RETELL_API_KEY` was caught by the
 * word list, but `agent_9f2c…` and a raw `llm_…` id would not be.
 */
// Hex suffixes only, and at least 12 of them. `agent_unlinked`,
// `agent_verified` and `call_analyzed` are OUR words — readiness keys and
// webhook event names — and a pattern that flags them is a pattern people
// learn to ignore.
const IDENTIFIER_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'provider agent id', pattern: /\bagent_[a-f0-9]{12,}\b/gi },
  { name: 'provider response-engine id', pattern: /\bllm_[a-f0-9]{12,}\b/gi },
  { name: 'provider call id', pattern: /\bcall_[a-f0-9]{12,}\b/gi },
  { name: 'provider credential env var', pattern: /\b[A-Z][A-Z0-9]{2,}_(?:API_KEY|AUTH_TOKEN|ACCOUNT_SID|FROM_NUMBER)\b/g },
];

/**
 * Files that may name a vendor, each with the reason it may.
 *
 * This list is a ceiling. It shrinks when a surface stops being an exception —
 * the eligibility rows go when eligibility becomes CareCommand-supplied the way
 * the voice line is, and the exemption markers go as the last identifiers move
 * behind the platform boundary. Nothing is added without deleting something.
 */
const ALLOWLIST: Record<string, string> = {
  // --- Platform-only surfaces ---------------------------------------------
  // Rendered behind the platform JWT, which a tenant token cannot mint. This is
  // where the mechanics the tenant no longer receives are supposed to land.
  'src/pages/PlatformConsole.tsx':
    'Platform Console. Operators must see supplier identities, credential field names and raw provider payloads — that is the point of moving them here.',

  // --- Services the CLINIC contracts and configures itself -----------------
  //
  // 2026-08-30: this section is EMPTY, and that is the point of the ratchet.
  //
  // Four screens lived here on the argument that the clinic holds the account
  // and therefore has to be told which one: the clearinghouse selector on
  // Insurance, the provider strip on InsuranceEligibility, the credential
  // fields on IntegrationSetup, and the Mock Mode explainer on
  // RevenueProtection. The argument does not survive contact with a practice
  // manager. None of them holds a clearinghouse contract, none can rotate a
  // card-processor key, and every one of those screens ended in a support
  // ticket with a supplier's name on it.
  //
  // All four now state a CAPABILITY and name us as the next step —
  // "Card payments: not set up. Contact CareCommand support to switch it on."
  // IntegrationSetup was deleted outright; the catalogue, the credential
  // fields and the health checks are Platform Console surfaces.
};

/** Lines that keep a vendor token for a stated, structural reason. */
const EXEMPT_MARKER = 'vendor-neutral-exempt';

/**
 * The exemption ceiling. Same ratchet discipline as the allowlist: this number
 * may fall and may never rise.
 */
const MAX_EXEMPT_LINES = 2;

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, found);
      continue;
    }
    if (/\.(ts|tsx|css|html|json)$/.test(entry)) found.push(full);
  }
  return found;
}

interface Offence { file: string; line: number; text: string; reason: string }

function scan(file: string): { offences: Offence[]; exempt: number } {
  const relativePath = relative(process.cwd(), file).split(sep).join('/');
  const offences: Offence[] = [];
  let exempt = 0;
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, index) => {
    if (line.includes(EXEMPT_MARKER)) { exempt += 1; return; }
    const lowered = line.toLowerCase();
    for (const word of VENDOR_WORDS) {
      if (lowered.includes(word)) {
        offences.push({ file: relativePath, line: index + 1, text: line.trim().slice(0, 140), reason: `vendor name "${word}"` });
        return;
      }
    }
    for (const { name, pattern } of IDENTIFIER_PATTERNS) {
      pattern.lastIndex = 0;
      if (pattern.test(line)) {
        offences.push({ file: relativePath, line: index + 1, text: line.trim().slice(0, 140), reason: name });
        return;
      }
    }
  });
  return { offences, exempt };
}

describe('the tenant sees CareCommand, not our suppliers', () => {
  it('scans a real tree', () => {
    const files = sourceFiles(SRC);
    expect(files.length, 'src/ produced no scannable files — the walker is broken, not the tree').toBeGreaterThan(100);
  });

  it('fails when a vendor name or a provider identifier reaches src/', () => {
    const offences: Offence[] = [];
    for (const file of sourceFiles(SRC)) {
      const relativePath = relative(process.cwd(), file).split(sep).join('/');
      if (ALLOWLIST[relativePath]) continue;
      offences.push(...scan(file).offences);
    }
    expect(offences, [
      'A supplier reached a tenant-facing file.',
      '',
      'The tenant vocabulary lives in ONE place — src/lib/receptionistVocabulary.ts.',
      'Import from it rather than writing a new word for the same thing.',
      '',
      'If the remediation genuinely requires action inside a supplier console,',
      'the tenant is NOT told a vaguer version of it. Put the precise',
      'instruction on the catalogue entry\'s `platformAction` in',
      'server/lib/receptionist/remediation.ts, and let the tenant read the',
      'support hand-off plus a Configuration reference.',
      '',
      'Offences:',
      ...offences.map(row => `  ${row.file}:${row.line}  (${row.reason})  ${row.text}`),
    ].join('\n')).toEqual([]);
  });

  it('keeps the allowlist a ceiling, never a target', () => {
    // Every entry states WHY, so removing one is a decision somebody can make
    // from the list itself rather than by re-deriving the argument.
    for (const [file, reason] of Object.entries(ALLOWLIST)) {
      expect(reason.length, `${file} is allowlisted without a reason`).toBeGreaterThan(40);
      expect(sourceFiles(SRC).map(f => relative(process.cwd(), f).split(sep).join('/')), `${file} is allowlisted but does not exist — delete the entry`).toContain(file);
    }
    expect(Object.keys(ALLOWLIST).length, 'the vendor-neutrality allowlist grew').toBeLessThanOrEqual(1);
  });

  it('keeps inline exemptions a ceiling too', () => {
    const exempt = sourceFiles(SRC).reduce((total, file) => total + scan(file).exempt, 0);
    expect(exempt, `${EXEMPT_MARKER} markers grew — a new supplier token was written into src/`).toBeLessThanOrEqual(MAX_EXEMPT_LINES);
  });

  it('reports how much supplier surface is still allowlisted', () => {
    // Not an assertion about a number, but the number itself, printed where a
    // reviewer sees it — the point of the allowlist is that it reaches zero.
    const rows = Object.keys(ALLOWLIST).map(file => {
      const { offences } = scan(resolve(process.cwd(), file));
      return `${file.split('/').pop()} ${offences.length}`;
    });
    console.log('[vendor-neutrality] allowlisted mentions remaining:', rows.join(' · '));
    expect(rows.length).toBe(Object.keys(ALLOWLIST).length);
  });
});
