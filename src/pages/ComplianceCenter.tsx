import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import {
  ShieldCheck, ListChecks, FileText, AlertTriangle, Building2, Siren,
  ScrollText, SlidersHorizontal, BarChart3, RefreshCw, Plus, Trash2, History,
  Loader2, Check, X, Lock, ExternalLink,
} from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import StatCard from '../components/ui/StatCard';
import { Field, TextInput, Select, Toggle } from '../components/ui/Field';
import { useSession } from '../hooks/useSession';
import {
  complianceApi as api, canWriteCompliance,
  CONTROL_STATUS_BADGE, CONTROL_STATUS_LABEL, REPORT_KEYS, REPORT_LABELS,
  type Control, type ControlStatus, type EvidenceVersion,
  type Risk, type Vendor, type Incident, type SecurityPolicy, type ReportBase, type ReportKey,
} from '../lib/compliance';

type Section = 'overview' | 'controls' | 'evidence' | 'risks' | 'vendors' | 'incidents' | 'audit-logs' | 'security-policy' | 'reports';

const TABS: Array<{ id: Section; label: string; icon: React.ElementType }> = [
  { id: 'overview', label: 'Overview', icon: ShieldCheck },
  { id: 'controls', label: 'Controls', icon: ListChecks },
  { id: 'evidence', label: 'Evidence Vault', icon: FileText },
  { id: 'risks', label: 'Risks', icon: AlertTriangle },
  { id: 'vendors', label: 'Vendor Risk', icon: Building2 },
  { id: 'incidents', label: 'Incidents', icon: Siren },
  { id: 'audit-logs', label: 'Audit Logs', icon: ScrollText },
  { id: 'security-policy', label: 'Security Policy', icon: SlidersHorizontal },
  { id: 'reports', label: 'Reports', icon: BarChart3 },
];

// Lint-safe async loader: setState only runs inside the resolved promise (after
// an await) or in event handlers, never synchronously in the effect body.
function useAsync<T>(factory: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  // `factory` must be memoized by callers (useCallback) so the effect re-runs
  // when its inputs change (e.g. filters) and not on every render.
  useEffect(() => {
    let active = true;
    factory()
      .then(d => { if (active) { setData(d); setError(null); setLoading(false); } })
      .catch(e => { if (active) { setError(e instanceof Error ? e.message : 'Failed to load'); setLoading(false); } });
    return () => { active = false; };
  }, [factory, nonce]);
  const reload = useCallback(() => { setLoading(true); setNonce(n => n + 1); }, []);
  return { data, loading, error, reload };
}

function StateBlock({ loading, error, empty, children }: { loading: boolean; error: string | null; empty?: boolean; children: React.ReactNode }) {
  if (loading) return <div className="cc-card p-10 text-center text-sm text-t3"><Loader2 className="w-4 h-4 animate-spin inline mr-2" /> Loading…</div>;
  if (error) return <div className="cc-card p-6 text-sm text-red-v inline-flex items-center gap-2"><AlertTriangle className="w-4 h-4" /> {error}</div>;
  if (empty) return <div className="cc-card p-10 text-center text-sm text-t3">Nothing here yet.</div>;
  return <>{children}</>;
}

function Note({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'gap'; children: React.ReactNode }) {
  const cls = tone === 'warn' ? 'bg-[var(--amber-soft)] text-amber-v' : tone === 'gap' ? 'bg-[var(--red-soft)] text-red-v' : 'bg-[var(--blue-soft)] text-blue-v';
  return <div className={`flex items-start gap-2 rounded-xl border border-[var(--b1)] ${cls} px-3 py-2 text-[11px] font-semibold leading-snug`}><AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> <span>{children}</span></div>;
}

function RefreshButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--b1)] bg-[var(--s2)] px-3 py-1.5 text-xs font-semibold text-t2 hover:bg-[var(--s3)]">
      <RefreshCw className="w-3.5 h-3.5" /> Refresh
    </button>
  );
}

// A small truthful integration badge for report cards / status rows.
function IntegrationBadge({ integrated, status }: { integrated?: boolean; status?: string }) {
  if (integrated === false) return <span className="badge badge-red">{status ? status.replace(/_/g, ' ') : 'not integrated'}</span>;
  if (integrated === true) return <span className="badge badge-emerald">{status ?? 'integrated'}</span>;
  return <span className="badge badge-blue">{status ?? 'unknown'}</span>;
}

