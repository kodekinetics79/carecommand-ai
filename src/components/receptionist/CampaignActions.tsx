import { useState } from 'react';
import { Link } from 'react-router';
import { Play, Pause, Archive, Loader2 } from 'lucide-react';
import type { Campaign } from '../../lib/receptionist';
import {
  blockedByOf, deploymentApi, readinessReasonsOf,
  type BlockedByCampaign, type ReadinessCheck, type ReadinessResponse,
} from '../../lib/receptionistDeployment';
import { isBusy, useMutationState } from '../../hooks/useMutationState';
import { ConfirmedButton } from './shared';
import { MutationNotice } from './MutationNotice';
import { ReadinessRow } from './ReadinessChecklist';

/**
 * Activate / Pause / Archive, replacing the raw status select. Activate is
 * disabled until the server says `ready`; a 409 answers with the failing
 * checks (`reasons`) or the campaigns that block the transition, and both are
 * rendered inline as alerts — never swallowed, never re-derived here.
 */
export function CampaignActions({ campaign, readiness, onChanged }: {
  campaign: Campaign;
  readiness: ReadinessResponse | null;
  onChanged: () => Promise<unknown> | void;
}) {
  const action = useMutationState();
  const [reasons, setReasons] = useState<ReadinessCheck[]>([]);
  const [blockedBy, setBlockedBy] = useState<BlockedByCampaign[]>([]);
  const busy = isBusy(action.state);
  const status = campaign.status;

  const canActivate = status !== 'ACTIVE' && status !== 'ARCHIVED' && Boolean(readiness?.ready && readiness.actions.activate.allowed);
  const canPause = status === 'ACTIVE' && (readiness?.actions.pause.allowed ?? true);
  const canArchive = status !== 'ACTIVE' && status !== 'ARCHIVED' && (readiness?.actions.archive.allowed ?? true);

  async function run(label: string, fn: () => Promise<unknown>, rethrow = false) {
    setReasons([]);
    setBlockedBy([]);
    await action.run(async () => {
      try {
        await fn();
      } catch (error) {
        setReasons(readinessReasonsOf(error));
        setBlockedBy(blockedByOf(error));
        throw error;
      }
      await onChanged();
    }, { successMessage: label, rethrow });
  }

  const activateTitle = status === 'ACTIVE' ? 'The campaign is already active.'
    : status === 'ARCHIVED' ? 'Archived campaigns cannot be activated.'
      : !readiness ? 'Readiness has not been evaluated yet.'
        : readiness.ready ? (readiness.actions.activate.reasons[0] ?? 'Activate the campaign') : 'Fix every failing readiness check first.';

  return (
    <section aria-label="Campaign actions" className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy || !canActivate}
          title={activateTitle}
          onClick={() => run('Campaign activated', () => deploymentApi.activate(campaign.id))}
          className="inline-flex items-center gap-2 rounded-xl bg-indigo px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-40"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Play className="h-4 w-4" aria-hidden="true" />} Activate
        </button>
        <ConfirmedButton
          dialogTitle="Pause this campaign?"
          message={`Pause ${campaign.name}? The receptionist stops answering and placing calls for it until you activate it again.`}
          confirmLabel="Pause campaign"
          tone="amber"
          disabled={busy || !canPause}
          buttonTitle={canPause ? 'Pause the campaign' : 'Only an active campaign can be paused.'}
          onConfirm={() => run('Campaign paused', () => deploymentApi.pause(campaign.id), true)}
          className="inline-flex items-center gap-2 rounded-xl border border-[var(--b1)] px-3 py-2 text-xs font-semibold text-t1 disabled:opacity-40"
        >
          <Pause className="h-3.5 w-3.5" aria-hidden="true" /> Pause
        </ConfirmedButton>
        <ConfirmedButton
          dialogTitle="Archive this campaign?"
          message={`Archive ${campaign.name}? Archived campaigns cannot be reactivated; their call history is kept.`}
          confirmLabel="Archive campaign"
          tone="red"
          disabled={busy || !canArchive}
          buttonTitle={status === 'ACTIVE' ? 'Pause the campaign before archiving it.' : canArchive ? 'Archive the campaign' : 'This campaign cannot be archived.'}
          onConfirm={() => run('Campaign archived', () => deploymentApi.archive(campaign.id), true)}
          className="inline-flex items-center gap-2 rounded-xl border border-[var(--b1)] px-3 py-2 text-xs font-semibold text-red-v disabled:opacity-40"
        >
          <Archive className="h-3.5 w-3.5" aria-hidden="true" /> Archive
        </ConfirmedButton>
      </div>
      <MutationNotice state={action.state} />
      {reasons.length > 0 && (
        <div role="alert" className="space-y-1.5 rounded-lg border border-red-v/40 bg-[var(--red-soft)] p-3">
          <p className="text-xs font-semibold text-red-v">The server refused activation until these are fixed:</p>
          <ul className="space-y-1.5">{reasons.map(check => <ReadinessRow key={check.key} check={check} />)}</ul>
        </div>
      )}
      {blockedBy.length > 0 && (
        <div role="alert" className="rounded-lg border border-amber-v/40 bg-[var(--amber-soft,var(--s3))] p-3 text-xs text-t1">
          <p className="font-semibold">Blocked by {blockedBy.length === 1 ? 'a campaign' : `${blockedBy.length} campaigns`} that must be paused first:</p>
          <ul className="mt-1 list-disc pl-4">
            {blockedBy.map(row => (
              <li key={row.campaignId}>
                <Link to={`/receptionist-studio?tab=outbound&campaign=${encodeURIComponent(row.campaignId)}`} className="font-semibold text-indigo hover:underline">{row.name}</Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
