import { createHash } from 'node:crypto';
import { db } from '../db';
import { deleteCallData } from '../retell';
import type { Prisma } from '../../generated/prisma/client';

export const RECORDING_DISCLOSURE_POLICY_VERSION = '2026-07-31.1';
export const RECORDING_DISCLOSURE_EVIDENCE_TEMPLATE =
  "Hi, I'm {{agent_name}}, an AI assistant for {{clinic_name}}. This call may be recorded or monitored for quality and documentation.{{clinic_disclosure}} Is that okay?";
export const DEFAULT_RECORDING_RETENTION_DAYS = 30;
export const DEFAULT_TRANSCRIPT_RETENTION_DAYS = 90;

export function disclosureEvidenceHash(disclosure: string): string {
  return createHash('sha256').update(disclosure).digest('hex');
}

/** Single source of truth for the exact disclosure spoken and hashed. */
export function renderRecordingDisclosure(input: { agentName: string; clinicName: string; clinicDisclosure?: string | null }): string {
  const baseline = `Hi, I'm ${input.agentName}, an AI assistant for ${input.clinicName}. This call may be recorded or monitored for quality and documentation.`;
  const clinicDisclosure = input.clinicDisclosure?.trim();
  // Supplemental clinic/jurisdiction language is part of the disclosure, not
  // speech that may follow the consent question. Keeping the question last
  // makes the provider begin-message an unambiguous consent turn: the agent
  // must wait for the caller instead of continuing into a greeting or offer.
  return `${baseline}${clinicDisclosure ? ` ${clinicDisclosure}` : ''} Is that okay?`;
}

async function retentionDeadline(
  client: typeof db | Prisma.TransactionClient,
  tenantId: string,
  dataClass: string,
  fallbackDays: number,
  from: Date,
) {
  const policy = await client.dataRetentionPolicy.findUnique({
    where: { tenantId_dataClass: { tenantId, dataClass } },
    select: { retentionDays: true, status: true },
  });
  const days = policy?.status === 'active' ? policy.retentionDays : fallbackDays;
  return new Date(from.getTime() + days * 86_400_000);
}

export async function recordRecordingConsent(input: {
  tenantId: string;
  callLogId: string;
  decision: 'GRANTED' | 'REFUSED' | 'WITHDRAWN';
  disclosureTextHash: string;
  jurisdiction?: string | null;
  source?: string;
  auditMetadata?: Prisma.InputJsonObject;
}) {
  const idempotencyKey = `${input.callLogId}:${input.decision}`;
  return db.$transaction(async tx => {
    const callIdentity = await tx.receptionistCallLog.findFirst({
      where: { id: input.callLogId, tenantId: input.tenantId },
      select: { retellCallId: true },
    });
    if (!callIdentity) throw new Error('call_log_not_found');
    // Consent and autonomous booking share this exact first lock. If a refusal
    // or withdrawal wins, booking subsequently reads the terminal status and
    // fails closed; if booking wins, its transaction is already committed
    // before the later consent transition proceeds.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`receptionist-call-lifecycle:${input.tenantId}:${callIdentity.retellCallId ?? input.callLogId}`})::bigint)`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`recording-consent:${input.tenantId}:${input.callLogId}`})::bigint)`;
    const call = await tx.receptionistCallLog.findFirst({ where: { id: input.callLogId, tenantId: input.tenantId }, select: { id: true, recordingConsentStatus: true } });
    if (!call) throw new Error('call_log_not_found');
    const prior = await tx.receptionistRecordingConsentEvent.findUnique({
      where: { tenantId_idempotencyKey: { tenantId: input.tenantId, idempotencyKey } },
    });
    if (prior) return prior;
    // Refusal and withdrawal are terminal for this call. A later provider/model
    // retry cannot upgrade a caller back to GRANTED after they said no.
    if (input.decision === 'GRANTED' && ['REFUSED', 'WITHDRAWN'].includes(call.recordingConsentStatus)) {
      throw new Error('recording_consent_terminal');
    }
    const event = await tx.receptionistRecordingConsentEvent.create({
      data: {
        tenantId: input.tenantId,
        callLogId: input.callLogId,
        decision: input.decision,
        source: input.source ?? 'retell_call_analysis',
        policyVersion: RECORDING_DISCLOSURE_POLICY_VERSION,
        disclosureTextHash: input.disclosureTextHash,
        jurisdiction: input.jurisdiction ?? undefined,
        // An in-call grant is evidence only. The provider remains metadata-only.
        providerStorageSetting: 'basic_attributes_only',
        idempotencyKey,
      },
    });
    await tx.receptionistCallLog.update({
      where: { id: input.callLogId },
      data: { recordingConsentStatus: input.decision, recordingConsentAt: event.occurredAt },
    });
    if (input.auditMetadata) {
      await tx.auditEvent.create({
        data: {
          tenantId: input.tenantId,
          actorUserId: null,
          action: 'receptionist.recording_preference.recorded',
          resource: 'receptionistLiveAgent',
          resourceId: input.callLogId,
          userAgent: 'retell-webhook',
          metadata: {
            ...input.auditMetadata,
            disclosureTextHash: event.disclosureTextHash,
            policyVersion: event.policyVersion,
          },
        },
      });
    }
    return event;
  });
}