export default function ComplianceCenter() {
  const { section } = useParams<{ section?: Section }>();
  const navigate = useNavigate();
  const { user } = useSession();
  const canWrite = canWriteCompliance(user?.role);
  const active: Section = (TABS.find(t => t.id === section)?.id) ?? 'overview';

  return (
    <div className="space-y-6 pb-10">
      <PageHeader
        title="Compliance Readiness Center"
        subtitle="SOC 2 Readiness, HIPAA Alignment, and internal security baseline — a readiness posture, not a certification."
        badge={canWrite ? 'Read / write' : 'Read only'}
        badgeColor={canWrite ? 'violet' : 'blue'}
      />

      <div className="flex items-center gap-1 overflow-x-auto rounded-xl bg-[var(--s3)] p-1">
        {TABS.map(t => {
          const Icon = t.icon;
          return (
            <button key={t.id} type="button" onClick={() => navigate(`/compliance/${t.id}`)}
              className={`flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-semibold transition-all ${active === t.id ? 'bg-[var(--s2)] text-t1 shadow-sm' : 'text-t3 hover:text-t2'}`}>
              <Icon className="w-3.5 h-3.5" /> {t.label}
            </button>
          );
        })}
      </div>

      {active === 'overview' && <OverviewSection />}
      {active === 'controls' && <ControlsSection canWrite={canWrite} />}
      {active === 'evidence' && <EvidenceSection canWrite={canWrite} />}
      {active === 'risks' && <RisksSection canWrite={canWrite} />}
      {active === 'vendors' && <VendorsSection canWrite={canWrite} />}
      {active === 'incidents' && <IncidentsSection canWrite={canWrite} />}
      {active === 'audit-logs' && <AuditLogsSection />}
      {active === 'security-policy' && <SecurityPolicySection canWrite={canWrite} />}
      {active === 'reports' && <ReportsSection />}
    </div>
  );
}

