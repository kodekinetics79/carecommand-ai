import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Worker } from 'bullmq';
import { db } from '../lib/db';
import { createAutopilotWorker } from '../workers/autopilot.worker';
import { enqueueAutopilotExecution } from '../workers/queues';

// Proves the background worker actually CONSUMES an enqueued job end-to-end
// (real Redis + Postgres, no queue mock): an APPROVED autopilot action becomes
// EXECUTED with an audit trail after it is enqueued and the worker runs. This
// closes the "enqueues but nothing consumes" gap.

let worker: Worker;
const tenantIds: string[] = [];

beforeAll(() => {
  worker = createAutopilotWorker();
});

afterAll(async () => {
  await worker.close();
  for (const id of tenantIds) await db.tenant.delete({ where: { id } }).catch(() => {});
  await db.$disconnect();
});

async function waitFor<T>(probe: () => Promise<T | null>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for worker to process the job');
    await new Promise(resolve => setTimeout(resolve, 150));
  }
}

describe('worker runtime — queues are actually drained', () => {
  it('executes an APPROVED autopilot action enqueued to the queue', async () => {
    const tenantId = randomUUID();
    await db.tenant.create({ data: { id: tenantId, name: `wk-${tenantId.slice(0, 6)}`, slug: `wk-${tenantId.slice(0, 8)}` } });
    tenantIds.push(tenantId);
    const playbook = await db.autopilotPlaybook.create({ data: { tenantId, key: 'recall', name: 'Recall', description: 'demo', config: {} } });
    const approval = await db.autopilotApproval.create({
      data: { tenantId, playbookId: playbook.id, title: 'Send recall', reason: 'overdue', payload: {}, confidence: 90, status: 'APPROVED' },
    });

    await enqueueAutopilotExecution({ approvalId: approval.id, tenantId });

    const executed = await waitFor(async () => {
      const row = await db.autopilotApproval.findUnique({ where: { id: approval.id }, select: { status: true } });
      return row?.status === 'EXECUTED' ? row : null;
    });
    expect(executed.status).toBe('EXECUTED');

    const audit = await db.auditEvent.findFirst({
      where: { tenantId, action: 'autopilot.approval.executed', resourceId: approval.id },
    });
    expect(audit).not.toBeNull();
  }, 20_000);
});
