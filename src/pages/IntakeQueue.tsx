import { useCallback, useEffect, useRef, useState } from 'react';
import { ClipboardList, Loader2, CheckCircle2, AlertCircle, Copy, Check, RefreshCw, FileText, Send } from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import ModuleTabs from '../components/ui/ModuleTabs';
import { useSession } from '../hooks/useSession';
import { hasPermission } from '../lib/access';
import { apiRequest } from '../lib/api';
import type { ApiPatient } from '../lib/apiAdapters';
import {
  intakeApi, intakeLink, INTAKE_STATUS_META, SECTION_LABEL,
  type IntakePacket, type IntakePacketDetail,
} from '../lib/intake';

type PatientPage = { data: ApiPatient[]; nextCursor?: string };

function maskedContact(patient: ApiPatient): string | null {
  const digits = patient.phone?.replace(/\D/g, '') ?? '';
  if (digits.length >= 4) return `phone ending ${digits.slice(-4)}`;
  if (patient.email) {
    const [local, domain] = patient.email.split('@');
    if (local && domain) return `${local.slice(0, 1)}***@${domain}`;
  }
  return null;
}

function patientOptionLabel(patient: ApiPatient): string {
  const identity = [
    patient.branch?.name,
    patient.externalRef ? `ref ${patient.externalRef}` : null,
    patient.dateOfBirth ? `DOB ${patient.dateOfBirth.slice(0, 10)}` : null,
    maskedContact(patient),
  ].filter((value): value is string => Boolean(value));
  return `${patient.firstName} ${patient.lastName} · ${identity.join(' · ') || `record ${patient.id.slice(0, 8)}`}`;
}

