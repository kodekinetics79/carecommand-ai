/* eslint-disable no-console -- reporting script */
/**
 * Code-backed Product Completion Audit. Static repo inspection (no DB) that
 * classifies each roadmap feature BUILT / PARTIAL / MISSING / NOT_STARTED from
 * real evidence: Prisma models, backend route signals, and frontend pages.
 *   npx tsx server/scripts/product-audit.ts
 *
 * A feature is BUILT only with model support (where needed) + backend API +
 * frontend UI (where user-facing). PARTIAL = some evidence. MISSING = model/stub
 * only. NOT_STARTED = no evidence.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const schema = readFileSync(join(root, 'prisma/schema.prisma'), 'utf8');
const appTs = readFileSync(join(root, 'server/app.ts'), 'utf8');

function readAll(dir: string): string {
  let out = '';
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts') && !e.name.endsWith('.verify.ts')) out += readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
}
const serverCode = readAll(join(root, 'server/modules'));
const pages = readdirSync(join(root, 'src/pages'));

const hasModel = (m: string) => new RegExp(`model ${m} \\{`).test(schema);
const hasRoute = (sig: string) => serverCode.includes(sig);
const hasPage = (p: string) => pages.includes(p);

type Status = 'BUILT' | 'PARTIAL' | 'MISSING' | 'NOT_STARTED';
interface Feature {
  phase: number; name: string;
  models?: string[]; routes?: string[]; pages?: string[]; userFacing?: boolean;
  note?: string;
}

const FEATURES: Feature[] = [
  // Phase 1
  { phase: 1, name: 'AI Master Morning Briefing', models: ['BusinessEvent', 'OperationalSignal', 'AIRecommendation'], routes: ["'/briefing'"], userFacing: false, note: 'rule-based, real data' },
  { phase: 1, name: 'Revenue Lead Meter', models: ['RevenueLeak', 'RevenueProtectionAlert', 'RevenueSnapshot'], routes: ["'/revenue-leaks'", "'/overview'"], pages: ['RevenueProtection.tsx', 'Revenue.tsx'], userFacing: true },
  { phase: 1, name: 'Insurance Command Center', models: ['InsurancePayer', 'EligibilityVerification', 'PriorAuthorization'], routes: ["'/eligibility'"], pages: ['Insurance.tsx'], userFacing: true },
  { phase: 1, name: 'AI Receptionist configuration', models: ['ReceptionistClinic', 'ReceptionistOutboundCampaign'], routes: ['outbound-campaigns'], pages: ['ReceptionistStudio.tsx', 'AIReceptionist.tsx'], userFacing: true },
  { phase: 1, name: 'CRM campaign / reactivation engine', models: ['Campaign', 'CommunicationConsent', 'CampaignDelivery'], routes: ["'/audiences/:type/preview'", "'/campaigns/:id/launch'"], pages: ['CampaignEngine.tsx'], userFacing: true, note: 'reactivation engine: audiences, consent, delivery, approval, RBAC, audit, verified' },
  { phase: 1, name: 'Compliance Readiness Center', models: ['ComplianceControl', 'ComplianceEvidence', 'ComplianceFramework'], routes: ["'/dashboard'", "'/controls'"], pages: ['ComplianceCenter.tsx'], userFacing: true },
  { phase: 1, name: 'Integration Hub foundation', models: ['Integration', 'IntegrationRunLog'], routes: ["'/integrations/status'"], pages: ['Integrations.tsx'], userFacing: true },
  { phase: 1, name: 'Patient portal MVP', routes: ["'/public/checkout/:token'"], pages: ['PatientPortal.tsx'], userFacing: true, note: 'only tokenized public checkout; no portal page' },
  { phase: 1, name: 'Multi-location dashboard', models: ['Branch'], routes: ["'/multi-location'"], pages: ['Dashboard.tsx'], userFacing: true, note: 'branch scoping + dashboard exist; dedicated cross-location analytics partial' },
  { phase: 1, name: 'Audit logs + RBAC hardening', models: ['AuditEvent', 'TenantSecurityPolicy', 'RoleDefinition'], routes: ['requireRoles', 'requireFeature'], userFacing: false },
  // Phase 2
  { phase: 2, name: 'EHR/PMS connector framework', models: [], routes: [], userFacing: true },
  { phase: 2, name: 'FHIR/HL7-ready data model', models: [], routes: [], userFacing: false },
  { phase: 2, name: 'Prior authorization tracker', models: ['PriorAuthorization'], routes: ["'/prior-auth'"], pages: ['Insurance.tsx'], userFacing: true },
  { phase: 2, name: 'Review / reputation management', models: ['Review', 'ReputationCase', 'ReviewRequest'], routes: ["'/reviews'", "'/reputation'"], pages: ['Reviews.tsx'], userFacing: true },
  { phase: 2, name: 'No-show prediction', models: ['Appointment'], routes: ["'/noShowPrediction'"], pages: ['Scheduling.tsx'], userFacing: true, note: 'noShowRisk field + UI display; no real prediction model' },
  { phase: 2, name: 'Staff productivity insights', models: ['StaffProfile', 'StaffTask'], routes: ["'/tasks'"], pages: ['StaffWorkflow.tsx'], userFacing: true },
  { phase: 2, name: 'Payment plan automation', userFacing: true },
  { phase: 2, name: 'Patient mobile app', userFacing: true, note: 'mobile-ready API fields only; no app' },
  // Phase 3
  { phase: 3, name: 'Autonomous AI advisor', models: ['AIRecommendation'], routes: ["'/autonomousAdvisor'"], pages: ['AdvisoryRoom.tsx'], userFacing: true, note: 'rule-based recs + advisory room exist; autonomy NOT built' },
  { phase: 3, name: 'AI campaign generator', models: ['Campaign'], routes: ["'/llmCampaignGenerate'"], pages: ['CampaignEngine.tsx'], userFacing: true, note: 'rule-based draft generation + approval exists; no LLM generation yet' },
  { phase: 3, name: 'AI denial-prevention assistant', models: ['AIRecommendation', 'OperationalSignal'], routes: ["'/denial-prevention/:appointmentId'"], pages: ['InsuranceCommandCenter.tsx'], userFacing: true, note: 'rule-based denial-prevention foundation + intake card; no dedicated AI page yet' },
  { phase: 3, name: 'AI payer performance analysis', models: [], routes: [], userFacing: true },
  { phase: 3, name: 'Referral network intelligence', models: [], routes: [], userFacing: true },
  { phase: 3, name: 'RPM / device integration', models: [], routes: [], userFacing: true },
  { phase: 3, name: 'Kiosk / tablet check-in', models: [], routes: [], userFacing: true },
  { phase: 3, name: 'Benchmarking across locations', models: ['Competitor'], routes: ["'/locationBenchmarking'"], pages: ['ClinicRadar.tsx'], userFacing: true, note: 'competitor radar exists; own cross-location benchmarking NOT built' },
  { phase: 3, name: 'Executive owner app', models: [], routes: [], userFacing: true },
];

function classify(f: Feature): Status {
  const modelExpected = (f.models?.length ?? 0) > 0;
  const modelFull = !modelExpected || f.models!.every(hasModel);
  const modelSome = modelExpected && f.models!.some(hasModel);
  const routeExpected = (f.routes?.length ?? 0) > 0;
  const routeOk = routeExpected && f.routes!.some(hasRoute);
  const uiExpected = !!f.userFacing && (f.pages?.length ?? 0) > 0;
  const uiOk = uiExpected && f.pages!.some(hasPage);

  // No positive evidence in any dimension → nothing has been started.
  if (!modelSome && !routeOk && !uiOk) return 'NOT_STARTED';

  const modelSatisfied = !modelExpected || modelFull;
  const routeSatisfied = !routeExpected || routeOk;
  const uiSatisfied = !uiExpected || uiOk;
  if (modelSatisfied && routeSatisfied && uiSatisfied) return 'BUILT';

  // Only a model/stub present, no API and no UI → MISSING (model-only).
  if (modelSome && !routeOk && !uiOk) return 'MISSING';
  return 'PARTIAL';
}

const order: Status[] = ['BUILT', 'PARTIAL', 'MISSING', 'NOT_STARTED'];
const counts: Record<Status, number> = { BUILT: 0, PARTIAL: 0, MISSING: 0, NOT_STARTED: 0 };

for (const phase of [1, 2, 3]) {
  console.log(`\n=== PHASE ${phase} ===`);
  for (const f of FEATURES.filter(x => x.phase === phase)) {
    const status = classify(f);
    counts[status]++;
    const ev: string[] = [];
    if (f.models?.length) ev.push(`models:${f.models.filter(hasModel).length}/${f.models.length}`);
    if (f.routes?.length) ev.push(`api:${f.routes.some(hasRoute) ? 'yes' : 'no'}`);
    if (f.userFacing) ev.push(`ui:${f.pages?.some(hasPage) ? 'yes' : 'no'}`);
    console.log(`  [${status.padEnd(11)}] ${f.name.padEnd(38)} ${ev.join(' ')}${f.note ? `  — ${f.note}` : ''}`);
  }
}

console.log('\n=== TOTALS ===');
for (const s of order) console.log(`  ${s.padEnd(11)}: ${counts[s]}`);
console.log(`\n(registered route groups in app.ts: ${(appTs.match(/protectedApi\.register/g) ?? []).length})`);
console.log('Product audit complete (code-backed, static inspection).');
