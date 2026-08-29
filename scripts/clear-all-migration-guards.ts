/**
 * One-shot production repair: clears EVERY data-guard across the pending
 * migrations so the whole chain applies in a single deploy (2026-08-29).
 *
 * Built from an exhaustive sweep of all 103 RAISE EXCEPTION statements in the
 * pending migrations (13 analysis agents + 13 independent adversarial
 * verifiers): 85 are runtime trigger bodies that cannot fail a deploy; the 14
 * pre-checkable preflight guards are encoded below. Post-backfill checks and
 * guards over tables created mid-chain evaluate against empty tables and pass.
 *
 * Behaviour:
 *  - Phase 1 (read-only): evaluates every guard, prints offending rows.
 *  - Aborts untouched if total offenders > 50 (does not smell like demo data)
 *    or if a guard with NO safe fix is failing (250000.7/.8 - rows protected
 *    by append-only triggers; expected 0 since their tables are hours old).
 *  - Phase 2 (one transaction): applies fixes in migration order, re-checks
 *    every guard, repeats up to 3 passes (fixes that delete rows can surface
 *    new orphans), COMMITs only when ALL guards are 0, then marks every
 *    failed _prisma_migrations record rolled back so migrate deploy retries.
 *  - Any error or unclean state => ROLLBACK, nothing changed.
 *
 * Run with the DIRECT Neon endpoint (no -pooler) as neondb_owner:
 *   FIX_DB_URL='postgresql://neondb_owner:...@ep-...aws.neon.tech/neondb?sslmode=require' \
 *     npx tsx scripts/clear-all-migration-guards.ts
 */
import pg from 'pg';

const url = process.env.FIX_DB_URL;
if (!url) { console.error('FIX_DB_URL not set'); process.exit(1); }
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

interface Spec { name: string; msg: string; checkSql: string; rowsSql: string; fixSql: string | null }

