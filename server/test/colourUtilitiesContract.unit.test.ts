import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Read the file, do not `import ... from '../index.css?raw'`: Vite treats a
// .css import as a stylesheet, so the raw query came back empty and the test
// reported EVERY class as undeclared — a guard that fails on everything is as
// useless as one that fails on nothing.
const css = readFileSync('src/index.css', 'utf8');

/**
 * Lives in server/test because it reads files from disk and the app tsconfig
 * carries no Node types — the same reason receptionistLiveUatContract, which
 * also greps the frontend, lives here. It is a repo contract, not a UI test.
 *
 * `text-red-v`, `bg-amber-v`, `border-l-emerald-v` and friends are NOT Tailwind
 * colours — they are hand-written rules in index.css. Tailwind therefore cannot
 * compose an opacity modifier onto them (`border-red-v/40`), and it never
 * emitted the border variants at all.
 *
 * Markup that says `border-red-v/40` looks correct in review, compiles, ships,
 * and renders NOTHING. Measured on 2026-08-31: 22 such class names were live on
 * real controls — every error card's red border, every warning card's amber
 * ground, and the coloured left-rules on the receptionist status cards were
 * absent while the markup claimed they were there.
 *
 * index.css already documented this for `bg-indigo`, which once shipped
 * invisible primary buttons across 56 controls. It was fixed for backgrounds
 * and left broken for borders, rings and every alpha variant — which is exactly
 * why a comment is not a guard. This test is the guard.
 */

const SEMANTIC = /(?<![\w-])((?:border-[ltbr]|border|bg|text|ring)-(?:red|emerald|amber|indigo|blue|cyan|violet)(?:-v)?(?:\/\d{1,3})?)(?![\w-])/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter(name => name.endsWith('.ts') || name.endsWith('.tsx'))
    .filter(name => !name.endsWith('.test.ts') && !name.endsWith('.test.tsx'))
    .map(name => join(dir, name));
}

/** A class is real only if index.css declares it; Tailwind owns none of these names. */
function declaredInCss(className: string): boolean {
  const escaped = className.replace(/\//g, '\\\\/').replace(/[.*+?^${}()|[\]]/g, '\\$&');
  return new RegExp(`\\.${escaped}\\s*(?:,|\\{|:)`).test(css);
}

describe('semantic colour utilities resolve to real CSS', () => {
  it('every one used in the app is declared in index.css', () => {
    const used = new Map<string, string[]>();
    for (const file of sourceFiles('src')) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(SEMANTIC)) {
        const cls = match[1];
        if (!used.has(cls)) used.set(cls, []);
        used.get(cls)!.push(file);
      }
    }

    const undeclared = [...used.entries()]
      .filter(([cls]) => !declaredInCss(cls))
      .map(([cls, files]) => `${cls} — used in ${files.length} file(s), e.g. ${files[0]}`)
      .sort();

    expect(
      undeclared,
      'These class names render NOTHING. They are hand-written utilities, so Tailwind cannot '
      + 'generate them or compose an opacity modifier onto them. Either declare them in the '
      + 'semantic colour block in src/index.css, or use an arbitrary value such as '
      + 'border-[var(--red)], which Tailwind CAN compose.',
    ).toEqual([]);
  });
});