// ===== Overview ============================================================
function OverviewSection() {
  const { data, loading, error, reload } = useAsync(useCallback(() => api.dashboard(), []));
  return (
    <div className="space-y-4">
      <div className="flex justify-end"><RefreshButton onClick={reload} /></div>
      <StateBlock loading={loading} error={error}>
        {data && (
          <div className="space-y-4">
            <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
              <StatCard title="Overall Readiness" value={`${data.overallReadinessScore}%`} subtitle="Weighted across frameworks" accent="violet" />
              <StatCard title="SOC 2 Readiness" value={`${data.soc2ReadinessPct}%`} accent="blue" />
              <StatCard title="HIPAA Alignment" value={`${data.hipaaAlignmentPct}%`} accent="cyan" />
              <StatCard title="Internal Baseline" value={`${data.internalBaselinePct}%`} accent="emerald" />
            </div>
            <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
              <StatCard title="Open Risks" value={String(data.openRisks)} accent="amber" />
              <StatCard title="Not Implemented Controls" value={String(data.notImplementedControls)} accent="red" />
              <StatCard title="Missing Evidence" value={String(data.missingEvidenceCount)} accent="amber" />
              <StatCard title="Expiring Evidence (30d)" value={String(data.expiringEvidenceCount)} accent="blue" />
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <div className="cc-card p-5 space-y-3">
                <h3 className="text-sm font-bold text-t1">Posture (truthful status)</h3>
                <StatusRow label="MFA adoption">
                  <span className="badge badge-red">{data.mfaStatus.enforced ? 'enforced' : 'not enforced'}</span>
                  <span className="text-[11px] text-t3">{data.mfaStatus.note}</span>
                </StatusRow>
                <StatusRow label="Backup verification">
                  <IntegrationBadge integrated={data.backupStatus.integrated} status={data.backupStatus.status} />
                  <span className="text-[11px] text-t3">{data.backupStatus.lastRunAt ? `Last: ${new Date(data.backupStatus.lastRunAt).toLocaleString()}` : 'No verified run'}</span>
                </StatusRow>
                <StatusRow label="Audit trail">
                  <span className="badge badge-emerald">append-only</span>
                  <span className="text-[11px] text-t3">Tamper-resistant; enforced at the database.</span>
                </StatusRow>
                <StatusRow label="Tenant isolation">
                  <span className="badge badge-amber">app scoping active</span>
                  <span className="text-[11px] text-t3">Database RLS rollout in progress for compliance tables.</span>
                </StatusRow>
                <StatusRow label="Security incidents">
                  <span className="badge badge-blue">{data.securityIncidents.open} open</span>
                  <span className="text-[11px] text-t3">{data.securityIncidents.total} total · {data.securityIncidents.resolved} resolved</span>
                </StatusRow>
              </div>

              <div className="cc-card p-5 space-y-2">
                <h3 className="text-sm font-bold text-t1 inline-flex items-center gap-2"><ScrollText className="w-4 h-4 text-indigo" /> Recent audit events</h3>
                {data.recentAuditEvents.length === 0 ? <p className="text-xs text-t3">No recent events.</p> : (
                  <div className="divide-y divide-[var(--b0)]">
                    {data.recentAuditEvents.map(e => (
                      <div key={e.id} className="py-2 flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-xs font-semibold text-t1 truncate">{e.action}</p>
                          <p className="text-[10px] text-t3 truncate">{e.resource}{e.resourceId ? ` · ${e.resourceId.slice(0, 8)}` : ''} · {e.actor}</p>
                        </div>
                        <span className="text-[10px] text-t3 shrink-0">{new Date(e.occurredAt).toLocaleString()}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </StateBlock>
    </div>
  );
}

function StatusRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-[var(--b1)] px-3 py-2">
      <span className="text-xs font-semibold text-t2">{label}</span>
      <div className="flex items-center gap-2 flex-wrap justify-end">{children}</div>
    </div>
  );
}

// ===== Controls ============================================================
function ControlsSection({ canWrite }: { canWrite: boolean }) {
  const { data, loading, error, reload } = useAsync(useCallback(() => api.listControls(), []));
  const grouped = useMemo(() => {
    const map = new Map<string, Control[]>();
    for (const c of data ?? []) {
      const key = c.framework.name;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(c);
    }
    return [...map.entries()];
  }, [data]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-t3">Grouped by framework and category. {canWrite ? 'Update status, owner, notes, and review date.' : 'Read-only view.'}</p>
        <RefreshButton onClick={reload} />
      </div>
      <StateBlock loading={loading} error={error} empty={(data?.length ?? 0) === 0}>
        <div className="space-y-4">
          {grouped.map(([framework, controls]) => (
            <div key={framework} className="cc-card p-5 space-y-2">
              <h3 className="text-sm font-bold text-t1">{framework}</h3>
              <div className="divide-y divide-[var(--b0)]">
                {controls.map(c => <ControlRow key={c.id} control={c} canWrite={canWrite} onSaved={reload} />)}
              </div>
            </div>
          ))}
        </div>
      </StateBlock>
    </div>
  );
}

function ControlRow({ control, canWrite, onSaved }: { control: Control; canWrite: boolean; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [status, setStatus] = useState<ControlStatus>(control.status);
  const [notes, setNotes] = useState(control.notes ?? '');
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await api.updateControl(control.id, { status, notes, lastReviewedAt: new Date().toISOString() });
      setEditing(false);
      onSaved();
    } finally { setBusy(false); }
  }

  return (
    <div className="py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-semibold text-t1">{control.title}</p>
            <span className={CONTROL_STATUS_BADGE[control.status]}>{CONTROL_STATUS_LABEL[control.status]}</span>
            <span className="badge badge-blue">{control.categoryKey.replace(/_/g, ' ')}</span>
          </div>
          <p className="text-[11px] text-t3 mt-0.5">{control.description}</p>
          <p className="text-[10px] text-t3 mt-1">
            Owner: {control.ownerUserId ? control.ownerUserId.slice(0, 8) : '—'} · Last reviewed: {control.lastReviewedAt ? new Date(control.lastReviewedAt).toLocaleDateString() : 'never'}
            {control.notes ? ` · ${control.notes}` : ''}
          </p>
        </div>
        {canWrite && !editing && (
          <button type="button" onClick={() => setEditing(true)} className="shrink-0 rounded-lg border border-[var(--b1)] px-2.5 py-1 text-[11px] font-semibold text-indigo hover:bg-[var(--s3)]">Edit</button>
        )}
      </div>
      {editing && (
        <div className="mt-2 grid gap-2 md:grid-cols-[200px_1fr_auto] items-end rounded-xl border border-dashed border-[var(--b2)] p-3">
          <Field label="Status">
            <Select value={status} onChange={e => setStatus(e.target.value as ControlStatus)}>
              {(Object.keys(CONTROL_STATUS_LABEL) as ControlStatus[]).map(s => <option key={s} value={s}>{CONTROL_STATUS_LABEL[s]}</option>)}
            </Select>
          </Field>
          <Field label="Notes"><TextInput value={notes} onChange={e => setNotes(e.target.value)} /></Field>
          <div className="flex gap-2">
            <button type="button" disabled={busy} onClick={save} className="rounded-xl bg-indigo px-3 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-40">{busy ? '…' : 'Save'}</button>
            <button type="button" onClick={() => setEditing(false)} className="rounded-xl border border-[var(--b1)] px-3 py-2 text-sm text-t2 hover:bg-[var(--s3)]">Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ===== Evidence Vault ======================================================
function EvidenceSection({ canWrite }: { canWrite: boolean }) {
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const { data, loading, error, reload } = useAsync(useCallback(() => api.listEvidence(includeDeleted), [includeDeleted]));
  const [adding, setAdding] = useState(false);
  const [versionsFor, setVersionsFor] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      <Note>Evidence file custody is not enabled yet. Store an external evidence link and a content hash for now — records keep a tamper-evident version chain, not stored files.</Note>
      <div className="flex items-center justify-between gap-2">
        <Toggle checked={includeDeleted} onChange={setIncludeDeleted} label="Include soft-deleted" />
        <div className="flex items-center gap-2">
          <RefreshButton onClick={reload} />
          {canWrite && <button type="button" onClick={() => setAdding(a => !a)} className="inline-flex items-center gap-1.5 rounded-xl bg-indigo px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90"><Plus className="w-3.5 h-3.5" /> New evidence</button>}
        </div>
      </div>

      {adding && canWrite && <EvidenceForm onClose={() => setAdding(false)} onSaved={() => { setAdding(false); reload(); }} />}

      <StateBlock loading={loading} error={error} empty={(data?.length ?? 0) === 0}>
        <div className="space-y-2">
          {(data ?? []).map(ev => (
            <div key={ev.id} className={`cc-card p-4 ${ev.deletedAt ? 'opacity-60' : ''}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-sm font-semibold text-t1 truncate">{ev.title}</p>
                    <span className={`badge ${ev.reviewStatus === 'APPROVED' ? 'badge-emerald' : ev.reviewStatus === 'REJECTED' ? 'badge-red' : 'badge-amber'}`}>{ev.reviewStatus.toLowerCase()}</span>
                    {ev.deletedAt && <span className="badge badge-red">soft-deleted</span>}
                    <span className="badge badge-blue">{ev.sourceType}</span>
                  </div>
                  <p className="text-[11px] text-t3 mt-1 truncate">
                    {ev.externalUrl ? <a href={ev.externalUrl} target="_blank" rel="noreferrer" className="text-indigo inline-flex items-center gap-1">external link <ExternalLink className="w-3 h-3" /></a> : 'no external link'}
                    {ev.contentHash ? ` · hash ${ev.contentHash.slice(0, 12)}…` : ''}
                    {ev.expiresAt ? ` · expires ${new Date(ev.expiresAt).toLocaleDateString()}` : ''}
                    {` · ${ev.controlEvidence.length} linked control(s)`}
                  </p>
                  {ev.auditorNotes && <p className="text-[10px] text-t3 mt-0.5">Auditor: {ev.auditorNotes}</p>}
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button type="button" onClick={() => setVersionsFor(versionsFor === ev.id ? null : ev.id)} className="rounded-lg border border-[var(--b1)] px-2 py-1 text-[11px] font-semibold text-t2 hover:bg-[var(--s3)] inline-flex items-center gap-1"><History className="w-3 h-3" /> Versions</button>
                  {canWrite && !ev.deletedAt && (
                    <button type="button" onClick={async () => { if (window.confirm('Soft delete this evidence metadata? The record is retained (deletedAt set), not erased.')) { await api.deleteEvidence(ev.id); reload(); } }}
                      className="rounded-lg border border-[var(--b1)] px-2 py-1 text-[11px] font-semibold text-red-v hover:bg-[var(--red-soft)] inline-flex items-center gap-1"><Trash2 className="w-3 h-3" /> Soft delete</button>
                  )}
                </div>
              </div>
              {versionsFor === ev.id && <EvidenceVersions evidenceId={ev.id} />}
            </div>
          ))}
        </div>
      </StateBlock>
    </div>
  );
}

function EvidenceForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState('');
  const [externalUrl, setExternalUrl] = useState('');
  const [contentHash, setContentHash] = useState('');
  const [sourceType, setSourceType] = useState('manual');
  const [expiresAt, setExpiresAt] = useState('');
  const [auditorNotes, setAuditorNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    if (title.trim().length < 2) { setErr('Title is required'); return; }
    setBusy(true); setErr(null);
    try {
      await api.createEvidence({
        title: title.trim(),
        externalUrl: externalUrl.trim() || undefined,
        contentHash: contentHash.trim() || undefined,
        sourceType,
        expiresAt: expiresAt || undefined,
        auditorNotes: auditorNotes.trim() || undefined,
      });
      onSaved();
    } catch (e) { setErr(e instanceof Error ? e.message : 'Failed to save'); }
    finally { setBusy(false); }
  }

  return (
    <div className="cc-card p-5 space-y-3">
      <h3 className="text-sm font-bold text-t1">New evidence (metadata only)</h3>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Title" required><TextInput value={title} onChange={e => setTitle(e.target.value)} /></Field>
        <Field label="Source type"><TextInput value={sourceType} onChange={e => setSourceType(e.target.value)} /></Field>
        <Field label="External evidence link" hint="No file is stored by the app."><TextInput value={externalUrl} onChange={e => setExternalUrl(e.target.value)} placeholder="https://…" /></Field>
        <Field label="Content hash" hint="e.g. SHA-256 of the source artifact."><TextInput value={contentHash} onChange={e => setContentHash(e.target.value)} /></Field>
        <Field label="Expires at"><TextInput type="date" value={expiresAt} onChange={e => setExpiresAt(e.target.value)} /></Field>
        <Field label="Auditor notes"><TextInput value={auditorNotes} onChange={e => setAuditorNotes(e.target.value)} /></Field>
      </div>
      {err && <p className="text-[11px] font-semibold text-red-v">{err}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className="rounded-xl border border-[var(--b1)] px-3 py-2 text-sm text-t2 hover:bg-[var(--s3)]">Cancel</button>
        <button type="button" disabled={busy} onClick={save} className="rounded-xl bg-indigo px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-40">{busy ? 'Saving…' : 'Create'}</button>
      </div>
    </div>
  );
}

function EvidenceVersions({ evidenceId }: { evidenceId: string }) {
  const { data, loading, error } = useAsync(useCallback(() => api.listEvidenceVersions(evidenceId), [evidenceId]));
  return (
    <div className="mt-3 rounded-xl border border-[var(--b1)] bg-[var(--s3)] p-3">
      <p className="text-[10px] font-bold uppercase tracking-widest text-t3 mb-2">Tamper-evident version chain</p>
      {loading && <p className="text-[11px] text-t3">Loading versions…</p>}
      {error && <p className="text-[11px] text-red-v">{error}</p>}
      <div className="space-y-1.5">
        {(data ?? []).map((v: EvidenceVersion) => (
          <div key={v.id} className="flex items-center justify-between gap-2 text-[11px]">
            <span className="font-semibold text-t2">v{v.version} · {v.changeType}</span>
            <span className="font-mono text-t3 truncate">hash {v.rowHash.slice(0, 10)}… {v.prevHash ? `← ${v.prevHash.slice(0, 8)}…` : '(genesis)'}</span>
            <span className="text-t3 shrink-0">{new Date(v.createdAt).toLocaleString()}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ===== Risks ===============================================================
function RisksSection({ canWrite }: { canWrite: boolean }) {
  const { data, loading, error, reload } = useAsync(useCallback(() => api.listRisks(), []));
  const [adding, setAdding] = useState(false);
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end gap-2">
        <RefreshButton onClick={reload} />
        {canWrite && <button type="button" onClick={() => setAdding(a => !a)} className="inline-flex items-center gap-1.5 rounded-xl bg-indigo px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90"><Plus className="w-3.5 h-3.5" /> New risk</button>}
      </div>
      {adding && canWrite && <RiskForm onClose={() => setAdding(false)} onSaved={() => { setAdding(false); reload(); }} />}
      <StateBlock loading={loading} error={error} empty={(data?.length ?? 0) === 0}>
        <div className="space-y-2">
          {(data ?? []).map((r: Risk) => (
            <div key={r.id} className="cc-card p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-sm font-semibold text-t1">{r.title}</p>
                    <span className={`badge ${r.status === 'CLOSED' ? 'badge-emerald' : r.status === 'OPEN' ? 'badge-red' : 'badge-amber'}`}>{r.status.toLowerCase()}</span>
                    <span className="badge badge-blue">score {r.score}</span>
                  </div>
                  <p className="text-[11px] text-t3 mt-0.5">{r.categoryKey.replace(/_/g, ' ')} · likelihood {r.likelihood} · impact {r.impact}</p>
                  {r.mitigationPlan && <p className="text-[10px] text-t3 mt-1">Mitigation: {r.mitigationPlan}</p>}
                </div>
                {canWrite && <RiskStatusControl risk={r} onSaved={reload} />}
              </div>
            </div>
          ))}
        </div>
      </StateBlock>
    </div>
  );
}

function RiskStatusControl({ risk, onSaved }: { risk: Risk; onSaved: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Select aria-label="Risk status" title="Risk status" value={risk.status} disabled={busy} onChange={async e => { setBusy(true); try { await api.updateRisk(risk.id, { status: e.target.value }); onSaved(); } finally { setBusy(false); } }} className="w-36 shrink-0">
      {['OPEN', 'MITIGATING', 'ACCEPTED', 'CLOSED'].map(s => <option key={s} value={s}>{s.toLowerCase()}</option>)}
    </Select>
  );
}

function RiskForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState('');
  const [categoryKey, setCategoryKey] = useState('risk_management');
  const [likelihood, setLikelihood] = useState('medium');
  const [impact, setImpact] = useState('medium');
  const [score, setScore] = useState(40);
  const [mitigationPlan, setMitigation] = useState('');
  const [busy, setBusy] = useState(false);
  async function save() {
    if (title.trim().length < 2) return;
    setBusy(true);
    try { await api.createRisk({ title: title.trim(), categoryKey, likelihood, impact, score, mitigationPlan: mitigationPlan.trim() || undefined }); onSaved(); }
    finally { setBusy(false); }
  }
  return (
    <div className="cc-card p-5 space-y-3">
      <h3 className="text-sm font-bold text-t1">New risk</h3>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Title" required><TextInput value={title} onChange={e => setTitle(e.target.value)} /></Field>
        <Field label="Category"><TextInput value={categoryKey} onChange={e => setCategoryKey(e.target.value)} /></Field>
        <Field label="Likelihood"><Select value={likelihood} onChange={e => setLikelihood(e.target.value)}>{['low', 'medium', 'high'].map(o => <option key={o}>{o}</option>)}</Select></Field>
        <Field label="Impact"><Select value={impact} onChange={e => setImpact(e.target.value)}>{['low', 'medium', 'high'].map(o => <option key={o}>{o}</option>)}</Select></Field>
        <Field label="Score (0-100)"><TextInput type="number" value={score} onChange={e => setScore(Number(e.target.value))} /></Field>
        <Field label="Mitigation plan"><TextInput value={mitigationPlan} onChange={e => setMitigation(e.target.value)} /></Field>
      </div>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className="rounded-xl border border-[var(--b1)] px-3 py-2 text-sm text-t2 hover:bg-[var(--s3)]">Cancel</button>
        <button type="button" disabled={busy} onClick={save} className="rounded-xl bg-indigo px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-40">{busy ? 'Saving…' : 'Create'}</button>
      </div>
    </div>
  );
}

// ===== Vendors =============================================================
function VendorsSection({ canWrite }: { canWrite: boolean }) {
  const { data, loading, error, reload } = useAsync(useCallback(() => api.listVendors(), []));
  const [adding, setAdding] = useState(false);
  return (
    <div className="space-y-4">
      <Note>Vendor status reflects the recorded value only — it does not assert that a vendor is approved or has a signed BAA unless the data says so.</Note>
      <div className="flex items-center justify-end gap-2">
        <RefreshButton onClick={reload} />
        {canWrite && <button type="button" onClick={() => setAdding(a => !a)} className="inline-flex items-center gap-1.5 rounded-xl bg-indigo px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90"><Plus className="w-3.5 h-3.5" /> New vendor</button>}
      </div>
      {adding && canWrite && <VendorForm onClose={() => setAdding(false)} onSaved={() => { setAdding(false); reload(); }} />}
      <StateBlock loading={loading} error={error} empty={(data?.length ?? 0) === 0}>
        <div className="space-y-2">
          {(data ?? []).map((v: Vendor) => (
            <div key={v.id} className="cc-card p-4 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-sm font-semibold text-t1">{v.vendorName}</p>
                  <span className={`badge ${v.baaStatus === 'signed' ? 'badge-emerald' : 'badge-amber'}`}>BAA: {v.baaStatus}</span>
                  <span className="badge badge-blue">{v.riskTier} risk</span>
                  <span className="badge badge-violet">{v.status}</span>
                </div>
                <p className="text-[11px] text-t3 mt-0.5">{v.category ?? 'uncategorized'} · access: {v.dataAccessLevel ?? 'n/a'} · next review: {v.nextReviewAt ? new Date(v.nextReviewAt).toLocaleDateString() : '—'}</p>
              </div>
            </div>
          ))}
        </div>
      </StateBlock>
    </div>
  );
}

function VendorForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [vendorName, setName] = useState('');
  const [category, setCategory] = useState('');
  const [dataAccessLevel, setAccess] = useState('');
  const [baaStatus, setBaa] = useState('unknown');
  const [riskTier, setTier] = useState('medium');
  const [busy, setBusy] = useState(false);
  async function save() {
    if (vendorName.trim().length < 2) return;
    setBusy(true);
    try { await api.createVendor({ vendorName: vendorName.trim(), category: category.trim() || undefined, dataAccessLevel: dataAccessLevel.trim() || undefined, baaStatus, riskTier }); onSaved(); }
    finally { setBusy(false); }
  }
  return (
    <div className="cc-card p-5 space-y-3">
      <h3 className="text-sm font-bold text-t1">New vendor</h3>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Vendor name" required><TextInput value={vendorName} onChange={e => setName(e.target.value)} /></Field>
        <Field label="Category"><TextInput value={category} onChange={e => setCategory(e.target.value)} /></Field>
        <Field label="Data access level"><TextInput value={dataAccessLevel} onChange={e => setAccess(e.target.value)} placeholder="none / limited / phi" /></Field>
        <Field label="BAA status"><Select value={baaStatus} onChange={e => setBaa(e.target.value)}>{['unknown', 'not_required', 'pending', 'signed'].map(o => <option key={o}>{o}</option>)}</Select></Field>
        <Field label="Risk tier"><Select value={riskTier} onChange={e => setTier(e.target.value)}>{['low', 'medium', 'high'].map(o => <option key={o}>{o}</option>)}</Select></Field>
      </div>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className="rounded-xl border border-[var(--b1)] px-3 py-2 text-sm text-t2 hover:bg-[var(--s3)]">Cancel</button>
        <button type="button" disabled={busy} onClick={save} className="rounded-xl bg-indigo px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-40">{busy ? 'Saving…' : 'Create'}</button>
      </div>
    </div>
  );
}

// ===== Incidents ===========================================================
function IncidentsSection({ canWrite }: { canWrite: boolean }) {
  const { data, loading, error, reload } = useAsync(useCallback(() => api.listIncidents(), []));
  const [adding, setAdding] = useState(false);
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end gap-2">
        <RefreshButton onClick={reload} />
        {canWrite && <button type="button" onClick={() => setAdding(a => !a)} className="inline-flex items-center gap-1.5 rounded-xl bg-indigo px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90"><Plus className="w-3.5 h-3.5" /> Log incident</button>}
      </div>
      {adding && canWrite && <IncidentForm onClose={() => setAdding(false)} onSaved={() => { setAdding(false); reload(); }} />}
      <StateBlock loading={loading} error={error} empty={(data?.length ?? 0) === 0}>
        <div className="space-y-2">
          {(data ?? []).map((i: Incident) => (
            <div key={i.id} className="cc-card p-4 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-sm font-semibold text-t1">{i.title}</p>
                  <span className={`badge ${i.severity === 'high' || i.severity === 'critical' ? 'badge-red' : i.severity === 'medium' ? 'badge-amber' : 'badge-blue'}`}>{i.severity}</span>
                  <span className={`badge ${i.status === 'resolved' ? 'badge-emerald' : 'badge-amber'}`}>{i.status}</span>
                </div>
                <p className="text-[11px] text-t3 mt-0.5">Detected {new Date(i.detectedAt).toLocaleString()}{i.resolvedAt ? ` · resolved ${new Date(i.resolvedAt).toLocaleString()}` : ''}{i.affectedScope ? ` · ${i.affectedScope}` : ''}</p>
                {i.summary && <p className="text-[10px] text-t3 mt-0.5">{i.summary}</p>}
              </div>
              {canWrite && i.status !== 'resolved' && (
                <button type="button" onClick={async () => { await api.updateIncident(i.id, { status: 'resolved', resolvedAt: new Date().toISOString() }); reload(); }}
                  className="shrink-0 rounded-lg border border-[var(--b1)] px-2.5 py-1 text-[11px] font-semibold text-emerald-v hover:bg-[var(--emerald-soft)]">Mark resolved</button>
              )}
            </div>
          ))}
        </div>
      </StateBlock>
    </div>
  );
}

function IncidentForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState('');
  const [severity, setSeverity] = useState('low');
  const [summary, setSummary] = useState('');
  const [affectedScope, setScope] = useState('');
  const [busy, setBusy] = useState(false);
  async function save() {
    if (title.trim().length < 2) return;
    setBusy(true);
    try { await api.createIncident({ title: title.trim(), severity, summary: summary.trim() || undefined, affectedScope: affectedScope.trim() || undefined }); onSaved(); }
    finally { setBusy(false); }
  }
  return (
    <div className="cc-card p-5 space-y-3">
      <h3 className="text-sm font-bold text-t1">Log incident</h3>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Title" required><TextInput value={title} onChange={e => setTitle(e.target.value)} /></Field>
        <Field label="Severity"><Select value={severity} onChange={e => setSeverity(e.target.value)}>{['low', 'medium', 'high', 'critical'].map(o => <option key={o}>{o}</option>)}</Select></Field>
        <Field label="Affected scope"><TextInput value={affectedScope} onChange={e => setScope(e.target.value)} /></Field>
        <Field label="Summary"><TextInput value={summary} onChange={e => setSummary(e.target.value)} /></Field>
      </div>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className="rounded-xl border border-[var(--b1)] px-3 py-2 text-sm text-t2 hover:bg-[var(--s3)]">Cancel</button>
        <button type="button" disabled={busy} onClick={save} className="rounded-xl bg-indigo px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-40">{busy ? 'Saving…' : 'Create'}</button>
      </div>
    </div>
  );
}

// ===== Audit Logs ==========================================================
function AuditLogsSection() {
  const [filters, setFilters] = useState({ action: '', resource: '', from: '', to: '' });
  const [applied, setApplied] = useState(filters);
  const { data, loading, error, reload } = useAsync(useCallback(() => api.auditLogs(applied), [applied]));
  return (
    <div className="space-y-4">
      <Note>The audit trail is <strong>append-only</strong> and enforced at the database — entries cannot be edited or deleted, including from this UI.</Note>
      <div className="cc-card p-4 grid gap-2 md:grid-cols-[1fr_1fr_1fr_1fr_auto] items-end">
        <Field label="Action"><TextInput value={filters.action} onChange={e => setFilters(f => ({ ...f, action: e.target.value }))} placeholder="e.g. compliance.evidence.created" /></Field>
        <Field label="Resource"><TextInput value={filters.resource} onChange={e => setFilters(f => ({ ...f, resource: e.target.value }))} /></Field>
        <Field label="From"><TextInput type="date" value={filters.from} onChange={e => setFilters(f => ({ ...f, from: e.target.value }))} /></Field>
        <Field label="To"><TextInput type="date" value={filters.to} onChange={e => setFilters(f => ({ ...f, to: e.target.value }))} /></Field>
        <button type="button" onClick={() => setApplied(filters)} className="rounded-xl bg-indigo px-4 py-2 text-sm font-semibold text-white hover:opacity-90">Apply</button>
      </div>
      <div className="flex justify-end"><RefreshButton onClick={reload} /></div>
      <StateBlock loading={loading} error={error} empty={(data?.length ?? 0) === 0}>
        <div className="cc-card divide-y divide-[var(--b0)]">
          {(data ?? []).map(e => (
            <div key={e.id} className="px-4 py-2.5 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs font-semibold text-t1 truncate">{e.action}</p>
                <p className="text-[10px] text-t3 truncate">{e.resource}{e.resourceId ? ` · ${e.resourceId.slice(0, 8)}` : ''} · {e.actor}{e.actorRole ? ` (${e.actorRole})` : ''}{e.ipAddress ? ` · ${e.ipAddress}` : ''}</p>
              </div>
              <span className="text-[10px] text-t3 shrink-0">{new Date(e.occurredAt).toLocaleString()}</span>
            </div>
          ))}
        </div>
      </StateBlock>
    </div>
  );
}

// ===== Security Policy =====================================================
function SecurityPolicySection({ canWrite }: { canWrite: boolean }) {
  const { data, loading, error, reload } = useAsync(useCallback(() => api.getSecurityPolicy(), []));
  const [draft, setDraft] = useState<SecurityPolicy | null>(null);
  const [busy, setBusy] = useState(false);
  const current = draft ?? data;
  const set = <K extends keyof SecurityPolicy>(key: K, value: SecurityPolicy[K]) => setDraft({ ...(current as SecurityPolicy), [key]: value });

  async function save() {
    if (!draft) return;
    setBusy(true);
    try {
      await api.updateSecurityPolicy(draft);
      setDraft(null);
      reload();
    } finally { setBusy(false); }
  }

  return (
    <div className="space-y-4">
      <StateBlock loading={loading} error={error}>
        {current && (
          <div className="cc-card p-5 space-y-4">
            {current.requireMfa && <Note tone="info">MFA is enforced. Users without verified TOTP enrollment must complete setup on their next sign-in; enrolled users must pass the MFA challenge.</Note>}
            <div className="grid gap-4 md:grid-cols-2">
              <Toggle checked={current.requireMfa} onChange={v => canWrite && set('requireMfa', v)} label="Require MFA" />
              <Toggle checked={current.failedLoginLockout} onChange={v => canWrite && set('failedLoginLockout', v)} label="Failed-login lockout" />
              <Field label="Password expiry (days, blank = none)"><TextInput type="number" disabled={!canWrite} value={current.passwordExpiryDays ?? ''} onChange={e => set('passwordExpiryDays', e.target.value ? Number(e.target.value) : null)} /></Field>
              <Field label="Session timeout (minutes)"><TextInput type="number" disabled={!canWrite} value={current.sessionTimeoutMinutes} onChange={e => set('sessionTimeoutMinutes', Number(e.target.value))} /></Field>
              <Field label="Data retention (days)"><TextInput type="number" disabled={!canWrite} value={current.dataRetentionDays} onChange={e => set('dataRetentionDays', Number(e.target.value))} /></Field>
              <Field label="Backup frequency"><TextInput disabled={!canWrite} value={current.backupFrequency} onChange={e => set('backupFrequency', e.target.value)} /></Field>
              <Field label="Evidence review frequency"><TextInput disabled={!canWrite} value={current.evidenceReviewFrequency} onChange={e => set('evidenceReviewFrequency', e.target.value)} /></Field>
              <Field label="Allowed IP ranges (comma separated)"><TextInput disabled={!canWrite} value={current.allowedIpRanges.join(', ')} onChange={e => set('allowedIpRanges', e.target.value.split(',').map(s => s.trim()).filter(Boolean))} /></Field>
            </div>
            {canWrite && (
              <div className="flex justify-end gap-2">
                {draft && <button type="button" onClick={() => setDraft(null)} className="rounded-xl border border-[var(--b1)] px-3 py-2 text-sm text-t2 hover:bg-[var(--s3)]">Reset</button>}
                <button type="button" disabled={!draft || busy} onClick={save} className="inline-flex items-center gap-2 rounded-xl bg-indigo px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-40">{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Save policy</button>
              </div>
            )}
            {!canWrite && <p className="text-[11px] text-t3 inline-flex items-center gap-1"><Lock className="w-3 h-3" /> Read-only — auditors cannot change the security policy.</p>}
          </div>
        )}
      </StateBlock>
    </div>
  );
}

// ===== Reports =============================================================
function ReportsSection() {
  return (
    <div className="space-y-4">
      <Note>Reports draw from live data where a system is integrated, and render an explicit gap state (<strong>not integrated / unverified</strong>) where it is not. No system is shown as passing unless the data says so.</Note>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {REPORT_KEYS.map(key => <ReportCard key={key} reportKey={key} />)}
      </div>
    </div>
  );
}

function ReportCard({ reportKey }: { reportKey: ReportKey }) {
  const { data, loading, error, reload } = useAsync(useCallback(() => api.report(reportKey), [reportKey]));
  const report = data as ReportBase | null;
  return (
    <div className="cc-card p-4 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-bold text-t1">{REPORT_LABELS[reportKey]}</h3>
        <button type="button" onClick={reload} aria-label="Refresh report" title="Refresh" className="text-t3 hover:text-indigo"><RefreshCw className="w-3.5 h-3.5" /></button>
      </div>
      {loading && <p className="text-[11px] text-t3"><Loader2 className="w-3 h-3 animate-spin inline mr-1" /> Loading…</p>}
      {error && <p className="text-[11px] text-red-v inline-flex items-center gap-1"><X className="w-3 h-3" /> {error}</p>}
      {report && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <IntegrationBadge integrated={report.integrated} status={report.status} />
            {report.integrated === false && <span className="text-[10px] text-t3">gap</span>}
          </div>
          {typeof report.note === 'string' && <p className="text-[11px] text-t3 leading-snug">{report.note}</p>}
          {reportKey === 'mfa' && <p className="text-[11px] text-t3">Adoption: {String((report as { adoptionPct?: number }).adoptionPct ?? 0)}% · {String((report as { totalUsers?: number }).totalUsers ?? 0)} users</p>}
          {reportKey === 'password-policy' && (
            <p className="text-[11px] text-t3">min length {String((report as { minLength?: number }).minLength ?? '—')} · expiry {String((report as { expiryDays?: number | null }).expiryDays ?? 'none')} · lockout {(report as { lockoutEnabled?: boolean }).lockoutEnabled ? 'on' : 'off'}</p>
          )}
          <p className="text-[10px] text-t3">Source: <span className="font-mono">/v1/compliance/reports/{reportKey}</span></p>
        </div>
      )}
    </div>
  );
}
