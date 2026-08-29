import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import {
  AlertCircle, AlertTriangle, Ban, CalendarCheck, CheckCircle2, Filter, HelpCircle, Loader2, Megaphone, Pause,
  Pencil, Plus, Save, Send, ShieldAlert, Sparkles, Trash2, Users, X,
} from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import StatCard from '../components/ui/StatCard';
import BentoCard from '../components/ui/BentoCard';
import ModuleTabs from '../components/ui/ModuleTabs';
import ResourceSection from '../components/ui/ResourceSection';
import EmptyStatePremium from '../components/ui/EmptyStatePremium';
import ConfirmationModal from '../components/workflow/ConfirmationModal';
import { useResource } from '../hooks/useResource';
import { receivedData } from '../lib/resourceState';
import {
  crmApi, AUDIENCE_TYPES, CAMPAIGN_TYPES, CAMPAIGN_GOALS, CAMPAIGN_STATUS_META, DELIVERY_STATUS_META,
  readCampaignHandoff, resolveHandoffDefaults,
  summarizeAttributedRevenue, attributionWindowsObserved, countAttributedOutcomes,
  formatAttributedAmount, describeEngagementUnavailability,
  type Campaign, type AudiencePreview, type CampaignDraft, type LaunchResult, type CampaignDelivery,
  type AudienceType, type CampaignType, type CommChannel, type CampaignLaunchPreview, type CampaignGoal,
  type CampaignHandoff, type CampaignAttributionSummary, type CampaignAttributionBasis,
  type CampaignAttributionDetail,
} from '../lib/crm';

/**
 * The campaign workspace.
 *
 * This page used to be a planner bolted onto `/v1/campaigns`, a thin CRUD whose
 * schema cannot set a campaign type, an audience or an approval — so nothing it
 * created could ever reach the dispatch path. The governed engine lived behind a
 * second door (`/reactivation`), and the one creative decision this page asked
 * for was dropped on the way there.
 *
 * It is now one destination on one backend: `/v1/crm/campaigns`. Approval takes
 * a launch fingerprint, launch re-reads the exact server preview and both are
 * confirmed against the audience, template, channel and provider the operator
 * actually saw. None of that is re-implemented here; it is the server's, and
 * this screen's job is to show it truthfully.
 */

const CHANNELS: CommChannel[] = ['sms', 'email', 'voice', 'whatsapp'];

const GOAL_ORDER = Object.keys(CAMPAIGN_GOALS) as CampaignGoal[];

function displayLabel(value: string | null): string {
  if (!value) return 'Not configured';
  const words = value.replaceAll('_', ' ').toLowerCase();
  return value.toLowerCase() === 'sms' ? 'SMS' : words[0].toUpperCase() + words.slice(1);
}

// Module-scope loader: useResource keys a request by the identity of its
// source, so this must not be re-created on every render.
const loadCampaigns = (signal: AbortSignal): Promise<Campaign[]> => crmApi.listCampaigns(signal);
const loadAttribution = (signal: AbortSignal): Promise<CampaignAttributionSummary> => crmApi.attributionSummary(signal);

const STATUS_FILTERS = [
  { id: 'all', label: 'All', match: () => true },
  { id: 'approval', label: 'Needs approval', match: (c: Campaign) => c.requiresApprovalPending },
  { id: 'scheduled', label: 'Scheduled', match: (c: Campaign) => c.status === 'SCHEDULED' },
  { id: 'running', label: 'Running', match: (c: Campaign) => c.status === 'ACTIVE' },
  { id: 'closed', label: 'Closed', match: (c: Campaign) => ['COMPLETED', 'CANCELLED', 'FAILED'].includes(c.status) },
] as const;