export default function IntakeQueue() {
  const { user } = useSession();
  const canWrite = hasPermission(user, 'intake:write');
  const [packets, setPackets] = useState<IntakePacket[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string>('');
  const [tab, setTab] = useState<'queue' | 'all'>('queue');
  // Originate a new intake for a patient (createPacket) directly from the queue.
  const [patients, setPatients] = useState<ApiPatient[]>([]);
  const [patientSearch, setPatientSearch] = useState('');
  const patientSearchRef = useRef('');
  const [patientsLoading, setPatientsLoading] = useState(false);
  const [patientsLoadingMore, setPatientsLoadingMore] = useState(false);
  const [patientNextCursor, setPatientNextCursor] = useState<string | null>(null);
  const [patientLoadError, setPatientLoadError] = useState<string | null>(null);
  const [patientLoadMoreError, setPatientLoadMoreError] = useState<string | null>(null);
  const [originatePatientId, setOriginatePatientId] = useState('');
  const [originating, setOriginating] = useState(false);
  const [originateNotice, setOriginateNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [originatedLink, setOriginatedLink] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const rows = tab === 'queue' ? await intakeApi.queue() : await intakeApi.listPackets();
      setPackets(rows);
      setSelectedId(prev => (prev && rows.some(r => r.intakePacketId === prev) ? prev : rows[0]?.intakePacketId ?? ''));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load intake packets');
    } finally {
      setLoading(false);
    }
  }, [tab]);

  useEffect(() => {
    let active = true;
    void (async () => {
      setLoading(true);
      try {
        const rows = tab === 'queue' ? await intakeApi.queue() : await intakeApi.listPackets();
        if (!active) return;
        setPackets(rows);
        setSelectedId(prev => (prev && rows.some(r => r.intakePacketId === prev) ? prev : rows[0]?.intakePacketId ?? ''));
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : 'Failed to load intake packets');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [tab]);

  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => void (async () => {
      setPatientsLoading(true);
      setPatientsLoadingMore(false);
      setPatientNextCursor(null);
      setPatientLoadError(null);
      setPatientLoadMoreError(null);
      try {
        const query = new URLSearchParams({ limit: '25' });
        if (patientSearch.trim()) query.set('search', patientSearch.trim());
        const res = await apiRequest<PatientPage | ApiPatient[]>(`/v1/patients?${query.toString()}`);
        const rows = Array.isArray(res) ? res : res.data;
        if (active) {
          setPatients(rows);
          setPatientNextCursor(Array.isArray(res) ? null : res.nextCursor ?? null);
          setPatientLoadError(null);
        }
      } catch (error) {
        if (active) setPatientLoadError(error instanceof Error ? error.message : 'Could not load the patient list.');
      } finally {
        if (active) setPatientsLoading(false);
      }
    })(), patientSearch ? 250 : 0);
    return () => { active = false; clearTimeout(timer); };
  }, [patientSearch]);

  async function loadMorePatients() {
    if (!patientNextCursor || patientsLoadingMore) return;
    const searched = patientSearch.trim();
    setPatientsLoadingMore(true);
    setPatientLoadMoreError(null);
    try {
      const query = new URLSearchParams({ limit: '25', cursor: patientNextCursor });
      if (searched) query.set('search', searched);
      const res = await apiRequest<PatientPage | ApiPatient[]>(`/v1/patients?${query.toString()}`);
      if (patientSearchRef.current.trim() !== searched) return;
      const rows = Array.isArray(res) ? res : res.data;
      setPatients(current => {
        const byId = new Map(current.map(patient => [patient.id, patient]));
        rows.forEach(patient => byId.set(patient.id, patient));
        return [...byId.values()];
      });
      setPatientNextCursor(Array.isArray(res) ? null : res.nextCursor ?? null);
    } catch (error) {
      if (patientSearchRef.current.trim() === searched) {
        setPatientLoadMoreError(error instanceof Error ? error.message : 'Could not load more matching patients.');
      }
    } finally {
      if (patientSearchRef.current.trim() === searched) setPatientsLoadingMore(false);
    }
  }

  async function originateIntake() {
    if (!originatePatientId) return;
    setOriginating(true);
    setOriginateNotice(null);
    setOriginatedLink(null);
    try {
      const packet = await intakeApi.createPacket({ patientId: originatePatientId, source: 'staff' });
      const link = intakeLink(packet.publicUrl, packet.publicToken);
      let copied = false;
      if (link) {
        try { await navigator.clipboard.writeText(link); copied = true; }
        catch { setOriginatedLink(link); }
      }
      setOriginateNotice({
        kind: 'ok',
        text: !link ? 'Intake packet created.' : copied ? 'Intake link created and copied to clipboard.' : 'Intake link created. Clipboard access was unavailable; copy the link below.',
      });
      setOriginatePatientId('');
      await reload();
      if (packet.intakePacketId) { setTab('all'); setSelectedId(packet.intakePacketId); }
    } catch (e) {
      setOriginateNotice({ kind: 'error', text: e instanceof Error ? e.message : 'Failed to create intake' });
    } finally {
      setOriginating(false);
    }
  }

  return (
    <div className="space-y-6 pb-8">
      <PageHeader title="Patient Intake" subtitle="Pre-visit intake packets, consent capture, and the staff review queue." />
      <div className="flex items-center gap-3 flex-wrap">
        <ModuleTabs
          tabs={[{ id: 'queue', label: 'Review queue' }, { id: 'all', label: 'All packets' }]}
          activeTab={tab}
          onChange={id => setTab(id as 'queue' | 'all')}
          ariaLabel="Intake packet views"
        />
        {canWrite && (
          <div className="flex flex-wrap items-center gap-2 bg-[var(--s2)] border border-[var(--b1)] p-1 rounded-xl">
            <input
              type="search"
              aria-label="Search patients for new intake"
              value={patientSearch}
              onChange={event => { patientSearchRef.current = event.target.value; setPatientSearch(event.target.value); setOriginatePatientId(''); }}
              placeholder="Search patient…"
              className="w-44 px-2.5 py-1.5 rounded-lg bg-white border border-[var(--b1)] text-xs text-t1 outline-none"
            />
            <select aria-label="Patient for new intake" value={originatePatientId} onChange={e => setOriginatePatientId(e.target.value)} disabled={patientsLoading || !!patientLoadError} className="px-2.5 py-1.5 rounded-lg bg-transparent text-xs text-t1 outline-none max-w-[220px] disabled:opacity-50">
              <option value="">{patientsLoading ? 'Searching…' : patients.length ? 'Select patient…' : 'No matching patients'}</option>
              {patients.map(patient => <option key={patient.id} value={patient.id}>{patientOptionLabel(patient)}</option>)}
            </select>
            {patientNextCursor && (
              <button type="button" onClick={() => void loadMorePatients()} disabled={patientsLoadingMore} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--b1)] bg-white px-3 py-1.5 text-xs font-semibold text-t2 hover:bg-[var(--s2)] transition disabled:opacity-40">
                {patientsLoadingMore && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {patientsLoadingMore ? 'Loading…' : patientSearch.trim() ? 'Load more matches' : 'Load more patients'}
              </button>
            )}
            <button type="button" disabled={!originatePatientId || originating} onClick={() => void originateIntake()} className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--indigo)] px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 transition disabled:opacity-40">
              <Send className="w-3.5 h-3.5" /> {originating ? 'Creating…' : 'Create & copy link'}
            </button>
          </div>
        )}
      </div>
      {patientLoadError && <p role="alert" className="text-xs font-semibold text-red-v">Patient list unavailable, so a new intake cannot be started right now. {patientLoadError}</p>}
      {patientLoadMoreError && <p role="alert" className="text-xs font-semibold text-red-v">More matching patients could not be loaded. The results already shown remain available. {patientLoadMoreError}</p>}
      {originateNotice && <p role={originateNotice.kind === 'error' ? 'alert' : 'status'} className={`text-xs font-semibold ${originateNotice.kind === 'ok' ? 'text-emerald-v' : 'text-red-v'}`}>{originateNotice.text}</p>}
      {originatedLink && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-[var(--b1)] bg-[var(--s2)] p-3">
          <input aria-label="New intake link" readOnly value={originatedLink} className="min-w-0 flex-1 rounded-lg border border-[var(--b1)] bg-white px-3 py-2 text-xs text-t1" />
          <button type="button" onClick={async () => {
            try { await navigator.clipboard.writeText(originatedLink); setOriginateNotice({ kind: 'ok', text: 'Intake link copied to clipboard.' }); setOriginatedLink(null); }
            catch { setOriginateNotice({ kind: 'error', text: 'Clipboard access is still unavailable. Select and copy the link manually.' }); }
          }} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--b1)] bg-white px-3 py-2 text-xs font-semibold text-t2"><Copy className="w-3.5 h-3.5" /> Copy link</button>
        </div>
      )}
      {error && <p role="alert" className="text-sm text-red-v">{error}</p>}
      {loading ? (
        <div className="cc-card p-10 text-center text-sm text-t3" role="status" aria-label="Loading intake packets"><Loader2 className="inline w-5 h-5 animate-spin" /></div>
      ) : (
        <div className="grid lg:grid-cols-[320px_1fr] gap-5">
          <div className="cc-card p-3 space-y-1.5 h-max">
            {packets.length === 0 && <p className="px-1 py-3 text-xs text-t3">No intake packets {tab === 'queue' ? 'awaiting review' : 'yet'}.</p>}
            {packets.map(p => {
              const meta = INTAKE_STATUS_META[p.status] ?? { label: p.status, badge: 'badge-blue' };
              const packetKind = p.appointmentId ? 'Appointment intake' : p.patientId ? 'Patient intake' : p.leadId ? 'Lead intake' : 'Unidentified intake';
              return (
                <button key={p.intakePacketId} type="button" onClick={() => setSelectedId(p.intakePacketId)} className={`w-full rounded-lg px-2.5 py-2 text-left transition-colors ${selectedId === p.intakePacketId ? 'bg-[var(--s2)] text-t1' : 'text-t2 hover:bg-[var(--s2)]'}`}>
                  <span className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold truncate">{p.subject.name ?? packetKind}</span>
                    <span className={`badge ${meta.badge} shrink-0`}>{meta.label}</span>
                  </span>
                  <span className="block text-[10px] text-t3 truncate">{p.clinic?.name ?? 'Clinic not resolved'} · {p.visit?.service ?? packetKind}</span>
                  <span className="text-[10px] text-t3">{p.source} · readiness {p.readinessScore}%</span>
                </button>
              );
            })}
          </div>
          <div>{selectedId ? <PacketDetail key={selectedId} id={selectedId} onChanged={reload} canWrite={canWrite} /> : <div className="cc-card p-10 text-center text-sm text-t3">Select an intake packet.</div>}</div>
        </div>
      )}
    </div>
  );
}

