import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('AI receptionist conversation-library challenge', () => {
  const library = readFileSync('docs/content/receptionist-conversation-library.md', 'utf8');

  it('keeps refusal, emergency, transfer, and after-hours wording operationally truthful', () => {
    expect(library).toContain('Do not collect or record a new message after recording refusal or withdrawal.');
    expect(library).toMatch(/possible emergency overrides disclosure completion, consent capture, identity checks/i);
    expect(library).toContain('do not create a second message task after a failed or uncertain transfer');
    expect(library).toContain('canonical clinic hours and timezone data prove the current after-hours state');
    expect(library).toContain('A browser clock, campaign label, or model inference is not sufficient.');
  });

  it('uses accessible voice copy while retaining canonical IDs as internal evidence', () => {
    expect(library).toContain('The scheduling system confirms your {{service}} appointment');
    expect(library).toContain('Keep the canonical appointment ID as internal evidence');
    expect(library).toContain('Keep the task ID as internal evidence');
    expect(library).not.toContain('The booking system returned appointment ID {{appointment_id}}');
    expect(library).not.toContain('with task ID {{task_id}}');
  });
});