export default function Campaigner() {
  const navigate = useNavigate();
  const location = useLocation();

  // The decision the user already made, wherever they made it. Read once per
  // navigation: a handoff is an instruction to open the creator, not a filter
  // that should survive the operator closing it.
  const [handoff] = useState<CampaignHandoff | null>(() => readCampaignHandoff(location.state));
  const [creatorDefaults, setCreatorDefaults] = useState<CampaignHandoff | null>(() =>
    handoff && (handoff.goal || handoff.campaignType || handoff.audienceType) ? handoff : null);

  const [chosenId, setChosenId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const campaigns = useResource<Campaign[]>(loadCampaigns);
  // The closed loop. Its own request, because attribution is evidence the
  // campaign list does not carry: the list says what exists, this says what any
  // of it earned, and neither may stand in for the other while it loads.
  const attribution = useResource<CampaignAttributionSummary>(loadAttribution);

  // Only ever non-null once a response arrived. Nothing below may print a
  // figure, a rate or a count from anything else.
  const campaignRecords = receivedData(campaigns.state);
  // Decoration only: the basis note explains a figure that is rendered inside a
  // ResourceSection, so it exists only once that same response has arrived.
  const attributionRecords = receivedData(attribution.state);

  // Derived, not stored. The response is the only authority on what exists, so
  // a selection that no longer resolves (archived, cancelled, filtered out by a
  // narrower grant) falls back to the most recent campaign instead of leaving
  // the pane pointed at a record the server did not send.
  //
  // During a reload the resource honestly reads as loading and receivedData()
  // goes null — but unmounting the detail pane for that beat destroyed its
  // local notice state, so the launch result ("dispatch complete: N accepted,
  // M suppressed…") flashed and vanished the moment onChanged() refreshed the
  // list. The pane derives from the last received list instead: it is the last
  // answer the server gave, the pane makes no freshness claim, and every KPI
  // figure on the page stays gated on the live resource state exactly as
  // before. When the reload resolves, selection re-derives from fresh data.
  const lastReceivedRecords = useRef<Campaign[] | null>(null);
  if (campaignRecords) lastReceivedRecords.current = campaignRecords;
  const paneRecords = campaignRecords ?? lastReceivedRecords.current;
  const selected = paneRecords
    ? paneRecords.find(row => row.id === chosenId) ?? paneRecords[0] ?? null
    : null;

  const filterTabs = campaignRecords && STATUS_FILTERS.map(tab => ({
    id: tab.id, label: tab.label, count: campaignRecords.filter(tab.match).length,
  }));

  function openCreator(defaults: CampaignHandoff) {
    setCreatorDefaults(defaults);
  }

  return (
    <div className="space-y-6 pb-8">
      <PageHeader
        title="Campaigns"
        subtitle="Draft, approve and dispatch patient outreach in one place. Approval and launch are authorized against an exact server preview, and consent, suppression and channel eligibility are re-checked at dispatch."
        // The badge is a claim about the portfolio, so it waits for the response
        // rather than counting an empty in-flight list as "0 running".
        badge={
          campaigns.state.status === 'loading' ? 'Loading campaigns'
            : campaigns.state.status === 'error' ? 'Data unavailable'
              : `${campaignRecords?.filter(c => c.status === 'ACTIVE').length ?? 0} running · ${campaignRecords?.length ?? 0} recorded`
        }
        badgeColor={campaigns.state.status === 'error' ? 'red' : campaigns.state.status === 'loading' ? 'blue' : 'emerald'}
        actions={
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => navigate('/revenue')} className="rounded-xl border border-[var(--b1)] px-3 py-2 text-sm font-semibold text-t2 hover:bg-[var(--s2)] transition">
              Revenue reporting
            </button>
            <button type="button" onClick={() => openCreator({})} className="inline-flex items-center gap-2 rounded-xl bg-[var(--indigo)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90 transition">
              <Plus className="w-4 h-4" /> New campaign
            </button>
          </div>
        }
      />

      {/* Portfolio state. Each tile is an aggregate of a whole response, so it
          lives behind one resolved state: a workspace with no campaigns really
          does have zero running, but a request that has not answered does not.
          The first three come from the campaign list; the fourth comes from the
          attribution read, and prints an amount only when a `paid` outcome row
          exists to produce one. */}
      <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
        <ResourceSection
          label="Campaign totals"
          state={campaigns.state}
          onRetry={campaigns.reload}
          className="col-span-2 sm:col-span-3"
          compact
          loading={<>{[0, 1, 2].map(i => <div key={i} className="skeleton-line h-24 rounded-2xl" />)}</>}
          // A campaign-free workspace is a real zero, so the tiles render it.
          isEmpty={() => false}
        >
          {rows => (
            <>
              <StatCard title="Recorded campaigns" value={rows.length} subtitle="In this workspace" icon={<Megaphone className="w-4 h-4" />} accent="indigo" />
              <StatCard title="Awaiting approval" value={rows.filter(c => c.requiresApprovalPending).length} subtitle="Cannot dispatch until authorized" icon={<CheckCircle2 className="w-4 h-4" />} accent="amber" />
              <StatCard title="Running" value={rows.filter(c => c.status === 'ACTIVE').length} subtitle="Currently active campaigns" icon={<Send className="w-4 h-4" />} accent="emerald" />
            </>
          )}
        </ResourceSection>
        {/* The fourth tile is now evidenced — or honestly absent. It never
            resolves an in-flight or failed request into $0: a figure lives only
            in the resolved branch, and a resolved response with no `paid`
            outcome states the absence instead of totalling nothing. */}
        <ResourceSection
          label="Attributed revenue"
          state={attribution.state}
          onRetry={attribution.reload}
          compact
          // The default skeleton, which announces the wait to a screen reader
          // ("Loading Attributed revenue…") instead of showing a silent box.
          lines={1}
          rowClassName="h-24 rounded-2xl"
          // A workspace with no attributed campaign is not an empty panel; the
          // tile itself is what says so, in the words the evidence supports.
          isEmpty={() => false}
        >
          {summary => <AttributedRevenueTile summary={summary} />}
        </ResourceSection>
      </div>

      {attributionRecords && <AttributionBasisNote basis={attributionRecords.basis} windows={attributionWindowsObserved(attributionRecords.campaigns)} />}

      {handoff?.contextLabel && (
        <div className="rounded-xl border border-[var(--b2)] bg-[var(--indigo-soft)] px-3 py-2 text-xs text-t1">
          <span className="font-semibold text-indigo">Carried over{handoff.source ? ` from ${handoff.source}` : ''}:</span> {handoff.contextLabel}
        </div>
      )}

      {/* Goal selector — every objective here maps to a campaign type AND to an
          audience the server can actually preview, so choosing one opens the
          creator already carrying that decision rather than asking again. */}
      <BentoCard title="Campaign Goal Selector" subtitle="Each goal opens a draft with its audience source selected" headerRight={<Sparkles className="w-4 h-4 text-violet-v" />}>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {GOAL_ORDER.map(goalId => {
            const goal = CAMPAIGN_GOALS[goalId];
            const active = creatorDefaults?.goal === goalId;
            return (
              <button
                key={goalId}
                type="button"
                onClick={() => openCreator({ goal: goalId, source: 'Goal selector' })}
                className={`relative text-left p-4 rounded-2xl border-2 transition-all hover:shadow-md ${
                  active ? 'border-indigo bg-[var(--indigo-soft)] shadow-md' : 'border-[var(--b2)] bg-[var(--s2)]'
                }`}
              >
                {active && (
                  <div className="absolute top-3 right-3 w-5 h-5 rounded-full bg-[var(--indigo)] flex items-center justify-center">
                    <CheckCircle2 className="w-3 h-3 text-white" />
                  </div>
                )}
                <p className="text-sm font-bold text-t1 leading-tight mb-1">{goal.label}</p>
                <p className="text-[11px] text-t3 mb-2">{goal.description}</p>
                <p className="text-[11px] font-semibold text-t3">Audience: {displayLabel(goal.audienceType)}</p>
              </button>
            );
          })}
        </div>
        <p className="mt-3 text-[11px] text-t3">Starting a draft does not authorize an audience, schedule delivery, or contact anyone. Recipient consent, suppression, channel eligibility and jurisdiction are checked when the exact preview is authorized and again at dispatch.</p>
      </BentoCard>

      <div className="grid gap-4 xl:grid-cols-[360px_1fr] items-start">
        {/* Library */}
        <BentoCard
          title="Campaign Library"
          subtitle="Most recent first"
        >
          {/* The filters sit under the header, not in headerRight. BentoCard
              marks headerRight shrink-0, so in this 360px column the three tabs
              took their full natural width and collapsed the title to nothing —
              the subtitle rendered as "Mo/Re/Firs". Below the header they get
              the full column and scroll if the labels outgrow it.
              The counts are part of the claim, so the tabs only exist once the
              records they count have arrived. */}
          {filterTabs && (
            <div className="mb-3 overflow-x-auto">
              <ModuleTabs tabs={filterTabs} activeTab={statusFilter} onChange={setStatusFilter} ariaLabel="Campaign status" />
            </div>
          )}
          <ResourceSection
            label="Campaign library"
            state={campaigns.state}
            onRetry={campaigns.reload}
            lines={3}
            rowClassName="h-16 rounded-xl"
            empty={{
              icon: <Megaphone className="w-5 h-5" />,
              title: 'No campaigns recorded yet',
              description: 'The campaign feed loaded successfully and this workspace has no campaign records. Pick a goal above to start a draft — creating one does not authorize an audience or contact anyone.',
              cta: { label: 'Start a campaign', onClick: () => openCreator({}) },
            }}
          >
            {rows => {
              const tab = STATUS_FILTERS.find(t => t.id === statusFilter) ?? STATUS_FILTERS[0];
              const filtered = rows.filter(tab.match);
              if (filtered.length === 0) {
                return (
                  <EmptyStatePremium
                    icon={<Filter className="w-5 h-5" />}
                    title={`No campaigns match “${tab.label}”`}
                    description={`This workspace has ${rows.length} campaign${rows.length === 1 ? '' : 's'} recorded, and none of them are in this state. Clear the filter to see the rest of the library.`}
                    cta={{ label: 'Show all campaigns', onClick: () => setStatusFilter('all') }}
                  />
                );
              }
              return (
                <div className="space-y-1.5 max-h-[540px] overflow-y-auto pr-0.5">
                  {filtered.map(row => {
                    const meta = CAMPAIGN_STATUS_META[row.status] ?? { label: row.status, badge: 'badge-blue' };
                    const active = !creatorDefaults && row.id === selected?.id;
                    return (
                      <button
                        key={row.id}
                        type="button"
                        aria-current={active ? 'true' : undefined}
                        onClick={() => { setCreatorDefaults(null); setChosenId(row.id); }}
                        className={`w-full rounded-xl px-3 py-2.5 text-left transition-colors border ${active ? 'border-indigo bg-[var(--s2)]' : 'border-[var(--b1)] hover:bg-[var(--s3)]'}`}
                      >
                        <span className="flex items-center justify-between gap-2">
                          <span className="text-sm font-semibold text-t1 truncate">{row.name}</span>
                          <span className={`badge ${meta.badge} shrink-0`}>{meta.label}</span>
                        </span>
                        <span className="mt-0.5 block text-[10px] text-t3">
                          {displayLabel(row.campaignType)} · {displayLabel(row.channel)} · audience {row.audienceSize}
                          {row.requiresApprovalPending ? ' · approval needed' : ''}
                        </span>
                      </button>
                    );
                  })}
                </div>
              );
            }}
          </ResourceSection>
        </BentoCard>

        {/* Creator / detail */}
        <div className="space-y-4">
          {creatorDefaults && (
            <CampaignCreator
              defaults={creatorDefaults}
              onCancel={() => setCreatorDefaults(null)}
              onCreated={id => { setCreatorDefaults(null); campaigns.reload(); setChosenId(id); }}
            />
          )}
          {!creatorDefaults && selected && (
            <CampaignDetail
              key={selected.id}
              campaign={selected}
              onChanged={campaigns.reload}
              onDeleted={() => { setChosenId(null); campaigns.reload(); }}
            />
          )}
          {!creatorDefaults && !selected && campaigns.state.status !== 'loading' && campaigns.state.status !== 'error' && (
            <div className="cc-card p-10 text-center text-sm text-t3">Select a campaign, or pick a goal above to start one.</div>
          )}
        </div>
      </div>

      {/* Requirements the SERVER enforces. Listed so an operator knows what the
          approval and dispatch checks cover — never as a claim that any of them
          has passed for a particular campaign. */}
      <BentoCard title="Consent & Safety" subtitle="Enforced at approval and again at dispatch · not asserted for any campaign here">
        <div className="grid gap-2 sm:grid-cols-2">
          {[
            'Purpose-specific consent is current and source-attributed',
            'DNC, revocation, and suppression checks pass at dispatch',
            'Channel and jurisdiction requirements are approved',
            'Opt-out instructions and handling are tested',
            'A reviewer authorized the exact final audience, template and provider',
          ].map(requirement => (
            <div key={requirement} className="flex items-center gap-2.5">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-v shrink-0" />
              <p className="text-xs text-t2">{requirement}</p>
            </div>
          ))}
        </div>
      </BentoCard>
    </div>
  );
}

