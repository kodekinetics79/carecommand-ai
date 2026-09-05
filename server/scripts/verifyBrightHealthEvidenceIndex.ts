import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { verifyBrightHealthEvidenceIndex } from './verifyBrightHealthEvidenceIndexCore';

const repositoryRoot = process.cwd();
const reportPath = 'docs/testing/BRIGHT_HEALTH_PREPILOT_CERTIFICATION_2026-09-02.md';

try {
  const result = verifyBrightHealthEvidenceIndex({
    report: readFileSync(resolve(repositoryRoot, reportPath), 'utf8'),
    repositoryRoot,
  });
  console.log(JSON.stringify({ report: reportPath, ...result }, null, 2));
} catch (error) {
  console.error(`Bright Health evidence index FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
