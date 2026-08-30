import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../../lib/db';
import { buildPilotChecklist, createPilotShareToken } from '../../lib/pilotStatus';
import { platformAuditEvent, requirePlatformAccess } from '../../lib/platformAuth';
import { platformDb } from '../../lib/platformDb';
import { runWithPlatformDatabaseRequest } from '../../lib/platformContextStore';
import { enterTenantContext, type TenantTxClient } from '../../lib/tenantContext';
import {
  analyzePilotImport,
  buildPreviewSample,
  buildPilotTemplateCsv,
  type PilotEntityType,
  type PilotImportRow,
  type PilotFieldSpec,
  PILOT_ENTITY_SPECS,
} from '../../lib/pilotImport';

const pilotAdmin = requirePlatformAccess('PLATFORM_ADMIN');
const uuid = z.string().uuid();
const entityTypeSchema = z.enum(['patients', 'appointments', 'insurance']);
const importBodySchema = z.object({
  csvText: z.string().trim().min(1).max(2_000_000),
  mapping: z.record(z.string(), z.string()).default({}),
});
const presetBodySchema = z.object({
  entityType: entityTypeSchema,
  name: z.string().trim().min(2).max(80),
  mapping: z.record(z.string(), z.string()).default({}),
  isDefault: z.boolean().default(false),
});
const shareBodySchema = z.object({
  label: z.string().trim().min(2).max(120).optional(),
  expiresInDays: z.coerce.number().int().min(1).max(90).default(14),
});
const patientLifecycleStages = new Set(['NEW', 'ACTIVE', 'AT_RISK', 'INACTIVE', 'LOST', 'RETAINED']);
const appointmentStatuses = new Set(['CONFIRMED', 'RISKY', 'ARRIVED', 'NO_SHOW', 'CANCELED', 'COMPLETED', 'WAITLIST']);
const appointmentChannels = new Set(['WHATSAPP', 'SMS', 'EMAIL', 'PUSH', 'CALL', 'VIDEO']);

function safeEnumValue(value: string | null | undefined, allowed: Set<string>, fallback: string) {
  if (!value) return fallback;
  const normalized = value.trim().toUpperCase();
  return allowed.has(normalized) ? normalized : fallback;
}

function safeNumberValue(value: string | null | undefined, fallback: number) {
  if (value == null) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function safeBoolValue(value: string | null | undefined, fallback: boolean) {
  if (value == null) return fallback;
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'active'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n', 'inactive'].includes(normalized)) return false;
  return fallback;
}

function rowHasFatalIssues(row: PilotImportRow): boolean {
  return row.status === 'error';
}

// Takes the commit's transaction client: a branch invented for row 400 must
// disappear with the rest of the import if row 900 brings it down.
async function loadOrCreateBranch(tx: TenantTxClient, tenantId: string, branchName: string | null | undefined) {
  const normalized = branchName?.trim();
  if (!normalized) {
    const existing = await tx.branch.findFirst({ where: { tenantId }, orderBy: { createdAt: 'asc' } });
    if (!existing) throw new Error('Tenant has no branch yet');
    return existing;
  }
  const existing = await tx.branch.findFirst({ where: { tenantId, name: { equals: normalized, mode: 'insensitive' } } });
  if (existing) return existing;
  return tx.branch.create({ data: { tenantId, name: normalized, location: normalized } });
}

function fieldSpecs(entityType: PilotEntityType): PilotFieldSpec[] {
  return PILOT_ENTITY_SPECS[entityType];
}

async function loadPresetMapping(tenantId: string, entityType: PilotEntityType) {
  const preset = await db.pilotImportPreset.findFirst({
    where: { tenantId, entityType },
    orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }],
  });
  return preset ? { preset, mapping: (preset.mapping ?? {}) as Record<string, string> } : { preset: null, mapping: {} as Record<string, string> };
}