/**
 * A figure the evidence does not support.
 *
 * Reached only from a RESOLVED response: the request answered, and what it
 * carried does not add up to an amount. "$0 attributed" is a claim a clinic
 * owner would act on and it is not one the data supports, so the tile states
 * the absence and the reason for it instead. During load and after a failure
 * this component is not rendered at all — ResourceSection owns those states.
 */
function UnevidencedStat({ title, reason, footnote }: { title: string; reason: string; footnote?: string }) {
  return (
    <div className="cc-card p-4 flex flex-col gap-3 border-dashed">
      <div className="stat-icon stat-icon-amber"><HelpCircle className="w-4 h-4" aria-hidden="true" /></div>
      <div>
        <p className="text-sm font-bold leading-snug text-t2">Not recorded yet</p>
        <p className="text-[11px] font-medium mt-1.5 text-t3">{title}</p>
        <p className="text-[10px] mt-0.5 text-t3">{reason}</p>
        {footnote && <p className="text-[10px] mt-1 text-t3">{footnote}</p>}
      </div>
    </div>
  );
}

/**
 * Attributed revenue across the portfolio.
 *
 * The count of `paid` outcomes decides whether there is an amount to print;
 * `attributedValue` is a sum, and the sum of no rows is the string '0.00'.
 * Reading the string first is how a workspace with no evidence would end up
 * displaying "$0 attributed", which is the whole defect.
 */
