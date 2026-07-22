/**
 * Demo sandbox provisioner — makes Connected Care "test-ready" for a client demo
 * WITHOUT any real vendor accounts.
 *
 *   npm run demo:sandbox
 *
 * For the dev tenant it:
 *   1. Puts Stedi (insurance) into SANDBOX.
 *   2. Puts every device provider (Dexcom, Withings, Validic, Terra, Tenovi,
 *      manual) into SANDBOX with an encrypted demo webhook secret.
 *   3. Enrolls demo patients (one external ref per provider).
 *   4. Streams realistic readings through the REAL adapter→severity pipeline
 *      (normalize → resolve patient → DeviceReading → evaluateSeverity →
 *      ReadingAlert → DeviceProviderSyncLog), so Integration Setup shows live
 *      Sandbox status + sync logs and the monitoring pages are populated.
 *
 * The webhook secret it sets is printed so you can also push signed webhooks by
 * hand during the demo (see docs/CONNECTED_CARE_SANDBOX.md).
 */
import 'dotenv/config';
import { createHmac } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { encryptSecret } from '../lib/security';
import { normalizeWebhook } from '../lib/connectedCare/deviceAdapters';
import { evaluateSeverity, resolveRule } from '../lib/monitoring';
import { DEVICE_PROVIDERS } from '../lib/connectedCare/catalog';

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL }) });
const tenantId = process.env.DEV_TENANT_ID ?? '11111111-1111-4111-8111-111111111111';
const DEMO_WEBHOOK_SECRET = 'demo-sandbox-secret';

interface RawReading { patientExternalRef: string; readingType: string; value: string; numericValue: number; valueSecondary?: number; unit: string }

// One batch of sample readings per provider (a couple are intentionally
// out-of-range so the severity engine raises alerts during the demo).
const PROVIDER_READINGS: Record<string, { ref: string; readings: RawReading[] }> = {
  dexcom: { ref: 'DEXCOM-001', readings: [
    { patientExternalRef: 'DEXCOM-001', readingType: 'glucose', value: '112', numericValue: 112, unit: 'mg/dL' },
    { patientExternalRef: 'DEXCOM-001', readingType: 'glucose', value: '318', numericValue: 318, unit: 'mg/dL' }, // critical
  ] },
  withings: { ref: 'WITHINGS-001', readings: [
    { patientExternalRef: 'WITHINGS-001', readingType: 'blood_pressure', value: '182/96', numericValue: 182, valueSecondary: 96, unit: 'mmHg' }, // critical
    { patientExternalRef: 'WITHINGS-001', readingType: 'weight', value: '84.2', numericValue: 84.2, unit: 'kg' },
  ] },
  validic: { ref: 'VALIDIC-001', readings: [
    { patientExternalRef: 'VALIDIC-001', readingType: 'oxygen', value: '90', numericValue: 90, unit: '%' }, // high
    { patientExternalRef: 'VALIDIC-001', readingType: 'heart_rate', value: '78', numericValue: 78, unit: 'bpm' },
  ] },
  terra: { ref: 'TERRA-001', readings: [
    { patientExternalRef: 'TERRA-001', readingType: 'heart_rate', value: '116', numericValue: 116, unit: 'bpm' }, // high
  ] },
  tenovi: { ref: 'TENOVI-001', readings: [
    { patientExternalRef: 'TENOVI-001', readingType: 'glucose', value: '134', numericValue: 134, unit: 'mg/dL' },
    { patientExternalRef: 'TENOVI-001', readingType: 'blood_pressure', value: '128/82', numericValue: 128, valueSecondary: 82, unit: 'mmHg' },
  ] },
  manual: { ref: 'MANUAL-001', readings: [
    { patientExternalRef: 'MANUAL-001', readingType: 'temperature', value: '37.1', numericValue: 37.1, unit: '°C' },
  ] },
};

async function processInbound(providerKey: string, body: unknown): Promise<{ ingested: number; alerts: number }> {
  const { readings } = normalizeWebhook(providerKey, body);
  let ingested = 0; let alerts = 0;
  for (const r of readings) {
    const enr = r.patientExternalRef
      ? await db.patientDeviceEnrollment.findFirst({ where: { tenantId, providerKey, externalRef: r.patientExternalRef, status: 'active' }, select: { patientId: true, branchId: true } })
      : null;
    const patientId = r.patientId ?? enr?.patientId ?? null;
    const branchId = enr?.branchId ?? null;
    const reading = await db.deviceReading.create({ data: { tenantId, patientId, branchId, readingType: r.readingType, value: r.value, numericValue: r.numericValue ?? null, valueSecondary: r.valueSecondary ?? null, unit: r.unit ?? null, capturedAt: r.capturedAt, source: 'webhook', validationStatus: 'valid', rawPayload: r as unknown as object }, select: { id: true, numericValue: true } });
    ingested++;
    const rule = await resolveRule(tenantId, { readingType: r.readingType, patientId, branchId });
    const { severity, reason } = evaluateSeverity(r.readingType, reading.numericValue, rule);
    if (severity !== 'normal') { await db.readingAlert.create({ data: { tenantId, patientId, branchId, readingId: reading.id, severity, alertType: 'abnormal_reading', status: 'open', generatedReason: reason } }); alerts++; }
  }
  await db.deviceProviderSyncLog.create({ data: { tenantId, providerKind: 'device', providerKey, direction: 'inbound', event: 'webhook', status: 'processed', httpStatus: 200, signatureValid: providerKey === 'manual' ? null : true, readingsIngested: ingested, alertsCreated: alerts, message: `Sandbox demo stream: ${ingested} reading(s), ${alerts} alert(s)`, payload: body as object } });
  return { ingested, alerts };
}

