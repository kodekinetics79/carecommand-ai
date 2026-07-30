import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('frontend translation privacy boundary', () => {
  it('never scans or transmits arbitrary rendered DOM text', async () => {
    const source = await readFile(
      new URL('../../src/components/AutoTranslate.tsx', import.meta.url),
      'utf8',
    );
    const client = await readFile(
      new URL('../../src/lib/i18n.ts', import.meta.url),
      'utf8',
    );

    expect(source).not.toContain('ensureTranslations');
    expect(source).not.toContain('MutationObserver');
    expect(source).not.toContain('document.body');
    expect(source).toContain('document.documentElement.lang');
    expect(source).toContain('document.documentElement.dir');
    expect(client).not.toContain('/v1/i18n/translate');
    expect(client).not.toContain('localStorage');
  });
});