// Resolve a CSV provider reference to the canonical ProviderProfile link.
//
// Appointment.providerProfileId is what the double-booking exclusion constraint
// binds on, and what every conflict, availability and past-date guard checks
// before it does anything. An appointment carrying only the legacy free-text
// providerRef is invisible to all of it: the audit booked the same patient into
// the same slot twice and rescheduled a confirmed appointment into 2019, purely
// because every imported row had a NULL provider. A practice migrating off
// Dentrix or Open Dental would land its entire history in that state.
//
// Matched on the clinic's own vocabulary: the profile id, the clinician's login
// email, or their display name. Anything unmatched is REPORTED rather than
// quietly dropped — silently importing an appointment outside the scheduling
// guards is how the current data got this way.
async function providerLookup(tx: TenantTxClient, tenantId: string) {
  const profiles = await tx.providerProfile.findMany({
    where: { tenantId },
    select: { id: true, user: { select: { displayName: true, email: true } } },
  });
  const byKey = new Map<string, string>();
  for (const profile of profiles) {
    byKey.set(profile.id.toLowerCase(), profile.id);
    if (profile.user?.email) byKey.set(profile.user.email.trim().toLowerCase(), profile.id);
    if (profile.user?.displayName) byKey.set(profile.user.displayName.trim().toLowerCase(), profile.id);
  }
  return (ref: string | null): string | null => (ref ? byKey.get(ref.trim().toLowerCase()) ?? null : null);
}