function PacketDetail({ id, onChanged, canWrite }: { id: string; onChanged: () => void; canWrite: boolean }) {
  const [packet, setPacket] = useState<IntakePacketDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [link, setLink] = useState<string | null>(null);

  const load = useCallback(async () => { try { setPacket(await intakeApi.getPacket(id)); } catch (e) { setError(e instanceof Error ? e.message : 'Failed to load'); } }, [id]);
  useEffect(() => { let a = true; void (async () => { try { const p = await intakeApi.getPacket(id); if (a) setPacket(p); } catch (e) { if (a) setError(e instanceof Error ? e.message : 'Failed'); } })(); return () => { a = false; }; }, [id]);

  async function run(fn: () => Promise<void>) { setBusy(true); setError(null); setNotice(null); try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : 'Action failed'); } finally { setBusy(false); } }

  if (error && !packet) return <div className="cc-card p-5 text-sm text-red-v">{error}</div>;
  if (!packet) return <div className="cc-card p-10 text-center text-sm text-t3"><Loader2 className="inline w-5 h-5 animate-spin" /></div>;
  const meta = INTAKE_STATUS_META[packet.status] ?? { label: packet.status, badge: 'badge-blue' };

  return (
    <div className="space-y-5">
      <div className="cc-card p-5 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-bold text-t1 flex items-center gap-2"><ClipboardList className="w-4 h-4 text-indigo" /> {packet.subject.name ?? 'Unidentified intake packet'}</h3>
            <p className="mt-0.5 text-[11px] text-t3">{packet.clinic?.name ?? 'Clinic not resolved'}{packet.visit?.service ? ` · ${packet.visit.service}` : ''}</p>
          </div>
          <span className={`badge ${meta.badge}`}>{meta.label}</span>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-[11px] text-t3">
          <span>Source: {packet.source}</span>
          <span>Readiness: <span className="text-t2 font-semibold">{packet.readinessScore}%</span></span>
          {packet.submittedAt && <span>Submitted {new Date(packet.submittedAt).toLocaleDateString()}</span>}
          {packet.setupRequired && <span className="text-amber-v inline-flex items-center gap-1"><AlertCircle className="w-3 h-3" /> Document upload needs object storage</span>}
        </div>
        {notice && <p className="text-[11px] text-emerald-v">{notice}</p>}
        {error && <p className="text-[11px] text-red-v">{error}</p>}
        <div className="flex flex-wrap gap-2">
          {canWrite && packet.allowedActions.includes('approve') && (
            <button type="button" disabled={busy || !packet.subject.name} title={!packet.subject.name ? 'Resolve the patient or lead identity before approval.' : undefined} onClick={() => run(async () => { await intakeApi.review(id, 'approve'); setNotice('Packet approved.'); await load(); onChanged(); })} className="inline-flex items-center gap-1.5 rounded-lg bg-indigo px-2.5 py-1.5 text-[11px] font-semibold text-white hover:opacity-90 disabled:opacity-50"><CheckCircle2 className="w-3.5 h-3.5" /> Approve</button>
          )}
          {canWrite && packet.allowedActions.includes('mark_needs_review') && (
            <button type="button" disabled={busy} onClick={() => run(async () => { await intakeApi.review(id, 'needs_review'); setNotice('Marked needs review.'); await load(); onChanged(); })} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--b1)] px-2.5 py-1.5 text-[11px] font-semibold text-t2 hover:bg-[var(--s2)] disabled:opacity-50"><AlertCircle className="w-3.5 h-3.5" /> Needs review</button>
          )}
          {canWrite && packet.allowedActions.includes('resend') && (
            <button type="button" disabled={busy} onClick={() => run(async () => { const r = await intakeApi.resend(id); setLink(intakeLink(r.publicUrl, r.publicToken)); setNotice('New intake link generated. Share it with the patient — the clinic does not send it for you.'); })} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--b1)] px-2.5 py-1.5 text-[11px] font-semibold text-t2 hover:bg-[var(--s2)] disabled:opacity-50"><RefreshCw className="w-3.5 h-3.5" /> Resend link</button>
          )}
          {link && (
            <button type="button" onClick={async () => {
              try { await navigator.clipboard.writeText(link); setCopied(true); setNotice('Patient link copied to clipboard.'); setTimeout(() => setCopied(false), 1500); }
              catch { setCopied(false); setError('Clipboard access is unavailable. Copy the link from the browser address field or try again after granting clipboard access.'); }
            }} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--b1)] px-2.5 py-1.5 text-[11px] font-semibold text-t2 hover:bg-[var(--s2)]">{copied ? <Check className="w-3.5 h-3.5 text-emerald-v" /> : <Copy className="w-3.5 h-3.5" />} {copied ? 'Copied' : 'Copy patient link'}</button>
          )}
        </div>
      </div>

      <div className="cc-card p-5">
        <h4 className="text-sm font-bold text-t1 mb-3 flex items-center gap-2"><FileText className="w-4 h-4 text-indigo" /> Sections</h4>
        <div className="space-y-1.5">
          {packet.sections.map(s => {
            const done = s.status === 'completed';
            return (
              <div key={s.sectionType} className="flex items-center justify-between rounded-lg border border-[var(--b1)] px-3 py-2 text-xs">
                <span className="text-t2">{SECTION_LABEL[s.sectionType] ?? s.sectionType}</span>
                <span className={`badge ${done ? 'badge-emerald' : s.status === 'needs_review' ? 'badge-amber' : 'badge-blue'}`}>{s.status.replace('_', ' ')}</span>
              </div>
            );
          })}
        </div>
        {packet.consentRecords.length > 0 && (
          <div className="mt-3 pt-3 border-t border-[var(--b1)]">
            <p className="text-[11px] font-bold uppercase tracking-wide text-t3 mb-1.5">Consent captured</p>
            <div className="flex flex-wrap gap-1.5">
              {packet.consentRecords.map((c, i) => <span key={i} className={`badge ${c.status === 'accepted' ? 'badge-emerald' : 'badge-red'}`}>{c.consentType.replace(/_/g, ' ')}: {c.status}</span>)}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
