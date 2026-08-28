import { access, readdir, readFile } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';

const root = resolve('.');
const sourceRoots = ['src', 'server', 'prisma'];
const rootProductionFiles = ['package.json', 'vite.config.ts', 'index.html'];
const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.json', '.html']);
const skippedSegments = ['/test/', '/tests/', '/__tests__/', '/node_modules/', '/generated/', '/prisma/migrations/', '/prisma/synthetic/'];
const reviewedAllowlist = new Set([
  'server/scripts/pilotSimulation.ts:production-imports-test-or-demo-data',
  'server/scripts/runPlaywright.ts:production-imports-test-or-demo-data',
]);

interface Violation { file: string; line: number; rule: string; excerpt: string }

const rules: Array<{ name: string; pattern: RegExp; scope?: 'ui' | 'all' }> = [
  { name: 'production-imports-test-or-demo-data', pattern: /(?:from\s+|import\s*\()['"][^'"]*(?:\/test\/|\/tests\/|__mocks__|(?:mock|fixture|seedData)[^/'"]*)/i },
  { name: 'embedded-provider-secret', pattern: /['"](?:sk_(?:live|test)|rk_live|whsec|retell_(?:api_)?key)[_-][A-Za-z0-9_-]{8,}['"]/i },
  { name: 'implicit-demo-identity', pattern: /['"](?:11111111-1111-4111-8111-111111111111|22222222-2222-4222-8222-222222222222)['"]/i },
  { name: 'legacy-demo-call-id', pattern: /call_demo_\d+/i },
  { name: 'legacy-demo-password', pattern: /(?:ChangeMe123!|Provider123!)/ },
  { name: 'unresolved-production-todo', pattern: /\b(?:TODO|FIXME)\b/ },
  { name: 'hardcoded-local-identity', pattern: /['"][^'"]+@[A-Za-z0-9.-]+\.local['"]/i },
  { name: 'implicit-demo-fallback', pattern: /VITE_DEMO_FALLBACK\s*(?:=|\?\?)\s*true/i },
  { name: 'dead-hash-link', pattern: /href\s*=\s*\{?['"]#['"]\}?/i, scope: 'ui' },
  { name: 'javascript-void-link', pattern: /javascript\s*:\s*void\s*\(/i, scope: 'ui' },
  { name: 'empty-click-handler', pattern: /on(?:Click|Submit)\s*=\s*\{\s*\(\s*\)\s*=>\s*\{\s*\}\s*\}/i, scope: 'ui' },
];

async function filesBelow(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = await Promise.all(entries.map(async entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [path];
  }));
  return paths.flat();
}

function isTestOnly(path: string): boolean {
  const normalized = `/${relative(root, path).replaceAll('\\', '/')}`;
  return normalized === '/prisma/seedSynthetic.ts' || skippedSegments.some(segment => normalized.includes(segment)) || /(?:\.test\.|\.spec\.|\.verify\.)/.test(normalized);
}

export async function inspectProductionArtifacts(): Promise<Violation[]> {
  const violations: Violation[] = [];
  const candidates: string[] = [];
  for (const sourceRoot of sourceRoots) {
    const absoluteRoot = resolve(sourceRoot);
    candidates.push(...await filesBelow(absoluteRoot));
  }
  for (const file of rootProductionFiles.map(path => resolve(path))) {
    try { await access(file); candidates.push(file); } catch { /* optional root file */ }
  }
  for (const file of candidates) {
      if (!sourceExtensions.has(extname(file)) || isTestOnly(file)) continue;
      const repoPath = relative(root, file).replaceAll('\\', '/');
      if (repoPath === 'server/scripts/verifyNoProductionDemoArtifacts.ts') continue;
      if (/^src\/data\/(?:mock|seedData)/i.test(repoPath)) {
        violations.push({ file: repoPath, line: 1, rule: 'production-demo-data-module', excerpt: 'Move fixtures into test-only synthetic infrastructure or delete unused module.' });
      }
      const lines = (await readFile(file, 'utf8')).split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        for (const rule of rules) {
          if (rule.scope === 'ui' && !repoPath.startsWith('src/')) continue;
          if (rule.pattern.test(lines[index])) {
            if (reviewedAllowlist.has(`${repoPath}:${rule.name}`)) continue;
            violations.push({ file: repoPath, line: index + 1, rule: rule.name, excerpt: lines[index].trim().slice(0, 180) });
          }
        }
      }
  }

  const dist = resolve('dist');
  try {
    await access(dist);
    for (const file of await filesBelow(dist)) {
      if (!['.js', '.html', '.css', '.map'].includes(extname(file))) continue;
      const text = await readFile(file, 'utf8');
      const repoPath = relative(root, file).replaceAll('\\', '/');
      for (const marker of ['server/test/', '__mocks__', 'ChangeMe123!', 'Provider123!', 'call_demo_', '@carecommand.local', '11111111-1111-4111-8111-111111111111']) {
        if (text.includes(marker)) violations.push({ file: repoPath, line: 1, rule: 'production-build-demo-artifact', excerpt: marker });
      }
    }
  } catch {
    // Source-only checks remain valid before the first production build.
  }
  return violations;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const violations = await inspectProductionArtifacts();
  if (violations.length) {
    for (const item of violations) console.error(`${item.file}:${item.line} [${item.rule}] ${item.excerpt}`);
    console.error(`Production artifact verification failed with ${violations.length} violation(s).`);
    process.exitCode = 1;
  } else {
    console.log('Production artifact verification PASS: scanned src/server/production Prisma/config and built assets for prohibited demo fixtures, known seed credentials/identities, unresolved TODOs, embedded provider secrets, and dead UI action patterns.');
  }
}