function AttributedRevenueTile({ summary }: { summary: CampaignAttributionSummary }) {
  const revenue = summarizeAttributedRevenue(summary.campaigns);
  const booked = countAttributedOutcomes(summary.campaigns, 'booked');
  const bookingNote = booked > 0
    ? `${booked} attributed booking${booked === 1 ? '' : 's'} recorded. A booking is an outcome, not revenue.`
    : undefined;

  if (revenue.status === 'not_attributed') {
    return <UnevidencedStat title="Attributed revenue" reason={revenue.reason} footnote={bookingNote} />;
  }
  return (
    <StatCard
      title="Attributed revenue"
      value={formatAttributedAmount(revenue.amount, revenue.currency)}
      subtitle={`${revenue.paidOutcomes} attributed payment${revenue.paidOutcomes === 1 ? '' : 's'} across ${revenue.campaigns} campaign${revenue.campaigns === 1 ? '' : 's'}`}
      icon={<CalendarCheck className="w-4 h-4" />}
      accent="emerald"
    />
  );
}

/**
 * The provenance, in the API's own words.
 *
 * A revenue figure whose arithmetic cannot be inspected is indistinguishable
 * from one multiplied out of hardcoded constants. This is what separates the
 * number above from that: the rules that made each link, the basis of the
 * value, and where the window came from — all shipped by the same response
 * that shipped the figure, never restated in this file.
 */
function AttributionBasisNote({ basis, windows }: { basis: CampaignAttributionBasis; windows: number[] }) {
  const windowLine = windows.length > 0
    ? `${windows.map(days => `${days}-day`).join(', ')} — ${basis.windowSource}`
    : basis.windowSource;
  return (
    <details className="rounded-xl border border-[var(--b2)] bg-[var(--s2)] px-3 py-2 text-[11px] text-t3">
      <summary className="cursor-pointer font-semibold text-t2">How every attributed figure on this page was produced</summary>
      <dl className="mt-2 space-y-1.5">
        <div><dt className="inline font-semibold text-t2">Attribution window: </dt><dd className="inline">{windowLine}</dd></div>
        <div><dt className="inline font-semibold text-t2">Value basis: </dt><dd className="inline">{basis.valueBasis}</dd></div>
        <div><dt className="inline font-semibold text-t2">Derived from: </dt><dd className="inline">{basis.derivedFrom}</dd></div>
        <div><dt className="inline font-semibold text-t2">Not attributed: </dt><dd className="inline">{basis.notAttributed}</dd></div>
        <div>
          <dt className="font-semibold text-t2">Rules in force</dt>
          <dd>
            <ul className="mt-0.5 space-y-0.5">
              {Object.entries(basis.rules).map(([outcome, rule]) => (
                <li key={outcome}>{outcome}: <span className="font-mono">{rule}</span></li>
              ))}
            </ul>
          </dd>
        </div>
      </dl>
    </details>
  );
}

/**
 * Creation. `defaults` is the decision the user already made — on a goal card,
 * in the CRM, on a patient — so the type and audience arrive selected. The
 * audience is never guessed: a handoff that names no audience leaves the field
 * unchosen and blocks creation until the operator picks one, because that field
 * decides who gets contacted.
 */
