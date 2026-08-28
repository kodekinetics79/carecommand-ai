import { useMemo, useState } from 'react';
import { Search, Users, AlertCircle, TrendingUp, Heart, Sparkles, ArrowRight, ShieldCheck, UserPlus, Filter } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import PageHeader from '../components/ui/PageHeader';
import StatCard from '../components/ui/StatCard';
import BentoCard from '../components/ui/BentoCard';
import ProgressBar from '../components/ui/ProgressBar';
import { formatCurrency } from '../utils/formatters';
import { useApiResource } from '../hooks/useApiResource';
import { mapPatient, type ApiPatient } from '../lib/apiAdapters';
import { apiRequest } from '../lib/api';

interface ApiBranchOption { id: string; name: string }
const emptyForm = { firstName: '', lastName: '', email: '', phone: '', branchId: '', lifecycleStage: 'NEW' };

const lifecycleConfig: Record<string, { label: string; color: string; bg: string }> = {
  new:      { label: 'New',      color: 'text-indigo',    bg: 'badge badge-blue' },
  active:   { label: 'Active',   color: 'text-emerald-v', bg: 'badge badge-emerald' },
  retained: { label: 'Retained', color: 'text-violet-v',  bg: 'badge badge-violet' },
  'at-risk':{ label: 'At Risk',  color: 'text-amber-v',   bg: 'badge badge-amber' },
  inactive: { label: 'Inactive', color: 'text-red-v',     bg: 'badge badge-red' },
};

