import { useEffect, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import {
  ArrowRight, Building2, CalendarClock, CheckCircle2,
  CircleDot, Clock3, Database, ExternalLink, Info,
  ShieldCheck, Signal, UserRound,
} from 'lucide-react';
import { apiRequest } from '../lib/api';
import { canOpenPath, hasPermission } from '../lib/access';
import { dashboardService, type BranchHealth, type PriorityAction } from '../lib/dashboardService';
import { useBackendHealth } from '../hooks/useBackendHealth';
import { useResource } from '../hooks/useResource';
import { useSession } from '../hooks/useSession';
import { receivedData } from '../lib/resourceState';

type CapabilityState = 'available' | 'test_data' | 'not_set_up';

interface TenantCapability {
  key: 'eligibility_checks' | 'card_payments';
  label: string;
  state: CapabilityState;
  detail: string;
  usable: boolean;
}

const loadSummary = () => dashboardService.getSummary();
const loadBranches = () => dashboardService.getBranchHealth();
const loadActions = () => dashboardService.getPriorityActions();
const loadCapabilities = () => apiRequest<TenantCapability[]>('/v1/capabilities');

const severityRank: Record<PriorityAction['severity'], number> = { critical: 0, high: 1, medium: 2, low: 3 };
const categoryLabel: Record<PriorityAction['category'], string> = {
  revenue: 'Revenue', no_shows: 'Schedule', missed_calls: 'Call', insurance: 'Eligibility',
  payments: 'Payment', device_alerts: 'Monitoring', reputation: 'Reputation',
};

function ageLabel(dueDate: string | null): { label: string; tone: 'critical' | 'warning' | 'neutral' } {
  if (!dueDate) return { label: 'No due time', tone: 'neutral' };
  const due = new Date(dueDate).getTime();
  if (!Number.isFinite(due)) return { label: 'Due time unavailable', tone: 'neutral' };
  const minutes = Math.round((due - Date.now()) / 60000);
  if (minutes < 0) return { label: `${Math.abs(minutes)}m overdue`, tone: 'critical' };
  if (minutes <= 30) return { label: `${minutes}m remaining`, tone: 'warning' };
  if (minutes < 1440) return { label: `Due in ${Math.round(minutes / 60)}h`, tone: 'neutral' };
  return { label: new Date(dueDate).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }), tone: 'neutral' };
}