async function main() {
  console.log(`[demo:sandbox] tenant ${tenantId}`);

  // 1) Stedi insurance → SANDBOX
  await db.insuranceProvider.upsert({ where: { tenantId_providerKey: { tenantId, providerKey: 'stedi' } }, create: { tenantId, providerKey: 'stedi', displayName: 'Stedi', category: 'INSURANCE', mode: 'sandbox', status: 'SANDBOX', lastHealthCheckAt: new Date(), lastHealthStatus: 'healthy', healthMessage: 'Sandbox reachable — simulated 271 response OK.' }, update: { mode: 'sandbox', status: 'SANDBOX', lastHealthCheckAt: new Date(), lastHealthStatus: 'healthy' } });
  console.log('  ✓ Stedi eligibility → SANDBOX (no key needed)');

  // 2) Device providers → SANDBOX with an encrypted demo webhook secret
  const encrypted = encryptSecret(JSON.stringify({ webhookSecret: DEMO_WEBHOOK_SECRET }));
  for (const def of DEVICE_PROVIDERS) {
    const status = def.category === 'MANUAL' ? 'ACTIVE' : 'SANDBOX';
    await db.deviceProvider.upsert({
      where: { tenantId_providerKey: { tenantId, providerKey: def.key } },
      create: { tenantId, providerKey: def.key, displayName: def.displayName, category: def.category, mode: 'sandbox', status, encryptedConfig: def.category === 'MANUAL' ? null : encrypted, webhookConfigured: def.supportsWebhook, lastHealthCheckAt: new Date(), lastHealthStatus: 'healthy', healthMessage: `Sandbox ready (${def.category})` },
      update: { mode: 'sandbox', status, encryptedConfig: def.category === 'MANUAL' ? null : encrypted, webhookConfigured: def.supportsWebhook, lastHealthCheckAt: new Date(), lastHealthStatus: 'healthy' },
    });
  }
  console.log('  ✓ Device providers → SANDBOX (dexcom, withings, validic, terra, tenovi; manual ACTIVE)');

  // 3) Enroll demo patients (one external ref per provider)
  const patients = await db.patient.findMany({ where: { tenantId, deletedAt: null }, orderBy: { createdAt: 'asc' }, take: 6, select: { id: true, branchId: true } });
  if (patients.length < 6) { console.error('  ! Need ≥6 patients — run `npm run db:seed` first.'); process.exit(1); }
  const keys = Object.keys(PROVIDER_READINGS);
  for (let i = 0; i < keys.length; i++) {
    const def = PROVIDER_READINGS[keys[i]]; const pt = patients[i];
    await db.patientDeviceEnrollment.upsert({ where: { tenantId_patientId_providerKey: { tenantId, patientId: pt.id, providerKey: keys[i] } }, create: { tenantId, patientId: pt.id, branchId: pt.branchId, providerKey: keys[i], programType: 'rpm', status: 'active', externalRef: def.ref }, update: { status: 'active', externalRef: def.ref } });
  }
  console.log('  ✓ Enrolled demo patients with provider external refs');

  // 4) Stream readings through the real pipeline
  let totalIngested = 0, totalAlerts = 0;
  for (const [providerKey, def] of Object.entries(PROVIDER_READINGS)) {
    const { ingested, alerts } = await processInbound(providerKey, { readings: def.readings });
    totalIngested += ingested; totalAlerts += alerts;
    console.log(`  ✓ ${providerKey}: ${ingested} reading(s) → ${alerts} alert(s)`);
  }

  console.log(`\n[demo:sandbox] done — ${totalIngested} readings, ${totalAlerts} alerts via the real pipeline.`);
  const sampleBody = JSON.stringify({ readings: PROVIDER_READINGS.dexcom.readings });
  const sig = createHmac('sha256', DEMO_WEBHOOK_SECRET).update(sampleBody).digest('hex');
  console.log('\nPush more signed sandbox readings during the demo:');
  console.log(`  curl -X POST http://localhost:3001/v1/connected-care/${tenantId}/providers/dexcom/webhook \\`);
  console.log(`    -H 'content-type: application/json' -H 'x-cc-signature: ${sig}' \\`);
  console.log(`    -d '${sampleBody}'`);
  console.log(`\n  (all device webhooks require a valid per-provider HMAC signature — unsigned requests are rejected 401)\n`);
  await db.$disconnect();
}

main().then(() => process.exit(0)).catch(async e => { console.error(e); await db.$disconnect(); process.exit(1); });