const SPECS: Spec[] = [
  // ── 20260730230000_receptionist_outbound_booking_authority ────────────────
  {
    name: '230000.1', msg: 'runnable or direct-booking campaign lacks authority',
    checkSql: `SELECT count(*)::int AS n FROM "ReceptionistOutboundCampaign" WHERE "status" IN ('SCHEDULED','RUNNING') OR "bookingMode" = 'DIRECT_BOOKING_IF_SLOT_AVAILABLE'`,
    rowsSql: `SELECT "id","tenantId","clinicId","name","status","bookingMode","createdAt" FROM "ReceptionistOutboundCampaign" WHERE "status" IN ('SCHEDULED','RUNNING') OR "bookingMode" = 'DIRECT_BOOKING_IF_SLOT_AVAILABLE' LIMIT 10`,
    fixSql: `UPDATE "ReceptionistOutboundCampaign" SET "status" = CASE WHEN "status" IN ('SCHEDULED','RUNNING') THEN 'PAUSED'::"OutboundCampaignStatus" ELSE "status" END, "bookingMode" = CASE WHEN "bookingMode" = 'DIRECT_BOOKING_IF_SLOT_AVAILABLE' THEN 'APPOINTMENT_REQUEST_ONLY'::"OutboundBookingMode" ELSE "bookingMode" END WHERE "status" IN ('SCHEDULED','RUNNING') OR "bookingMode" = 'DIRECT_BOOKING_IF_SLOT_AVAILABLE'`,
  },
  {
    name: '230000.2', msg: 'call target identifies zero or both of patient/lead',
    checkSql: `SELECT count(*)::int AS n FROM "ReceptionistCallTarget" WHERE (("patientId" IS NOT NULL)::int + ("leadId" IS NOT NULL)::int) <> 1`,
    rowsSql: `SELECT "id","tenantId","campaignId","patientId","leadId","phone","status","createdAt" FROM "ReceptionistCallTarget" WHERE (("patientId" IS NOT NULL)::int + ("leadId" IS NOT NULL)::int) <> 1 LIMIT 10`,
    fixSql: `DELETE FROM "ReceptionistCallTarget" WHERE (("patientId" IS NOT NULL)::int + ("leadId" IS NOT NULL)::int) <> 1`,
  },
  {
    name: '230000.3', msg: 'duplicate (tenant,campaign,phone) call targets',
    checkSql: `SELECT count(*)::int AS n FROM (SELECT 1 FROM "ReceptionistCallTarget" GROUP BY "tenantId","campaignId","phone" HAVING COUNT(*) > 1) x`,
    rowsSql: `SELECT "tenantId","campaignId","phone",count(*)::int AS copies FROM "ReceptionistCallTarget" GROUP BY "tenantId","campaignId","phone" HAVING COUNT(*) > 1 LIMIT 10`,
    fixSql: `DELETE FROM "ReceptionistCallTarget" AS t USING "ReceptionistCallTarget" AS keep WHERE keep."tenantId" = t."tenantId" AND keep."campaignId" = t."campaignId" AND keep."phone" = t."phone" AND (keep."createdAt", keep."id") < (t."createdAt", t."id")`,
  },
  {
    name: '230000.4', msg: 'call target patient/lead selector orphaned or cross-tenant',
    checkSql: `SELECT count(*)::int AS n FROM "ReceptionistCallTarget" target LEFT JOIN "Patient" patient ON patient."tenantId" = target."tenantId" AND patient."id" = target."patientId" LEFT JOIN "Lead" lead ON lead."tenantId" = target."tenantId" AND lead."id" = target."leadId" WHERE (target."patientId" IS NOT NULL AND patient."id" IS NULL) OR (target."leadId" IS NOT NULL AND lead."id" IS NULL)`,
    rowsSql: `SELECT target."id",target."tenantId",target."campaignId",target."patientId",target."leadId",target."phone" FROM "ReceptionistCallTarget" target LEFT JOIN "Patient" patient ON patient."tenantId" = target."tenantId" AND patient."id" = target."patientId" LEFT JOIN "Lead" lead ON lead."tenantId" = target."tenantId" AND lead."id" = target."leadId" WHERE (target."patientId" IS NOT NULL AND patient."id" IS NULL) OR (target."leadId" IS NOT NULL AND lead."id" IS NULL) LIMIT 10`,
    fixSql: `DELETE FROM "ReceptionistCallTarget" AS target WHERE (target."patientId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Patient" patient WHERE patient."tenantId" = target."tenantId" AND patient."id" = target."patientId")) OR (target."leadId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Lead" lead WHERE lead."tenantId" = target."tenantId" AND lead."id" = target."leadId"))`,
  },
  // ── 20260730250000_receptionist_delivery_consent_integrity ────────────────
  {
    name: '250000.1', msg: 'outbound campaign clinic/default-branch orphaned or cross-tenant',
    checkSql: `SELECT count(*)::int AS n FROM "ReceptionistOutboundCampaign" campaign LEFT JOIN "ReceptionistClinic" clinic ON clinic."tenantId" = campaign."tenantId" AND clinic.id = campaign."clinicId" LEFT JOIN "Branch" branch ON branch."tenantId" = campaign."tenantId" AND branch.id = campaign."defaultBranchId" WHERE clinic.id IS NULL OR (campaign."defaultBranchId" IS NOT NULL AND branch.id IS NULL)`,
    rowsSql: `SELECT campaign."id",campaign."tenantId",campaign."clinicId",campaign."defaultBranchId",campaign."name",campaign."status" FROM "ReceptionistOutboundCampaign" campaign LEFT JOIN "ReceptionistClinic" clinic ON clinic."tenantId" = campaign."tenantId" AND clinic.id = campaign."clinicId" LEFT JOIN "Branch" branch ON branch."tenantId" = campaign."tenantId" AND branch.id = campaign."defaultBranchId" WHERE clinic.id IS NULL OR (campaign."defaultBranchId" IS NOT NULL AND branch.id IS NULL) LIMIT 10`,
    fixSql: `DELETE FROM "ReceptionistOutboundCampaign" campaign WHERE NOT EXISTS (SELECT 1 FROM "ReceptionistClinic" clinic WHERE clinic."tenantId" = campaign."tenantId" AND clinic.id = campaign."clinicId") OR (campaign."defaultBranchId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Branch" branch WHERE branch."tenantId" = campaign."tenantId" AND branch.id = campaign."defaultBranchId"))`,
  },
  {
    name: '250000.2', msg: 'call target campaign orphaned or cross-tenant',
    checkSql: `SELECT count(*)::int AS n FROM "ReceptionistCallTarget" target LEFT JOIN "ReceptionistOutboundCampaign" campaign ON campaign."tenantId" = target."tenantId" AND campaign.id = target."campaignId" WHERE campaign.id IS NULL`,
    rowsSql: `SELECT target."id",target."tenantId",target."campaignId",target."phone" FROM "ReceptionistCallTarget" target LEFT JOIN "ReceptionistOutboundCampaign" campaign ON campaign."tenantId" = target."tenantId" AND campaign.id = target."campaignId" WHERE campaign.id IS NULL LIMIT 10`,
    fixSql: `DELETE FROM "ReceptionistCallTarget" target WHERE NOT EXISTS (SELECT 1 FROM "ReceptionistOutboundCampaign" campaign WHERE campaign."tenantId" = target."tenantId" AND campaign.id = target."campaignId")`,
  },
  {
    name: '250000.3', msg: 'call log clinic/campaign/target reference dangling',
    checkSql: `SELECT count(*)::int AS n FROM "ReceptionistCallLog" call LEFT JOIN "ReceptionistClinic" clinic ON clinic."tenantId" = call."tenantId" AND clinic.id = call."clinicId" LEFT JOIN "ReceptionistCampaign" booking_campaign ON booking_campaign."tenantId" = call."tenantId" AND booking_campaign.id = call."campaignId" LEFT JOIN "ReceptionistOutboundCampaign" outbound_campaign ON outbound_campaign."tenantId" = call."tenantId" AND outbound_campaign.id = call."outboundCampaignId" LEFT JOIN "ReceptionistCallTarget" target ON target."tenantId" = call."tenantId" AND target."campaignId" = call."outboundCampaignId" AND target.id = call."targetId" WHERE (call."clinicId" IS NOT NULL AND clinic.id IS NULL) OR (call."campaignId" IS NOT NULL AND booking_campaign.id IS NULL) OR (call."outboundCampaignId" IS NOT NULL AND outbound_campaign.id IS NULL) OR (call."targetId" IS NOT NULL AND target.id IS NULL)`,
    rowsSql: `SELECT call."id",call."tenantId",call."clinicId",call."campaignId",call."outboundCampaignId",call."targetId",call."outcome" FROM "ReceptionistCallLog" call LEFT JOIN "ReceptionistClinic" clinic ON clinic."tenantId" = call."tenantId" AND clinic.id = call."clinicId" LEFT JOIN "ReceptionistCampaign" booking_campaign ON booking_campaign."tenantId" = call."tenantId" AND booking_campaign.id = call."campaignId" LEFT JOIN "ReceptionistOutboundCampaign" outbound_campaign ON outbound_campaign."tenantId" = call."tenantId" AND outbound_campaign.id = call."outboundCampaignId" LEFT JOIN "ReceptionistCallTarget" target ON target."tenantId" = call."tenantId" AND target."campaignId" = call."outboundCampaignId" AND target.id = call."targetId" WHERE (call."clinicId" IS NOT NULL AND clinic.id IS NULL) OR (call."campaignId" IS NOT NULL AND booking_campaign.id IS NULL) OR (call."outboundCampaignId" IS NOT NULL AND outbound_campaign.id IS NULL) OR (call."targetId" IS NOT NULL AND target.id IS NULL) LIMIT 10`,
    fixSql: `UPDATE "ReceptionistCallLog" call SET "clinicId" = CASE WHEN call."clinicId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "ReceptionistClinic" clinic WHERE clinic."tenantId" = call."tenantId" AND clinic.id = call."clinicId") THEN NULL ELSE call."clinicId" END, "campaignId" = CASE WHEN call."campaignId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "ReceptionistCampaign" bc WHERE bc."tenantId" = call."tenantId" AND bc.id = call."campaignId") THEN NULL ELSE call."campaignId" END, "outboundCampaignId" = CASE WHEN call."outboundCampaignId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "ReceptionistOutboundCampaign" oc WHERE oc."tenantId" = call."tenantId" AND oc.id = call."outboundCampaignId") THEN NULL ELSE call."outboundCampaignId" END, "targetId" = CASE WHEN call."targetId" IS NOT NULL AND (NOT EXISTS (SELECT 1 FROM "ReceptionistCallTarget" t WHERE t."tenantId" = call."tenantId" AND t."campaignId" = call."outboundCampaignId" AND t.id = call."targetId") OR NOT EXISTS (SELECT 1 FROM "ReceptionistOutboundCampaign" oc2 WHERE oc2."tenantId" = call."tenantId" AND oc2.id = call."outboundCampaignId")) THEN NULL ELSE call."targetId" END WHERE (call."clinicId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "ReceptionistClinic" clinic WHERE clinic."tenantId" = call."tenantId" AND clinic.id = call."clinicId")) OR (call."campaignId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "ReceptionistCampaign" bc WHERE bc."tenantId" = call."tenantId" AND bc.id = call."campaignId")) OR (call."outboundCampaignId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "ReceptionistOutboundCampaign" oc WHERE oc."tenantId" = call."tenantId" AND oc.id = call."outboundCampaignId")) OR (call."targetId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "ReceptionistCallTarget" t WHERE t."tenantId" = call."tenantId" AND t."campaignId" = call."outboundCampaignId" AND t.id = call."targetId"))`,
  },
  {
    name: '250000.4', msg: 'call target lastCallLogId dangling or cross-campaign',
    checkSql: `SELECT count(*)::int AS n FROM "ReceptionistCallTarget" target LEFT JOIN "ReceptionistCallLog" call ON call."tenantId" = target."tenantId" AND call."outboundCampaignId" = target."campaignId" AND call.id = target."lastCallLogId" WHERE target."lastCallLogId" IS NOT NULL AND call.id IS NULL`,
    rowsSql: `SELECT target."id",target."tenantId",target."campaignId",target."lastCallLogId",target."phone" FROM "ReceptionistCallTarget" target LEFT JOIN "ReceptionistCallLog" call ON call."tenantId" = target."tenantId" AND call."outboundCampaignId" = target."campaignId" AND call.id = target."lastCallLogId" WHERE target."lastCallLogId" IS NOT NULL AND call.id IS NULL LIMIT 10`,
    fixSql: `UPDATE "ReceptionistCallTarget" target SET "lastCallLogId" = NULL WHERE target."lastCallLogId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "ReceptionistCallLog" call WHERE call."tenantId" = target."tenantId" AND call."outboundCampaignId" = target."campaignId" AND call.id = target."lastCallLogId")`,
  },
  {
    name: '250000.5', msg: 'communication consent names zero or both of patient/lead',
    checkSql: `SELECT count(*)::int AS n FROM "CommunicationConsent" WHERE (("patientId" IS NOT NULL)::int + ("leadId" IS NOT NULL)::int) <> 1`,
    rowsSql: `SELECT "id","tenantId","patientId","leadId",channel,"capturedAt" FROM "CommunicationConsent" WHERE (("patientId" IS NOT NULL)::int + ("leadId" IS NOT NULL)::int) <> 1 LIMIT 10`,
    fixSql: `DELETE FROM "CommunicationConsent" WHERE (("patientId" IS NOT NULL)::int + ("leadId" IS NOT NULL)::int) <> 1`,
  },
  {
    name: '250000.6', msg: 'duplicate consent per (tenant,patient,lead,channel)',
    checkSql: `SELECT count(*)::int AS n FROM (SELECT 1 FROM "CommunicationConsent" GROUP BY "tenantId","patientId","leadId",channel HAVING count(*) > 1) x`,
    rowsSql: `SELECT "tenantId","patientId","leadId",channel,count(*)::int AS copies FROM "CommunicationConsent" GROUP BY "tenantId","patientId","leadId",channel HAVING count(*) > 1 LIMIT 10`,
    fixSql: `DELETE FROM "CommunicationConsent" WHERE id IN (SELECT id FROM (SELECT id, row_number() OVER (PARTITION BY "tenantId","patientId","leadId",channel ORDER BY "capturedAt" DESC, "createdAt" DESC, id DESC) AS rn FROM "CommunicationConsent") ranked WHERE rn > 1)`,
  },
  {
    name: '250000.7', msg: 'confirmation NotificationEvent has fabricated/incomplete state (NO SAFE FIX; expect 0 - table hours old)',
    checkSql: `SELECT count(*)::int AS n FROM "NotificationEvent" event WHERE event.source = 'receptionist.appointment_confirmation' AND (event.status = 'sent' OR (event.status IN ('accepted','delivered') AND (event."acceptedAt" IS NULL OR NULLIF(btrim(event.provider), '') IS NULL OR NULLIF(btrim(event."providerMessageId"), '') IS NULL OR event.attempts < 1)) OR (event.status = 'delivered' AND event."deliveredAt" IS NULL))`,
    rowsSql: `SELECT id,"tenantId",status,provider,"providerMessageId",attempts FROM "NotificationEvent" event WHERE event.source = 'receptionist.appointment_confirmation' AND (event.status = 'sent' OR (event.status IN ('accepted','delivered') AND (event."acceptedAt" IS NULL OR NULLIF(btrim(event.provider), '') IS NULL OR NULLIF(btrim(event."providerMessageId"), '') IS NULL OR event.attempts < 1)) OR (event.status = 'delivered' AND event."deliveredAt" IS NULL)) LIMIT 10`,
    fixSql: null,
  },
  {
    name: '250000.8', msg: 'confirmation RESULT attempt without matching INTENT (NO SAFE FIX; expect 0 - table hours old)',
    checkSql: `SELECT count(*)::int AS n FROM "NotificationDeliveryAttempt" result JOIN "NotificationEvent" event ON event."tenantId" = result."tenantId" AND event.id = result."notificationEventId" WHERE event.source = 'receptionist.appointment_confirmation' AND result.phase = 'RESULT' AND NOT EXISTS (SELECT 1 FROM "NotificationDeliveryAttempt" intent WHERE intent."tenantId" = result."tenantId" AND intent."notificationEventId" = result."notificationEventId" AND intent."attemptNumber" = result."attemptNumber" AND intent.phase = 'INTENT')`,
    rowsSql: `SELECT result.id,result."tenantId",result."notificationEventId",result."attemptNumber" FROM "NotificationDeliveryAttempt" result JOIN "NotificationEvent" event ON event."tenantId" = result."tenantId" AND event.id = result."notificationEventId" WHERE event.source = 'receptionist.appointment_confirmation' AND result.phase = 'RESULT' AND NOT EXISTS (SELECT 1 FROM "NotificationDeliveryAttempt" intent WHERE intent."tenantId" = result."tenantId" AND intent."notificationEventId" = result."notificationEventId" AND intent."attemptNumber" = result."attemptNumber" AND intent.phase = 'INTENT') LIMIT 10`,
    fixSql: null,
  },
  // ── 20260730260000_receptionist_provider_boundary_recovery ────────────────
  {
    name: '260000.1', msg: 'retrying confirmation lacks coherent attempt evidence',
    checkSql: `SELECT count(*)::int AS n FROM "NotificationEvent" e WHERE e.source='receptionist.appointment_confirmation' AND e.status='retrying' AND (e.attempts < 1 OR NOT EXISTS (SELECT 1 FROM "NotificationDeliveryAttempt" a WHERE a."tenantId"=e."tenantId" AND a."notificationEventId"=e.id AND a."attemptNumber"=e.attempts AND a.phase='INTENT') OR EXISTS (SELECT 1 FROM "NotificationDeliveryAttempt" a WHERE a."tenantId"=e."tenantId" AND a."notificationEventId"=e.id AND a."attemptNumber"=e.attempts AND a.phase='RESULT'))`,
    rowsSql: `SELECT id,"tenantId",status,attempts,"nextAttemptAt" FROM "NotificationEvent" e WHERE e.source='receptionist.appointment_confirmation' AND e.status='retrying' AND (e.attempts < 1 OR NOT EXISTS (SELECT 1 FROM "NotificationDeliveryAttempt" a WHERE a."tenantId"=e."tenantId" AND a."notificationEventId"=e.id AND a."attemptNumber"=e.attempts AND a.phase='INTENT') OR EXISTS (SELECT 1 FROM "NotificationDeliveryAttempt" a WHERE a."tenantId"=e."tenantId" AND a."notificationEventId"=e.id AND a."attemptNumber"=e.attempts AND a.phase='RESULT')) LIMIT 10`,
    fixSql: `UPDATE "NotificationEvent" e SET status='dead_lettered', "nextAttemptAt"=NULL, "deadLetteredAt"=clock_timestamp(), "updatedAt"=clock_timestamp() WHERE e.source='receptionist.appointment_confirmation' AND e.status='retrying' AND (e.attempts < 1 OR NOT EXISTS (SELECT 1 FROM "NotificationDeliveryAttempt" a WHERE a."tenantId"=e."tenantId" AND a."notificationEventId"=e.id AND a."attemptNumber"=e.attempts AND a.phase='INTENT') OR EXISTS (SELECT 1 FROM "NotificationDeliveryAttempt" a WHERE a."tenantId"=e."tenantId" AND a."notificationEventId"=e.id AND a."attemptNumber"=e.attempts AND a.phase='RESULT'))`,
  },
  // ── 20260730280000_campaign_integrity ─────────────────────────────────────
  {
    name: '280000.1', msg: 'duplicate CampaignDelivery per (campaign,patient,lead,channel)',
    checkSql: `SELECT count(*)::int AS n FROM (SELECT "campaignId","patientId","leadId",channel FROM "CampaignDelivery" GROUP BY "campaignId","patientId","leadId",channel HAVING count(*) > 1) x`,
    rowsSql: `SELECT "campaignId","patientId","leadId",channel,count(*)::int AS copies FROM "CampaignDelivery" GROUP BY "campaignId","patientId","leadId",channel HAVING count(*) > 1 LIMIT 10`,
    fixSql: `DELETE FROM "CampaignDelivery" WHERE id IN (SELECT id FROM (SELECT id, row_number() OVER (PARTITION BY "campaignId","patientId","leadId",channel ORDER BY ("providerMessageId" IS NOT NULL) DESC, "createdAt" DESC, id DESC) AS rn FROM "CampaignDelivery") ranked WHERE ranked.rn > 1)`,
  },
];

