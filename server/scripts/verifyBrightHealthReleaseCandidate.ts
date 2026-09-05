import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

type CandidateManifest = {
  schemaVersion: number;
  candidate: string;
  state: 'UNCOMMITTED_LOCAL_CANDIDATE' | 'COMMITTED_RELEASE_CANDIDATE';
  baseHead: string;
  branch: string;
  repositoryContentFingerprint: string;
  excludedPaths: string[];
  excludedPrefixes: string[];
  requiredArtifacts: string[];
  certificationReport: string;
};

const manifestPath = 'docs/testing/bright-health-release-candidate.json';

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function manifest(): CandidateManifest {
  const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as CandidateManifest;
  if (parsed.schemaVersion !== 1) throw new Error('Unsupported Bright Health candidate manifest schema');
  return parsed;
}

function repositoryPaths(): string[] {
  const output = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z']);
  return [...new Set(output.toString('utf8').split('\0').filter(Boolean))].sort((left, right) => left.localeCompare(right, 'en'));
}

function fingerprint(candidate: CandidateManifest): { fingerprint: string; files: number } {
  const excluded = new Set(candidate.excludedPaths);
  const paths = repositoryPaths().filter(path => (
    !excluded.has(path)
    && !candidate.excludedPrefixes.some(prefix => path.startsWith(prefix))
  ));
  const aggregate = createHash('sha256');
  for (const path of paths) {
    const contentHash = createHash('sha256').update(readFileSync(path)).digest('hex');
    aggregate.update(path);
    aggregate.update('\0');
    aggregate.update(contentHash);
    aggregate.update('\n');
  }
  return { fingerprint: aggregate.digest('hex'), files: paths.length };
}

function main(): void {
  const candidate = manifest();
  for (const path of candidate.requiredArtifacts) {
    if (!existsSync(path)) throw new Error(`Required release-candidate artifact is missing: ${path}`);
  }

  const actual = fingerprint(candidate);
  if (process.argv.includes('--print')) {
    console.log(JSON.stringify({ ...actual, head: git(['rev-parse', 'HEAD']), branch: git(['branch', '--show-current']) }));
    return;
  }

  const head = git(['rev-parse', 'HEAD']);
  const branch = git(['branch', '--show-current']);
  if (candidate.state === 'UNCOMMITTED_LOCAL_CANDIDATE') {
    if (head !== candidate.baseHead) {
      throw new Error(`Candidate base HEAD changed: expected ${candidate.baseHead}, received ${head}`);
    }
  } else {
    const parent = git(['rev-parse', 'HEAD^']);
    if (parent !== candidate.baseHead) {
      throw new Error(`Committed candidate parent changed: expected ${candidate.baseHead}, received ${parent}`);
    }
    if (git(['status', '--porcelain'])) {
      throw new Error('Committed release candidate requires a clean working tree');
    }
  }
  if (branch !== candidate.branch) throw new Error(`Candidate branch changed: expected ${candidate.branch}, received ${branch}`);
  if (actual.fingerprint !== candidate.repositoryContentFingerprint) {
    throw new Error(`Candidate content changed: expected ${candidate.repositoryContentFingerprint}, received ${actual.fingerprint}`);
  }

  execFileSync('git', ['diff', '--check'], { stdio: 'inherit' });
  const report = readFileSync(candidate.certificationReport, 'utf8');
  if (!report.includes(candidate.repositoryContentFingerprint)) {
    throw new Error('Certification report does not identify the candidate fingerprint');
  }

  console.log(`Bright Health release candidate PASS: ${JSON.stringify({
    candidate: candidate.candidate,
    state: candidate.state,
    head,
    branch,
    fingerprint: actual.fingerprint,
    files: actual.files,
  })}`);
}

main();