export default function Patients() {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [activeLifecycle, setActiveLifecycle] = useState<string>('all');
  const { data: customerRecords, source, error, reload } = useApiResource<ApiPatient, ReturnType<typeof mapPatient>>('/v1/patients?limit=100', [], mapPatient);
  const { data: branchOptions } = useApiResource<ApiBranchOption, ApiBranchOption>('/v1/branches?limit=100', [], b => b);
  const [showAddForm, setShowAddForm] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const loadError = error;

  async function createPatient() {
    const branchId = form.branchId || branchOptions[0]?.id;
    if (!form.firstName.trim() || !form.lastName.trim() || !branchId) {
      setFormError('First name, last name and branch are required.');
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      await apiRequest('/v1/patients', {
        method: 'POST',
        body: JSON.stringify({
          branchId,
          firstName: form.firstName.trim(),
          lastName: form.lastName.trim(),
          email: form.email.trim() || undefined,
          phone: form.phone.trim() || undefined,
          lifecycleStage: form.lifecycleStage,
        }),
      });
      setForm(emptyForm);
      setShowAddForm(false);
      reload();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to add customer');
    } finally {
      setSaving(false);
    }
  }

  const familyCount = customerRecords.filter(p => p.familyAccountId).length;
  const highRisk = customerRecords.filter(p => p.churnRisk >= 60).length;
  const activeCount = customerRecords.filter(p => p.lifecycleStage === 'active' || p.lifecycleStage === 'retained').length;
  const avgLTV = customerRecords.length > 0 ? Math.round(customerRecords.reduce((sum, patient) => sum + patient.lifetimeValue, 0) / customerRecords.length) : 0;
  const segments = [
    { label: 'High LTV (>$4,000)', count: customerRecords.filter(p => p.lifetimeValue > 4000).length, color: 'emerald' as const },
    { label: 'At-risk churn', count: customerRecords.filter(p => p.churnRisk >= 60).length, color: 'red' as const },
    { label: 'Inactive (90d+)', count: customerRecords.filter(p => p.lifecycleStage === 'inactive').length, color: 'amber' as const },
    { label: 'Marketing consented', count: customerRecords.filter(p => p.consentStatus.marketing).length, color: 'blue' as const },
    { label: 'Family accounts', count: familyCount, color: 'violet' as const },
  ];

  const filtered = useMemo(() => {
    let list = customerRecords;
    if (activeLifecycle !== 'all') list = list.filter(p => p.lifecycleStage === activeLifecycle);
    if (query) list = list.filter(p =>
      p.name.toLowerCase().includes(query.toLowerCase()) ||
      p.phone.includes(query) ||
      p.email.toLowerCase().includes(query.toLowerCase())
    );
    return list;
  }, [query, activeLifecycle, customerRecords]);

  return (
    <div className="space-y-6 pb-8">
      <PageHeader
        title="Customer360"
        subtitle="Customer intelligence, lifecycle insights, consent-aware outreach, and LTV management."
        badge={loadError ? 'Live Data Error' : `${highRisk} At Risk · ${source === 'live' ? 'Live DB' : 'Loading'}`}
        badgeColor="red"
        actions={
          <button type="button" onClick={() => setShowAddForm(true)} className="inline-flex items-center gap-2 rounded-xl bg-[var(--indigo)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90 transition">
            <UserPlus className="w-4 h-4" /> Add Customer
          </button>
        }
      />

      {loadError && (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          Customer data could not be loaded from the live API: {loadError}
        </div>
      )}

      {showAddForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setShowAddForm(false)}>
          <div className="w-full max-w-md rounded-2xl bg-[var(--s1)] border border-[var(--b2)] p-5 shadow-xl" onClick={e => e.stopPropagation()}>
            <p className="text-sm font-bold text-t1 mb-3">Add Customer</p>
            {formError && <p className="text-[11px] text-red-v mb-2">{formError}</p>}
            <div className="grid grid-cols-2 gap-2.5">
              <input value={form.firstName} onChange={e => setForm(f => ({ ...f, firstName: e.target.value }))} placeholder="First name" className="px-3 py-2 rounded-lg border border-[var(--b1)] bg-[var(--s2)] text-xs text-t1 outline-none focus:border-[var(--b3)]" />
              <input value={form.lastName} onChange={e => setForm(f => ({ ...f, lastName: e.target.value }))} placeholder="Last name" className="px-3 py-2 rounded-lg border border-[var(--b1)] bg-[var(--s2)] text-xs text-t1 outline-none focus:border-[var(--b3)]" />
              <input value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} placeholder="Email" className="col-span-2 px-3 py-2 rounded-lg border border-[var(--b1)] bg-[var(--s2)] text-xs text-t1 outline-none focus:border-[var(--b3)]" />
              <input value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} placeholder="Phone" className="col-span-2 px-3 py-2 rounded-lg border border-[var(--b1)] bg-[var(--s2)] text-xs text-t1 outline-none focus:border-[var(--b3)]" />
              <select aria-label="Branch" title="Branch" value={form.branchId} onChange={e => setForm(f => ({ ...f, branchId: e.target.value }))} className="px-3 py-2 rounded-lg border border-[var(--b1)] bg-[var(--s2)] text-xs text-t1 outline-none focus:border-[var(--b3)]">
                <option value="">Select branch…</option>
                {branchOptions.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
              <select aria-label="Lifecycle stage" title="Lifecycle stage" value={form.lifecycleStage} onChange={e => setForm(f => ({ ...f, lifecycleStage: e.target.value }))} className="px-3 py-2 rounded-lg border border-[var(--b1)] bg-[var(--s2)] text-xs text-t1 outline-none focus:border-[var(--b3)]">
                {['NEW', 'ACTIVE', 'AT_RISK', 'INACTIVE', 'LOST', 'RETAINED'].map(s => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
              </select>
            </div>
            <div className="flex gap-2 mt-4">
              <button type="button" disabled={saving} onClick={createPatient} className="flex-1 py-2 rounded-lg bg-[var(--indigo)] text-white text-xs font-semibold hover:opacity-90 transition disabled:opacity-40">{saving ? 'Saving…' : 'Add Customer'}</button>
              <button type="button" onClick={() => setShowAddForm(false)} className="px-4 py-2 rounded-lg border border-[var(--b1)] text-t2 text-xs font-semibold hover:bg-[var(--s3)] transition">Cancel</button>
            </div>
          </div>
        </div>
      )}

      <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
        <StatCard title="Total Customers" value={customerRecords.length} subtitle="All branches" icon={<Users className="w-4 h-4" />} accent="blue" />
        <StatCard title="Active & Retained" value={activeCount} subtitle="Engaged lifecycle" trend={4} icon={<Heart className="w-4 h-4" />} accent="emerald" />
        <StatCard title="At-Risk Churn" value={highRisk} subtitle="Score ≥60%" icon={<AlertCircle className="w-4 h-4" />} accent="red" />
        <StatCard title="Avg Lifetime Value" value={formatCurrency(avgLTV)} subtitle="Per customer" trend={6} icon={<TrendingUp className="w-4 h-4" />} accent="violet" />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_340px]">
        {/* Main customer list */}
        <div className="space-y-4">
          {/* Search & filter */}
          <BentoCard title="Customer Records" subtitle="Search and filter all customers">
            {/* Lifecycle filter */}
            <div className="flex items-center gap-2 flex-wrap mb-4">
              {['all', 'new', 'active', 'retained', 'at-risk', 'inactive'].map((lc) => (
                <button
                  key={lc}
                  type="button"
                  onClick={() => setActiveLifecycle(lc)}
                  className={`text-xs font-semibold px-3 py-1.5 rounded-lg transition-all capitalize ${
                    activeLifecycle === lc
                      ? 'bg-[var(--indigo)] text-white'
                      : 'bg-[var(--s3)] text-t2 hover:bg-[var(--s3)]'
                  }`}
                >
                  {lc === 'all' ? 'All' : lifecycleConfig[lc]?.label ?? lc}
                  {lc !== 'all' && <span className="ml-1 opacity-70">({customerRecords.filter(p => p.lifecycleStage === lc).length})</span>}
                </button>
              ))}
            </div>

            {/* Search */}
            <div className="relative mb-4">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-t3" />
              <input
                aria-label="Search customers by name, phone or email"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search name, phone or email…"
                className="w-full rounded-xl border border-[var(--b1)] bg-[var(--s2)] py-2.5 pl-10 pr-4 text-sm text-t1 outline-none focus:border-[var(--indigo)] focus:ring-2 focus:ring-[var(--indigo-soft)] transition"
              />
              {query && (
                <button type="button" onClick={() => setQuery('')} title="Clear search" aria-label="Clear search" className="absolute right-3 top-1/2 -translate-y-1/2 text-t3 hover:text-t1">
                  <Filter className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {/* Customer rows */}
            <div className="space-y-2">
              {filtered.slice(0, 15).map((patient) => {
                const lc = lifecycleConfig[patient.lifecycleStage];
                return (
                  <button
                    key={patient.id}
                    type="button"
                    onClick={() => navigate(`/patients/${patient.id}`)}
                    className={`w-full flex items-center gap-3 p-3.5 rounded-xl border transition-all hover:bg-[var(--s3)] text-left ${
                      patient.churnRisk >= 60 ? 'border-[var(--red-soft)] hover:border-[var(--red-soft)]' :
                      patient.lifecycleStage === 'inactive' ? 'border-[var(--amber-soft)] hover:border-[var(--amber-soft)]' :
                      'border-[var(--b1)] hover:border-[var(--b2)]'
                    }`}
                  >
                    <div className="w-9 h-9 rounded-full bg-[var(--s3)] flex items-center justify-center text-t2 text-[10px] font-bold shrink-0">
                      {patient.name.split(' ').map(n => n[0]).join('')}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-bold text-t1 truncate">{patient.name}</p>
                        {patient.familyAccountId && <span className="badge badge-violet shrink-0">Family</span>}
                      </div>
                      <p className="text-[11px] text-t3 truncate">{patient.preferredChannel.toUpperCase()} · {patient.visitCount} visits · LTV {formatCurrency(patient.lifetimeValue)}</p>
                    </div>
                    <div className="flex flex-col items-end gap-1.5 shrink-0">
                      <span className={lc?.bg}>{lc?.label}</span>
                      {patient.churnRisk >= 60 && <span className="text-[10px] font-bold text-red-v">{patient.churnRisk}% risk</span>}
                    </div>
                  </button>
                );
              })}
              {filtered.length > 15 && (
                <p className="text-xs text-t3 text-center py-2">{filtered.length - 15} more customers — refine search to filter</p>
              )}
              {filtered.length === 0 && (
                <p className="text-sm text-t3 text-center py-6">No customers match your search.</p>
              )}
            </div>
          </BentoCard>
        </div>

        <div className="space-y-4">
          {/* Quick metrics */}
          <BentoCard title="Customer Intelligence" subtitle="Network-wide signals">
            <div className="space-y-3">
              {[
                { label: 'Preferred channel', value: 'WhatsApp', icon: <ShieldCheck className="w-3.5 h-3.5 text-emerald-v" /> },
                { label: 'Marketing consent rate', value: '87%', icon: <ShieldCheck className="w-3.5 h-3.5 text-emerald-v" /> },
                { label: 'Follow-up opportunities', value: '18 customers', icon: <Sparkles className="w-3.5 h-3.5 text-violet-v" /> },
                { label: 'Outstanding balances', value: formatCurrency(customerRecords.reduce((s, p) => s + p.outstandingBalance, 0)), icon: <AlertCircle className="w-3.5 h-3.5 text-amber-v" /> },
              ].map((item) => (
                <div key={item.label} className="flex items-center justify-between gap-3 p-2.5 rounded-xl border border-[var(--b1)] hover:bg-[var(--s3)] transition-colors">
                  <div className="flex items-center gap-2">
                    {item.icon}
                    <p className="text-xs text-t2">{item.label}</p>
                  </div>
                  <p className="text-xs font-bold text-t1">{item.value}</p>
                </div>
              ))}
            </div>
          </BentoCard>

          {/* Segments */}
          <BentoCard title="Customer Segments" subtitle="Live segmentation">
            <div className="space-y-2.5">
              {segments.map((seg) => (
                <div key={seg.label} className="flex items-center justify-between gap-3 p-3 rounded-xl border border-[var(--b1)] hover:bg-[var(--s3)] transition-all">
                  <div className="flex-1">
                    <p className="text-xs font-semibold text-t1 mb-1">{seg.label}</p>
                    <ProgressBar value={seg.count} max={customerRecords.length} color={seg.color} size="xs" />
                  </div>
                  <span className="text-xs font-bold text-t2 shrink-0">{seg.count}</span>
                </div>
              ))}
            </div>
          </BentoCard>

          {/* Branch coverage */}
          <BentoCard title="Branch Coverage" subtitle="Customers per location">
            <div className="space-y-2.5">
              {branchOptions.map((branch) => (
                <div key={branch.id} className="flex items-center justify-between gap-3 p-2.5 rounded-xl border border-[var(--b1)] hover:bg-[var(--s3)] transition-colors">
                  <div>
                    <p className="text-xs font-bold text-t1">{branch.name}</p>
                  </div>
                  <span className="text-xs font-bold text-t2">
                    {customerRecords.filter(patient => patient.branchId === branch.id).length}
                  </span>
                </div>
              ))}
            </div>
          </BentoCard>

          {/* Outreach recommendation */}
          <div className="rounded-2xl bg-[var(--s2)] border border-[var(--b2)] p-4">
            <div className="flex items-center gap-2 mb-2">
              <Sparkles className="w-4 h-4 text-violet-v" />
              <p className="text-[10px] font-bold uppercase tracking-widest text-violet-v">Outreach Recommendation</p>
            </div>
            <p className="text-sm font-bold text-t1 mb-1">18 customers ready for outreach</p>
            <p className="text-xs text-t2 mb-3">High-LTV customers with marketing consent who haven't been contacted in 60+ days.</p>
            <button type="button" onClick={() => navigate('/campaigner')} className="w-full py-2 rounded-xl bg-[var(--violet-soft)] hover:bg-[var(--s3)] text-violet-v text-xs font-semibold transition-colors flex items-center justify-center gap-1.5">
              <ArrowRight className="w-3.5 h-3.5" /> Launch outreach campaign
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