export const pilotRoutes: FastifyPluginAsync = async app => {
  // Same scope platformRoutes establishes: platformDb only sets its actor GUCs
  // inside this store, and without it every platform-plane read here is denied
  // by RLS and silently returns nothing.
  app.addHook('onRequest', (_request, _reply, done) => runWithPlatformDatabaseRequest(done));
  app.addHook('preHandler', pilotAdmin);

  // Every route below is scoped to /tenants/:tenantId and reads or writes TENANT
  // tables — Tenant, Branch, Patient, Appointment, InsurancePayer,
  // PatientInsurancePolicy — through the RLS runtime client (lib/db.ts), which
  // only sets app.current_tenant_id inside a tenant context. These routes ran
  // without one, and both tables carry FORCE ROW LEVEL SECURITY while neither
  // app_rls nor app_platform holds BYPASSRLS, so the plugin failed two ways at
  // once: the CSV commit died on `42501 new row violates row-level security
  // policy for table "Branch"` before a single row landed, and every route that
  // first resolves the workspace matched zero Tenant rows and returned 404 for
  // tenants that plainly exist.
  //
  // The database already models this exact caller. app_rls_tenant_allowed() has
  // a `source = 'platform'` branch that admits a tenant-scoped query when the
  // actor is an ACTIVE PlatformUser, so a platform admin gets in on their own
  // identity while every row stays inside the tenant they named. That branch
  // matches the actor id against a bare UUID — a decorated value like
  // "platform:<id>" fails the pattern and the policy denies the read — so the
  // platform user id is passed through unadorned, and the legacy static token
  // (a synthetic actor backed by no PlatformUser row) is denied, as it should be
  // on a route that writes real clinic data.
  app.addHook('preHandler', async (request, reply) => {
    const params = request.params as { tenantId?: string } | undefined;
    const parsed = uuid.safeParse(params?.tenantId);
    if (!parsed.success) return; // the route's own parse answers with a 400

    const actor = request.platformUser;

    // Break-glass, same contract as the staff roster.
    //
    // These routes read and write a clinic's Patient, Appointment and
    // PatientInsurancePolicy rows. The RLS `source = 'platform'` branch admits
    // ANY active PlatformUser to ANY tenant table, so without this check the
    // most sensitive platform capability we have was also the only one with no
    // reason recorded, no expiry and nothing for the clinic to see afterwards -
    // while the strict `source = 'support'` branch, built for exactly this, sat
    // unused. Requiring a live session here does not weaken the database
    // policy; it stops us relying on a route guard as the only control over
    // vendor access to patient data.
    const session = await platformDb.supportAccessSession.findFirst({
      where: { tenantId: parsed.data, endedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { startedAt: 'desc' },
      select: { id: true },
    });
    if (!session) {
      return reply.code(403).send({
        error: 'support_session_required',
        message: 'Open a support session for this workspace before importing or reading its clinic data. The session records your reason and expires on its own.',
      });
    }

    enterTenantContext({
      tenantId: parsed.data,
      // Bare id: app_rls_tenant_allowed() requires a UUID that resolves to an
      // active PlatformUser. platformAuditEvent() records who acted separately.
      actorId: actor?.id ?? 'platform:unidentified',
      actorRole: actor?.role ?? 'PLATFORM_ADMIN',
      source: 'platform',
      requestId: request.id,
    });

    // One cheap read inside the context just entered. A live workspace returns
    // its row; an unknown, suspended or archived one makes the context check
    // fail closed. Either way the caller gets a workspace-shaped answer instead
    // of an internal error surfacing from somewhere deeper in the import.
    const known = await db.tenant
      .findUnique({ where: { id: parsed.data }, select: { id: true } })
      .catch(() => null);
    if (!known) {
      return reply.code(404).send({
        error: 'tenant_not_found',
        message: 'That workspace could not be found, or is no longer active.',
      });
    }
  });

  app.get('/tenants/:tenantId/pilot-checklist', async (request, reply) => {
    const { tenantId } = z.object({ tenantId: uuid }).parse(request.params);
    const checklist = await buildPilotChecklist(tenantId);
    if (!checklist) return reply.code(404).send({ error: 'not_found', message: 'Tenant not found' });
    await platformAuditEvent(request, 'pilot.checklist.viewed', { type: 'tenant', id: tenantId, tenantId }, { readinessScore: checklist.readinessScore, readyCount: checklist.readyCount, itemCount: checklist.itemCount });
    return checklist;
  });

  app.get('/tenants/:tenantId/pilot-import/:entityType/template.csv', async (request, reply) => {
    const { tenantId, entityType } = z.object({ tenantId: uuid, entityType: entityTypeSchema }).parse(request.params);
    const tenant = await db.tenant.findUnique({ where: { id: tenantId }, select: { id: true } });
    if (!tenant) return reply.code(404).send({ error: 'not_found', message: 'Tenant not found' });
    const { csv } = buildPilotTemplateCsv(entityType);
    await platformAuditEvent(request, 'pilot.import.template.downloaded', { type: 'tenant', id: tenantId, tenantId }, { entityType });
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="pilot-${entityType}-template.csv"`)
      .send(csv);
  });

  app.get('/tenants/:tenantId/pilot-import/presets', async (request, reply) => {
    const { tenantId } = z.object({ tenantId: uuid }).parse(request.params);
    const { entityType } = z.object({ entityType: entityTypeSchema.optional() }).parse(request.query);
    const tenant = await db.tenant.findUnique({ where: { id: tenantId }, select: { id: true } });
    if (!tenant) return reply.code(404).send({ error: 'not_found', message: 'Tenant not found' });
    const rows = await db.pilotImportPreset.findMany({
      where: { tenantId, ...(entityType ? { entityType } : {}) },
      orderBy: [{ entityType: 'asc' }, { isDefault: 'desc' }, { updatedAt: 'desc' }],
    });
    return rows.map((row: { id: string; tenantId: string; entityType: string; name: string; isDefault: boolean; mapping: unknown; createdAt: Date; updatedAt: Date }) => ({
      id: row.id,
      tenantId: row.tenantId,
      entityType: row.entityType as PilotEntityType,
      name: row.name,
      isDefault: row.isDefault,
      mapping: row.mapping,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
  });

  app.post('/tenants/:tenantId/pilot-import/presets', async (request, reply) => {
    const { tenantId } = z.object({ tenantId: uuid }).parse(request.params);
    const body = presetBodySchema.parse(request.body);
    const tenant = await db.tenant.findUnique({ where: { id: tenantId }, select: { id: true } });
    if (!tenant) return reply.code(404).send({ error: 'not_found', message: 'Tenant not found' });
    const mapping = body.mapping ?? {};
    if (body.isDefault) {
      await db.pilotImportPreset.updateMany({ where: { tenantId, entityType: body.entityType, isDefault: true }, data: { isDefault: false } });
    }
    const preset = await db.pilotImportPreset.upsert({
      where: { tenantId_entityType_name: { tenantId, entityType: body.entityType, name: body.name } },
      update: { mapping, isDefault: body.isDefault },
      create: { tenantId, entityType: body.entityType, name: body.name, mapping, isDefault: body.isDefault },
    });
    await platformAuditEvent(request, 'pilot.import.preset.saved', { type: 'tenant', id: tenantId, tenantId }, { entityType: body.entityType, name: body.name, isDefault: body.isDefault });
    return reply.code(201).send({
      id: preset.id,
      tenantId: preset.tenantId,
      entityType: preset.entityType as PilotEntityType,
      name: preset.name,
      isDefault: preset.isDefault,
      mapping: preset.mapping,
      createdAt: preset.createdAt.toISOString(),
      updatedAt: preset.updatedAt.toISOString(),
    });
  });

  app.delete('/tenants/:tenantId/pilot-import/presets/:presetId', async (request, reply) => {
    const { tenantId, presetId } = z.object({ tenantId: uuid, presetId: uuid }).parse(request.params);
    const preset = await db.pilotImportPreset.findFirst({ where: { id: presetId, tenantId }, select: { id: true, entityType: true, name: true } });
    if (!preset) return reply.code(404).send({ error: 'not_found', message: 'Preset not found' });
    await db.pilotImportPreset.delete({ where: { id: presetId } });
    await platformAuditEvent(request, 'pilot.import.preset.deleted', { type: 'tenant', id: tenantId, tenantId }, { entityType: preset.entityType, name: preset.name });
    return reply.code(204).send();
  });

  app.get('/tenants/:tenantId/pilot-status-links', async (request, reply) => {
    const { tenantId } = z.object({ tenantId: uuid }).parse(request.params);
    const tenant = await db.tenant.findUnique({ where: { id: tenantId }, select: { id: true } });
    if (!tenant) return reply.code(404).send({ error: 'not_found', message: 'Tenant not found' });
    const rows = await db.pilotStatusShare.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' }, take: 20 });
    return rows.map((row: { id: string; tenantId: string; label: string | null; expiresAt: Date; lastViewedAt: Date | null; createdAt: Date; updatedAt: Date }) => ({
      id: row.id,
      tenantId: row.tenantId,
      label: row.label,
      expiresAt: row.expiresAt.toISOString(),
      lastViewedAt: row.lastViewedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      active: row.expiresAt.getTime() > Date.now(),
      url: `${process.env.PUBLIC_APP_URL ?? ''}/pilot/${row.id}`,
    }));
  });

  app.post('/tenants/:tenantId/pilot-status-links', async (request, reply) => {
    const { tenantId } = z.object({ tenantId: uuid }).parse(request.params);
    const body = shareBodySchema.parse(request.body);
    const tenant = await db.tenant.findUnique({ where: { id: tenantId }, select: { id: true, name: true, slug: true } });
    if (!tenant) return reply.code(404).send({ error: 'not_found', message: 'Tenant not found' });
    const { token, hash } = createPilotShareToken();
    const expiresAt = new Date(Date.now() + body.expiresInDays * 86400000);
    const row = await db.pilotStatusShare.create({
      data: {
        tenantId,
        tokenHash: hash,
        label: body.label?.trim() || null,
        expiresAt,
        createdById: request.platformUser?.legacy ? null : request.platformUser?.id,
      },
    });
    await platformAuditEvent(request, 'pilot.status_link.created', { type: 'tenant', id: tenantId, tenantId }, { label: row.label, expiresAt: row.expiresAt.toISOString() });
    return reply.code(201).send({
      id: row.id,
      tenantId: row.tenantId,
      label: row.label,
      expiresAt: row.expiresAt.toISOString(),
      token,
      url: `${process.env.PUBLIC_APP_URL ?? ''}/pilot/${token}`,
      clinicName: tenant.name,
      clinicSlug: tenant.slug,
    });
  });

  app.post('/tenants/:tenantId/pilot-import/:entityType/preview', async request => {
    const { tenantId, entityType } = z.object({ tenantId: uuid, entityType: entityTypeSchema }).parse(request.params);
    const body = importBodySchema.parse(request.body);
    const preset = await loadPresetMapping(tenantId, entityType);
    const mapping = { ...preset.mapping, ...body.mapping };
    const analysis = analyzePilotImport(entityType, body.csvText, mapping);
    await platformAuditEvent(request, 'pilot.import.previewed', { type: 'tenant', id: tenantId, tenantId }, { entityType, summary: analysis.summary, headers: analysis.headers.length });
    return {
      entityType,
      headers: analysis.headers,
      fields: fieldSpecs(entityType).map(field => ({
        key: field.key,
        label: field.label,
        required: field.required,
        example: field.example ?? null,
        mappedHeader: analysis.mapping[field.key] ?? null,
      })),
      mapping: analysis.mapping,
      preset: preset.preset ? { id: preset.preset.id, name: preset.preset.name, isDefault: preset.preset.isDefault } : null,
      summary: analysis.summary,
      rows: analysis.rows.slice(0, 25).map(row => ({
        index: row.index,
        status: row.status,
        issues: row.issues,
        sample: buildPreviewSample(row),
      })),
      canCommit: analysis.summary.invalid === 0 && analysis.summary.total > 0,
    };
  });

  app.post('/tenants/:tenantId/pilot-import/:entityType/commit', async (request, reply) => {
    const { tenantId, entityType } = z.object({ tenantId: uuid, entityType: entityTypeSchema }).parse(request.params);
    const body = importBodySchema.parse(request.body);
    const preset = await loadPresetMapping(tenantId, entityType);
    const mapping = { ...preset.mapping, ...body.mapping };
    const analysis = analyzePilotImport(entityType, body.csvText, mapping);
    const validRows = analysis.rows.filter(row => !rowHasFatalIssues(row));
    if (validRows.length === 0) return reply.code(400).send({ error: 'no_valid_rows', message: 'No rows are ready to import.' });

    // Durable intent on the platform plane, recorded BEFORE the work and in the
    // past-conditional: ".requested", not ".committed". The platform plane sits
    // on a different connection from the tenant transaction below, so it cannot
    // be atomic with it — a plane that cannot guarantee the outcome must not
    // assert one. The route previously wrote "pilot.import.committed" here after
    // the fact, which claimed an import that a later rollback could erase. The
    // outcome is recorded on the tenant plane, inside the same transaction as
    // the rows. Same order the public pilot-share route uses.
    await platformAuditEvent(
      request,
      'pilot.import.committed.requested',
      { type: 'tenant', id: tenantId, tenantId },
      { entityType, totalRows: analysis.summary.total, validRows: validRows.length },
    );

    // One transaction for the whole commit, tenant audit evidence included.
    // A pilot import carries a customer's real clinic data: applying it in
    // pieces leaves a half-populated workspace nobody can reconcile against the
    // source file, and evidence written separately can survive rows that were
    // rolled back — or describe rows that never landed. Both go in together or
    // neither does. Generous timeout: the CSV ceiling is 2MB of rows.
    const results = await db.$transaction(async tx => {
      const tally = { created: 0, updated: 0, skipped: 0, warnings: analysis.summary.warnings, providersUnmatched: 0 };
      const unmatchedProviderRefs = new Set<string>();
      const resolveProvider = entityType === 'appointments' ? await providerLookup(tx, tenantId) : null;

      for (const row of validRows) {
        if (entityType === 'patients') {
          const branch = await loadOrCreateBranch(tx, tenantId, row.values.branchName);
          const firstName = row.values.firstName?.trim();
          const lastName = row.values.lastName?.trim();
          if (!firstName || !lastName) { tally.skipped++; continue; }
          const email = row.values.email?.trim() || null;
          const phone = row.values.phone?.trim() || null;
          const lifecycleStage = safeEnumValue(row.values.lifecycleStage, patientLifecycleStages, 'NEW') as never;
          const tags = row.values.tags ? row.values.tags.split(/[;,|]/).map(v => v.trim()).filter(Boolean) : [];
          const externalRef = row.values.externalRef?.trim() || null;
          const existing = externalRef ? await tx.patient.findUnique({ where: { tenantId_externalRef: { tenantId, externalRef } } }) : null;
          if (existing) {
            await tx.patient.update({
              where: { id: existing.id },
              data: { branchId: branch.id, firstName, lastName, ...(email ? { email } : {}), ...(phone ? { phone } : {}), lifecycleStage, tags },
            });
            tally.updated++;
          } else {
            await tx.patient.create({ data: { tenantId, branchId: branch.id, firstName, lastName, ...(externalRef ? { externalRef } : {}), ...(email ? { email } : {}), ...(phone ? { phone } : {}), lifecycleStage, tags } });
            tally.created++;
          }
          continue;
        }

        if (entityType === 'appointments') {
          const patientRef = row.values.patientExternalRef?.trim();
          const service = row.values.service?.trim();
          const startsAt = row.values.startsAt ? new Date(row.values.startsAt) : null;
          const endsAt = row.values.endsAt ? new Date(row.values.endsAt) : null;
          if (!patientRef || !service || !startsAt || !endsAt) { tally.skipped++; continue; }
          const patient = await tx.patient.findUnique({ where: { tenantId_externalRef: { tenantId, externalRef: patientRef } }, select: { id: true, branchId: true } });
          if (!patient) { tally.skipped++; continue; }
          const branch = await loadOrCreateBranch(tx, tenantId, row.values.branchName);
          const status = safeEnumValue(row.values.status, appointmentStatuses, 'CONFIRMED') as never;
          const channel = safeEnumValue(row.values.channel, appointmentChannels, 'EMAIL') as never;
          const value = safeNumberValue(row.values.value, 0);
          const providerRef = row.values.providerRef?.trim() || null;
          // Keep providerRef as the clinic wrote it; add the canonical link so
          // the row is actually covered by the scheduling guards.
          const providerProfileId = resolveProvider?.(providerRef) ?? null;
          if (providerRef && !providerProfileId) {
            unmatchedProviderRefs.add(providerRef);
            tally.providersUnmatched++;
          }
          const notes = row.values.notes?.trim() || null;
          const existing = await tx.appointment.findFirst({ where: { tenantId, patientId: patient.id, startsAt, service } });
          if (existing) {
            await tx.appointment.update({
              where: { id: existing.id },
              data: { branchId: branch.id, endsAt, status, channel, value, providerProfileId, ...(providerRef ? { providerRef } : { providerRef: null }), ...(notes ? { notes } : { notes: null }) },
            });
            tally.updated++;
          } else {
            await tx.appointment.create({
              data: { tenantId, branchId: branch.id, patientId: patient.id, service, startsAt, endsAt, status, channel, value, ...(providerProfileId ? { providerProfileId } : {}), ...(providerRef ? { providerRef } : {}), ...(notes ? { notes } : {}) },
            });
            tally.created++;
          }
          continue;
        }

        if (entityType === 'insurance') {
          const patientRef = row.values.patientExternalRef?.trim();
          const planName = row.values.planName?.trim();
          const memberId = row.values.memberId?.trim();
          if (!patientRef || !planName || !memberId) { tally.skipped++; continue; }
          const patient = await tx.patient.findUnique({ where: { tenantId_externalRef: { tenantId, externalRef: patientRef } }, select: { id: true, branchId: true } });
          if (!patient) { tally.skipped++; continue; }
          const branch = await loadOrCreateBranch(tx, tenantId, row.values.branchName);
          const payerName = row.values.payerName?.trim() || 'Imported Payer';
          const payer = await tx.insurancePayer.upsert({
            where: { tenantId_name: { tenantId, name: payerName } },
            create: { tenantId, name: payerName, active: true, sourceProvider: 'import' },
            update: { active: true },
          });
          const verificationStatus = row.values.verificationStatus?.trim() || 'pending';
          const subscriberName = row.values.subscriberName?.trim() || null;
          const relationship = row.values.relationship?.trim() || null;
          const groupNumber = row.values.groupNumber?.trim() || null;
          const payerReference = row.values.payerReference?.trim() || null;
          const active = safeBoolValue(row.values.active, true);
          const existing = await tx.patientInsurancePolicy.findFirst({ where: { tenantId, patientId: patient.id, memberId, planName }, orderBy: { updatedAt: 'desc' } });
          if (existing) {
            await tx.patientInsurancePolicy.update({
              where: { id: existing.id },
              data: { branchId: branch.id, payerId: payer.id, verificationStatus, active, ...(subscriberName ? { subscriberName } : {}), ...(relationship ? { relationship } : {}), ...(groupNumber ? { groupNumber } : {}), ...(payerReference ? { payerReference } : {}) },
            });
            tally.updated++;
          } else {
            await tx.patientInsurancePolicy.create({
              data: { tenantId, branchId: branch.id, patientId: patient.id, payerId: payer.id, planName, memberId, verificationStatus, active, ...(subscriberName ? { subscriberName } : {}), ...(relationship ? { relationship } : {}), ...(groupNumber ? { groupNumber } : {}), ...(payerReference ? { payerReference } : {}) },
            });
            tally.created++;
          }
          continue;
        }
      }


      // Tenant-plane evidence, written on the same connection as the rows it
      // describes. actorUserId stays null because the importer is a platform
      // operator, not a member of this workspace — AuditEvent.actorUserId only
      // references tenant Users. Who acted is recorded on the platform plane by
      // platformAuditEvent below.
      await tx.auditEvent.create({
        data: {
          tenantId,
          actorUserId: null,
          action: 'pilot.import.committed',
          resource: 'pilotImport',
          resourceId: tenantId,
          requestId: request.id,
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'],
          metadata: { entityType, summary: tally, totalRows: analysis.summary.total, validRows: validRows.length },
        },
      });

      return { ...tally, unmatchedProviderRefs: [...unmatchedProviderRefs].slice(0, 50) };
    }, { timeout: 120_000, maxWait: 15_000 });

    const { unmatchedProviderRefs, ...counts } = results;
    return {
      entityType,
      preset: preset.preset ? { id: preset.preset.id, name: preset.preset.name, isDefault: preset.preset.isDefault } : null,
      summary: { ...counts, total: analysis.summary.total, validRows: validRows.length, invalidRows: analysis.summary.invalid },
      // Named so the clinic can map them and re-import, instead of discovering
      // months later that those visits were never covered by the double-booking
      // guard.
      unmatchedProviderRefs,
      preview: analysis.rows.slice(0, 10).map(row => ({ index: row.index, status: row.status, issues: row.issues, sample: buildPreviewSample(row) })),
    };
  });
};
