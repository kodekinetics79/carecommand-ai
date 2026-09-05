import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { UserPlus, Plus, Loader2, Pause, Play, Square, ShieldCheck, RefreshCw, AlertTriangle } from 'lucide-react';
import BentoCard from '../components/ui/BentoCard';
import PageHeader from '../components/ui/PageHeader';
import ResourceSection from '../components/ui/ResourceSection';
import ConsentModal from '../components/connectedCare/ConsentModal';
import { useResource } from '../hooks/useResource';
import { apiRequest } from '../lib/api';
import { crmService, type CrmPatient } from '../lib/crmService';
import { useSession } from '../hooks/useSession';

interface Enrollment { id: string; patientId: string; patientName: string; providerKey: string; programType: string; status: string; externalRef: string | null; enrolledAt: string; endedAt: string | null }
interface DeviceProvider { key: string; displayName: string; status: string; category: string; configured: boolean; webhookConfigured: boolean }
interface DeviceRow { id: string; name: string; deviceType: string; serialNumber: string | null; connectivity: string; branchId: string | null }
interface Page { enrollments: Enrollment[]; patients: CrmPatient[]; providers: DeviceProvider[]; devices: DeviceRow[] }

const STATUS_BADGE: Record<string, string> = { active: 'badge-emerald', paused: 'badge-amber', ended: 'badge' };

const loadPage = async (): Promise<Page> => {
  const [enrollments, patients, providers, deviceOverview] = await Promise.all([
    apiRequest<Enrollment[]>('/v1/connected-care/enrollments'),
    crmService.getPatients().catch(() => [] as CrmPatient[]),
    apiRequest<DeviceProvider[]>('/v1/devices/providers').catch(() => [] as DeviceProvider[]),
    apiRequest<{ devices: DeviceRow[] }>('/v1/devices/overview').catch(() => ({ devices: [] as DeviceRow[] })),
  ]);
  return { enrollments, patients, providers, devices: deviceOverview.devices };
};

