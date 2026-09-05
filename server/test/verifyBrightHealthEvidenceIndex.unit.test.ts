import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  parseBrightHealthEvidenceIndex,
  verifyBrightHealthEvidenceIndex,
} from '../scripts/verifyBrightHealthEvidenceIndexCore';

const temporaryRoots: string[] = [];

function temporaryRepository(): string {
  const root = mkdtempSync(join(tmpdir(), 'bright-health-evidence-'));
  temporaryRoots.push(root);
  return root;
}

function report(...entries: string[]): string {
  return [
    '# Certification',
    '',
    '## Evidence index',
    '',
    ...entries.map(entry => `- \`${entry}\``),
    '',
    '## Certification boundary',
    '',
    'Boundary.',
  ].join('\n');
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Bright Health evidence-index verifier', () => {
  it('parses the bounded Evidence index and emits deterministic hashes for non-empty files', () => {
    const root = temporaryRepository();
    mkdirSync(join(root, 'test-results'));
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, 'test-results', 'journey.png'), Buffer.from([1, 2, 3]));
    writeFileSync(join(root, 'docs', 'packet.md'), 'operations evidence\n');

    const source = report('test-results/journey.png', 'docs/packet.md');
    expect(parseBrightHealthEvidenceIndex(source)).toEqual([
      'test-results/journey.png',
      'docs/packet.md',
    ]);
    expect(verifyBrightHealthEvidenceIndex({ report: source, repositoryRoot: root })).toEqual({
      artifacts: [
        {
          path: 'test-results/journey.png',
          bytes: 3,
          sha256: createHash('sha256').update(Buffer.from([1, 2, 3])).digest('hex'),
        },
        {
          path: 'docs/packet.md',
          bytes: 20,
          sha256: createHash('sha256').update('operations evidence\n').digest('hex'),
        },
      ],
    });
  });

  it.each([
    '../outside.txt',
    'docs/../outside.txt',
    '/tmp/outside.txt',
    'C:\\outside.txt',
    'docs\\packet.md',
  ])('rejects unsafe artifact path %s', artifactPath => {
    const root = temporaryRepository();
    expect(() => verifyBrightHealthEvidenceIndex({ report: report(artifactPath), repositoryRoot: root }))
      .toThrow(/repository-relative|traversal|ambiguous|canonical/);
  });

  it('rejects a symlink that resolves outside the repository', () => {
    const root = temporaryRepository();
    const outside = temporaryRepository();
    writeFileSync(join(outside, 'evidence.txt'), 'outside');
    symlinkSync(join(outside, 'evidence.txt'), join(root, 'linked-evidence.txt'));
    expect(() => verifyBrightHealthEvidenceIndex({ report: report('linked-evidence.txt'), repositoryRoot: root }))
      .toThrow('resolves outside the repository');
  });

  it('rejects missing, empty, non-file and duplicate artifacts', () => {
    const root = temporaryRepository();
    writeFileSync(join(root, 'empty.txt'), '');
    mkdirSync(join(root, 'directory'));
    expect(() => verifyBrightHealthEvidenceIndex({ report: report('missing.txt'), repositoryRoot: root }))
      .toThrow('does not exist');
    expect(() => verifyBrightHealthEvidenceIndex({ report: report('empty.txt'), repositoryRoot: root }))
      .toThrow('is empty');
    expect(() => verifyBrightHealthEvidenceIndex({ report: report('directory'), repositoryRoot: root }))
      .toThrow('not a regular file');
    expect(() => verifyBrightHealthEvidenceIndex({ report: report('empty.txt', 'empty.txt'), repositoryRoot: root }))
      .toThrow('duplicate artifact path');
  });

  it('rejects a missing, empty or malformed Evidence index', () => {
    expect(() => parseBrightHealthEvidenceIndex('# Certification')).toThrow('missing ## Evidence index');
    expect(() => parseBrightHealthEvidenceIndex('# Certification\n\n## Evidence index\n\n## Boundary'))
      .toThrow('contains no local artifacts');
    expect(() => parseBrightHealthEvidenceIndex('# Certification\n\n## Evidence index\n\n- [remote](https://example.com)\n\n## Boundary'))
      .toThrow('unsupported entry');
  });
});
