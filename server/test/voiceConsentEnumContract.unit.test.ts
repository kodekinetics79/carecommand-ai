import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every `captureMethod` / `source` this codebase writes must be a value the
 * DATABASE accepts.
 *
 * On 2026-08-31 the live-test attach path wrote
 *   captureMethod: 'STAFF_ATTESTED_SYNTHETIC_UAT'
 *   source:        'CARECOMMAND_LIVE_UAT'
 * Neither has ever been legal. `ReceptionistVoiceConsentEvent_capture_method_check`
 * allows five values and `_method_source_check` demands the matching source, so
 * "Add the approved test number" failed with 23514 EVERY time it ran — the only
 * way to attach the authorised recipient for a live call was broken outright.
 *
 * It shipped because the only test naming that route greps the source for the
 * route's existence; nothing ever executed the insert. A plausible-looking
 * SCREAMING_CASE constant reviews fine and is refused by Postgres at runtime.
 *
 * This reads the allowed values out of the migration itself rather than
 * restating them, so the test cannot drift from the constraint it protects.
 */

const MIGRATION = 'prisma/migrations/20260730250000_receptionist_delivery_consent_integrity/migration.sql';

function allowedValues(constraint: string, column: string): string[] {
  const sql = readFileSync(MIGRATION, 'utf8');
  const block = new RegExp(`CONSTRAINT "${constraint}"\\s*CHECK \\(\\s*"?${column}"?\\s+IN \\(([^)]*)\\)`, 'i').exec(sql);
  if (!block) throw new Error(`Could not read ${constraint} out of ${MIGRATION}`);
  return [...block[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
}

function serverSources(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'generated' && entry.name !== 'test') walk(full); }
      else if (entry.name.endsWith('.ts')) files.push(full);
    }
  };
  walk('server');
  return files;
}

describe('voice consent events use values the database accepts', () => {
  const captureMethods = allowedValues('ReceptionistVoiceConsentEvent_capture_method_check', 'captureMethod');
  const sources = allowedValues('ReceptionistVoiceConsentEvent_source_check', 'source');

  it('reads the allowed sets from the migration, not from a copy', () => {
    // If this ever fails the parser broke, and every assertion below is vacuous.
    expect(captureMethods).toContain('staff_attestation');
    expect(sources).toContain('staff_attested');
    expect(captureMethods.length).toBeGreaterThan(1);
  });

  it('writes no captureMethod or source the constraints would refuse', () => {
    const offenders: string[] = [];
    for (const file of serverSources()) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/\bcaptureMethod:\s*'([^']+)'/g)) {
        if (!captureMethods.includes(match[1])) offenders.push(`${file}: captureMethod '${match[1]}'`);
      }
      // `source:` is a common property name — communicationConsent,
      // appointmentRequest and the legacy consentEvent all have one, with
      // different rules. Only judge a source that sits in the SAME object
      // literal as a captureMethod, which makes it a voice consent event.
      const lines = text.split('\n');
      lines.forEach((line, index) => {
        if (!/\bcaptureMethod:\s*'/.test(line)) return;
        for (let near = Math.max(0, index - 8); near <= Math.min(lines.length - 1, index + 8); near += 1) {
          const found = /\bsource:\s*'([^']+)'/.exec(lines[near]);
          if (found && !sources.includes(found[1])) offenders.push(`${file}: source '${found[1]}'`);
        }
      });
    }
    expect(
      offenders.sort(),
      'These values are refused by the ReceptionistVoiceConsentEvent CHECK constraints at runtime (Postgres 23514). '
      + `Allowed captureMethod: ${captureMethods.join(' | ')}. Allowed source: ${sources.join(' | ')}. `
      + 'Record UAT or provenance detail in jurisdiction/evidenceReference instead of inventing an enum value.',
    ).toEqual([]);
  });
});
