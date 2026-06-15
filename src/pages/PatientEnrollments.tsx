import { useCallback, useEffect, useState } from 'react';
import { UserPlus, Plus, Loader2, Pause, Play, Square, ShieldCheck, RefreshCw } from 'lucide-react';
import BentoCard from '../components/ui/BentoCard';
import EmptyStatePremium from '../components/ui/EmptyStatePremium';
import { apiRequest } from '../lib/api';
import { crmService, type CrmPatient } from '../lib/crmService';

interface Enrollment { id: string; patientId: string; patientName: string; providerKey: string; programType: string; status: string; externalRef: string | null; enrolledAt: string; endedAt: string | null }
interface DeviceProvider { key: string; displayName: string; status: string }

const STATUS_BADGE: Record<string, string> = { active: 'badge-emerald', paused: 'badge-amber', ended: 'badge' };

export default function PatientEnrollments() {
  const [rows, setRows] = useState<Enrollment[]>([]);
  const [patients, setPatients] = useState<CrmPatient[]>([]);
  const [providers, setProviders] = useState<DeviceProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState({ patientId: '', providerKey: 'manual', programType: 'rpm' });
  const [showForm, setShowForm] = useState(false);

  const load = useCallback(async () => {
    try {
      const [enr, pats, provs] = await Promise.all([
        apiRequest<Enrollment[]>('/v1/connected-care/enrollments'),
        crmService.getPatients().catch(() => [] as CrmPatient[]),
        apiRequest<DeviceProvider[]>('/v1/devices/providers').catch(() => [] as DeviceProvider[]),
      ]);
      setRows(enr); setPatients(pats); setProviders(provs); setError(null);
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed to load enrollments'); }
    finally { setLoading(false); }
  }, []);
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  async function enroll() {
    if (!form.patientId) return;
    setBusy('new');
    try { await apiRequest('/v1/connected-care/enrollments', { method: 'POST', body: JSON.stringify(form) }); setShowForm(false); setForm({ patientId: '', providerKey: 'manual', programType: 'rpm' }); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Enroll failed'); }
    finally { setBusy(null); }
  }
  async function setStatus(e: Enrollment, status: string) {
    setBusy(e.id);
    try { await apiRequest(`/v1/connected-care/enrollments/${e.id}`, { method: 'PATCH', body: JSON.stringify({ status }) }); await load(); }
    finally { setBusy(null); }
  }
  async function grantConsent(patientId: string, granted: boolean) {
    setBusy(`consent-${patientId}`);
    try { await apiRequest('/v1/connected-care/consent', { method: 'POST', body: JSON.stringify({ patientId, consentType: 'rpm', granted, method: 'verbal' }) }); }
    catch (e) { setError(e instanceof Error ? e.message : 'Consent update failed'); }
    finally { setBusy(null); }
  }

  return (
    <div className="space-y-4 pb-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] text-t3">Patients enrolled into remote monitoring via a device provider.</p>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => void load()} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--b1)] bg-white px-3 py-1.5 text-[13px] font-semibold text-t1 hover:bg-[var(--s2)] transition"><RefreshCw className="w-3.5 h-3.5 text-t3" /> Refresh</button>
          <button type="button" onClick={() => setShowForm(v => !v)} className="inline-flex items-center gap-2 rounded-lg bg-[var(--indigo)] px-3.5 py-2 text-[13px] font-semibold text-white hover:opacity-90 transition"><Plus className="w-4 h-4" /> Enroll patient</button>
        </div>
      </div>

      {error && <div className="rounded-xl border border-[var(--b1)] bg-[var(--amber-soft)] p-3 text-[13px] text-amber-v">{error}</div>}

      {showForm && (
        <div className="rounded-xl border border-[var(--b2)] bg-[var(--s2)] p-4 grid gap-2.5 sm:grid-cols-3 items-end">
          <label className="block space-y-1"><span className="text-[11px] font-semibold text-t2">Patient</span>
            <select aria-label="Patient" value={form.patientId} onChange={e => setForm(f => ({ ...f, patientId: e.target.value }))} className={inputCls}><option value="">Select…</option>{patients.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
          <label className="block space-y-1"><span className="text-[11px] font-semibold text-t2">Provider</span>
            <select aria-label="Provider" value={form.providerKey} onChange={e => setForm(f => ({ ...f, providerKey: e.target.value }))} className={inputCls}>{providers.map(p => <option key={p.key} value={p.key}>{p.displayName}{p.status === 'NOT_CONFIGURED' ? ' (not configured)' : ''}</option>)}</select></label>
          <div className="flex gap-2">
            <button type="button" disabled={busy === 'new' || !form.patientId} onClick={enroll} className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--indigo)] px-3.5 py-2 text-[13px] font-semibold text-white hover:opacity-90 disabled:opacity-50">{busy === 'new' ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />} Enroll</button>
            <button type="button" onClick={() => setShowForm(false)} className="rounded-lg border border-[var(--b1)] px-3 py-2 text-[13px] font-semibold text-t2 hover:bg-[var(--s3)]">Cancel</button>
          </div>
        </div>
      )}

      <BentoCard title="Active & Past Enrollments" subtitle="Program, provider, status — with consent capture">
        {loading ? <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="skeleton-line h-12 rounded-lg" />)}</div>
          : rows.length === 0 ? <EmptyStatePremium icon={<UserPlus className="w-5 h-5" />} title="No enrollments yet" description="Enroll a patient into a monitoring program to start receiving device readings." />
          : (
            <div className="overflow-x-auto rounded-xl border border-[var(--b1)]">
              <table className="w-full border-collapse text-left">
                <thead><tr className="bg-[var(--s2)] border-b border-[var(--b1)]"><th className={thCls}>Patient</th><th className={thCls}>Provider</th><th className={thCls}>Program</th><th className={thCls}>Status</th><th className={`${thCls} text-right`}>Actions</th></tr></thead>
                <tbody className="divide-y divide-[var(--b1)]">
                  {rows.map(e => (
                    <tr key={e.id} className="hover:bg-[var(--s2)] transition-colors">
                      <td className="px-4 py-2.5 text-[13px] font-semibold text-t1 whitespace-nowrap">{e.patientName}</td>
                      <td className="px-4 py-2.5 text-[12px] text-t2 capitalize whitespace-nowrap">{e.providerKey}</td>
                      <td className="px-4 py-2.5 text-[12px] text-t2 uppercase whitespace-nowrap">{e.programType}</td>
                      <td className="px-4 py-2.5 whitespace-nowrap"><span className={`badge ${STATUS_BADGE[e.status] ?? 'badge'}`}>{e.status}</span></td>
                      <td className="px-4 py-2.5 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1.5">
                          <button type="button" disabled={busy === `consent-${e.patientId}`} onClick={() => grantConsent(e.patientId, true)} title="Grant RPM consent" className="inline-flex items-center gap-1 rounded-lg border border-[var(--b1)] px-2 py-1 text-[11px] font-semibold text-t2 hover:bg-[var(--s3)] disabled:opacity-50"><ShieldCheck className="w-3 h-3" /> Consent</button>
                          {e.status === 'active' && <button type="button" disabled={busy === e.id} onClick={() => setStatus(e, 'paused')} title="Pause" className="inline-flex items-center justify-center w-7 h-7 rounded-lg border border-[var(--b1)] text-t3 hover:bg-[var(--s3)]"><Pause className="w-3.5 h-3.5" /></button>}
                          {e.status === 'paused' && <button type="button" disabled={busy === e.id} onClick={() => setStatus(e, 'active')} title="Resume" className="inline-flex items-center justify-center w-7 h-7 rounded-lg border border-[var(--b1)] text-t3 hover:bg-[var(--s3)]"><Play className="w-3.5 h-3.5" /></button>}
                          {e.status !== 'ended' && <button type="button" disabled={busy === e.id} onClick={() => setStatus(e, 'ended')} title="End enrollment" className="inline-flex items-center justify-center w-7 h-7 rounded-lg border border-[var(--b1)] text-t3 hover:text-red-v hover:border-red-v/30"><Square className="w-3.5 h-3.5" /></button>}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </BentoCard>
    </div>
  );
}

const inputCls = 'w-full px-3 py-2 rounded-lg border border-[var(--b1)] bg-[var(--s1)] text-xs text-t1 outline-none focus:border-[var(--b3)]';
const thCls = 'px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-t3';