export async function ingestCallArtifacts(input: {
  tenantId: string;
  callLogId: string;
  recordingUrl?: string | null;
  transcriptSummary?: string | null;
  retentionFrom?: Date;
}) {
  const from = input.retentionFrom ?? new Date();
  return db.$transaction(async tx => {
    const callIdentity = await tx.receptionistCallLog.findFirst({
      where: { id: input.callLogId, tenantId: input.tenantId },
      select: { retellCallId: true },
    });
    if (!callIdentity) throw new Error('call_log_not_found');
    // Preserve the same lifecycle -> consent lock order used by booking and
    // consent mutation, then read/write artifacts on this transaction.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`receptionist-call-lifecycle:${input.tenantId}:${callIdentity.retellCallId ?? input.callLogId}`})::bigint)`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`recording-consent:${input.tenantId}:${input.callLogId}`})::bigint)`;
    const call = await tx.receptionistCallLog.findFirst({
      where: { id: input.callLogId, tenantId: input.tenantId },
      select: { id: true, recordingConsentStatus: true },
    });
    if (!call) throw new Error('call_log_not_found');
    if (call.recordingConsentStatus !== 'GRANTED') {
      // Never persist provider artifacts without affirmative evidence. A
      // webhook may transiently carry them while provider storage is disabled.
      return { recordingStored: false, transcriptStored: false, reason: 'consent_not_granted' as const };
    }

    const [recordingExpiresAt, transcriptExpiresAt] = await Promise.all([
      input.recordingUrl ? retentionDeadline(tx, input.tenantId, 'receptionist_recording', DEFAULT_RECORDING_RETENTION_DAYS, from) : null,
      input.transcriptSummary ? retentionDeadline(tx, input.tenantId, 'receptionist_transcript', DEFAULT_TRANSCRIPT_RETENTION_DAYS, from) : null,
    ]);
    await tx.receptionistCallLog.update({
      where: { id: input.callLogId },
      data: {
        recordingUrl: input.recordingUrl ?? undefined,
        transcriptSummary: input.transcriptSummary ?? undefined,
        recordingRetentionExpiresAt: recordingExpiresAt ?? undefined,
        transcriptRetentionExpiresAt: transcriptExpiresAt ?? undefined,
      },
    });
    if (recordingExpiresAt) await tx.receptionistArtifactLifecycleEvent.create({
      data: { tenantId: input.tenantId, callLogId: input.callLogId, artifactType: 'RECORDING', action: 'RETENTION_SCHEDULED', metadata: { expiresAt: recordingExpiresAt.toISOString() } },
    });
    if (transcriptExpiresAt) await tx.receptionistArtifactLifecycleEvent.create({
      data: { tenantId: input.tenantId, callLogId: input.callLogId, artifactType: 'TRANSCRIPT', action: 'RETENTION_SCHEDULED', metadata: { expiresAt: transcriptExpiresAt.toISOString() } },
    });
    return { recordingStored: Boolean(input.recordingUrl), transcriptStored: Boolean(input.transcriptSummary) };
  });
}

