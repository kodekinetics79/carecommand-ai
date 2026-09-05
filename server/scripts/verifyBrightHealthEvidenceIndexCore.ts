import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, posix, relative, resolve, win32 } from 'node:path';

const EVIDENCE_HEADING = '## Evidence index';

export type EvidenceArtifact = {
  path: string;
  bytes: number;
  sha256: string;
};

export type EvidenceIndexVerification = {
  artifacts: EvidenceArtifact[];
};

export function parseBrightHealthEvidenceIndex(report: string): string[] {
  const lines = report.split(/\r?\n/);
  const headingIndex = lines.findIndex(line => line.trim() === EVIDENCE_HEADING);
  if (headingIndex < 0) throw new Error(`Certification report is missing ${EVIDENCE_HEADING}`);

  const paths: string[] = [];
  for (const line of lines.slice(headingIndex + 1)) {
    if (/^##\s+/.test(line.trim())) break;
    if (!line.trim()) continue;
    const match = /^-\s+`([^`]+)`\s*$/.exec(line.trim());
    if (!match) throw new Error(`Evidence index contains an unsupported entry: ${line.trim()}`);
    paths.push(match[1]);
  }
  if (paths.length === 0) throw new Error('Evidence index contains no local artifacts');
  if (new Set(paths).size !== paths.length) throw new Error('Evidence index contains a duplicate artifact path');
  return paths;
}

function safeRepositoryPath(repositoryRoot: string, artifactPath: string): string {
  if (!artifactPath || artifactPath.includes('\0')) throw new Error('Evidence artifact path is empty or invalid');
  if (artifactPath.includes('\\') || isAbsolute(artifactPath) || win32.isAbsolute(artifactPath)) {
    throw new Error(`Evidence artifact path must be repository-relative: ${artifactPath}`);
  }
  const segments = artifactPath.split('/');
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`Evidence artifact path contains traversal or ambiguous segments: ${artifactPath}`);
  }
  if (posix.normalize(artifactPath) !== artifactPath) {
    throw new Error(`Evidence artifact path is not canonical: ${artifactPath}`);
  }

  const root = realpathSync(repositoryRoot);
  const candidate = resolve(root, artifactPath);
  let realCandidate: string;
  try {
    realCandidate = realpathSync(candidate);
  } catch {
    throw new Error(`Evidence artifact does not exist: ${artifactPath}`);
  }
  const fromRoot = relative(root, realCandidate);
  if (!fromRoot || fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
    throw new Error(`Evidence artifact resolves outside the repository: ${artifactPath}`);
  }
  return realCandidate;
}

export function verifyBrightHealthEvidenceIndex(input: {
  report: string;
  repositoryRoot: string;
}): EvidenceIndexVerification {
  const paths = parseBrightHealthEvidenceIndex(input.report);
  const artifacts = paths.map(artifactPath => {
    const absolutePath = safeRepositoryPath(input.repositoryRoot, artifactPath);
    const stat = statSync(absolutePath);
    if (!stat.isFile()) throw new Error(`Evidence artifact is not a regular file: ${artifactPath}`);
    if (stat.size === 0) throw new Error(`Evidence artifact is empty: ${artifactPath}`);
    const content = readFileSync(absolutePath);
    return {
      path: artifactPath,
      bytes: content.byteLength,
      sha256: createHash('sha256').update(content).digest('hex'),
    };
  });
  return { artifacts };
}