function CampaignCreator({ defaults, onCreated, onCancel }: {
  defaults: CampaignHandoff; onCreated: (id: string) => void; onCancel: () => void;
}) {
  const resolved = resolveHandoffDefaults(defaults);
  const [name, setName] = useState(resolved.name);
  const [campaignType, setType] = useState<CampaignType | ''>(resolved.campaignType ?? '');
  const [audienceType, setAudience] = useState<AudienceType | ''>(resolved.audienceType ?? '');
  const [channel, setChannel] = useState<CommChannel>(resolved.channel);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const goal = defaults.goal ? CAMPAIGN_GOALS[defaults.goal] : null;
  const ready = name.trim().length >= 2 && campaignType !== '' && audienceType !== '';

  async function create() {
    if (!ready) return;
    setBusy(true); setErr(null);
    try {
      const row = await crmApi.createCampaign({
        name: name.trim(),
        campaignType: campaignType as CampaignType,
        audienceType: audienceType as AudienceType,
        channel,
      });
      onCreated(row.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to create campaign');
    } finally {
      setBusy(false);
    }
  }

  const inputCls = 'w-full rounded-xl border border-[var(--b1)] bg-[var(--s3)] px-3 py-2 text-sm text-t1 outline-none focus:border-indigo';
  return (
    <div className="cc-card p-5 space-y-4">
      <h3 className="text-sm font-bold text-t1 flex items-center gap-2"><Megaphone className="w-4 h-4 text-indigo" /> New campaign draft</h3>
      {goal && (
        <p className="rounded-lg border border-[var(--b2)] bg-[var(--indigo-soft)] px-3 py-2 text-[11px] text-t2">
          <span className="font-semibold text-indigo">Goal:</span> {goal.label}. The campaign type and audience below are set from it and can be changed before you create the draft.
        </p>
      )}
      <label className="block space-y-1.5"><span className="text-[11px] font-bold uppercase tracking-wide text-t3">Name</span>
        <input className={inputCls} value={name} onChange={e => setName(e.target.value)} placeholder="Q3 reactivation" /></label>
      <div className="grid grid-cols-3 gap-3">
        <label className="block space-y-1.5"><span className="text-[11px] font-bold uppercase tracking-wide text-t3">Type</span>
          <select aria-label="Campaign type" className={inputCls} value={campaignType} onChange={e => setType(e.target.value as CampaignType | '')}>
            <option value="">Select a type</option>
            {CAMPAIGN_TYPES.map(t => <option key={t} value={t}>{displayLabel(t)}</option>)}
          </select></label>
        <label className="block space-y-1.5"><span className="text-[11px] font-bold uppercase tracking-wide text-t3">Audience</span>
          <select aria-label="Audience type" className={inputCls} value={audienceType} onChange={e => setAudience(e.target.value as AudienceType | '')}>
            <option value="">Select an audience</option>
            {AUDIENCE_TYPES.map(t => <option key={t} value={t}>{displayLabel(t)}</option>)}
          </select></label>
        <label className="block space-y-1.5"><span className="text-[11px] font-bold uppercase tracking-wide text-t3">Channel</span>
          <select aria-label="Channel" className={inputCls} value={channel} onChange={e => setChannel(e.target.value as CommChannel)}>{CHANNELS.map(c => <option key={c} value={c}>{displayLabel(c)}</option>)}</select></label>
      </div>
      <p className="text-[11px] text-t3">The audience decides who is contacted, so it is never assumed. The draft is created as approval-required; nothing is sent until an exact server preview is authorized.</p>
      {err && <p className="text-xs text-red-v">{err}</p>}
      <div className="flex gap-2">
        <button type="button" disabled={busy || !ready} onClick={create} className="inline-flex items-center gap-2 rounded-xl bg-indigo px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50">{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Create</button>
        <button type="button" onClick={onCancel} className="rounded-xl border border-[var(--b1)] px-4 py-2 text-sm font-semibold text-t2 hover:bg-[var(--s2)]">Cancel</button>
      </div>
    </div>
  );
}

function CampaignDetail({ campaign, onChanged, onDeleted }: { campaign: Campaign; onChanged: () => void; onDeleted: () => void }) {
  const [preview, setPreview] = useState<AudiencePreview | null>(null);
  const [draft, setDraft] = useState<CampaignDraft | null>(null);
  const [launch, setLaunch] = useState<LaunchResult | null>(null);
  const [deliveries, setDeliveries] = useState<CampaignDelivery[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [audienceError, setAudienceError] = useState<string | null>(null);
  const [deliveryError, setDeliveryError] = useState<string | null>(null);
  const [deliveryEvidenceLoaded, setDeliveryEvidenceLoaded] = useState(false);
  const [attribution, setAttribution] = useState<CampaignAttributionDetail | null>(null);
  const [attributionError, setAttributionError] = useState<string | null>(null);
  const [attributionLoaded, setAttributionLoaded] = useState(false);
  const [confirmation, setConfirmation] = useState<{ kind: 'approve' | 'launch'; preview: CampaignLaunchPreview } | null>(null);

  const meta = CAMPAIGN_STATUS_META[campaign.status] ?? { label: campaign.status, badge: 'badge-blue' };
  const audienceType = (campaign.audienceType ?? 'inactive_patients') as AudienceType;
  const channel = (campaign.channel ?? 'sms') as CommChannel;

  const loadAux = useCallback(async () => {
    const [audienceResult, deliveryResult, attributionResult] = await Promise.allSettled([
      crmApi.previewAudience(audienceType, channel),
      crmApi.listDeliveries(campaign.id),
      crmApi.campaignAttribution(campaign.id),
    ]);
    if (audienceResult.status === 'fulfilled') {
      setPreview(audienceResult.value);
      setAudienceError(null);
    } else {
      setPreview(null);
      setAudienceError('Audience evidence is unavailable. Do not infer that no recipients are eligible or suppressed.');
    }
    if (deliveryResult.status === 'fulfilled') {
      setDeliveries(deliveryResult.value);
      setDeliveryError(null);
      setDeliveryEvidenceLoaded(true);
    } else {
      setDeliveryError('Dispatch evidence is unavailable. Do not infer that no dispatch occurred; review provider records before retrying.');
      setDeliveryEvidenceLoaded(false);
    }
    if (attributionResult.status === 'fulfilled') {
      setAttribution(attributionResult.value);
      setAttributionError(null);
      setAttributionLoaded(true);
    } else {
      setAttribution(null);
      setAttributionError('Attribution evidence is unavailable. Do not infer that this campaign produced no bookings or no revenue.');
      setAttributionLoaded(false);
    }
  }, [audienceType, channel, campaign.id]);

  useEffect(() => {
    let active = true;
    void (async () => {
      const [audienceResult, deliveryResult, attributionResult] = await Promise.allSettled([
        crmApi.previewAudience(audienceType, channel),
        crmApi.listDeliveries(campaign.id),
        crmApi.campaignAttribution(campaign.id),
      ]);
      if (!active) return;
      if (audienceResult.status === 'fulfilled') {
        setPreview(audienceResult.value); setAudienceError(null);
      } else {
        setPreview(null); setAudienceError('Audience evidence is unavailable. Do not infer that no recipients are eligible or suppressed.');
      }
      if (deliveryResult.status === 'fulfilled') {
        setDeliveries(deliveryResult.value); setDeliveryError(null); setDeliveryEvidenceLoaded(true);
      } else {
        setDeliveryError('Dispatch evidence is unavailable. Do not infer that no dispatch occurred; review provider records before retrying.');
        setDeliveryEvidenceLoaded(false);
      }
      if (attributionResult.status === 'fulfilled') {
        setAttribution(attributionResult.value); setAttributionError(null); setAttributionLoaded(true);
      } else {
        setAttribution(null);
        setAttributionError('Attribution evidence is unavailable. Do not infer that this campaign produced no bookings or no revenue.');
        setAttributionLoaded(false);
      }
      setDraft(null); setLaunch(null); setNotice(null); setError(null);
    })();
    return () => { active = false; };
  }, [audienceType, channel, campaign.id]);

  async function run(fn: () => Promise<void>) {
    setBusy(true); setError(null); setNotice(null);
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : 'Action failed'); } finally { setBusy(false); }
  }

  const actions = campaign.allowedActions;

  async function prepareConfirmation(kind: 'approve' | 'launch') {
    await run(async () => {
      const exactPreview = await crmApi.launchPreview(campaign.id);
      setConfirmation({ kind, preview: exactPreview });
    });
  }

  async function confirmExactPreview() {
    if (!confirmation) return;
    const { kind, preview: exactPreview } = confirmation;
    await run(async () => {
      if (kind === 'approve') {
        await crmApi.approve(campaign.id, exactPreview.fingerprint);
        setNotice(campaign.scheduledAt ? 'Scheduled dispatch authorized for this exact preview.' : 'Approved. Dispatch remains operator-controlled.');
        onChanged();
        return;
      }
      const result = await crmApi.launch(campaign.id, exactPreview.fingerprint);
      setLaunch(result);
      if (result.summary.authorityBlocked > 0) {
        setError(`${result.summary.authorityBlocked} recipient(s) lacked a current consent record tied to the approved notice version and this message purpose. Nothing was submitted for them.`);
      } else if (result.summary.atomicBoundaryBlocked > 0) {
        setError('Live campaign delivery is not activated. Nothing was submitted because the last-second consent and opt-out safety control has not been validated.');
      } else {
        setNotice(result.setupRequired ? 'Provider not configured — nothing submitted.' : `Dispatch complete: ${result.summary.accepted} provider-accepted, ${result.summary.deliveryUnknown} delivery-unknown, ${result.summary.queued} queued, ${result.summary.suppressed} suppressed. Delivery still requires provider receipts; unknown submissions require reconciliation, not automatic retry.`);
      }
      await loadAux();
      onChanged();
    });
  }

  return (
    <div className="space-y-5">
      <div className="cc-card p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-t1">{campaign.name}</h3>
          <span className={`badge ${meta.badge}`}>{meta.label}</span>
        </div>
        <div className="flex flex-wrap gap-1.5 text-[11px]">
          <span className="badge badge-blue">{displayLabel(campaign.campaignType)}</span>
          <span className="badge badge-violet">{displayLabel(campaign.audienceType)}</span>
          <span className="badge badge-blue">{displayLabel(campaign.channel)}</span>
          {campaign.requiresApprovalPending && <span className="badge badge-amber">Approval required</span>}
          {campaign.dispatchAuthorizationRecorded && <span className="badge badge-emerald">Dispatch authorization recorded</span>}
        </div>
        {/* This campaign's outcomes, from the per-campaign attribution read.
            Every count below is a count of CampaignAttribution rows; engagement
            is the one figure the platform cannot evidence, and it is named as
            unavailable rather than rendered as a small percentage. */}
        <CampaignOutcomes
          loaded={attributionLoaded}
          error={attributionError}
          detail={attribution}
          onRetry={() => void loadAux()}
        />
        {campaign.messageTemplate && <p className="text-xs text-t3 whitespace-pre-wrap rounded-lg border border-[var(--b1)] p-2.5">{campaign.messageSubject ? `${campaign.messageSubject}\n` : ''}{campaign.messageTemplate}</p>}
        {notice && <p className="text-[11px] text-emerald-v">{notice}</p>}
        {error && <p className="text-[11px] text-red-v">{error}</p>}
        <div className="flex flex-wrap gap-2">
          {actions.includes('generate_draft') && (
            <button type="button" disabled={busy} onClick={() => run(async () => { const d = await crmApi.generateDraft(campaign.id); setDraft(d); onChanged(); })} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--b1)] px-2.5 py-1.5 text-[11px] font-semibold text-t2 hover:bg-[var(--s2)] disabled:opacity-50"><Sparkles className="w-3.5 h-3.5" /> Generate draft (rule-based)</button>
          )}
          {actions.includes('approve') && (
            <button type="button" disabled={busy} onClick={() => void prepareConfirmation('approve')} className="inline-flex items-center gap-1.5 rounded-lg bg-indigo px-2.5 py-1.5 text-[11px] font-semibold text-white hover:opacity-90 disabled:opacity-50"><CheckCircle2 className="w-3.5 h-3.5" /> Review and approve</button>
          )}
          {actions.includes('launch') && (
            <button type="button" disabled={busy} onClick={() => void prepareConfirmation('launch')} className="inline-flex items-center gap-1.5 rounded-lg bg-indigo px-2.5 py-1.5 text-[11px] font-semibold text-white hover:opacity-90 disabled:opacity-50"><Send className="w-3.5 h-3.5" /> Review and launch</button>
          )}
          {actions.includes('pause') && (
            <button type="button" disabled={busy} onClick={() => run(async () => { await crmApi.pause(campaign.id); onChanged(); })} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--b1)] px-2.5 py-1.5 text-[11px] font-semibold text-t2 hover:bg-[var(--s2)] disabled:opacity-50"><Pause className="w-3.5 h-3.5" /> Pause</button>
          )}
          {actions.includes('edit') && (
            <button type="button" disabled={busy} onClick={() => { setEditing(v => !v); setError(null); setNotice(null); }} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--b1)] px-2.5 py-1.5 text-[11px] font-semibold text-t2 hover:bg-[var(--s2)] disabled:opacity-50"><Pencil className="w-3.5 h-3.5" /> {editing ? 'Close editor' : 'Edit'}</button>
          )}
          {actions.includes('cancel') && (
            <button type="button" disabled={busy} onClick={() => run(async () => { await crmApi.cancel(campaign.id); setNotice('Campaign canceled.'); onChanged(); })} className="inline-flex items-center gap-1.5 rounded-lg border border-amber-v/30 text-amber-v px-2.5 py-1.5 text-[11px] font-semibold hover:bg-amber-v/5 disabled:opacity-50"><Ban className="w-3.5 h-3.5" /> Cancel campaign</button>
          )}
          <button type="button" disabled={busy} onClick={() => setConfirmDelete(true)} className="inline-flex items-center gap-1.5 rounded-lg border border-red-v/30 text-red-v px-2.5 py-1.5 text-[11px] font-semibold hover:bg-red-v/5 disabled:opacity-50"><Trash2 className="w-3.5 h-3.5" /> Archive</button>
        </div>
        {confirmDelete && (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-red-v/30 bg-red-v/5 px-3 py-2 text-[11px]">
            <span className="text-red-v font-semibold">Archive “{campaign.name}”? Campaign and delivery evidence will be preserved and removed from the active list.</span>
            <span className="flex gap-1.5 shrink-0">
              <button type="button" disabled={busy} onClick={() => run(async () => { await crmApi.archiveCampaign(campaign.id); onDeleted(); })} className="rounded-md bg-red-v px-2.5 py-1 font-semibold text-white hover:opacity-90 disabled:opacity-50">Archive and preserve evidence</button>
              <button type="button" onClick={() => setConfirmDelete(false)} className="rounded-md border border-[var(--b1)] px-2.5 py-1 font-semibold text-t2 hover:bg-[var(--s2)]">Keep</button>
            </span>
          </div>
        )}
        {editing && (
          <CampaignEditForm campaign={campaign} onSaved={() => { setEditing(false); setNotice('Changes saved.'); onChanged(); }} onError={setError} />
        )}
        {draft && (
          <div className="rounded-lg border border-amber-v/30 bg-amber-v/5 p-2.5 text-[11px] text-t2 space-y-1">
            <p className="font-semibold text-t1">Draft ({draft.draftSource}) — requires approval</p>
            {draft.warnings.map(w => <p key={w} className="text-amber-v">• {w}</p>)}
          </div>
        )}
        {launch?.setupRequired && (
          <div className="flex items-center gap-2 rounded-lg border border-red-v/40 bg-red-v/5 px-2.5 py-1.5 text-[11px] text-red-v">
            <AlertCircle className="w-3.5 h-3.5" /> {launch.provider.channel} provider not configured ({launch.provider.missing.join(', ')}). Nothing was submitted to a provider.
          </div>
        )}
        {confirmation && (
          <ConfirmationModal
            title={confirmation.kind === 'approve' ? 'Authorize this exact campaign preview?' : 'Dispatch this exact campaign preview?'}
            message={`${confirmation.preview.confirmationStatement} Eligible: ${confirmation.preview.audience.eligible}; consent record required: ${confirmation.preview.audience.authorityRequired}; live safety control pending: ${confirmation.preview.audience.atomicBoundaryBlocked}; suppressed: ${confirmation.preview.audience.suppressed}; missing contact: ${confirmation.preview.audience.missingContact}; channel: ${displayLabel(confirmation.preview.channel)}; provider: ${confirmation.preview.provider}; provider mode: ${displayLabel(confirmation.preview.providerMode)}${confirmation.preview.scheduledAt ? `; scheduled: ${new Date(confirmation.preview.scheduledAt).toLocaleString()}` : ''}.`}
            confirmLabel={confirmation.kind === 'approve' ? 'Authorize exact preview' : 'Dispatch exact preview'}
            tone="amber"
            onConfirm={confirmExactPreview}
            onClose={() => setConfirmation(null)}
          />
        )}
        {confirmation?.preview.activationNotice && <p role="status" className="rounded-lg border border-amber-v/30 bg-amber-v/5 px-3 py-2 text-[11px] text-amber-v">{confirmation.preview.activationNotice}</p>}
      </div>

      {audienceError && <div role="alert" className="rounded-xl border border-red-v/30 bg-[var(--red-soft)] p-3 text-xs text-red-v">{audienceError} <button type="button" onClick={() => void loadAux()} className="ml-2 font-semibold underline">Try again</button></div>}
      {preview && (
        <div className="cc-card p-5">
          <h4 className="text-sm font-bold text-t1 mb-3 flex items-center gap-2"><Users className="w-4 h-4 text-indigo" /> Audience preview</h4>
          <div className="grid grid-cols-4 gap-3 text-center">
            <Stat label="Total" value={preview.total} />
            <Stat label="Contactable*" value={preview.eligible} accent="emerald" />
            <Stat label="Suppressed" value={preview.suppressed} accent="violet" />
            <Stat label="No contact" value={preview.missingContact} accent="amber" />
          </div>
          <p className="mt-2 text-[11px] text-t3">*Contact and suppression check only. This count is not live outreach authority; the exact purpose, versioned evidence, provider mode, and activation boundary are checked again before submission.</p>
          {preview.sample.length > 0 && (
            <div className="mt-3 space-y-1">
              {preview.sample.map((s, i) => <p key={i} className="text-[11px] text-t3">{s.name} · {s.reason} · {s.destinationMasked}</p>)}
            </div>
          )}
        </div>
      )}

      <div className="cc-card p-5">
        <h4 className="text-sm font-bold text-t1 mb-1 flex items-center gap-2"><ShieldAlert className="w-4 h-4 text-indigo" /> Dispatch evidence ({deliveries.length})</h4>
        <p className="mb-3 text-[11px] text-t3">Provider acceptance is not confirmed delivery. Delivery receipts require separate provider evidence.</p>
        {!deliveryEvidenceLoaded && !deliveryError ? (
          <p role="status" aria-live="polite" className="text-xs text-t3">Loading dispatch evidence…</p>
        ) : deliveryError ? (
          <p role="alert" className="text-xs text-red-v">{deliveryError} <button type="button" onClick={() => void loadAux()} className="ml-2 font-semibold underline">Try again</button></p>
        ) : deliveryEvidenceLoaded && deliveries.length === 0 ? <p className="text-xs text-t3">No dispatch records are stored for this campaign.</p> : (
          <div className="space-y-1.5">
            {deliveries.slice(0, 50).map(d => {
              const dm = DELIVERY_STATUS_META[d.status] ?? { label: d.status, badge: 'badge-blue' };
              return (
                <div key={d.deliveryId} className="flex items-center justify-between rounded-lg border border-[var(--b1)] px-3 py-2 text-xs">
                  <span className="text-t2">{d.destinationMasked ?? '—'} · {d.channel}</span>
                  <span className={`badge ${dm.badge}`}>{dm.label}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * One campaign's attributed outcomes.
 *
 * The counts are counts of evidence rows, so a resolved response carrying none
 * is a truthful zero — it says this campaign has no attributed outcome, not
 * that outcomes are unmeasured. Money is different: only a `paid` row carries
 * an amount, so the absence of one is stated rather than totalled to $0. And
 * engagement is never a number here at all; the API reports it as unavailable
 * with a reason, and that reason is what is rendered.
 */
function CampaignOutcomes({ loaded, error, detail, onRetry }: {
  loaded: boolean; error: string | null; detail: CampaignAttributionDetail | null; onRetry: () => void;
}) {
  if (error) {
    return (
      <p role="alert" className="text-[11px] text-red-v">
        {error} <button type="button" onClick={onRetry} className="ml-1 font-semibold underline">Try again</button>
      </p>
    );
  }
  if (!loaded || !detail) {
    return <p role="status" aria-live="polite" className="text-[11px] text-t3">Loading attributed outcomes…</p>;
  }

  const revenue = summarizeAttributedRevenue([detail]);
  const windows = attributionWindowsObserved([detail]);
  return (
    <div className="rounded-lg border border-[var(--b1)] p-2.5 space-y-1.5">
      <p className="text-[10px] font-bold uppercase tracking-wide text-t3">Attributed outcomes</p>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-t2">
        <span><span className="font-bold text-t1 tabular-nums">{detail.outcomes.booked}</span> attributed booking{detail.outcomes.booked === 1 ? '' : 's'}</span>
        <span><span className="font-bold text-t1 tabular-nums">{detail.outcomes.attended}</span> attended</span>
        <span>
          Attributed revenue:{' '}
          {revenue.status === 'attributed'
            ? <span className="font-bold text-emerald-v tabular-nums">{formatAttributedAmount(revenue.amount, revenue.currency)}</span>
            : <span className="font-semibold text-t3">not recorded yet</span>}
        </span>
      </div>
      {revenue.status === 'not_attributed' && <p className="text-[10px] text-t3">{revenue.reason}</p>}
      {/* The engagement rate this platform refuses to invent. */}
      <p className="text-[10px] text-t3">{describeEngagementUnavailability(detail.engagement)}</p>
      <p className="text-[10px] text-t3">
        {detail.attributions.length} evidence row{detail.attributions.length === 1 ? '' : 's'}
        {windows.length > 0 ? ` · ${windows.map(days => `${days}-day`).join(', ')} attribution window as recorded on each row` : ''}
        {detail.lastAttributedAt ? ` · last attributed ${new Date(detail.lastAttributedAt).toLocaleDateString()}` : ''}
      </p>
      <p className="text-[10px] text-t3">An outcome that cannot be tied to a provider-accepted delivery inside that delivery's window is not attributed at all. Dispatch evidence below records what left the building.</p>
    </div>
  );
}

function CampaignEditForm({ campaign, onSaved, onError }: { campaign: Campaign; onSaved: () => void; onError: (msg: string | null) => void }) {
  const [name, setName] = useState(campaign.name);
  const [subject, setSubject] = useState(campaign.messageSubject ?? '');
  const [template, setTemplate] = useState(campaign.messageTemplate ?? '');
  const [channel, setChannel] = useState<CommChannel>((campaign.channel ?? 'sms') as CommChannel);
  const [scheduledAt, setScheduledAt] = useState(() => {
    if (!campaign.scheduledAt) return '';
    const date = new Date(campaign.scheduledAt);
    return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  });
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true); onError(null);
    try {
      await crmApi.updateCampaign(campaign.id, {
        name: name.trim(),
        messageSubject: subject.trim() || undefined,
        messageTemplate: template.trim() || undefined,
        channel,
        scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : undefined,
      });
      onSaved();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Failed to save changes');
    } finally {
      setSaving(false);
    }
  }

  const inputCls = 'w-full rounded-lg border border-[var(--b1)] bg-[var(--s3)] px-3 py-2 text-sm text-t1 outline-none focus:border-indigo';
  return (
    <div className="rounded-lg border border-[var(--b1)] bg-[var(--s2)] p-3 space-y-3">
      <p className="text-[11px] font-bold uppercase tracking-wide text-t3">Edit campaign</p>
      <label className="block space-y-1"><span className="text-[10px] font-semibold text-t3">Name</span>
        <input className={inputCls} value={name} onChange={e => setName(e.target.value)} /></label>
      <div className="grid grid-cols-2 gap-3">
        <label className="block space-y-1"><span className="text-[10px] font-semibold text-t3">Message subject (email)</span>
          <input className={inputCls} value={subject} onChange={e => setSubject(e.target.value)} placeholder="Optional" /></label>
        <label className="block space-y-1"><span className="text-[10px] font-semibold text-t3">Channel</span>
          <select aria-label="Channel" className={inputCls} value={channel} onChange={e => setChannel(e.target.value as CommChannel)}>{CHANNELS.map(c => <option key={c} value={c}>{c}</option>)}</select></label>
      </div>
      <label className="block space-y-1"><span className="text-[10px] font-semibold text-t3">Message template</span>
        <textarea className={`${inputCls} min-h-[80px] resize-y`} value={template} onChange={e => setTemplate(e.target.value)} placeholder="Hi {{firstName}}, …" /></label>
      <label className="block space-y-1"><span className="text-[10px] font-semibold text-t3">Scheduled dispatch (optional)</span>
        <input type="datetime-local" className={inputCls} value={scheduledAt} onChange={e => setScheduledAt(e.target.value)} />
        <span className="block text-[10px] text-t3">The scheduler will run only after you review and authorize the exact server preview. Any eligibility, template, channel, or provider-mode change requires a new authorization.</span>
      </label>
      <div className="flex gap-2">
        <button type="button" disabled={saving || name.trim().length < 2} onClick={save} className="inline-flex items-center gap-1.5 rounded-lg bg-indigo px-3 py-1.5 text-[11px] font-semibold text-white hover:opacity-90 disabled:opacity-50">{saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} Save changes</button>
        <button type="button" onClick={() => onSaved()} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--b1)] px-3 py-1.5 text-[11px] font-semibold text-t2 hover:bg-[var(--s2)]"><X className="w-3.5 h-3.5" /> Close</button>
      </div>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: number; accent?: string }) {
  const color = accent === 'emerald' ? 'text-emerald-v' : accent === 'violet' ? 'text-violet-v' : accent === 'amber' ? 'text-amber-v' : 'text-t1';
  return (
    <div className="rounded-xl border border-[var(--b1)] py-2.5">
      <p className={`text-lg font-bold ${color}`}>{value}</p>
      <p className="text-[10px] text-t3">{label}</p>
    </div>
  );
}