function freshnessLabel(generatedAt?: string): string {
  if (!generatedAt) return 'Freshness unavailable';
  const updated = new Date(generatedAt).getTime();
  if (!Number.isFinite(updated)) return 'Freshness unavailable';
  const minutes = Math.max(0, Math.round((Date.now() - updated) / 60000));
  if (minutes < 1) return 'Updated just now';
  if (minutes < 60) return `Updated ${minutes}m ago`;
  if (minutes < 1440) return `Updated ${Math.round(minutes / 60)}h ago`;
  return `Updated ${new Date(updated).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;
}

function capabilityStatus(state: CapabilityState): { label: string; tone: string } {
  if (state === 'available') return { label: 'Live', tone: 'live' };
  if (state === 'test_data') return { label: 'Test data', tone: 'test' };
  return { label: 'Not configured', tone: 'off' };
}

export default function Dashboard() {
  const navigate = useNavigate();
  const apiReady = useBackendHealth();
  const { user, loading: sessionLoading } = useSession();
  const knowsUser = !sessionLoading;
  const canSeeRevenue = knowsUser && hasPermission(user, 'revenue:read');
  const canSeeStaff = knowsUser && hasPermission(user, 'staff:read');

  const summary = useResource(loadSummary);
  const branches = useResource<BranchHealth[]>(loadBranches, { enabled: canSeeStaff });
  const actions = useResource<PriorityAction[]>(loadActions, { enabled: canSeeRevenue });
  const capabilities = useResource<TenantCapability[]>(loadCapabilities);

  useEffect(() => {
    const previous = document.title;
    document.title = 'Today | CareCommand AI';
    return () => { document.title = previous; };
  }, []);

  const summaryData = receivedData(summary.state);
  const branchRows = receivedData(branches.state) ?? [];
  const actionRows = [...(receivedData(actions.state) ?? [])]
    .sort((a, b) => severityRank[a.severity] - severityRank[b.severity])
    .slice(0, 8);
  const capabilityRows = receivedData(capabilities.state) ?? [];
  const generatedAt = summaryData?.generatedAt;
  const localTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Local timezone';
  const syntheticWorkspace = !!user && (
    /(^|[-_])(demo|synthetic|test)([-_]|$)/i.test(user.tenant.slug)
    || user.email.endsWith('.local')
    || user.email.endsWith('@example.test')
  );
  const canOpenProof = canOpenPath(user, '/compliance');

  return (
    <section className="today-workspace" aria-labelledby="today-heading">
      <div className="today-scope" aria-label="Active workspace scope">
        <ScopeChip icon={<Building2 />} value={user?.tenant.name ?? 'Clinic network'} label="Network scope" />
        <ScopeChip icon={<Clock3 />} value={localTimezone} label="Browser timezone" />
        <ScopeChip className="today-scope-clinics" icon={<Database />} value={branchRows.length > 0 ? `All ${branchRows.length} clinics` : user?.branch?.name ?? 'Accessible clinics'} label="Clinic coverage" />
      </div>

      <header className="today-heading-row">
        <div>
          <h1 id="today-heading">Operational Briefing</h1>
          <p>{new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date())} · {user?.tenant.name ?? 'Clinic workspace'}</p>
        </div>
        <div className={`today-data-state ${syntheticWorkspace ? 'is-synthetic' : 'is-live'}`}><CircleDot aria-hidden="true" />{syntheticWorkspace ? 'Synthetic data' : 'Tenant data'}</div>
      </header>

      <section className="today-brief" aria-labelledby="attention-heading">
        <div className="today-brief-head">
          <div>
            <h2 id="attention-heading">{briefHeading(canSeeRevenue, actions.state.status, actionRows.length)}</h2>
          </div>
          <span className="today-freshness"><Info aria-hidden="true" /> {freshnessLabel(generatedAt)}</span>
        </div>
        <div className="today-priority-grid">
          {canSeeRevenue && actions.state.status === 'loading' && [0, 1, 2].map(index => <div key={index} className="today-priority skeleton" aria-hidden="true" />)}
          {canSeeRevenue && actions.state.status === 'error' && <StateMessage error actionLabel="Try again" onAction={actions.reload}>Priority actions could not be loaded.</StateMessage>}
          {canSeeRevenue && actions.state.status === 'ready' && actionRows.length === 0 && <StateMessage icon={<CheckCircle2 />}>The priority feed loaded and contains no recorded actions.</StateMessage>}
          {canSeeRevenue && actionRows.slice(0, 3).map((action, index) => <PriorityBrief key={action.id} action={action} index={index + 1} canOpen={canOpenPath(user, action.cta.route)} onOpen={() => navigate(action.cta.route)} />)}
          {!canSeeRevenue && <StateMessage icon={<ShieldCheck />} actionLabel={canOpenPath(user, '/front-desk') ? 'Open Work Queue' : undefined} onAction={() => navigate('/front-desk')}>This briefing does not request revenue data your role cannot read.</StateMessage>}
        </div>
      </section>

      <section className="today-ledger" aria-labelledby="ledger-heading">
        <div className="today-section-head">
          <div><h2 id="ledger-heading">Live work ledger</h2><p>Recorded priorities with source, ownership, due state and evidence freshness.</p></div>
          {canSeeRevenue && <button type="button" className="today-secondary-action" onClick={() => navigate('/opportunities')}>View full work queue <ArrowRight aria-hidden="true" /></button>}
        </div>
        {canSeeRevenue && actions.state.status === 'loading' && <div className="today-ledger-loading skeleton" aria-label="Loading work ledger" />}
        {canSeeRevenue && actions.state.status === 'error' && <StateMessage error actionLabel="Retry" onAction={actions.reload}>The work ledger could not be loaded.</StateMessage>}
        {canSeeRevenue && actions.state.status === 'ready' && actionRows.length === 0 && <StateMessage>The priority feed loaded successfully and contains no recorded work.</StateMessage>}
        {canSeeRevenue && actionRows.length > 0 && (
          <div className="today-ledger-table" role="table" aria-label="Current operational priorities">
            <div className="today-ledger-header" role="row"><span role="columnheader">Scope</span><span role="columnheader">Work item / context</span><span role="columnheader">Source</span><span role="columnheader">Owner</span><span role="columnheader">SLA / due</span><span role="columnheader">Evidence / freshness</span><span role="columnheader">Next action</span></div>
            {actionRows.slice(0, 5).map(action => <LedgerRow key={action.id} action={action} freshness={freshnessLabel(action.updatedAt ?? undefined)} canOpen={canOpenPath(user, action.cta.route)} onOpen={() => navigate(action.cta.route)} />)}
            <div className="today-ledger-footer">
              <span>1–{Math.min(5, actionRows.length)} of {actionRows.length}</span>
              {actionRows.length > 5 && <button type="button" onClick={() => navigate('/opportunities')}>View remaining {actionRows.length - 5} <ArrowRight aria-hidden="true" /></button>}
            </div>
          </div>
        )}
        {!canSeeRevenue && <StateMessage>This ledger stays hidden because your current role does not include the underlying revenue records.</StateMessage>}
      </section>

      <div className="today-evidence-row">
        <section className="today-connections" aria-labelledby="connections-heading">
          <div className="today-section-head compact"><div><h2 id="connections-heading">Connection health</h2><p>Customer-safe capability states only.</p></div><Info aria-label="States come from current capability and readiness checks." /></div>
          <div className="today-connection-grid">
            <ConnectionStatus icon={<Signal />} label="Application API" status={apiReady ? 'Live' : 'Unavailable'} tone={apiReady ? 'live' : 'off'} detail="Readiness check" />
            {capabilityRows.map(capability => { const status = capabilityStatus(capability.state); return <ConnectionStatus key={capability.key} icon={capability.key === 'eligibility_checks' ? <ShieldCheck /> : <CalendarClock />} label={capability.label} status={status.label} tone={status.tone} detail={capability.detail} />; })}
            {capabilities.state.status === 'loading' && <div className="today-connection-loading skeleton" aria-label="Loading capability status" />}
            {capabilities.state.status === 'error' && <button type="button" className="today-connection-error" onClick={capabilities.reload}>Capability states unavailable · Retry</button>}
          </div>
        </section>
        <section className="today-proof" aria-labelledby="proof-heading">
          <div className="today-proof-mark"><ShieldCheck aria-hidden="true" /></div>
          <div><h2 id="proof-heading">Open PHI-safe executive proof</h2><p>Readiness evidence only; this view does not claim certification or customer outcomes.</p></div>
          <button type="button" disabled={!canOpenProof} onClick={() => canOpenProof && navigate('/compliance/proof')}>{canOpenProof ? <>Open proof <ExternalLink aria-hidden="true" /></> : 'Proof unavailable for this role'}</button>
        </section>
      </div>
    </section>
  );
}

function briefHeading(canSeeRevenue: boolean, status: string, count: number) {
  if (!canSeeRevenue) return 'Your role-specific work is available from the Work Queue.';
  if (status === 'loading') return 'Loading the current priority record…';
  if (count === 0) return 'No priority actions were returned.';
  return `${count} recorded ${count === 1 ? 'item needs' : 'items need'} attention.`;
}

function ScopeChip({ icon, value, label, className = '' }: { icon: ReactNode; value: string; label: string; className?: string }) {
  return <div className={`today-scope-chip ${className}`}><span aria-hidden="true">{icon}</span><span><strong>{value}</strong><small>{label}</small></span></div>;
}

function StateMessage({ children, icon, error = false, actionLabel, onAction }: { children: ReactNode; icon?: ReactNode; error?: boolean; actionLabel?: string; onAction?: () => void }) {
  return <div className={`today-state-message ${error ? 'is-error' : ''}`} role={error ? 'alert' : undefined}>{icon && <span aria-hidden="true">{icon}</span>}<p>{children}</p>{actionLabel && onAction && <button type="button" onClick={onAction}>{actionLabel}</button>}</div>;
}

function PriorityBrief({ action, index, canOpen, onOpen }: { action: PriorityAction; index: number; canOpen: boolean; onOpen: () => void }) {
  const due = ageLabel(action.dueDate);
  return <article className="today-priority"><div className={`today-priority-number severity-${action.severity}`}>{index}</div><div className="today-priority-copy"><div className="today-priority-title-row"><h3>{action.title}</h3><span className={`today-severity severity-${action.severity}`}>{action.severity}</span></div><p>{action.description || `${categoryLabel[action.category]} record`}</p><dl><div><dt>Owner</dt><dd><UserRound aria-hidden="true" /> {action.owner}</dd></div><div><dt>SLA / due</dt><dd className={`tone-${due.tone}`}><Clock3 aria-hidden="true" /> {due.label}</dd></div></dl></div><button type="button" disabled={!canOpen} onClick={onOpen}>{canOpen ? action.cta.label : 'Unavailable for this role'}</button></article>;
}

function LedgerRow({ action, freshness, canOpen, onOpen }: { action: PriorityAction; freshness: string; canOpen: boolean; onOpen: () => void }) {
  const due = ageLabel(action.dueDate);
  return <div className="today-ledger-row" role="row"><span role="cell" data-label="Scope"><Building2 aria-hidden="true" /> Network</span><span role="cell" data-label="Work item / context"><strong>{action.title}</strong><small>{action.description || 'No additional context supplied by the source.'}</small></span><span role="cell" data-label="Source"><Database aria-hidden="true" /> {categoryLabel[action.category]}</span><span role="cell" data-label="Owner"><UserRound aria-hidden="true" /> {action.owner}</span><span role="cell" data-label="SLA / due" className={`tone-${due.tone}`}><Clock3 aria-hidden="true" /> {due.label}</span><span role="cell" data-label="Evidence / freshness"><CircleDot aria-hidden="true" /> API record<small>{freshness}</small></span><span role="cell" data-label="Next action"><button type="button" disabled={!canOpen} onClick={onOpen}>{canOpen ? action.cta.label : 'Unavailable for this role'}</button></span></div>;
}

function ConnectionStatus({ icon, label, status, tone, detail }: { icon: ReactNode; label: string; status: string; tone: string; detail: string }) {
  return <div className="today-connection-item" title={detail}><span className="today-connection-icon" aria-hidden="true">{icon}</span><span><strong>{label}</strong><small className={`connection-${tone}`}><i /> {status}</small></span></div>;
}
