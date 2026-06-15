import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ShieldCheck, Plus, CheckCircle2, BadgeCheck, FileText, Users, Building2, ArrowRight, Globe,
} from 'lucide-react';
import StatCard from '../components/ui/StatCard';
import BentoCard from '../components/ui/BentoCard';
import { apiRequest } from '../lib/api';
import { useApiData } from '../hooks/useApiData';

interface Payer {
  id: string;
  name: string;
  tradingPartnerServiceId: string | null;
  sourceProvider: string;
  active: boolean;
  sortOrder: number;
  policyCount: number;
}
interface InsuranceOverview {
  summary: { acceptedPayers: number; totalPayers: number; totalPolicies: number; verifiedPolicies: number; verifiedPct: number };
  payers: Payer[];
}

const PROVIDERS = ['mock', 'stedi', 'availity', 'pverify', 'optum'];
const fallback: InsuranceOverview = { summary: { acceptedPayers: 0, totalPayers: 0, totalPolicies: 0, verifiedPolicies: 0, verifiedPct: 0 }, payers: [] };

export default function Insurance() {
  const navigate = useNavigate();
  const { data, loading, reload } = useApiData<InsuranceOverview>('/v1/insurance/overview', fallback);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: '', sourceProvider: 'mock' });
  const [error, setError] = useState<string | null>(null);

  async function addPayer() {
    if (!form.name.trim()) return;
    setPendingId('new');
    setError(null);
    try {
      await apiRequest('/v1/insurance/payers', { method: 'POST', body: JSON.stringify({ name: form.name.trim(), sourceProvider: form.sourceProvider }) });
      setForm({ name: '', sourceProvider: 'mock' });
      setShowForm(false);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add insurer');
    } finally {
      setPendingId(null);
    }
  }

  async function toggle(payer: Payer) {
    setPendingId(payer.id);
    try {
      await apiRequest(`/v1/insurance/payers/${payer.id}`, { method: 'PATCH', body: JSON.stringify({ active: !payer.active }) });
      await reload();
    } finally {
      setPendingId(null);
    }
  }

  const s = data.summary;
  const activePayers = data.payers.filter(p => p.active);

  return (
    <div className="space-y-4 pb-6">
      {/* Slim toolbar — the topbar breadcrumb carries the page title. */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="badge badge-emerald">{s.acceptedPayers} accepted insurers</span>
        <button type="button" onClick={() => navigate('/revenue-protection')} className="inline-flex items-center gap-2 rounded-lg bg-[var(--indigo)] px-3.5 py-2 text-[13px] font-semibold text-white hover:opacity-90 transition">
          <BadgeCheck className="w-4 h-4" /> Verify Eligibility
        </button>
      </div>

      <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
        <StatCard title="Accepted Insurers" value={s.acceptedPayers} subtitle={`of ${s.totalPayers} configured`} icon={<ShieldCheck className="w-4 h-4" />} accent="emerald" />
        <StatCard title="Policies on File" value={s.totalPolicies} subtitle="Patient coverage records" icon={<FileText className="w-4 h-4" />} accent="blue" />
        <StatCard title="Verified Coverage" value={`${s.verifiedPct}%`} subtitle={`${s.verifiedPolicies} verified`} icon={<CheckCircle2 className="w-4 h-4" />} accent="violet" />
        <StatCard title="Insured Patients" value={s.totalPolicies} subtitle="Covered by a plan" icon={<Users className="w-4 h-4" />} accent="amber" />
      </div>

      <div className="rounded-2xl border border-[var(--b1)] bg-[var(--blue-soft)] p-4 flex items-start gap-3">
        <Building2 className="w-5 h-5 text-blue-v shrink-0 mt-0.5" />
        <p className="text-xs text-blue-v leading-relaxed">
          <span className="font-bold">Why this matters:</span> patients overwhelmingly choose providers that accept their insurance.
          Every plan you accept here widens your addressable patient base and is checked in real time during booking and check-in via Revenue Protection.
        </p>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
        {/* Accepted insurers directory */}
        <BentoCard title="Accepted Insurers" subtitle="Plans this practice accepts · drives eligibility checks" headerRight={<ShieldCheck className="w-4 h-4 text-t3" />}>
          {error && <p className="text-[11px] text-red-v mb-2">{error}</p>}
          <div className="space-y-2.5">
            {loading && data.payers.length === 0 && <div className="skeleton h-16 rounded-xl" />}
            {data.payers.map(payer => (
              <div key={payer.id} className={`flex items-center justify-between gap-3 p-3.5 rounded-xl border transition-all ${payer.active ? 'border-[var(--b1)] hover:border-[var(--b2)]' : 'border-[var(--b1)] bg-[var(--s2)] opacity-70'}`}>
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-emerald-500 to-blue-500 flex items-center justify-center text-white text-[10px] font-bold shrink-0">
                    {payer.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs font-bold text-t1 truncate">{payer.name}</p>
                    <p className="text-[10px] text-t3">{payer.policyCount} {payer.policyCount === 1 ? 'patient' : 'patients'} · via {payer.sourceProvider}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    disabled={pendingId === payer.id}
                    onClick={() => toggle(payer)}
                    className={`text-[10px] font-bold px-2.5 py-1 rounded-full transition disabled:opacity-40 ${payer.active ? 'badge badge-emerald' : 'badge badge-red'}`}
                  >
                    {pendingId === payer.id ? '…' : payer.active ? 'Accepted' : 'Not accepted'}
                  </button>
                </div>
              </div>
            ))}
          </div>

          {showForm ? (
            <div className="mt-3 p-3 rounded-xl border border-[var(--b2)] bg-[var(--s2)] space-y-2">
              <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Insurer name (e.g. MetLife)" className="w-full px-3 py-2 rounded-lg border border-[var(--b1)] bg-[var(--s1)] text-xs text-t1 outline-none focus:border-[var(--b3)]" />
              <select aria-label="Eligibility provider" value={form.sourceProvider} onChange={e => setForm(f => ({ ...f, sourceProvider: e.target.value }))} className="w-full px-3 py-2 rounded-lg border border-[var(--b1)] bg-[var(--s1)] text-xs text-t1 outline-none focus:border-[var(--b3)]">
                {PROVIDERS.map(p => <option key={p} value={p}>Eligibility via {p}</option>)}
              </select>
              <div className="flex gap-2">
                <button type="button" disabled={pendingId === 'new'} onClick={addPayer} className="flex-1 py-2 rounded-lg bg-[var(--indigo)] text-white text-xs font-semibold hover:opacity-90 disabled:opacity-40">{pendingId === 'new' ? 'Adding…' : 'Accept insurer'}</button>
                <button type="button" onClick={() => setShowForm(false)} className="px-3 py-2 rounded-lg border border-[var(--b1)] text-t2 text-xs font-semibold hover:bg-[var(--s3)]">Cancel</button>
              </div>
            </div>
          ) : (
            <button type="button" onClick={() => setShowForm(true)} className="mt-3 w-full py-2 border border-dashed border-[var(--b2)] rounded-xl text-xs font-semibold text-t3 hover:text-indigo hover:bg-[var(--s3)] inline-flex items-center justify-center gap-1"><Plus className="w-3.5 h-3.5" /> Accept a new insurer</button>
          )}
        </BentoCard>

        <div className="space-y-4">
          {/* Patient-facing accepted list */}
          <BentoCard title="Insurances We Accept" subtitle="Patient-facing · share on your booking page" headerRight={<Globe className="w-4 h-4 text-t3" />}>
            <div className="flex flex-wrap gap-2">
              {activePayers.map(p => (
                <span key={p.id} className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-emerald-v bg-[var(--emerald-soft)] border border-[var(--b1)] px-2.5 py-1.5 rounded-full">
                  <CheckCircle2 className="w-3 h-3" /> {p.name}
                </span>
              ))}
              {activePayers.length === 0 && <p className="text-xs text-t3">No insurers accepted yet.</p>}
            </div>
            <p className="text-[10px] text-t3 mt-3">Prospective patients see this list when they book — confirming they're covered before they ever call.</p>
          </BentoCard>

          {/* Eligibility CTA */}
          <div className="rounded-2xl border border-[var(--b1)] bg-[var(--s2)] p-4">
            <div className="flex items-center gap-2 mb-1">
              <BadgeCheck className="w-4 h-4 text-violet-v" />
              <p className="text-xs font-bold text-t1">Real-time eligibility</p>
            </div>
            <p className="text-[11px] text-t3 mb-3">Run live coverage checks, capture copays, and track prior authorisations in Revenue Protection.</p>
            <button type="button" onClick={() => navigate('/revenue-protection')} className="w-full py-2 rounded-xl bg-[var(--s3)] hover:bg-[var(--indigo-soft)] text-t1 hover:text-indigo text-xs font-semibold transition-colors flex items-center justify-center gap-1.5">
              Open verification queue <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
