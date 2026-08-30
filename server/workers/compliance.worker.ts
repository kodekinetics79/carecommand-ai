import { Worker } from 'bullmq';
import { captureException } from '../lib/observability';
import { observed } from './observedJob';
import {
  enqueueComplianceTenantJob,
  bullMqPrefix,
  redisConnection,
  type ComplianceJobName,
  type ScheduledQueueData,
} from './queues';
import { assertSchedulerTick, validateTenantJobEnvelope } from '../lib/jobEnvelope';
import { resolveActiveJobTenantIds } from '../lib/jobTenantResolver';
import { runWithJobTenantContext } from '../lib/tenantContext';
import { dispatchDueAppointmentConfirmations } from '../lib/receptionist/confirmationOutbox';
import { reverifyExpiringAgents } from '../lib/receptionist/agentReverification';
import {
  runReadinessRecalc,
  runEvidenceExpiry,
  runBackupPlaceholder,
  runAccessReviewReminder,
  runVendorReviewReminder,
} from '../modules/compliance/jobs';

// Consumer for the compliance-maintenance queue. Each repeatable job runs across
// all tenants (the job functions iterate tenants and scope every write by
// tenantId). Retries/backoff come from the queue's defaultJobOptions. Exported as
// a factory; schedule registration + shutdown are owned by the worker runtime.
const COMPLIANCE_SCHEDULERS: Record<ComplianceJobName, string> = {
  'readiness-recalc': 'compliance-readiness-recalc',
  'evidence-expiry': 'compliance-evidence-expiry',
  'backup-placeholder': 'compliance-backup-placeholder',
  'access-review-reminder': 'compliance-access-review',
  'vendor-review-reminder': 'compliance-vendor-review',
  'security-scan-placeholder': 'compliance-security-scan',
  'receptionist-confirmation-dispatch': 'receptionist-confirmation-dispatch',
  'receptionist-agent-reverify': 'receptionist-agent-reverify',
};

function isComplianceJobName(name: string): name is ComplianceJobName {
  return Object.hasOwn(COMPLIANCE_SCHEDULERS, name);
}

export async function runTenantComplianceJob(operation: ComplianceJobName, tenantId: string): Promise<void> {
  switch (operation) {
    case 'readiness-recalc': await runReadinessRecalc(tenantId); break;
    case 'evidence-expiry': await runEvidenceExpiry(tenantId); break;
    case 'backup-placeholder': await runBackupPlaceholder(tenantId); break;
    case 'access-review-reminder': await runAccessReviewReminder(tenantId); break;
    case 'vendor-review-reminder': await runVendorReviewReminder(tenantId); break;
    case 'security-scan-placeholder':
      console.info('[compliance-job] security scanner not integrated; awaiting supplied scan data');
      break;
    case 'receptionist-confirmation-dispatch':
      await runWithJobTenantContext(
        tenantId,
        async () => { await dispatchDueAppointmentConfirmations(tenantId); },
        'worker:receptionist-confirmation',
      );
      break;
    case 'receptionist-agent-reverify':
      await runWithJobTenantContext(
        tenantId,
        async () => { await reverifyExpiringAgents(tenantId); },
        'worker:receptionist-agent-reverify',
      );
      break;
  }
}

export function createComplianceWorker(): Worker<ScheduledQueueData, void, string> {
  const worker = new Worker<ScheduledQueueData, void, string>(
    'compliance-maintenance',
    observed('compliance-maintenance', async job => {
      if (isComplianceJobName(job.name)) {
        assertSchedulerTick(job, { name: job.name, schedulerId: COMPLIANCE_SCHEDULERS[job.name] });
        for (const tenantId of await resolveActiveJobTenantIds()) await enqueueComplianceTenantJob(job.name, tenantId);
        return;
      }
      const suffix = '-tenant';
      const operation = job.name.endsWith(suffix) ? job.name.slice(0, -suffix.length) : '';
      if (!isComplianceJobName(operation)) throw new Error(`Unknown compliance job: ${job.name}`);
      if (!job.id) throw new Error('Signed tenant job is missing its BullMQ job ID');
      const envelope = validateTenantJobEnvelope(job.data, {
        queue: 'compliance-maintenance', operation, jobId: job.id,
      });
      await runTenantComplianceJob(operation, envelope.tenantId);
    }),
    { connection: redisConnection, prefix: bullMqPrefix, concurrency: 3 },
  );

  worker.on('completed', job => console.info({ jobId: job.id, name: job.name }, 'compliance job completed'));
  worker.on('failed', (job, error) => {
    captureException(error, { route: `worker:compliance:${job?.name ?? 'unknown'}`, requestId: job?.id });
  });

  return worker;
}
