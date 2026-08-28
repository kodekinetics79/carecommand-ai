import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { syntheticProfiles } from '../../prisma/synthetic/profileManifest';
import { syntheticScenarioCatalog } from '../../prisma/synthetic/scenarioCatalog';

const outDir = resolve('docs/testing');
await mkdir(outDir, { recursive: true });

await writeFile(
  resolve(outDir, 'synthetic-scenarios.json'),
  `${JSON.stringify({ generatedAt: '2026-07-30', profiles: syntheticProfiles, scenarios: syntheticScenarioCatalog }, null, 2)}\n`,
  'utf8',
);

const profileRows = Object.values(syntheticProfiles)
  .map(item => `| ${item.profile} | ${item.tenants} | ${item.clinics} | ${item.users} | ${item.portalAccounts} | ${item.patients} | ${item.appointments} | ${item.calls} | ${item.paymentRequests} | ${item.documents} | ${item.notifications} | ${item.auditEvents} |`)
  .join('\n');
const categoryRows = Object.entries(
  syntheticScenarioCatalog.reduce<Record<string, number>>((counts, item) => {
    const category = item.scenarioId.split('-')[0];
    counts[category] = (counts[category] ?? 0) + 1;
    return counts;
  }, {}),
).map(([category, count]) => `| ${category} | ${count} |`).join('\n');
const executableCount = syntheticScenarioCatalog.filter(item => item.evidenceStatus === 'EXECUTABLE').length;

await writeFile(resolve(outDir, 'SYNTHETIC_DATA_CATALOG.md'), `# Synthetic Data Catalog

Generated from \`prisma/synthetic/profileManifest.ts\` and \`scenarioCatalog.ts\`. Data is fictional, uses example-domain identities and must only be loaded into an explicitly confirmed disposable test database.

| Profile | Tenants | Clinics | Users | Portal accounts | Patients | Appointments | Calls | Payments | Documents | Notifications | Audit events |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
${profileRows}

- Fixed seed: ${Object.values(syntheticProfiles)[0].fixedSeed}
- Controlled clock: ${Object.values(syntheticProfiles)[0].controlledClock}
- Reset strategy: drop the disposable database; never cascade-delete append-only audit evidence.
- Test credential, when seeded: \`synthetic.user.N@example.test\` / \`SyntheticOnly!2026\`. The seeder refuses non-test or unconfirmed targets.
- Machine-readable catalog: \`docs/testing/synthetic-scenarios.json\`.
`, 'utf8');

await writeFile(resolve(outDir, 'REALISTIC_SCENARIO_MATRIX.md'), `# Realistic Scenario Matrix

The ${syntheticScenarioCatalog.length} deterministic scenarios below define tenant, actors, preconditions, input, expected database/API/UI/audit behavior, authorization and reset strategy in the machine-readable catalog. ${executableCount} scenarios link to current executable evidence; the remainder are explicitly marked specification-only and are not release evidence.

| Category | Scenarios |
|---|---:|
${categoryRows}

| ID | Profile | Evidence | Tenant | Input event | Expected authorization |
|---|---|---|---|---|---|
${syntheticScenarioCatalog.map(item => `| ${item.scenarioId} | ${item.profile} | ${item.evidenceStatus} | ${item.tenant} | ${item.inputEvent.replace(/\|/g, '\\|')} | ${item.expectedAuthorization.replace(/\|/g, '\\|')} |`).join('\n')}
`, 'utf8');

console.log(`Wrote ${syntheticScenarioCatalog.length} scenarios and ${Object.keys(syntheticProfiles).length} profiles to ${outDir}`);