const MAX_TOTAL_OFFENDERS = 50;

async function runCheck(spec: Spec): Promise<number> {
  try {
    return (await c.query(spec.checkSql)).rows[0].n as number;
  } catch (e) {
    const msg = (e as Error).message;
    if (/does not exist/.test(msg)) { console.log(`  ${spec.name}: not yet checkable (${msg.split('\n')[0]})`); return 0; }
    throw e;
  }
}

async function main() {
  await c.connect();
  const who = await c.query('select current_user, current_database()');
  console.log('connected:', JSON.stringify(who.rows[0]));

  console.log('\n===== PHASE 1: read-only survey of all guards =====');
  let total = 0; const failing: Spec[] = [];
  for (const spec of SPECS) {
    const n = await runCheck(spec);
    console.log(`  ${spec.name} [${spec.msg}] -> ${n}`);
    if (n > 0) {
      failing.push(spec); total += n;
      const rows = await c.query(spec.rowsSql);
      console.log('    offending rows:', JSON.stringify(rows.rows, null, 2).split('\n').join('\n    '));
    }
  }

  if (total > MAX_TOTAL_OFFENDERS) { console.error(`\nABORT: ${total} offenders > ${MAX_TOTAL_OFFENDERS}; this does not look like demo data. Nothing changed.`); process.exit(1); }
  const unfixable = failing.filter(s => !s.fixSql);
  if (unfixable.length) { console.error(`\nABORT: guard(s) with no safe fix are failing: ${unfixable.map(s => s.name).join(', ')}. Nothing changed.`); process.exit(1); }
  if (!failing.length) console.log('\nAll guards already clean; proceeding to clear failed migration state only.');

  console.log('\n===== PHASE 2: transactional fix =====');
  await c.query('BEGIN');
  try {
    for (let pass = 1; pass <= 3; pass++) {
      let dirty = 0;
      for (const spec of SPECS) {
        if (!spec.fixSql) continue;
        const n = await runCheck(spec);
        if (n === 0) continue;
        const r = await c.query(spec.fixSql);
        console.log(`  pass ${pass}: ${spec.name} fixed ${r.rowCount} row(s)`);
        dirty++;
      }
      if (!dirty) break;
    }
    console.log('\n  final re-check (all must be 0):');
    let bad = 0;
    for (const spec of SPECS) {
      const n = await runCheck(spec);
      console.log(`    ${spec.name} = ${n}`);
      if (n !== 0) bad++;
    }
    if (bad) throw new Error(`${bad} guard(s) still failing after 3 passes`);

    const mig = await c.query(`UPDATE _prisma_migrations SET rolled_back_at = now() WHERE finished_at IS NULL AND rolled_back_at IS NULL RETURNING migration_name`);
    console.log(`\n  failed migrations marked rolled back: ${mig.rows.map(r => r.migration_name).join(', ') || '(none)'}`);

    await c.query('COMMIT');
    console.log('\nCOMMITTED. Redeploy now - the full migration chain should apply.');
  } catch (e) {
    await c.query('ROLLBACK');
    console.error('ROLLED BACK:', (e as Error).message);
    process.exit(1);
  }
  await c.end();
}
await main();