export async function purgeDueReceptionistArtifacts(options: { now?: Date; limit?: number } = {}) {
  const now = options.now ?? new Date();
  const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
  const calls = await db.receptionistCallLog.findMany({
    where: {
      OR: [
        { recordingUrl: { not: null }, recordingRetentionExpiresAt: { lte: now } },
        { transcriptSummary: { not: null }, transcriptRetentionExpiresAt: { lte: now } },
      ],
    },
    orderBy: { updatedAt: 'asc' },
    take: limit,
  });
  let localPurges = 0;
  let vendorConfirmed = 0;
  for (const candidate of calls) {
    const holds = await db.receptionistCallLegalHold.findMany({
      where: { tenantId: candidate.tenantId, callLogId: candidate.id, status: 'ACTIVE' },
      select: { scope: true },
    });
    const held = (type: 'RECORDING' | 'TRANSCRIPT') => holds.some(hold => hold.scope === null || hold.scope === type);
    const purgeRecording = Boolean(candidate.recordingUrl && candidate.recordingRetentionExpiresAt && candidate.recordingRetentionExpiresAt <= now && !held('RECORDING'));
    const purgeTranscript = Boolean(candidate.transcriptSummary && candidate.transcriptRetentionExpiresAt && candidate.transcriptRetentionExpiresAt <= now && !held('TRANSCRIPT'));
    if (!purgeRecording && !purgeTranscript) continue;

    await db.$transaction(async tx => {
      if (purgeRecording) {
        await tx.receptionistArtifactLifecycleEvent.create({ data: { tenantId: candidate.tenantId, callLogId: candidate.id, artifactType: 'RECORDING', action: 'PURGE_REQUESTED' } });
        await tx.receptionistCallLog.update({ where: { id: candidate.id }, data: { recordingUrl: null, recordingPurgedAt: now } });
        await tx.receptionistArtifactLifecycleEvent.create({ data: { tenantId: candidate.tenantId, callLogId: candidate.id, artifactType: 'RECORDING', action: 'PURGED' } });
        localPurges += 1;
      }
      if (purgeTranscript) {
        await tx.receptionistArtifactLifecycleEvent.create({ data: { tenantId: candidate.tenantId, callLogId: candidate.id, artifactType: 'TRANSCRIPT', action: 'PURGE_REQUESTED' } });
        await tx.receptionistCallLog.update({ where: { id: candidate.id }, data: { transcriptSummary: null, transcriptPurgedAt: now } });
        await tx.receptionistArtifactLifecycleEvent.create({ data: { tenantId: candidate.tenantId, callLogId: candidate.id, artifactType: 'TRANSCRIPT', action: 'PURGED' } });
        localPurges += 1;
      }
    });

    // Retell deletes the whole call, not one artifact. Request vendor deletion
    // only when no unexpired or held local artifact remains.
    const remaining = await db.receptionistCallLog.findUnique({ where: { id: candidate.id }, select: { recordingUrl: true, transcriptSummary: true } });
    if (!remaining?.recordingUrl && !remaining?.transcriptSummary && candidate.retellCallId && holds.length === 0) {
      const types = [purgeRecording ? 'RECORDING' : null, purgeTranscript ? 'TRANSCRIPT' : null].filter(Boolean) as Array<'RECORDING' | 'TRANSCRIPT'>;
      for (const artifactType of types) await db.receptionistArtifactLifecycleEvent.create({ data: { tenantId: candidate.tenantId, callLogId: candidate.id, artifactType, action: 'VENDOR_DELETE_REQUESTED', provider: 'retell' } });
      const result = await deleteCallData(candidate.retellCallId);
      const action = result.ok && result.applied ? 'VENDOR_DELETE_CONFIRMED' : 'VENDOR_DELETE_FAILED';
      for (const artifactType of types) await db.receptionistArtifactLifecycleEvent.create({
        data: { tenantId: candidate.tenantId, callLogId: candidate.id, artifactType, action, provider: 'retell', errorCode: action === 'VENDOR_DELETE_FAILED' ? (result.ok ? 'mock_not_applied' : result.error) : undefined },
      });
      if (action === 'VENDOR_DELETE_CONFIRMED') {
        await db.receptionistCallLog.update({ where: { id: candidate.id }, data: { vendorDeletionConfirmedAt: now } });
        vendorConfirmed += 1;
      }
    }
  }
  return { scanned: calls.length, localPurges, vendorConfirmed };
}