export default function PatientEnrollments() {
  const navigate = useNavigate();
  const { user } = useSession();
  const canManage = Boolean(user && ['OWNER', 'ADMIN', 'MANAGER'].includes(user.role));
  const { state, reload } = useResource<Page>(loadPage);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ patientId: '', providerKey: '', deviceId: '', programType: 'rpm' });
  const [showForm, setShowForm] = useState(false);
  const [consentFor, setConsentFor] = useState<{ id: string; name: string } | null>(null);
  const [patientSearch, setPatientSearch] = useState('');
  const [patientOptions, setPatientOptions] = useState<CrmPatient[]>([]);
  const [patientSearchError, setPatientSearchError] = useState<string | null>(null);

  useEffect(() => {
    if (!showForm || state.status !== 'ready') return;
    const signal = { cancelled: false };
    const timer = setTimeout(() => void (async () => {
      try {
        const page = await crmService.listPatients({ search: patientSearch });
        if (!signal.cancelled) { setPatientOptions(page.patients); setPatientSearchError(null); }
      } catch (error) {
        if (!signal.cancelled) setPatientSearchError(error instanceof Error ? error.message : 'Patient search failed');
      }
    })(), patientSearch ? 250 : 0);
    return () => { signal.cancelled = true; clearTimeout(timer); };
  }, [patientSearch, showForm, state.status]);

  const enroll = useCallback(async () => {
    if (!form.patientId || !form.providerKey) return;
    setBusy('new');
    setError(null);
    try {
      await apiRequest('/v1/connected-care/enrollments', {
        method: 'POST',
        body: JSON.stringify({
          patientId: form.patientId,
          providerKey: form.providerKey,
          programType: form.programType,
          // Binding the device is what makes a reading countable. Without it
          // every reading is excluded for missing provenance and the patient
          // can never reach a billable device-day, however long they transmit.
          ...(form.deviceId ? { deviceId: form.deviceId } : {}),
        }),
      });
      setShowForm(false);
      setForm({ patientId: '', providerKey: '', deviceId: '', programType: 'rpm' });
      reload();
    } catch (e) { setError(e instanceof Error ? e.message : 'Enrolment failed'); }
    finally { setBusy(null); }
  }, [form, reload]);

  const setStatus = useCallback(async (e: Enrollment, status: string) => {
    setBusy(e.id);
    setError(null);
    try {
      await apiRequest(`/v1/connected-care/enrollments/${e.id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
      reload();
    } catch (err) {
      // Previously this had no catch at all: a failed pause looked like a
      // no-op and the row silently did not change.
      setError(err instanceof Error ? err.message : 'Could not update this enrolment');
    } finally { setBusy(null); }
  }, [reload]);

  // 'manual' is offered last and labelled, because a manual enrolment's
  // readings can never qualify as automated-device evidence — it satisfies the
  // "active enrolment" tick while making device-days structurally impossible.
  const orderedProviders = useMemo(() => {
    const list = state.status === 'ready' ? state.data.providers : [];
    return [...list].sort((a, b) => (a.key === 'manual' ? 1 : 0) - (b.key === 'manual' ? 1 : 0));
  }, [state]);
  const selectedProviderIsManual = form.providerKey === 'manual';
  const selectedProvider = orderedProviders.find(provider => provider.key === form.providerKey);
  const selectedProviderReady = selectedProviderIsManual || Boolean(selectedProvider?.configured && selectedProvider.webhookConfigured);
  const rpmDeviceMissing = form.programType === 'rpm' && !selectedProviderIsManual && !form.deviceId;
  const canEnroll = Boolean(form.patientId && form.providerKey && selectedProviderReady && !rpmDeviceMissing);

  return (
    <div className="space-y-6 pb-8">
      <PageHeader
        title="Device Enrolments"
        subtitle="Patients enrolled into remote monitoring. Enrolment records consent, starts the billing period, and binds the device whose readings count as evidence."
        actions={
          <div className="flex items-center gap-2">
            <button type="button" onClick={reload} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--b1)] bg-white px-3 py-1.5 text-[13px] font-semibold text-t1 hover:bg-[var(--s2)] transition">
              <RefreshCw className="w-3.5 h-3.5 text-t3" /> Refresh
            </button>
            {canManage && (
              <button type="button" onClick={() => setShowForm(v => !v)} className="inline-flex items-center gap-2 rounded-lg bg-[var(--indigo)] px-3.5 py-2 text-[13px] font-semibold text-white hover:opacity-90 transition">
                <Plus className="w-4 h-4" /> Enrol patient
              </button>
            )}
          </div>
        }
      />

      {error && <div role="alert" className="rounded-xl border border-[var(--b1)] bg-[var(--amber-soft)] p-3 text-[13px] text-amber-v">{error}</div>}

      {showForm && state.status === 'ready' && (
        <div className="rounded-xl border border-[var(--b2)] bg-[var(--s2)] p-4 space-y-3">
          <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
            <label className="block space-y-1">
              <span className="text-[11px] font-semibold text-t2">Program</span>
              <select aria-label="Monitoring program" value={form.programType} onChange={e => setForm(f => ({ ...f, programType: e.target.value }))} className={inputCls}>
                <option value="rpm">Remote patient monitoring</option>
                <option value="ccm">Chronic care management</option>
                <option value="general">General monitoring</option>
              </select>
            </label>
            <label className="block space-y-1">
              <span className="text-[11px] font-semibold text-t2">Patient</span>
              <input type="search" aria-label="Search patients for enrolment" value={patientSearch} onChange={event => { setPatientSearch(event.target.value); setForm(current => ({ ...current, patientId: '' })); }} placeholder="Search name, phone, or email…" className={`${inputCls} mb-1.5`} />
              <select aria-label="Patient" value={form.patientId} onChange={e => setForm(f => ({ ...f, patientId: e.target.value }))} className={inputCls}>
                <option value="">Select…</option>
                {patientOptions.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              {patientSearchError && <span role="alert" className="text-[10px] text-amber-v">{patientSearchError}</span>}
            </label>
            <label className="block space-y-1">
              <span className="text-[11px] font-semibold text-t2">Device provider</span>
              <select aria-label="Device provider" value={form.providerKey} onChange={e => setForm(f => ({ ...f, providerKey: e.target.value }))} className={inputCls}>
                <option value="">Select…</option>
                {orderedProviders.map(p => (
                  <option key={p.key} value={p.key}>
                    {p.displayName}
                    {p.key === 'manual' ? ' (manual entry — not billable evidence)' : p.status === 'NOT_CONFIGURED' ? ' (not configured)' : ''}
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-1">
              <span className="text-[11px] font-semibold text-t2">Device</span>
              <select aria-label="Device" value={form.deviceId} onChange={e => setForm(f => ({ ...f, deviceId: e.target.value }))} className={inputCls}>
                <option value="">Select the device given to the patient…</option>
                {state.data.devices.map(d => (
                  <option key={d.id} value={d.id}>{d.name}{d.serialNumber ? ` · ${d.serialNumber}` : ''}</option>
                ))}
              </select>
            </label>
          </div>

          {rpmDeviceMissing && (
            <p className="inline-flex items-start gap-1.5 text-[11px] text-amber-v">
              <AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" />
              Without a bound device, readings cannot be traced to this enrolment and will not count toward device-days.
              {state.data.devices.length === 0 && (
                <button type="button" onClick={() => navigate('/devices')} className="font-semibold underline">Register a device first</button>
              )}
            </p>
          )}
          {form.providerKey && !selectedProviderReady && (
            <p role="alert" className="inline-flex items-start gap-1.5 text-[11px] text-amber-v">
              <AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" />
              This provider is not ready to receive verified patient readings. Configure its credentials and signed webhook before enrolling anyone.
              <button type="button" onClick={() => navigate('/devices')} className="font-semibold underline">Open device setup</button>
            </p>
          )}
          {selectedProviderIsManual && (
            <p className="inline-flex items-start gap-1.5 text-[11px] text-amber-v">
              <AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" />
              Manual entry is recorded for care, but its readings are not automated device transmissions and cannot support device-supply codes.
            </p>
          )}

          <div className="flex gap-2">
            <button type="button" disabled={busy === 'new' || !canEnroll} onClick={() => void enroll()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--indigo)] px-3.5 py-2 text-[13px] font-semibold text-white hover:opacity-90 disabled:opacity-50">
              {busy === 'new' ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />} Enrol
            </button>
            <button type="button" onClick={() => setShowForm(false)} className="rounded-lg border border-[var(--b1)] px-3 py-2 text-[13px] font-semibold text-t2 hover:bg-[var(--s3)]">Cancel</button>
          </div>
        </div>
      )}

      <BentoCard title="Active & Past Enrolments" subtitle="Program, provider, status — grouped by patient">
        <ResourceSection
          label="Enrolments"
          state={state}
          onRetry={reload}
          lines={4}
          rowClassName="h-12 rounded-lg"
          isEmpty={p => p.enrollments.length === 0}
          empty={{
            icon: <UserPlus className="w-5 h-5" />,
            title: 'No patients enrolled yet',
            description: 'Enrolling a patient records their consent, starts their billing period, and opens their monitoring record.',
            ...(canManage ? { cta: { label: 'Enrol a patient', onClick: () => setShowForm(true) } } : {}),
          }}
        >
          {page => (
            <div className="overflow-x-auto rounded-xl border border-[var(--b1)]">
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="bg-[var(--s2)] border-b border-[var(--b1)]">
                    <th className={thCls}>Patient</th><th className={thCls}>Provider</th><th className={thCls}>Program</th><th className={thCls}>Status</th><th className={`${thCls} text-right`}>Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--b1)]">
                  {page.enrollments.map(e => (
                    <tr key={e.id} className="hover:bg-[var(--s2)] transition-colors">
                      <td className="px-4 py-2.5 text-[13px] font-semibold text-t1 whitespace-nowrap">{e.patientName}</td>
                      <td className="px-4 py-2.5 text-[12px] text-t2 capitalize whitespace-nowrap">
                        {e.providerKey}
                        {e.providerKey === 'manual' && <span className="ml-1 text-[10px] text-amber-v">(not billable evidence)</span>}
                      </td>
                      <td className="px-4 py-2.5 text-[12px] text-t2 uppercase whitespace-nowrap">{e.programType}</td>
                      <td className="px-4 py-2.5 whitespace-nowrap"><span className={`badge ${STATUS_BADGE[e.status] ?? 'badge'}`}>{e.status}</span></td>
                      <td className="px-4 py-2.5 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1.5">
                          <button type="button" onClick={() => setConsentFor({ id: e.patientId, name: e.patientName })}
                            className="inline-flex items-center gap-1 rounded-lg border border-[var(--b1)] px-2 py-1 text-[11px] font-semibold text-t2 hover:bg-[var(--s3)]">
                            <ShieldCheck className="w-3 h-3" /> Consent
                          </button>
                          {canManage && e.status === 'active' && (
                            <button type="button" disabled={busy === e.id} onClick={() => void setStatus(e, 'paused')}
                              aria-label={`Pause monitoring for ${e.patientName}`} title="Pause — readings stop being ingested, including alerts"
                              className="inline-flex items-center justify-center w-9 h-9 rounded-lg border border-[var(--b1)] text-t3 hover:bg-[var(--s3)] disabled:opacity-50">
                              <Pause className="w-3.5 h-3.5" />
                            </button>
                          )}
                          {canManage && e.status === 'paused' && (
                            <button type="button" disabled={busy === e.id} onClick={() => void setStatus(e, 'active')}
                              aria-label={`Resume monitoring for ${e.patientName}`} title="Resume"
                              className="inline-flex items-center justify-center w-9 h-9 rounded-lg border border-[var(--b1)] text-t3 hover:bg-[var(--s3)] disabled:opacity-50">
                              <Play className="w-3.5 h-3.5" />
                            </button>
                          )}
                          {canManage && e.status !== 'ended' && (
                            <button type="button" disabled={busy === e.id} onClick={() => void setStatus(e, 'ended')}
                              aria-label={`End enrolment for ${e.patientName}`} title="End enrolment"
                              className="inline-flex items-center gap-1 rounded-lg border border-[var(--b1)] px-2 py-1 text-[11px] font-semibold text-t2 hover:text-red-v hover:border-red-v/30 disabled:opacity-50">
                              <Square className="w-3 h-3" /> End
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </ResourceSection>
      </BentoCard>

      {consentFor && (
        <ConsentModal
          patientId={consentFor.id}
          patientName={consentFor.name}
          canWrite={canManage}
          onClose={() => setConsentFor(null)}
          onSaved={reload}
        />
      )}
    </div>
  );
}

const inputCls = 'w-full px-3 py-2 rounded-lg border border-[var(--b1)] bg-[var(--s1)] text-xs text-t1 outline-none focus:border-[var(--b3)]';
const thCls = 'px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-t3';
