import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Read the CSS files directly, do not `import ...?raw`: Vite treats a .css
// import as a stylesheet and the raw query can come back empty. `main.tsx`
// imports both files before the demo theme, so these declarations are part of
// every application bundle rather than test-only definitions.
const css = [
  readFileSync('src/index.css', 'utf8'),
  readFileSync('src/semantic-colour-overrides.css', 'utf8'),
].join('\n');

/**
 * Lives in server/test because it reads files from disk and the app tsconfig
 * carries no Node types — the same reason receptionistLiveUatContract, which
 * also greps the frontend, lives here. It is a repo contract, not a UI test.
 *
 * `text-red-v`, `bg-amber-v`, `border-l-emerald-v` and friends are NOT Tailwind
 * colours — they are hand-written rules in application CSS. Tailwind therefore
 * cannot compose an opacity modifier onto them (`border-red-v/40`) unless the
 * composed class itself is explicitly declared.
 *
 * Markup that says `border-red-v/40` looks correct in review, compiles, ships,
 * and renders NOTHING when no matching rule exists. This guard verifies every
 * semantic colour utility used in production source resolves to real bundled
 * CSS, including the small token-aware alpha set kept in the dedicated
 * semantic-colour override file.
 */

const SEMANTIC = /(?<![\w-])((?:border-[ltbr]|border|bg|text|ring)-(?:red|emerald|amber|indigo|blue|cyan|violet)(?:-v)?(?:\/\d{1,3})?)(?![\w-])/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter(name => name.endsWith('.ts') || name.endsWith('.tsx'))
    .filter(name => !name.endsWith('.test.ts') && !name.endsWith('.test.tsx'))
    .map(name => join(dir, name));
}

/** A semantic class is real only if one of the globally imported CSS files declares it. */
function declaredInCss(className: string): boolean {
  const escaped = className.replace(/\//g, '\\\\/').replace(/[.*+?^${}()|[\]]/g, '\\$&');
  return new RegExp(`\\.${escaped}\\s*(?:,|\\{|:)`).test(css);
}

describe('semantic colour utilities resolve to real CSS', () => {
  it('every one used in the app is declared in globally imported CSS', () => {
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
      'These class names render NOTHING. They are hand-written semantic utilities, so Tailwind cannot '
      + 'generate them or compose an opacity modifier onto them. Declare each class in a globally '
      + 'imported semantic CSS file, or use an arbitrary value that Tailwind can compose.',
    ).toEqual([]);
  });
});
